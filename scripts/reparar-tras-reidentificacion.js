/**
 * REPARAR TRAS LA PASADA DE REIDENTIFICACIÓN (29/30-sep) — todas las reparaciones, en orden, en un solo comando.
 *
 * La pasada `reidentificar-sin-isbn --todos --edicion-por-elegir --ejecutar` corrió con el código de antes de los
 * arreglos del 30-sep. Este script aplica esos arreglos a lo que ya hizo. En seco por defecto; `--ejecutar` aplica.
 *
 *   Fase 1 · COLABORADORES de ediciones sin confirmar: la pasada dio el traductor/ilustrador… de la autoridad a
 *            ediciones PROVISIONALES o DUDOSAS. Son de la edición y no valen hasta confirmarla (regla del usuario):
 *            se quitan los que añadió la pasada (según su diario `deshacer[]`), nunca los que el libro ya tenía.
 *   Fase 2 · EDITORIALES FALSAS impuestas: donde la pasada puso un distribuidor («Distribooks Inc» en lugar de
 *            «Hodder Children's Books») o un marcador («Unknown»), se devuelve la editorial anterior.
 *   Fase 3 · EDITORIALES CON PUNTUACIÓN («Valdemar,», «Ultramar.», «Alianza, etc»): se fusionan con la de nombre
 *            limpio (el nombre sucio queda como grafía alternativa: nada se pierde) o, si no existe, se renombran.
 *            No se fusiona una que tenga datos propios (logo, web…): se lista para hacerlo a mano.
 *   Fase 4 · scripts/modernizar-cdu.js         (CDU en notación antigua → moderna + carpetas; juveniles 087.5)
 *   Fase 5 · scripts/editoriales-por-prefijo.js (editorial por el prefijo del ISBN: solo huecos y basura)
 *   Fase 6 · scripts/reidentificar-sin-isbn.js --edicion-por-elegir  (falsos «❓ otro título», ISBN probable y
 *            datos de la obra en las que sigan sin decidir). Larga (horas): en seco se salta, salvo
 *            `--con-reidentificar`.
 *   (Aquí se añadirán las reparaciones de lo que muestre el log final de la pasada.)
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/reparar-tras-reidentificacion.js              (en seco)
 *   sudo docker exec -t gestor-biblioteca node scripts/reparar-tras-reidentificacion.js --ejecutar
 *   … --desde 2026-09-29   solo lo que hizo la pasada desde esa fecha (por defecto, el 29-sep)
 *   … --fases 1,2,3        solo esas fases
 *
 * Antes de --ejecutar: copia de la base (scripts/copia-base.js o CopiaBase.ps1). Conformador y campañas apagados.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { esEditorialFalsa, limpiarNombreEditorial } from '../src/utils/editoriales-falsas.js';
import { fusionarEditoriales } from '../src/utils/gestion-editoriales.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const CON_REIDENTIFICAR = args.includes('--con-reidentificar');
const DESDE = new Date(arg('--desde') || '2026-09-29');
const FASES = arg('--fases') ? new Set(arg('--fases').split(',').map((x) => Number(x.trim()))) : null;
const toca = (n) => !FASES || FASES.has(n);

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = await conectarDB();
const col = db.collection('biblioteca');
const resumen = [];

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · reparaciones tras la pasada de reidentificación (desde ${DESDE.toISOString().slice(0, 10)})\n`);

// Documentos que la pasada tocó: los que tienen una entrada «reidentificar» en su diario desde DESDE.
const filtroPasada = { deshacer: { $elemMatch: { origen: 'reidentificar', fecha: { $gte: DESDE } } } };
const entradasDe = (doc) => (doc.deshacer || []).filter((e) => e.origen === 'reidentificar' && new Date(e.fecha) >= DESDE);

/** Anota en el diario, regenera sidecars e índice. */
async function guardar(doc, update, antes, alerta) {
    const ahora = new Date();
    await col.updateOne({ _id: doc._id }, {
        ...update,
        $set: { ...(update.$set || {}), fecha_actualizacion: ahora },
        $push: { deshacer: { fecha: ahora, origen: 'reparar-tras-reidentificacion', antes }, alertas_agente: alerta },
    });
    const nuevo = await col.findOne({ _id: doc._id });
    await regenerarSidecarsDoc(db, nuevo, carpetaDeDoc(nuevo)).catch(() => {});
    await indexarDoc(db, doc._id).catch(() => {});
}

// ─── FASE 1: colaboradores de ediciones sin confirmar ─────────────────────────────────────────────────────────
if (toca(1)) {
    const filtro = { ...filtroPasada, $or: [{ isbn_provisional: true }, { isbn_dudoso: true }], 'contribuciones.0': { $exists: true } };
    let n = 0;
    const p = progreso(await col.countDocuments(filtro), 'Fase 1 · colaboradores');
    for await (const doc of col.find(filtro)) {
        p.paso(doc.titulo);
        // ¿Los añadió la pasada? Su diario guarda cómo estaban ANTES: si entonces no había ninguno, son de ella.
        const añadidos = entradasDe(doc).some((e) => e.antes && 'contribuciones' in e.antes && !(e.antes.contribuciones?.length));
        if (!añadidos) continue;
        n++;
        p.nota(`${doc._id} · quitar ${doc.contribuciones.length} colaborador(es) · «${String(doc.titulo || '').slice(0, 50)}»`);
        if (EJECUTAR) {
            await guardar(doc, { $unset: { contribuciones: '' } }, { contribuciones: doc.contribuciones },
                'Colaboradores quitados: los había dado la autoridad a una edición PROVISIONAL o DUDOSA (son de la edición; volverán al confirmarla).');
        }
    }
    p.fin();
    resumen.push(`Fase 1 · colaboradores quitados de ediciones sin confirmar: ${n}`);
}

// ─── FASE 2: editoriales falsas impuestas por la pasada ───────────────────────────────────────────────────────
if (toca(2)) {
    const nombrePorId = new Map();
    for await (const e of db.collection('editoriales').find({}, { projection: { nombre: 1 } })) nombrePorId.set(String(e._id), e.nombre);
    const filtro = { ...filtroPasada, editorial: { $exists: true } };
    let n = 0;
    const p = progreso(await col.countDocuments(filtro), 'Fase 2 · editoriales falsas');
    for await (const doc of col.find(filtro, { projection: { editorial: 1, deshacer: 1, titulo: 1, alertas_agente: 1, ruta_base: 1 } })) {
        p.paso(doc.titulo);
        const actual = nombrePorId.get(String(doc.editorial));
        if (!actual || !esEditorialFalsa(actual)) continue;
        // La editorial que tenía ANTES de la pasada (la entrada más antigua del periodo que la cambió).
        const entrada = entradasDe(doc).find((e) => e.antes && 'editorial' in e.antes);
        if (!entrada) continue;
        const anterior = entrada.antes.editorial;
        const nombreAnterior = anterior ? nombrePorId.get(String(anterior)) : null;
        if (nombreAnterior && esEditorialFalsa(nombreAnterior)) continue;   // antes también era falsa: nada que devolver
        n++;
        p.nota(`${doc._id} · «${actual}» → ${nombreAnterior ? `«${nombreAnterior}»` : '(sin editorial)'} · «${String(doc.titulo || '').slice(0, 45)}»`);
        if (EJECUTAR) {
            const update = anterior ? { $set: { editorial: anterior } } : { $unset: { editorial: '' } };
            await guardar(doc, update, { editorial: doc.editorial },
                `Editorial «${actual}» (un distribuidor o marcador, no una editorial) devuelta a ${nombreAnterior ? `«${nombreAnterior}»` : 'vacía'}.`);
        }
    }
    p.fin();
    resumen.push(`Fase 2 · editoriales falsas devueltas a la anterior: ${n}`);
}

// ─── FASE 3: editoriales con puntuación en el nombre ─────────────────────────────────────────────────────────
if (toca(3)) {
    const colEd = db.collection('editoriales');
    const todas = await colEd.find({}).toArray();
    const porNombre = new Map(todas.map((e) => [e.nombre, e]));
    const PROPIOS = new Set(['_id', 'nombre', 'nombres_alternativos', 'fecha_creacion', 'fecha_actualizacion']);
    let fusionadas = 0, renombradas = 0, aMano = 0;
    const sucias = todas.filter((e) => e.nombre && limpiarNombreEditorial(e.nombre) && limpiarNombreEditorial(e.nombre) !== e.nombre);
    const p = progreso(sucias.length, 'Fase 3 · nombres de editorial');
    for (const e of sucias) {
        p.paso(e.nombre);
        const limpio = limpiarNombreEditorial(e.nombre);
        const destino = porNombre.get(limpio);
        const conDatos = Object.keys(e).some((k) => !PROPIOS.has(k));
        if (destino && conDatos) { aMano++; p.nota(`✋ «${e.nombre}» tiene datos propios: fusiónala a mano con «${limpio}»`); continue; }
        if (destino) {
            fusionadas++;
            p.nota(`«${e.nombre}» → se fusiona con «${limpio}»`);
            if (EJECUTAR) await fusionarEditoriales(db, destino._id, [e._id]);
        } else {
            renombradas++;
            p.nota(`«${e.nombre}» → se renombra «${limpio}»`);
            if (EJECUTAR) {
                const alt = [...new Set([...(e.nombres_alternativos || []), e.nombre])];
                await colEd.updateOne({ _id: e._id }, { $set: { nombre: limpio, nombres_alternativos: alt, fecha_actualizacion: new Date() } });
                porNombre.set(limpio, { ...e, nombre: limpio });
            }
        }
    }
    p.fin();
    resumen.push(`Fase 3 · editoriales con puntuación: ${fusionadas} fusionadas, ${renombradas} renombradas, ${aMano} a mano`);
    if (EJECUTAR && fusionadas) resumen.push('         (los sidecars de sus libros los pone al día la campaña «sidecars»)');
}

// ─── FASES 4-6: los scripts de cada arreglo, en orden ────────────────────────────────────────────────────────
function lanzar(script, extra = []) {
    return new Promise((resolve) => {
        const argumentos = [path.join(RAIZ, 'scripts', script), ...extra, ...(EJECUTAR ? ['--ejecutar'] : [])];
        console.log(`\n▶▶ ${script} ${[...extra, ...(EJECUTAR ? ['--ejecutar'] : [])].join(' ')}\n`);
        const hijo = spawn(process.execPath, argumentos, { stdio: 'inherit', cwd: RAIZ });
        hijo.on('exit', (codigo) => resolve(codigo ?? 1));
    });
}
if (toca(4)) resumen.push(`Fase 4 · modernizar-cdu: ${(await lanzar('modernizar-cdu.js')) === 0 ? 'bien' : 'con fallos (mira su log)'}`);
if (toca(5)) resumen.push(`Fase 5 · editoriales-por-prefijo: ${(await lanzar('editoriales-por-prefijo.js')) === 0 ? 'bien' : 'con fallos (mira su log)'}`);
if (toca(6)) {
    if (!EJECUTAR && !CON_REIDENTIFICAR) {
        resumen.push('Fase 6 · reidentificar --edicion-por-elegir: saltada en seco (tarda horas; --con-reidentificar para verla)');
    } else {
        resumen.push(`Fase 6 · reidentificar --edicion-por-elegir: ${(await lanzar('reidentificar-sin-isbn.js', ['--edicion-por-elegir'])) === 0 ? 'bien' : 'con fallos (mira su log)'}`);
    }
}

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} ===`);
for (const l of resumen) console.log(`  ${l}`);
if (!EJECUTAR) console.log('\n▶ Repite con --ejecutar para aplicarlo (antes: copia de la base; Conformador y campañas apagados).');
process.exit(0);
