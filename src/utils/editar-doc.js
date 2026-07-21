/**
 * Edición MANUAL de un documento desde la ficha (fase de revisión humana). Lista BLANCA de campos; resuelve
 * autores/editorial por NOMBRE (check-then-create), valida ISBN/ISSN (descarta los malformados para no
 * romper el $jsonSchema) y nunca borra el título (campo requerido). El flag `locked` protege el documento
 * del Conformador. No mueve ficheros (un cambio de CDU re-aloja luego con el Conformador/sanear).
 */
import { ObjectId } from 'mongodb';
import { validarISBN, validarISSN } from './identificadores.js';
import { normalizarDOI } from './buscador-crossref.js';
import { indexarDoc } from './indice-busqueda.js';
import { reubicarPorCdu, carpetaDeDoc, archivoOriginal } from '../mantenimiento/util-mantenimiento.js';
import { resolverPersona } from './resolver-persona.js';
import { ROLES_VALIDOS } from './contribuciones.js';
import { claveNumero } from './revistas.js';
import path from 'node:path';

const TEXTO = ['subtitulo', 'idioma', 'numero_edicion', 'cdu', 'dewey', 'lcc', 'lccn', 'sinopsis', 'obra_titulo'];
const NUM = ['año_edicion', 'paginas', 'volumen_numero'];
// Extensión del fichero original → su formato (para cuando se recupera el fichero al pasar papel→digital).
const FORMATO_POR_EXT = { '.pdf': 'pdf', '.epub': 'epub', '.mobi': 'mobi', '.azw': 'mobi', '.azw3': 'mobi', '.djvu': 'djvu', '.djv': 'djvu', '.cbr': 'cbr', '.cbz': 'cbz', '.cb7': 'cb7' };

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
    // Campos de fecha/nº de una REVISTA (mes/año/nº de ejemplar) → recomputan la clave del número.
    const tocaClave = ['año_edicion', 'mes_publicacion', 'numero_issue'].some((k) => k in campos);
    // Documento actual: se necesita para reubicar por CDU y para recomputar clave_numero (mezclar con lo actual).
    const docActual = (('cdu' in campos) || ('soporte' in campos) || tocaClave) ? await db.collection('biblioteca').findOne({ _id: new ObjectId(id) }) : null;

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

    // Revistas: mes de publicación (1-12) y número de ejemplar. Junto con año_edicion (NUM) definen la
    // identidad del número dentro de su cabecera (clave_numero), que se recomputa más abajo.
    if ('mes_publicacion' in campos) {
        const m = parseInt(campos.mes_publicacion, 10);
        if (m >= 1 && m <= 12) set.mes_publicacion = m; else unset.mes_publicacion = '';
    }
    if ('numero_issue' in campos) {
        const v = String(campos.numero_issue ?? '').trim();
        if (v) set.numero_issue = v; else unset.numero_issue = '';
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
    // DOI (identificador del artículo): se normaliza a «10.xxxx/…» en minúsculas (quita «doi.org/», «doi:»).
    if ('doi' in campos) {
        const bruto = String(campos.doi || '').trim();
        if (!bruto) unset.doi = '';
        else { const ok = normalizarDOI(bruto); if (ok) set.doi = ok; else avisos.push(`DOI inválido (ignorado): ${bruto}`); }
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
    // Corregir un tipo mal detectado (libro/revista/artículo/apuntes/capítulo). No re-aloja el fichero por
    // sí solo: el Conformador/reprocesar re-archiva en la carpeta que corresponda; aquí solo se fija el campo.
    if ('tipo_recurso' in campos && ['libro', 'revista', 'articulo', 'apuntes', 'capitulo', 'software'].includes(campos.tipo_recurso)) set.tipo_recurso = campos.tipo_recurso;

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

    // Recomputa la clave del número si el doc es una REVISTA y cambió mes/año/nº (AAAA-MM → n<nº> → AAAA →
    // sin clave). Un LIBRO nunca lleva clave_numero (año_edicion se envía siempre, así que se limpia si lo tuviera).
    if (tocaClave) {
        const tipoFinal = ('tipo_recurso' in campos && ['libro', 'revista'].includes(campos.tipo_recurso))
            ? campos.tipo_recurso : (docActual && docActual.tipo_recurso);
        if (tipoFinal === 'revista') {
            const base = docActual || {};
            const valor = (k) => (k in set ? set[k] : (k in unset ? undefined : base[k]));
            const clave = claveNumero({ año_edicion: valor('año_edicion'), mes_publicacion: valor('mes_publicacion'), numero_issue: valor('numero_issue') });
            if (clave) set.clave_numero = clave; else unset.clave_numero = '';
        } else if (!('clave_numero' in set)) {
            unset.clave_numero = '';
        }
    }

    // SOPORTE (papel ↔ digital) a mano. Pasar a DIGITAL intenta RECUPERAR el fichero original de la carpeta del
    // documento (p. ej. un PDF escaneado que se catalogó por error como 'papel'): si lo encuentra, fija el
    // formato real (pdf/epub/…) y su nombre_archivo; si no, avisa (se puede subir una copia por Cuarentena).
    if ('soporte' in campos && docActual) {
        const soporte = String(campos.soporte);
        const esPapelAhora = (docActual.formatos || []).includes('papel');
        if (soporte === 'digital' && esPapelAhora) {
            let orig = null;
            try { orig = await archivoOriginal(carpetaDeDoc(docActual)); } catch { /* sin carpeta accesible */ }
            if (orig) {
                const fmt = FORMATO_POR_EXT[path.extname(orig).toLowerCase()] || path.extname(orig).slice(1).toLowerCase() || 'pdf';
                set.formatos = [fmt];
                set.nombre_archivo = path.basename(orig);
                avisos.push(`Formato → digital (${fmt}); fichero original recuperado: «${path.basename(orig)}».`);
            } else {
                avisos.push('No se encontró ningún fichero digital en la carpeta del documento. Sube una copia desde Cuarentena → «ilegibles» para completarlo.');
            }
        } else if (soporte === 'papel' && !esPapelAhora) {
            set.formatos = ['papel'];
            avisos.push('Formato → papel.');
        }
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
