/**
 * Re-enriquece documentos catalogados con metadatos POBRES (lotes ingestados con las APIs
 * caídas: título = nombre de archivo, autor basura, cdu "00"…) O que se quedaron SIN AUTOR (p. ej. tras
 * limpiar los autores-artefacto [?]_): con un ISBN, rellena el autor/editorial desde OL/Fichero. A diferencia
 * del flujo normal (conservador: nunca sobrescribe), aquí SÍ se sobrescriben los campos no fiables, porque:
 *   (a) sabemos que el registro viene de un lote degradado, y
 *   (b) tenemos un ISBN válido → la búsqueda por ISBN es autoritativa.
 *
 * NO mueve ficheros. Tras corregir el título, des-sella la tarea 're-clasificar-cdu' del
 * documento para que el Conformador lo re-clasifique (y mueva su carpeta) con el título ya bueno.
 * Los sidecars registro.json/.marc.xml se regeneran luego con: node "Test Battery/regenerar-registros.js".
 *
 *   node scripts/re-enriquecer-degradados.js                 (DRY-RUN: informa, no escribe)
 *   node scripts/re-enriquecer-degradados.js --limite 5      (prueba con 5 candidatos)
 *   node scripts/re-enriquecer-degradados.js --ejecutar
 */

import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { buscarMetadatosExternos } from '../src/utils/proveedor-metadatos.js';
import { resolverColeccion } from '../src/utils/colecciones.js';
import { resolverPersona } from '../src/utils/resolver-persona.js';
import { validarISBN, validarISSN, variantesISBN } from '../src/utils/identificadores.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const idxLim = process.argv.indexOf('--limite');
const LIMITE = idxLim >= 0 ? Number(process.argv[idxLim + 1]) : Infinity;
const PAUSA_MS = 1200; // ritmo entre documentos para no saturar las APIs

const norm = (s) => String(s || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '');

/** ¿El título es en realidad basura (nombre de archivo, identificador o un código)? */
function tituloNoFiable(doc) {
    const t = doc.titulo || '';
    if (!t.trim()) return true;
    if (validarISBN(t) || validarISSN(t)) return true;
    if (doc.nombre_archivo && norm(t) === norm(doc.nombre_archivo)) return true;
    // "Code-like": sin espacios, con dígitos y separadores _/-, largo (p.ej. 10.1007_978-…).
    if (!/\s/.test(t) && /\d/.test(t) && /[_\-.]/.test(t) && t.length > 8) return true;
    return false;
}

/** ¿El documento NO tiene autor ni contribuyente? (p. ej. tras limpiar autores-artefacto quedó sin autor). */
function sinAutor(doc) {
    return (!doc.autores || doc.autores.length === 0) && (!doc.contribuciones || doc.contribuciones.length === 0);
}

/** ¿El documento parece degradado (merece re-enriquecerse)? */
function esDegradado(doc) {
    const cduMala = ['00', '0', '000'].includes(String(doc.cdu || ''));
    const apisCaidas = (doc.alertas_agente || []).some(a => /inalcanzable/i.test(a));
    const pendiente = doc.estado_verificacion === 'pendiente';
    return tituloNoFiable(doc) || cduMala || apisCaidas || pendiente || sinAutor(doc);
}

async function resolverAutores(db, nombres) {
    // resolverPersona = check-then-create INSENSIBLE a mayúsculas/acentos → no crea autores duplicados
    // («JEAN TOUCHARD» reusa «Touchard, Jean»), importante tras la limpieza de autores.
    const out = [];
    for (const n of nombres) { const r = await resolverPersona(db, n); if (r?._id) out.push(r._id); }
    return out;
}
async function resolverEditorial(db, nombre) {
    const ex = await db.collection('editoriales').findOne({ nombre });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre })).insertedId;
}

async function main() {
    console.log(`\nRe-enriquecimiento de documentos degradados  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}]`);
    if (Number.isFinite(LIMITE)) console.log(`  límite: ${LIMITE} documento(s)`);
    if (!EJECUTAR) console.log('  ℹ️  DRY-RUN: no se escribe nada.\n'); else console.log('');

    const db = await conectarDB();
    const col = db.collection('biblioteca');

    // Candidatos: con ISBN (ancla fiable) y señal de degradación.
    const todos = await col.find({ isbn: { $exists: true, $ne: null } }).toArray();
    const candidatos = todos.filter(esDegradado).slice(0, LIMITE);
    console.log(`Candidatos (con ISBN + señal de degradación): ${candidatos.length}\n`);

    let mejorados = 0, sinCambios = 0, fallos = 0;

    for (const doc of candidatos) {
        const isbnVar = variantesISBN(doc.isbn);
        if (!isbnVar.length) { sinCambios++; continue; }

        let datos;
        try {
            datos = await buscarMetadatosExternos(doc.titulo || '', '', null, {
                incluirSinopsis: true, incluirCdu: true, isbnsArchivo: isbnVar, idioma: doc.idioma || null,
            });
        } catch (e) {
            console.error(`  ⛔ [${doc._id}] lookup falló: ${e.message}`); fallos++;
            await new Promise(r => setTimeout(r, PAUSA_MS)); continue;
        }

        const garbage = tituloNoFiable(doc);
        const faltaAutor = sinAutor(doc);
        const set = {};
        const nombres = {}; // para el log legible

        // Título/editorial: se SOBRESCRIBEN solo si el título actual es basura.
        if (garbage && datos.titulo) { set.titulo = datos.titulo; nombres.titulo = datos.titulo; }
        if (garbage && datos.editorial) { set.editorial = await resolverEditorial(db, datos.editorial); nombres.editorial = datos.editorial; }
        // Autor: se rellena si el título es basura O si el doc se quedó SIN autor (aunque el título sea bueno).
        if ((garbage || faltaAutor) && datos.autores?.length) { set.autores = await resolverAutores(db, datos.autores); nombres.autores = datos.autores; }

        // Gaps (siempre que falten): sinopsis, año, idioma, palabras clave, colección.
        if (datos.sinopsis && !doc.sinopsis) set.sinopsis = datos.sinopsis;
        if (datos.año_edicion && !doc.año_edicion) set.año_edicion = datos.año_edicion;
        if (datos.idioma && !doc.idioma) set.idioma = datos.idioma;
        if (datos.categorias?.length && !(doc.palabras_clave?.length)) set.palabras_clave = datos.categorias;
        if (datos.coleccion_nombre && !doc.coleccion) {
            const { _id } = await resolverColeccion(db, datos.coleccion_nombre, set.editorial || (typeof doc.editorial !== 'string' ? doc.editorial : null));
            set.coleccion = _id; set.coleccion_nombre = datos.coleccion_nombre;
            if (datos.coleccion_numero) set.coleccion_numero = String(datos.coleccion_numero);
        }

        if (Object.keys(set).length === 0) {
            console.log(`  ·  [${doc._id}] "${doc.titulo}" — sin mejora disponible`);
            sinCambios++;
            await new Promise(r => setTimeout(r, PAUSA_MS)); continue;
        }

        // Si corregimos el título, des-sellar re-clasificar-cdu para que el Conformador
        // re-clasifique y mueva la carpeta con el título ya bueno.
        if (set.titulo) {
            set['mantenimiento.re-clasificar-cdu'] = 0;
            set.mantenimiento_firma = 'pendiente-re-enriquecido';
        }
        set.fecha_actualizacion = new Date();
        set.alertas_agente = [...(doc.alertas_agente || []), 'Metadatos re-enriquecidos desde ISBN (lote degradado).'];

        const resumen = Object.keys(nombres).length
            ? Object.entries(nombres).map(([k, v]) => `${k}="${Array.isArray(v) ? v.join(', ') : v}"`).join(' · ')
            : Object.keys(set).filter(k => !['fecha_actualizacion', 'alertas_agente'].includes(k)).join(', ');
        console.log(`  ${EJECUTAR ? '✅' : '↪️'} [${doc._id}] "${doc.titulo}"  →  ${resumen}`);

        if (EJECUTAR) {
            try { await col.updateOne({ _id: doc._id }, { $set: set }); }
            catch (e) { console.error(`     ⛔ update falló: ${e.message}`); fallos++; continue; }
        }
        mejorados++;
        await new Promise(r => setTimeout(r, PAUSA_MS));
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('RESUMEN');
    console.log(`  ${EJECUTAR ? 'Mejorados' : 'A mejorar'}:   ${mejorados}`);
    console.log(`  Sin mejora:    ${sinCambios}`);
    console.log(`  Fallos:        ${fallos}`);
    if (mejorados && EJECUTAR) {
        console.log(`\n  Siguiente: el Conformador re-clasificará los de título corregido.`);
        console.log(`  Y regenera los sidecars:  node "Test Battery/regenerar-registros.js"`);
    }
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
