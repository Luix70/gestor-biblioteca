/**
 * BACKFILL DE SINOPSIS POR ISBN (sin IA).
 *
 * El 37% del catálogo se quedó sin sinopsis porque ninguna acción la rellenaba: la única tarea que la tocaba
 * (`re-enriquecer-degradados`) solo entra en documentos DEGRADADOS, y una ingesta sin IA deja documentos
 * limpios pero vacíos de sinopsis. Ver `src/utils/completar-sinopsis.js`.
 *
 * ESTRATEGIA RECOMENDADA, en dos tiempos, para no tentar a los límites de uso de las APIs:
 *   1) --solo-fichero --ejecutar     → drena el grueso contra el volcado LOCAL. Sin red, sin freno, rápido.
 *   2) --ejecutar                    → el resto sale a OpenLibrary/Google Books, con pausa entre documentos.
 *
 *   node scripts/completar-sinopsis.js                          (DRY-RUN: informa, no escribe)
 *   node scripts/completar-sinopsis.js --solo-fichero --ejecutar
 *   node scripts/completar-sinopsis.js --ejecutar --limite 500 --pausa 400
 *
 * Opciones:
 *   --ejecutar        aplica los cambios (sin él solo informa)
 *   --solo-fichero    SOLO el volcado local: cero red, cero riesgo de bloqueo
 *   --limite N        procesa como mucho N documentos (por defecto, todos)
 *   --pausa MS        espera entre documentos al usar APIs (por defecto 250 ms; ignorado con --solo-fichero)
 *   --forzar          reemplaza la sinopsis existente en vez de solo rellenar huecos
 *   --id <id>         un único documento
 *
 * REANUDABLE: sin --forzar solo toca documentos que SIGUEN sin sinopsis, así que se puede cortar y relanzar
 * cuantas veces haga falta sin repetir trabajo.
 */
import 'dotenv/config';
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { completarSinopsisDoc } from '../src/utils/completar-sinopsis.js';

const args = process.argv.slice(2);
const tiene = (f) => args.includes(f);
const valor = (f, def = null) => { const i = args.indexOf(f); return i > -1 && args[i + 1] ? args[i + 1] : def; };

const EJECUTAR = tiene('--ejecutar');
const SOLO_FICHERO = tiene('--solo-fichero');
const FORZAR = tiene('--forzar');
const LIMITE = Number(valor('--limite', 0)) || 0;
const PAUSA = Number(valor('--pausa', 250));
const ID = valor('--id');

const SIN_SINOPSIS = { $or: [{ sinopsis: { $exists: false } }, { sinopsis: null }, { sinopsis: '' }] };

/** Progreso en una línea, con ritmo y tiempo restante (regla del proyecto para toda tarea masiva). */
function progreso(i, total, t0, st) {
    const transcurrido = (Date.now() - t0) / 1000;
    const ritmo = i / Math.max(transcurrido, 0.001);
    const restante = ritmo > 0 ? Math.round((total - i) / ritmo) : 0;
    const mm = String(Math.floor(restante / 60)).padStart(2, '0');
    const ss = String(restante % 60).padStart(2, '0');
    process.stdout.write(
        `\r   ${i}/${total}  ·  ✔ ${st.recuperada}  ·  sin fuente ${st.sin_fuente}  ·  ${ritmo.toFixed(1)}/s  ·  faltan ${mm}:${ss}   `,
    );
}

async function main() {
    const db = await conectarDB();
    const col = db.collection('biblioteca');

    const filtro = ID
        ? { _id: new ObjectId(ID) }
        : { isbn: { $exists: true, $nin: [null, ''] }, ...(FORZAR ? {} : SIN_SINOPSIS) };

    const total = await col.countDocuments(filtro);
    const aProcesar = LIMITE ? Math.min(LIMITE, total) : total;

    console.log('\n📝 Recuperación de sinopsis por ISBN (sin IA)');
    console.log(`   Modo:      ${EJECUTAR ? '⚠️  EJECUTAR (escribe en la base)' : 'DRY-RUN (no escribe nada)'}`);
    console.log(`   Fuentes:   ${SOLO_FICHERO ? 'SOLO Fichero local (offline, sin red)' : 'Fichero local → OpenLibrary → Google Books'}`);
    if (!SOLO_FICHERO) console.log(`   Pausa:     ${PAUSA} ms entre documentos (freno anti-bloqueo)`);
    if (FORZAR) console.log('   ⚠️  FORZAR: reemplaza sinopsis existentes');
    console.log(`   Candidatos: ${total.toLocaleString('es')}${LIMITE ? ` (se procesarán ${aProcesar})` : ''}\n`);

    if (!total) { console.log('   Nada que hacer.\n'); process.exit(0); }

    const st = { recuperada: 0, ya_tenia: 0, sin_isbn: 0, sin_fuente: 0 };
    const ejemplos = [];
    const t0 = Date.now();
    let i = 0;

    // Cursor por lotes: 16.000 documentos no caben cómodos en memoria de golpe en el Atom del NAS.
    const cursor = col.find(filtro, { projection: { titulo: 1, isbn: 1, sinopsis: 1, idioma: 1 } }).batchSize(200);

    for await (const doc of cursor) {
        if (LIMITE && i >= LIMITE) break;
        try {
            const { estado, sinopsis } = await completarSinopsisDoc(db, doc, { aplicar: EJECUTAR, forzar: FORZAR, soloFichero: SOLO_FICHERO });
            st[estado]++;
            // En dry-run interesa VER lo que se guardaría: es la única forma de juzgar si la fuente sirve.
            if (estado === 'recuperada' && ejemplos.length < 5) {
                ejemplos.push(`"${(doc.titulo || '').slice(0, 45)}" → ${String(sinopsis).slice(0, 110)}…`);
            }
        } catch { st.sin_fuente++; }
        i++;
        if (i % 10 === 0) progreso(i, aProcesar, t0, st);   // el cierre lo pinta una vez al salir del bucle
        if (!SOLO_FICHERO && PAUSA > 0) await new Promise((r) => setTimeout(r, PAUSA));
    }
    progreso(i, aProcesar, t0, st);

    const mins = Math.round((Date.now() - t0) / 60000);
    console.log('\n\n── Resumen ──────────────────────────────────────────');
    console.log(`   Procesados:   ${i.toLocaleString('es')}  (${mins} min)`);
    console.log(`   ✔ Sinopsis recuperada: ${st.recuperada.toLocaleString('es')}`);
    console.log(`   Sin fuente:            ${st.sin_fuente.toLocaleString('es')}`);
    if (st.ya_tenia) console.log(`   Ya tenían:             ${st.ya_tenia.toLocaleString('es')}`);
    if (st.sin_isbn) console.log(`   Sin ISBN:              ${st.sin_isbn.toLocaleString('es')}  (usa antes «🔎 Extraer ISBN»)`);

    if (ejemplos.length) {
        console.log('\n   Ejemplos de lo que se guardaría:');
        for (const e of ejemplos) console.log(`     · ${e}`);
    }
    if (!EJECUTAR && st.recuperada) console.log('\n   → Para aplicarlo: añade --ejecutar');
    if (EJECUTAR && SOLO_FICHERO && st.sin_fuente) {
        console.log('\n   → Los que no estaban en el Fichero pueden intentarse contra las APIs:');
        console.log('     node scripts/completar-sinopsis.js --ejecutar --pausa 400');
    }
    console.log('');
    process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
