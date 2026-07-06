/**
 * Edición MANUAL de un documento desde la ficha (fase de revisión humana). Lista BLANCA de campos; resuelve
 * autores/editorial por NOMBRE (check-then-create), valida ISBN/ISSN (descarta los malformados para no
 * romper el $jsonSchema) y nunca borra el título (campo requerido). El flag `locked` protege el documento
 * del Conformador. No mueve ficheros (un cambio de CDU re-aloja luego con el Conformador/sanear).
 */
import { ObjectId } from 'mongodb';
import { validarISBN, validarISSN } from './identificadores.js';
import { indexarDoc } from './indice-busqueda.js';
import { reubicarPorCdu } from '../mantenimiento/util-mantenimiento.js';
import { resolverPersona } from './resolver-persona.js';
import { ROLES_VALIDOS } from './contribuciones.js';

const TEXTO = ['subtitulo', 'idioma', 'numero_edicion', 'cdu', 'dewey', 'lcc', 'lccn', 'sinopsis', 'obra_titulo'];
const NUM = ['año_edicion', 'paginas', 'volumen_numero'];

// Resuelve nombres → ObjectId con resolverPersona (INSENSIBLE a mayúsculas/acentos + normalización BNE):
// así editar «JEAN TOUCHARD» reusa «Touchard, Jean» en vez de crear un duplicado.
async function resolverAutores(db, nombres) {
    const out = [];
    for (const n of nombres) {
        const r = await resolverPersona(db, n);
        if (r?._id) out.push(r._id);
    }
    return out;
}
async function resolverEditorial(db, nombre) {
    const t = String(nombre || '').trim(); if (!t) return null;
    const ex = await db.collection('editoriales').findOne({ nombre: t });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre: t })).insertedId;
}

export async function editarDocumento(db, id, campos = {}) {
    if (!ObjectId.isValid(id)) return { ok: false, motivo: 'id inválido' };
    const set = {}, unset = {};
    const avisos = [];
    // Documento actual: solo se necesita si cambia la CDU a mano (para reubicar su carpeta desde la ruta vieja).
    const docActual = ('cdu' in campos) ? await db.collection('biblioteca').findOne({ _id: new ObjectId(id) }) : null;

    // Título: requerido por el esquema → solo se actualiza si viene NO vacío (nunca se borra).
    if ('titulo' in campos && String(campos.titulo).trim()) set.titulo = String(campos.titulo).trim();

    for (const k of TEXTO) {
        if (!(k in campos)) continue;
        const v = String(campos[k] ?? '').trim();
        if (v) set[k] = v; else unset[k] = '';
    }
    for (const k of NUM) {
        if (!(k in campos)) continue;
        const raw = campos[k];
        if (raw === '' || raw == null) { unset[k] = ''; continue; }
        const v = parseInt(raw, 10);
        if (Number.isFinite(v)) set[k] = v; else unset[k] = '';
    }

    // Identificadores: validar checksum; si es inválido, NO se guarda (aviso) para no violar el esquema.
    if ('isbn' in campos) {
        const v = String(campos.isbn || '').trim();
        if (!v) unset.isbn = '';
        else { const ok = validarISBN(v); if (ok) set.isbn = ok; else avisos.push(`ISBN inválido (ignorado): ${v}`); }
    }
    if ('issn' in campos) {
        const v = String(campos.issn || '').trim();
        if (!v) unset.issn = '';
        else { const ok = validarISSN(v); if (ok) set.issn = ok; else avisos.push(`ISSN inválido (ignorado): ${v}`); }
    }

    // ISBNs ALTERNATIVOS (otras ediciones/encuadernaciones, con su rol). Se validan por checksum; los
    // inválidos/duplicados se descartan (no romper el esquema). El ISBN primario no se repite aquí.
    if ('isbns_alternativos' in campos) {
        const ROLES = ['tapa_dura', 'tapa_blanda', 'ebook', 'obra', 'volumen', 'barras', 'otro'];
        const arr = Array.isArray(campos.isbns_alternativos) ? campos.isbns_alternativos : [];
        const vistos = new Set();
        const primario = validarISBN(String(campos.isbn || '').trim());
        if (primario) vistos.add(primario);
        const limpio = [];
        for (const it of arr) {
            const ok = validarISBN(String(it?.isbn || '').trim());
            if (!ok || vistos.has(ok)) continue;
            vistos.add(ok);
            const a = { isbn: ok, rol: ROLES.includes(it?.rol) ? it.rol : 'otro', fuente: it?.fuente || 'manual' };
            if (it?.etiqueta) a.etiqueta = String(it.etiqueta).slice(0, 40);
            limpio.push(a);
        }
        if (limpio.length) set.isbns_alternativos = limpio; else unset.isbns_alternativos = '';
        const desc = arr.length - limpio.length;
        if (desc > 0) avisos.push(`${desc} ISBN alternativo(s) inválido(s)/duplicado(s) ignorado(s)`);
    }

    if ('autores' in campos) {
        // Separador «;» (NO coma): un nombre puede llevar coma («Touchard, Jean»). Acepta también array.
        const arr = (Array.isArray(campos.autores) ? campos.autores : String(campos.autores || '').split(';')).map(s => s.trim()).filter(Boolean);
        if (arr.length) set.autores = await resolverAutores(db, arr); else unset.autores = '';
    }
    // CONTRIBUCIONES con rol (traductor/ilustrador/editor/…): [{nombre, rol}] → [{persona, rol}] (resueltos,
    // insensible a grafía). Se excluye 'autor' (va en autores[]); rol no válido → se descarta; dedup (persona,rol).
    if ('contribuciones' in campos) {
        const arr = Array.isArray(campos.contribuciones) ? campos.contribuciones : [];
        const out = [], vistos = new Set();
        for (const c of arr) {
            const nombre = String(c?.nombre || '').trim();
            const rol = String(c?.rol || '').trim().toLowerCase();
            if (!nombre || rol === 'autor' || !ROLES_VALIDOS.includes(rol)) continue;
            const r = await resolverPersona(db, nombre);
            if (!r?._id) continue;
            const key = String(r._id) + '|' + rol;
            if (vistos.has(key)) continue; vistos.add(key);
            out.push({ persona: r._id, rol });
        }
        if (out.length) set.contribuciones = out; else unset.contribuciones = '';
    }
    if ('editorial' in campos) {
        const e = await resolverEditorial(db, campos.editorial);
        if (e) set.editorial = e; else unset.editorial = '';
    }
    if ('palabras_clave' in campos) {
        const arr = (Array.isArray(campos.palabras_clave) ? campos.palabras_clave : String(campos.palabras_clave || '').split(',')).map(s => s.trim()).filter(Boolean);
        if (arr.length) set.palabras_clave = arr; else unset.palabras_clave = '';
    }
    if (campos.ubicacion) {
        set.ubicacion = {
            ambito: String(campos.ubicacion.ambito || '').trim() || 'Sin asignar',
            estanteria: String(campos.ubicacion.estanteria || '').trim() || 'Sin asignar',
        };
    }
    if ('locked' in campos) set.locked = !!campos.locked;
    if ('estado_verificacion' in campos && ['pendiente', 'completado'].includes(campos.estado_verificacion)) set.estado_verificacion = campos.estado_verificacion;
    // Corregir un tipo mal detectado (revista↔libro). No re-aloja el fichero por sí solo: el Conformador/
    // reprocesar re-archiva en revistas/ o libros/ según corresponda; aquí solo se fija el campo.
    if ('tipo_recurso' in campos && ['libro', 'revista'].includes(campos.tipo_recurso)) set.tipo_recurso = campos.tipo_recurso;

    // CDU cambiada A MANO: la clasificación manual manda → mover la carpeta a su árbol nuevo al instante y
    // proteger el valor (cdu_manual) para que el Conformador (re-clasificar-cdu) no lo recalcule ni lo pise.
    if (set.cdu && docActual && set.cdu !== docActual.cdu) {
        try {
            const reub = await reubicarPorCdu(docActual, set.cdu);
            if (reub) {
                Object.assign(set, reub.set);   // cdu + ruta_base + portada + imagenes remapeadas
                (reub.alertas || []).forEach(a => avisos.push(a));
            }
        } catch (e) {
            avisos.push(`No se pudo reubicar la carpeta por la nueva CDU: ${e.message}`);
        }
        set.cdu_manual = true;
    }

    if (!Object.keys(set).length && !Object.keys(unset).length) return { ok: true, sinCambios: true, avisos };
    set.fecha_actualizacion = new Date();
    const upd = {};
    if (Object.keys(set).length) upd.$set = set;
    if (Object.keys(unset).length) upd.$unset = unset;
    const r = await db.collection('biblioteca').updateOne({ _id: new ObjectId(id) }, upd);
    if (!r.matchedCount) return { ok: false, motivo: 'documento no encontrado' };
    // Reindexar para que la búsqueda refleje los cambios (best-effort; no rompe la edición).
    await indexarDoc(db, id);
    return { ok: true, avisos };
}
