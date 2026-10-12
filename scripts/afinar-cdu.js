/**
 * AFINAR LA CDU de los libros cuya clasificación es más gruesa de lo que permiten sus propios códigos (12-oct).
 *
 * El motor (clasificador-cdu) ahora sabe más sin IA:
 *   · LCC por TRAMOS de número: «Calculus» (QA303) → 517 en vez de 51; Nietzsche (B3311) → 1(430) en vez de 1;
 *     cine (PN1993-1999) → 791.43; marketing (HF5410-5417) → 658.8; redes (TK5105.5-.9) → 004.7…
 *   · Dewey 190-199, filosofía por países: 193 → 1(430), 194 → 1(44)…
 *   · religiones con su división moderna: BP (islam) → 28, BR-BX (cristianismo) → 27…
 * Este script recalcula la CDU de cada libro con ese motor (SIN IA, sin aprender nada) y SOLO la cambia si la nueva
 * AFINA la actual dentro de la MISMA rama (51 → 517 sí; 82 → 791.43 no: eso es otra rama y lo decide la auditoría).
 * Nunca toca una CDU manual ni una de más rango que la deducida (BNE, impresa en el libro). Mueve la carpeta por el
 * camino seguro (reubicarPorCdu + aplicarCambio, con diario para la copia USB) y deja una alerta con la de antes.
 *
 *   sudo docker exec -it gestor-biblioteca node scripts/afinar-cdu.js                     (en seco)
 *   sudo docker exec -it gestor-biblioteca node scripts/afinar-cdu.js --ejecutar --limite 500
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { resolverCDU } from '../src/clasificador-cdu.js';
import { reubicarPorCdu, aplicarCambio, carpetaDeDoc, carpetaExiste } from '../src/mantenimiento/util-mantenimiento.js';
import { cduVacia, rangoFuente, fuenteCduDoc, RANGO_CDU } from '../src/utils/prioridad-cdu.js';
import { progreso } from '../src/utils/progreso-cli.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const LIMITE = Number(arg('--limite')) || 0;

const PROYECCION = {
  titulo: 1, cdu: 1, cdu_fuente: 1, dewey: 1, lcc: 1, cdu_manual: 1, locked: 1, ruta_base: 1, portada: 1, imagenes: 1,
  obra: 1, coleccion: 1, ruta_fija: 1, naturaleza: 1, tipo_recurso: 1, isbn: 1, issn: 1, año_edicion: 1,
  mes_publicacion: 1, alertas_agente: 1, isbn_obra: 1, obra_titulo: 1, volumen_numero: 1,
};

/** El número principal de una CDU, para comparar ramas: «94(430).085» → «94». */
const numero = (cdu) => (String(cdu || '').match(/^\d[\d.]*/) || [''])[0].replace(/\.$/, '');

/**
 * ¿«nueva» AFINA a «actual»? Tiene que CONTENERLA entera y añadir algo: 51 → 517, 1 → 1(430), 82 → 82.09. Si no,
 * cambiaría un detalle por otro: «82-312.9 → 821.111(73)» ganaba la literatura pero PERDÍA el género (ciencia
 * ficción), «598(410) → 598.2» perdía el lugar (seco del 12-oct). Eso no es afinar: lo decide la auditoría.
 */
function afina(actual, nueva) {
  if (!nueva || nueva === actual) return false;
  return String(nueva).startsWith(String(actual)) && Boolean(numero(nueva));
}

async function main() {
  const db = await conectarDB();
  const col = db.collection('biblioteca');
  console.log(`\n🔬 Afinar la CDU con los códigos del propio libro (sin IA) — ${EJECUTAR ? '⚠️  EJECUTAR (mueve carpetas)' : 'DRY-RUN (no toca nada)'}\n`);

  const docs = await col.find(
    { $or: [{ lcc: { $exists: true, $nin: [null, ''] } }, { dewey: { $exists: true, $nin: [null, ''] } }], cdu_manual: { $ne: true } },
    { projection: PROYECCION },
  ).toArray();
  console.log(`   Libros con Dewey o LCC (no manuales): ${docs.length}`);

  const cambios = [];
  const omitidos = {};
  const p1 = progreso(docs.length, 'Calculando');
  for (const d of docs) {
    p1.paso(String(d.titulo || '').slice(0, 30));
    if (cduVacia(d.cdu) || d.locked) { omitidos['sin CDU o bloqueado'] = (omitidos['sin CDU o bloqueado'] || 0) + 1; continue; }
    if (rangoFuente(fuenteCduDoc(d)) > RANGO_CDU.clasificador) { omitidos['CDU de la BNE o impresa'] = (omitidos['CDU de la BNE o impresa'] || 0) + 1; continue; }
    const r = await resolverCDU({ dewey: d.dewey, lcc: d.lcc, titulo: d.titulo, permitirIA: false, aprender: false }).catch(() => null);
    if (afina(d.cdu, r?.cdu)) cambios.push({ doc: d, nueva: r.cdu, via: r.fuente });
  }
  p1.fin();

  const transiciones = {};
  for (const c of cambios) {
    const k = `«${c.doc.cdu}» → «${c.nueva}» (${c.via})`;
    transiciones[k] = (transiciones[k] || 0) + 1;
  }
  console.log(`\n   Se afinarían: ${cambios.length}`);
  for (const [m, n] of Object.entries(omitidos)) console.log(`   No se miran: ${n} — ${m}`);
  console.log('\n   Transiciones:');
  for (const [k, n] of Object.entries(transiciones).sort((a, b) => b[1] - a[1]).slice(0, 50)) console.log(`     ${String(n).padStart(5)}  ${k}`);
  console.log('\n   Ejemplos:');
  for (const c of cambios.slice(0, 15)) console.log(`     [${c.doc.dewey || '-'} · ${c.doc.lcc || '-'}] ${String(c.doc.titulo).slice(0, 50)}  «${c.doc.cdu}» → «${c.nueva}»`);

  if (!EJECUTAR) {
    console.log(`\n   → Para aplicarlo: --ejecutar [--limite N]   (${cambios.length} documentos; mueve sus carpetas)\n`);
    process.exit(0);
  }

  if (LIMITE) cambios.splice(LIMITE);
  // SALVAGUARDA: solo donde vive el árbol CDU (si no, la base se desincronizaría del disco).
  const muestra = cambios.slice(0, 20);
  let vistas = 0;
  for (const c of muestra) if (await carpetaExiste(carpetaDeDoc(c.doc))) vistas++;
  if (muestra.length && vistas < Math.ceil(muestra.length / 2)) {
    console.error(`\n   ❌ Solo ${vistas} de ${muestra.length} carpetas de muestra existen en ESTA máquina: ejecútalo en el NAS.\n`);
    process.exit(1);
  }

  let hechos = 0, movidos = 0, fallos = 0;
  const p2 = progreso(cambios.length, 'Afinando');
  for (const c of cambios) {
    p2.paso(c.doc.titulo);
    try {
      const reub = await reubicarPorCdu(c.doc, c.nueva);
      if (!reub) continue;
      await aplicarCambio(col, c.doc, carpetaDeDoc({ ...c.doc, ...reub.set }), {
        set: { ...reub.set, cdu_fuente: 'clasificador' },
        alertas: [`CDU afinada: «${c.doc.cdu}» → «${c.nueva}» (${c.via}, por sus propios códigos; sin IA).`],
      });
      if (reub.set.ruta_base && reub.set.ruta_base !== c.doc.ruta_base) movidos++;
      hechos++;
    } catch (e) {
      fallos++;
      p2.nota(`⚠️  ${c.doc._id}: ${e.message}`);
    }
  }
  p2.fin();
  console.log(`\n   ✔ Afinados: ${hechos}  ·  carpetas movidas: ${movidos}${fallos ? `  ·  ⚠️  fallos: ${fallos}` : ''}${LIMITE && cambios.length === LIMITE ? '  ·  relanza para la siguiente tanda' : ''}\n`);
  process.exit(fallos ? 1 : 0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
