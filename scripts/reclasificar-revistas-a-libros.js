// ── RECLASIFICAR "revistas" que en realidad son LIBROS (colección-revista de 1 miembro) ─────────────────
// Repara el daño del bug "nombre fechado → revista" (un release de ebook como «Apress.Pro.Android.Games.
// Dec.2009.pdf» u «Oxford.Extreme.Politics.Jan.2010.eBook-ELOHiM.pdf» se catalogaba como REVISTA, perdía su
// ISBN y creaba una cabecera/colección falsa de 1 solo miembro). Selecciona SOLO los que tienen SEÑAL FUERTE
// de libro (bloque CIP en las alertas, o prefijo de EDITORIAL en el nombre) y NINGÚN ISSN. Para cada uno:
//   1) copia su fichero original al Inbox con un sidecar override { tipo_recurso: 'libro' } (garantiza que se
//      re-catalogue como LIBRO aunque el nombre siga siendo fechado) preservando ubicación/valoración/nsfw/nfc;
//   2) BORRA el doc-revista y recicla su carpeta CDU a la Papelera (recuperable);
//   3) BORRA la colección-revista que queda vacía.
// El Vigilante (ACTIVO) re-cataloga cada fichero del Inbox como el libro que es, re-alojado en libros/ y con
// su ISBN recuperado del CIP. Las REVISTAS de verdad (sin CIP/editorial) NO se tocan.
//
// SEGURO: dry-run por defecto (solo lista). --ejecutar aplica. --limite N para hacerlo por tandas.
// ⚠ Antes de --ejecutar: haz COPIA DE SEGURIDAD de la BD. Requiere el Vigilante ACTIVO para re-catalogar.
//   docker exec gestor-biblioteca node scripts/reclasificar-revistas-a-libros.js            (lista, dry-run)
//   docker exec gestor-biblioteca node scripts/reclasificar-revistas-a-libros.js --ejecutar --limite 10
import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { carpetaDeDoc, EXT_DOC } from '../src/mantenimiento/util-mantenimiento.js';
import { eliminarDocumento } from '../src/utils/reproceso.js';
import { esTituloArtefacto } from '../src/utils/parsear-nombre.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const LIMITE = (() => { const i = process.argv.indexOf('--limite'); return i >= 0 ? Number(process.argv[i + 1]) || Infinity : Infinity; })();

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');
const existe = (p) => fs.access(p).then(() => true).catch(() => false);

// Prefijos de EDITORIAL (releases de ebook) → señal fuerte de libro (igual que el diagnóstico).
const PREFIJO_EDITOR = /^(apress|wrox|o'?reilly|packt(pub)?|springer|wiley|manning|oxford|cambridge|mcgraw|sams|addison|microsoft\.?press|no\.?starch|prentice|morgan|elsevier|academic\.?press|crc|routledge|course\.technology)\b/i;

// ¿El miembro es un LIBRO mal clasificado como revista? Señal fuerte: bloque CIP, o prefijo de editorial en el
// nombre/colección. Y NINGÚN ISSN (un ISSN real sería revista de verdad).
function esLibroMalClasificado(doc, col) {
    const alertas = (doc.alertas_agente || []).join(' | ');
    if (doc.issn || col.issn) return false;                       // tiene ISSN → revista real
    const cip = /bloque CIP/i.test(alertas);
    const prefijo = PREFIJO_EDITOR.test(doc.nombre_archivo || '') || PREFIJO_EDITOR.test(col.nombre || '');
    return cip || prefijo;
}

// Sidecar override para forzar LIBRO + preservar lo curado (NO la colección, que es falsa).
function sidecarLibro(doc) {
    const s = { tipo_recurso: 'libro' };
    if (doc.ubicacion && (doc.ubicacion.ambito || doc.ubicacion.estanteria)) s.ubicacion = doc.ubicacion;
    if (doc.valoracion) s.valoracion = doc.valoracion;
    if (doc.nsfw) s.nsfw = true;
    if (doc.nfc && (doc.nfc.uid || doc.nfc.fecha_vinculacion)) { s._id = String(doc._id); s.nfc = doc.nfc; } // preserva identidad si hay NFC
    return s;
}

async function main() {
    const db = await conectarDB();
    const bib = db.collection('biblioteca');

    const cols = await db.collection('colecciones').aggregate([
        { $match: { tipo: 'revista' } },
        { $lookup: { from: 'biblioteca', localField: '_id', foreignField: 'coleccion', as: 'm' } },
        { $match: { $expr: { $eq: [{ $size: '$m' }, 1] } } },
        { $project: { nombre: 1, issn: 1, miembro: { $arrayElemAt: ['$m', 0] } } },
    ]).toArray();

    const objetivos = cols.filter(c => c.miembro && esLibroMalClasificado(c.miembro, c));
    console.log(`Colecciones-revista de 1 miembro: ${cols.length} · LIBROS mal clasificados a reparar: ${objetivos.length}${EJECUTAR ? '' : ' (dry-run)'}\n`);

    await fs.mkdir(DIR_INBOX, { recursive: true }).catch(() => {});
    let hechos = 0, saltados = 0;
    for (const c of objetivos) {
        if (hechos >= LIMITE) break;
        const doc = c.miembro;
        const nombre = doc.nombre_archivo || '';
        const esDoc = nombre && EXT_DOC.includes(path.extname(nombre).toLowerCase());
        const origen = esDoc ? path.join(carpetaDeDoc(doc), nombre) : null;
        const ok = origen && await existe(origen);
        const artef = esTituloArtefacto(doc.titulo || '');
        console.log(`  ${EJECUTAR ? '→' : '·'} «${c.nombre.slice(0, 48)}»  [${nombre.slice(0, 46)}]${ok ? '' : '  ⚠ SIN FICHERO'}${artef ? '  (título-artefacto)' : ''}`);
        if (!ok) { saltados++; continue; }
        if (!EJECUTAR) { hechos++; continue; }

        try {
            // 1) copiar al Inbox + sidecar override (forzar libro, preservar lo curado).
            let destino = path.join(DIR_INBOX, nombre);
            if (await existe(destino)) destino = path.join(DIR_INBOX, `${path.basename(nombre, path.extname(nombre))} (relib ${String(doc._id).slice(-6)})${path.extname(nombre)}`);
            await fs.copyFile(origen, destino);
            await fs.writeFile(destino + '.meta.json', JSON.stringify(sidecarLibro(doc), null, 2));
            // 2) borrar el doc-revista + reciclar su carpeta CDU (recuperable).
            await eliminarDocumento(db, doc);
            // 3) borrar la colección-revista que queda vacía.
            const quedan = await bib.countDocuments({ coleccion: c._id });
            if (quedan === 0) await db.collection('colecciones').deleteOne({ _id: c._id });
            console.log(`      ✔ al Inbox como «${path.basename(destino)}» · doc borrado · colección ${quedan === 0 ? 'eliminada' : `conserva ${quedan}`}`);
            hechos++;
        } catch (e) {
            console.error(`      ✗ error: ${e.message}`);
            saltados++;
        }
    }

    console.log(`\n${EJECUTAR ? `Reparados: ${hechos}` : `A reparar: ${hechos}`}${saltados ? ` · saltados (sin fichero/error): ${saltados}` : ''}.`);
    if (!EJECUTAR) console.log('Dry-run. Con --ejecutar se aplica (⚠ BACKUP antes; Vigilante ACTIVO para re-catalogar). --limite N para tandas.');
    else console.log('Los ficheros están en el Inbox: el Vigilante (activo) los re-cataloga como libros con su ISBN.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
