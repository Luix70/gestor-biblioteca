#!/usr/bin/env node
/**
 * FIX B — reclasifica los LIBROS mal clasificados como revista → libro. SOLO BD (no mueve ficheros).
 * DRY-RUN por defecto; aplica con --ejecutar. Reversible (cambios de campos en BD).
 *
 * Detecta un libro disfrazado de revista por señales FUERTES (poco riesgo de tocar una revista real):
 *   · el nombre de archivo lleva un ISBN válido (libros nombrados por su ISBN: Springer, etc.),
 *   · el título es un ARTEFACTO del productor del PDF (marca de agua),
 *   · ya está colocado como TOMO DE LIBRO en obras/<obra>/vol-N (una revista no va ahí),
 *   · trae Dewey/LCC y NO tiene señal de número de revista (numero_issue / mes_publicacion).
 *
 * Acción por documento: tipo_recurso='libro' (+ recupera el ISBN del nombre si faltaba) y lo DESVINCULA
 * de su cabecera de revista si la tenía (quita obra/clave_numero). Al final borra las cabeceras (obras
 * tipo:'revista') que quedaron VACÍAS. NO mueve ficheros: el fichero sigue accesible por su ruta_base;
 * recolocarlo en libros/ es opcional y se puede hacer después sin riesgo.
 *
 * Uso (en el contenedor del NAS):
 *   docker exec gestor-biblioteca node scripts/reclasificar-libros.js              # DRY-RUN
 *   docker exec gestor-biblioteca node scripts/reclasificar-libros.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { validarISBN, variantesISBN } from '../src/utils/identificadores.js';
import { esTituloArtefacto } from '../src/utils/parsear-nombre.js';

const EJECUTAR = process.argv.includes('--ejecutar');

// ISBN incrustado en un nombre de archivo (réplica del extractor de lector-pdf, tolerante a sufijos).
function isbnDeNombre(nombre) {
    if (!nombre) return null;
    const re = /(?:ISBN(?:-1[03])?:?\s*)?((?:97[89][-\s]?)?(?:[0-9][-\s]?){9}[0-9Xx])/g;
    let m;
    while ((m = re.exec(nombre)) !== null) { const v = validarISBN(m[1]); if (v) return v; }
    return null;
}

function razonLibro(doc) {
    const isbn = isbnDeNombre(doc.nombre_archivo);
    if (isbn) return { libro: true, isbn, motivo: 'ISBN en el nombre' };
    if (esTituloArtefacto(doc.titulo)) return { libro: true, isbn: null, motivo: 'título-artefacto (marca del productor)' };
    if (/\/obras\//.test(doc.ruta_base || '')) return { libro: true, isbn: null, motivo: 'tomo de libro en obras/' };
    if ((doc.dewey || doc.lcc) && !doc.numero_issue && !doc.mes_publicacion) return { libro: true, isbn: null, motivo: 'Dewey/LCC sin nº de revista' };
    return { libro: false };
}

async function main() {
    console.log(`📚 Fix B — reclasificar libros mal clasificados como revista — ${EJECUTAR ? '⚠ EJECUTAR' : 'DRY-RUN (no cambia nada)'}`);
    const db = await conectarDB();
    const bib = db.collection('biblioteca'), obras = db.collection('obras');

    const revistas = await bib.find({ tipo_recurso: 'revista' }).toArray();
    const aLibro = [];
    for (const doc of revistas) { const r = razonLibro(doc); if (r.libro) aLibro.push({ doc, ...r }); }

    const cuenta = {};
    for (const a of aLibro) cuenta[a.motivo] = (cuenta[a.motivo] || 0) + 1;
    console.log(`\nRevistas examinadas: ${revistas.length}  ·  detectadas como LIBRO: ${aLibro.length}`);
    for (const [k, n] of Object.entries(cuenta)) console.log(`  · ${String(n).padStart(4)} × ${k}`);

    if (!EJECUTAR) {
        console.log('\nMuestra (hasta 50):');
        for (const a of aLibro.slice(0, 50)) console.log(`  [${a.motivo}] ${a.doc.titulo || a.doc.nombre_archivo}`);
        console.log('\n(DRY-RUN; añade --ejecutar para aplicar)');
        process.exit(0);
    }

    const cabIds = new Set((await obras.find({ tipo: 'revista' }, { projection: { _id: 1 } }).toArray()).map(o => String(o._id)));
    let reclasif = 0, desvinc = 0;
    for (const a of aLibro) {
        const set = { tipo_recurso: 'libro' };
        if (a.isbn && !a.doc.isbn) set.isbn = variantesISBN(a.isbn).find(v => v.length === 13) || a.isbn;
        const unset = {};
        if (a.doc.obra && cabIds.has(String(a.doc.obra))) { unset.obra = ''; unset.clave_numero = ''; desvinc++; }
        const upd = { $set: set };
        if (Object.keys(unset).length) upd.$unset = unset;
        await bib.updateOne({ _id: a.doc._id }, upd);
        reclasif++;
    }

    // Borrar cabeceras (obras tipo:'revista') que quedaron sin miembros tras desvincular los libros.
    let cabBorradas = 0;
    for (const id of cabIds) {
        if (await bib.countDocuments({ obra: new ObjectId(id) }) === 0) { await obras.deleteOne({ _id: new ObjectId(id) }); cabBorradas++; }
    }

    console.log(`\nReclasificados a libro: ${reclasif}  ·  desvinculados de cabecera: ${desvinc}  ·  cabeceras vacías borradas: ${cabBorradas}`);
    const restoLibrosEnRevista = await bib.countDocuments({ tipo_recurso: 'revista' });
    console.log(`Revistas restantes en BD: ${restoLibrosEnRevista}`);
    process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
