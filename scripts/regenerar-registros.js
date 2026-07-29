/**
 * Regenera los sidecars registro.json y registro.marc.xml de cada documento a partir de
 * MongoDB (la fuente de verdad). Resuelve las referencias ObjectId (autores, editorial,
 * contribuciones) a sus NOMBRES para que el registro sea legible, igual que en la ingesta, y
 * marca `sidecars_fecha` en el doc (para que la campaña de fondo «sidecars» sepa que están al día).
 *
 * Los sidecars son la COPIA EN DISCO desde la que se puede reconstruir la base de datos ante una
 * catástrofe: tras correcciones masivas (re-enriquecimiento, cambios de CDU/autores/colección…)
 * hay que regenerarlos para que reflejen el estado real.
 *
 *   node scripts/regenerar-registros.js                         (DRY-RUN: cuenta, no escribe)
 *   node scripts/regenerar-registros.js --ejecutar              (regenera TODOS)
 *   node scripts/regenerar-registros.js --solo-desactualizados  (solo los modificados tras su sidecar)
 *   node scripts/regenerar-registros.js --solo-desactualizados --ejecutar
 *
 * Reutiliza el MISMO regenerador que la campaña de fondo (utils/registro.js·regenerarSidecarsDoc),
 * así que el backfill y la campaña producen sidecars idénticos. Recomendado tras el primer despliegue
 * (con --ejecutar) para sembrar `sidecars_fecha` y dejar la campaña casi vacía en régimen normal.
 */

import 'dotenv/config';
import '../src/config.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { conectarDB } from '../src/database.js';
import { regenerarSidecarsDoc, FILTRO_SIDECARS_DESACTUALIZADOS } from '../src/utils/registro.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolverDir = (envVar, def) => {
    const v = process.env[envVar] || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const DIR_CDU = resolverDir('PATH_CDU', 'CDU');
const EJECUTAR = process.argv.includes('--ejecutar');
const SOLO_STALE = process.argv.includes('--solo-desactualizados');

/** Carpeta absoluta del documento a partir de su ruta_base (/recursos/...). */
function carpetaDeDoc(doc) {
    if (!doc.ruta_base) return null;
    const rel = doc.ruta_base.startsWith('/recursos/') ? doc.ruta_base.slice('/recursos/'.length) : doc.ruta_base;
    return path.join(DIR_CDU, ...rel.split('/'));
}
const existe = (p) => fs.access(p).then(() => true).catch(() => false);

async function main() {
    console.log(`\nRegeneración de sidecars registro.json / registro.marc.xml  [${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'}${SOLO_STALE ? ' · solo desactualizados' : ''}]`);
    console.log(`  PATH_CDU: ${DIR_CDU}`);
    if (!EJECUTAR) console.log('  ℹ️  DRY-RUN: no se escribe nada.\n'); else console.log('');

    const db = await conectarDB();
    const col = db.collection('biblioteca');

    // Mapas id→nombre de autores y editoriales (UNA consulta cada uno, en memoria): resolver los nombres de
    // cada documento SIN 2 consultas por doc a Atlas (lo que hacía lento el backfill). Contribuciones usan el
    // mismo mapa de autores (persona ∈ autores). Se pasan ya resueltos a regenerarSidecarsDoc.
    const autorMap = new Map();
    for (const a of await db.collection('autores').find({}, { projection: { nombre: 1 } }).toArray()) autorMap.set(String(a._id), a.nombre);
    const editorialMap = new Map();
    for (const e of await db.collection('editoriales').find({}, { projection: { nombre: 1 } }).toArray()) editorialMap.set(String(e._id), e.nombre);
    const nombresDe = (doc) => ({
        autores: (doc.autores || []).map((id) => autorMap.get(String(id)) || String(id)),
        editorial: doc.editorial ? (editorialMap.get(String(doc.editorial)) || null) : null,
        contribuciones: (doc.contribuciones || []).filter((c) => c && c.persona).map((c) => {
            const nombre = autorMap.get(String(c.persona));
            return nombre ? { rol: c.rol, nombre, persona: String(c.persona) } : { rol: c.rol, nombre: `⚠ ${String(c.persona)}`, persona: String(c.persona), desconocido: true };
        }),
    });

    const filtro = SOLO_STALE ? FILTRO_SIDECARS_DESACTUALIZADOS : {};
    // Proyección mínima para el recorrido (regenerarSidecarsDoc re-lee lo que necesita por _id). Con _id + los
    // campos de ruta/fecha basta y no carga ~28k documentos completos en memoria.
    const total = await col.countDocuments(filtro);
    console.log(`Documentos a revisar: ${total}${SOLO_STALE ? ' (desactualizados)' : ''}\n`);
    if (!total) { console.log('Nada que hacer.'); process.exit(0); }

    // Progreso con ETA: se refresca una línea (\r) cada ~50 docs o cada ~2 s, para saber el ritmo real.
    const t0 = Date.now();
    let ultimoPint = 0;
    const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
    const pintar = (hechos) => {
        const seg = (Date.now() - t0) / 1000;
        const rit = hechos / Math.max(seg, 0.001);
        const eta = rit > 0 ? (total - hechos) / rit : 0;
        const pct = ((hechos / total) * 100).toFixed(1);
        process.stdout.write(`\r  ${hechos}/${total} (${pct}%) · ${rit.toFixed(1)}/s · transcurrido ${mmss(seg)} · ETA ${mmss(eta)}   `);
    };

    let escritos = 0, sinCarpeta = 0, fallos = 0, hechos = 0;
    // Cursor (no carga todo en memoria); si el proceso se interrumpe, lo ya sellado no se repite al relanzar.
    const cursor = col.find(filtro);
    for await (const doc of cursor) {
        const carpeta = carpetaDeDoc(doc);
        // DRY-RUN: solo comprueba si hay carpeta y contaría; no escribe ni sella.
        if (!EJECUTAR) {
            if (carpeta && await existe(carpeta)) escritos++; else sinCarpeta++;
        } else {
            try {
                const r = await regenerarSidecarsDoc(db, doc, carpeta, { nombres: nombresDe(doc) }); // escribe los 2 sidecars + sella
                if (r.ok) escritos++; else sinCarpeta++;                  // sinCarpeta también queda sellado (drena la cola)
            } catch (e) {
                process.stdout.write('\n');
                console.error(`  ⛔ [${doc._id}] "${doc.titulo}": ${e.message}`);
                fallos++;
            }
        }
        hechos++;
        if (hechos - ultimoPint >= 50) { pintar(hechos); ultimoPint = hechos; }
    }
    pintar(hechos);
    process.stdout.write('\n');

    console.log(`\n${'═'.repeat(60)}`);
    console.log('RESUMEN');
    console.log(`  ${EJECUTAR ? 'Sidecars regenerados' : 'A regenerar'}: ${escritos}`);
    console.log(`  Docs sin carpeta:     ${sinCarpeta}`);
    if (EJECUTAR) console.log(`  Fallos:               ${fallos}`);
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
