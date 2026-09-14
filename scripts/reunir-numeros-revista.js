/**
 * REUNIR LOS NÚMEROS DE UNA REVISTA EN SU CABECERA (reparación).
 *
 * Para cuando los números de una misma publicación acabaron repartidos en «cabeceras» de UN solo número. Caso real
 * (14-sep-2026, 2DArtist 2012): la guía de la carpeta se recicló tras ingerir el primer número (fallo ya corregido
 * en vigilante · limpiarInbox) y los seis siguientes, sin cabecera ni pista de tipo, crearon cada uno su propia
 * cabecera («2DAIssue.074.»…), con el título sacado del nombre del fichero y CDU 000.
 *
 * Sobre los números de revista cuyo FICHERO casa con --fichero:
 *   · los cuelga de la cabecera --cabecera (la crea si no existe) con su clave de número, y BORRA las cabeceras que
 *     se queden vacías — el mismo camino que «Agrupar en colección» del panel (agrupar-docs · asignarColeccion);
 *   · un título que sea solo un resto del nombre del fichero pasa a «Cabecera nº 73 (enero 2012)» (revistas ·
 *     tituloDeNumero); un título de verdad se conserva;
 *   · la CDU GENÉRICA (vacía/0/000) pasa a la de --cdu o, sin él, a la de la CABECERA si ya tiene una buena,
 *     MOVIENDO la carpeta, por el camino del Conformador (reubicarPorCdu + aplicarCambio: diario de movimientos
 *     para la copia USB, sidecars al día, SIN cdu_manual — es una CDU automática), y la cabecera la toma también.
 *     Una CDU que ya no sea genérica no se toca.
 *
 *   node scripts/reunir-numeros-revista.js --cabecera "2DArtist" --fichero "2DAIssue" --cdu 741   (DRY-RUN)
 *   … --ejecutar   → en el NAS, donde están las carpetas:
 *   sudo docker exec gestor-biblioteca node scripts/reunir-numeros-revista.js --cabecera "2DArtist" --fichero "2DAIssue" --cdu 741 --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { asignarColeccion } from '../src/utils/agrupar-docs.js';
import { tituloDeNumero, tituloEsDelFichero } from '../src/utils/revistas.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { reubicarPorCdu, aplicarCambio, carpetaDeDoc, carpetaExiste } from '../src/mantenimiento/util-mantenimiento.js';

const args = process.argv.slice(2);
const valor = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const CABECERA = valor('--cabecera');
const FICHERO = valor('--fichero');
const CDU = valor('--cdu');
const EJECUTAR = args.includes('--ejecutar');

const generica = (c) => ['', '0', '000'].includes(String(c || '').trim());
const escaparRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function main() {
    if (!CABECERA || !FICHERO) {
        console.error('Uso: node scripts/reunir-numeros-revista.js --cabecera "<nombre>" --fichero "<parte del nombre de fichero>" [--cdu <cdu>] [--ejecutar]');
        process.exit(1);
    }
    const db = await conectarDB();
    const bib = db.collection('biblioteca');
    const cols = db.collection('colecciones');

    const docs = await bib.find({ tipo_recurso: 'revista', nombre_archivo: new RegExp(escaparRegex(FICHERO), 'i') })
        .sort({ 'año_edicion': 1, mes_publicacion: 1, numero_issue: 1 }).toArray();
    if (!docs.length) { console.log(`\n   Ningún número de revista con «${FICHERO}» en el nombre del fichero.\n`); process.exit(0); }

    const cab = await cols.findOne({ nombre: CABECERA, tipo: 'revista' }, { collation: { locale: 'es', strength: 1 } });
    // Sin --cdu, la de la CABECERA si ya no es genérica: la corrige el primer número que entra con la CDU que dio el
    // agente al inspeccionar la carpeta, y así los números viejos quedan con la misma, sin adivinarla aquí.
    const cduObjetivo = CDU || (cab && !generica(cab.cdu) ? cab.cdu : null);
    const idsCab = new Set(docs.map((d) => String(d.coleccion || '')).filter(Boolean));
    const nombresCab = await cols.find({ _id: { $in: docs.map((d) => d.coleccion).filter(Boolean) } }, { projection: { nombre: 1 } }).toArray();

    console.log(`\n📰 Reunir ${docs.length} número(s) («${FICHERO}») en la cabecera «${CABECERA}»`
        + `${cab ? ` (existe${cab.issn ? `, ISSN ${cab.issn}` : ''}${cab.cdu ? `, CDU ${cab.cdu}` : ''})` : ' (NUEVA)'}`
        + `${cduObjetivo ? ` · CDU para los números con 000: ${cduObjetivo}${CDU ? '' : ' (la de la cabecera)'}` : ' · sin CDU que aplicar (usa --cdu)'}`);
    console.log(`   Hoy repartidos en ${idsCab.size} cabecera(s): ${nombresCab.map((c) => `«${c.nombre}»`).join(', ')}\n`);

    const plan = docs.map((d) => ({
        doc: d,
        mueveCabecera: !cab || String(d.coleccion || '') !== String(cab._id),
        titulo: tituloEsDelFichero(d.titulo, d.nombre_archivo) ? tituloDeNumero(CABECERA, d) : null,
        cdu: cduObjetivo && generica(d.cdu) ? cduObjetivo : null,
    }));
    for (const p of plan) {
        const cambios = [p.mueveCabecera && `cabecera «${p.doc.coleccion_nombre || '—'}» → «${CABECERA}»`,
            p.titulo && `título «${p.doc.titulo}» → «${p.titulo}»`, p.cdu && `CDU ${p.doc.cdu || '—'} → ${p.cdu} (mueve la carpeta)`].filter(Boolean);
        console.log(`   · ${p.doc.nombre_archivo}\n       ${cambios.length ? cambios.join('\n       ') : 'ya estaba bien'}`);
    }

    if (!EJECUTAR) {
        console.log('\n   (DRY-RUN: no se ha tocado nada. Para aplicarlo: --ejecutar, en el NAS si hay cambios de CDU.)\n');
        process.exit(0);
    }

    // SALVAGUARDA (como reparar-cdu-contaminada): mover carpetas exige estar donde viven. Fuera del NAS,
    // reubicarPorCdu cambiaría la ruta en Mongo SIN mover la carpeta y base y disco quedarían desincronizados.
    if (plan.some((p) => p.cdu)) {
        let vistas = 0;
        for (const p of plan) if (await carpetaExiste(carpetaDeDoc(p.doc))) vistas++;
        if (vistas < Math.ceil(plan.length / 2)) {
            console.error(`\n   ❌ Solo ${vistas} de ${plan.length} carpetas existen en ESTA máquina: ejecútalo en el NAS (ver cabecera).\n`);
            process.exit(1);
        }
    }

    // 1) Cabecera: el camino de «Agrupar en colección» (clave de número + inventario + borra las que se vacían).
    const r = await asignarColeccion(db, docs.map((d) => String(d._id)), cab ? { coleccionId: String(cab._id) } : { nombre: CABECERA, tipo: 'revista' });
    if (!r.ok) { console.error(`\n   ❌ ${r.motivo}\n`); process.exit(1); }
    console.log(`\n   ✔ ${r.n} número(s) en «${r.coleccion.nombre}»; cabeceras vaciadas y borradas: ${r.vaciadas}`);

    // 2) Título y CDU, documento a documento (releído: la cabecera acaba de cambiar).
    let hechos = 0, movidos = 0, fallos = 0;
    for (const p of plan) {
        try {
            const doc = await bib.findOne({ _id: p.doc._id });
            const set = {};
            const alertas = [];
            if (p.titulo) { set.titulo = p.titulo; alertas.push(`Título del nombre del fichero → «${p.titulo}» (reunir-numeros-revista).`); }
            let carpeta = carpetaDeDoc(doc);
            if (p.cdu) {
                const reub = await reubicarPorCdu(doc, p.cdu);
                if (reub) {
                    Object.assign(set, reub.set);
                    alertas.push(...reub.alertas);
                    carpeta = carpetaDeDoc({ ...doc, ...reub.set });
                    if (reub.set.ruta_base && reub.set.ruta_base !== doc.ruta_base) movidos++;
                }
            }
            if (Object.keys(set).length) await aplicarCambio(bib, doc, carpeta, { set, alertas });
            await indexarDoc(db, doc._id);   // el título entra en la búsqueda
            hechos++;
        } catch (e) {
            fallos++;
            console.warn(`   ⚠️  ${p.doc.nombre_archivo}: ${e.message}`);
        }
    }

    // 3) La cabecera toma la CDU si la suya es genérica.
    if (cduObjetivo) {
        const c = await cols.findOne({ _id: new ObjectId(r.coleccion._id) });
        if (c && generica(c.cdu)) {
            await cols.updateOne({ _id: c._id }, { $set: { cdu: cduObjetivo, fecha_actualizacion: new Date() } });
            console.log(`   ✔ CDU de la cabecera: ${c.cdu || '(vacía)'} → ${cduObjetivo}`);
        }
    }
    console.log(`   ✔ Números actualizados: ${hechos} · carpetas movidas: ${movidos}${fallos ? ` · ⚠️ fallos: ${fallos}` : ''}\n`);
    process.exit(fallos ? 1 : 0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
