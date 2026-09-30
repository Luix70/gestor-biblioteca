/**
 * MODERNIZAR CDU — pasa a notación MODERNA las CDU guardadas en notación antigua y recoloca sus carpetas.
 *
 * Por qué (30-sep): la BNE (y los CIP de libros viejos) dan la literatura con la notación anterior a los años 90:
 * 820 inglesa, 840 francesa, 860 española… La pasada de reidentificar-sin-isbn las aplicó tal cual (tienen prioridad
 * sobre lo deducido) y el árbol quedó partido: 8/821/821.111… y 8/820/820(73)-31"19". Desde ahora toda CDU se
 * traduce al entrar (src/utils/cdu-moderna.js); este script arregla las que ya estaban guardadas.
 * También recoloca las publicaciones juveniles de la BNE (087.5:82…), que se UBICAN ahora por su parte literaria
 * (decisión del usuario, opción A) — su CDU guardada no cambia.
 *
 * Dos fases, para que las carpetas compartidas (varias versiones del mismo libro) se muevan de una vez:
 *   1. BASE: cdu y cdu_autoridad → notación moderna (y la caché equivalencias_cdu).
 *   2. DISCO: cada documento afectado cuya carpeta ya no refleja su ficha se mueve a su árbol (con verificación
 *      de la copia; si la carpeta vieja no está en disco, no se toca). Nada se borra.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/modernizar-cdu.js              (DRY-RUN: qué cambiaría)
 *   sudo docker exec -t gestor-biblioteca node scripts/modernizar-cdu.js --ejecutar
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { modernizarCDU, esCduAntigua } from '../src/utils/cdu-moderna.js';
import { carpetaReflejaFicha, recolocarSegunCdu, aplicarCambio, carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');

const db = await conectarDB();
const col = db.collection('biblioteca');

// Prefiltro en Mongo (rápido): alguna faceta que empiece por 8xx, o una publicación especial 087… El filtro fino
// (qué números son de verdad notación antigua) lo hace esCduAntigua en memoria.
const RE_CANDIDATA = /(^|:)\s*(8[2-8]\d|087)/;
const filtro = { $or: [{ cdu: RE_CANDIDATA }, { cdu_autoridad: RE_CANDIDATA }] };

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · CDU en notación antigua y publicaciones juveniles\n`);

// ─── FASE 1: la base ─────────────────────────────────────────────────────────────────────────────────────────
const afectados = [];
let cambiadas = 0;
const p1 = progreso(await col.countDocuments(filtro), 'Fase 1 · base');
for await (const d of col.find(filtro, { projection: { cdu: 1, cdu_autoridad: 1, titulo: 1 } })) {
    p1.paso(d.titulo);
    const set = {};
    if (esCduAntigua(d.cdu)) set.cdu = modernizarCDU(d.cdu);
    if (esCduAntigua(d.cdu_autoridad)) set.cdu_autoridad = modernizarCDU(d.cdu_autoridad);
    // Solo 087…: la CDU no cambia, pero la carpeta sí (se ubica por la parte literaria).
    const juvenil = /^\s*087/.test(String(d.cdu || ''));
    if (Object.keys(set).length || juvenil) afectados.push(d._id);
    if (!Object.keys(set).length) continue;
    cambiadas++;
    if (cambiadas <= 40 || !EJECUTAR) {
        p1.nota(`${set.cdu ? `cdu ${d.cdu} → ${set.cdu}` : `cdu_autoridad ${d.cdu_autoridad} → ${set.cdu_autoridad}`}  «${String(d.titulo || '').slice(0, 40)}»`);
    }
    if (EJECUTAR) {
        await col.updateOne({ _id: d._id }, {
            $set: { ...set, fecha_actualizacion: new Date() },
            $push: { alertas_agente: `CDU pasada a notación moderna (scripts/modernizar-cdu): ${d.cdu} → ${set.cdu || d.cdu}.` },
        });
    }
}
p1.fin();

// La caché de equivalencias: una CDU aprendida en notación antigua se serviría a los libros siguientes.
let equivalencias = 0;
for await (const e of db.collection('equivalencias_cdu').find({ cdu: RE_CANDIDATA }, { projection: { cdu: 1 } })) {
    if (!esCduAntigua(e.cdu)) continue;
    equivalencias++;
    if (EJECUTAR) await db.collection('equivalencias_cdu').updateOne({ _id: e._id }, { $set: { cdu: modernizarCDU(e.cdu) } });
}
console.log(`\nFase 1: ${cambiadas} documento(s) con CDU antigua${EJECUTAR ? ' corregidos' : ''} · ${equivalencias} equivalencia(s) de la caché.\n`);

// ─── FASE 2: el disco ────────────────────────────────────────────────────────────────────────────────────────
let movidos = 0, sinCarpeta = 0, fallos = 0, enSuSitio = 0;
const p2 = progreso(afectados.length, EJECUTAR ? 'Fase 2 · recolocando' : 'Fase 2 · revisando');
for (const _id of afectados) {
    const doc = await col.findOne({ _id });
    p2.paso(doc?.titulo);
    if (!doc?.ruta_base) continue;
    // En seco la fase 1 no se aplicó: se mira dónde iría con la CDU ya modernizada.
    const comoQuedaria = EJECUTAR ? doc : { ...doc, cdu: modernizarCDU(doc.cdu) };
    if (carpetaReflejaFicha(comoQuedaria)) { enSuSitio++; continue; }
    if (!EJECUTAR) {
        p2.nota(`↪️  ${String(comoQuedaria.cdu).padEnd(24)} ${doc.ruta_base}  «${String(doc.titulo || '').slice(0, 40)}»`);
        continue;
    }
    try {
        const reub = await recolocarSegunCdu(doc);
        if (!reub?.set?.ruta_base) { sinCarpeta++; continue; }
        const carpeta = reub.carpetaNueva || carpetaDeDoc({ ...doc, ...reub.set });
        await aplicarCambio(col, doc, carpeta, {
            set: reub.set,
            alertas: ['Carpeta recolocada: CDU en notación moderna / publicación juvenil por su parte literaria (scripts/modernizar-cdu).', ...(reub.alertas || [])],
        });
        await regenerarSidecarsDoc(db, { ...doc, ...reub.set }, carpeta).catch(() => {});
        await indexarDoc(db, doc._id).catch(() => {});
        movidos++;
    } catch (e) {
        fallos++;
        p2.nota(`⛔ ${doc._id}: ${e.message}`);
    }
}
const tiempo = p2.fin();

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} · ${tiempo} ===`);
console.log(`  CDU pasadas a notación moderna : ${cambiadas}`);
console.log(`  equivalencias de la caché      : ${equivalencias}`);
console.log(`  carpetas ${EJECUTAR ? 'recolocadas' : 'que se recolocarían'}${EJECUTAR ? '    ' : ''}  : ${EJECUTAR ? movidos : afectados.length - enSuSitio}`);
if (EJECUTAR) console.log(`  sin carpeta en disco (no se tocan): ${sinCarpeta} · fallos: ${fallos}`);
console.log(`  ya en su sitio                 : ${enSuSitio}`);
if (!EJECUTAR) console.log('\n▶ Repite con --ejecutar para aplicarlo.');
process.exit(fallos ? 1 : 0);
