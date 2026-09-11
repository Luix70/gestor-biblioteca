/**
 * REPARACIÓN DE LOS DOCUMENTOS QUE HEREDARON UNA CDU DE UNA EQUIVALENCIA DE CLASE CONTAMINADA.
 *
 * Contexto (ver instructions.txt · «CDU: contaminación de la caché aprendida por clase LCC»): una decisión de
 * la IA sobre UN libro, aprendida a nivel de CLASE LCC, se aplicó a TODOS los libros de esa clase. El motor ya
 * está arreglado (resolverCDU) y la caché curada (auditar-equivalencias-cdu --reparar); esto corrige los
 * DOCUMENTOS que ya se habían guardado con la CDU mala.
 *
 * SOLO SE REPARA LO QUE SE SABE REPARAR. Cada exclusión de abajo existe porque, medida sobre la base real,
 * «repararlo» lo habría EMPEORADO:
 *   · QA75-76 es INFORMÁTICA (Access, Android, XMPP…). Su «004.8» no es exacto, pero acierta la clase
 *     principal (004); pasarlo a «51» lo alejaría más.
 *   · «QA» a SECAS, sin número: no se sabe si es matemática o informática («The R Book», «Fuzzy Clustering»).
 *   · GN: GN1-296 es antropología FÍSICA (el «572» aprendido es correcto) y GN301+ etnología («39»). Mitad y
 *     mitad: no se puede arreglar en bloque.
 *
 * CÓMO SE APLICA — y por qué NO con editarDocumento: ese camino marca `cdu_manual:true` siempre que cambia la
 * CDU, porque está pensado para ediciones a mano. Aquí son CDU AUTOMÁTICAS: marcarlas como manuales mentiría
 * sobre su origen y las BLINDARÍA contra cualquier mejora futura (p. ej. la CDU por carpeta del agente de
 * estructura). Se usa el camino del Conformador (re-clasificar-cdu): reubicarPorCdu (mueve la carpeta y ANOTA
 * el movimiento en el diario, así la copia USB lo replica con un `mv`) + aplicarCambio (Mongo + sidecars).
 *
 * La CDU nueva la calcula resolverCDU SIN IA — el mismo motor ya arreglado que clasificará lo que entre a
 * partir de ahora, para que lo reparado quede coherente con lo nuevo.
 *
 *   node scripts/reparar-cdu-contaminada.js              (DRY-RUN: enseña qué cambiaría, no toca nada)
 *   node scripts/reparar-cdu-contaminada.js --ejecutar   (mueve carpetas: haz copia de seguridad antes)
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { resolverCDU, claseLcc } from '../src/clasificador-cdu.js';
import { reubicarPorCdu, aplicarCambio, carpetaDeDoc, carpetaExiste } from '../src/mantenimiento/util-mantenimiento.js';

const EJECUTAR = process.argv.includes('--ejecutar');

/** Número de la signatura tras las letras de clase: «QA-0076.3» → 76.3; «QA» a secas → NaN. */
function numeroLcc(lcc) {
    const resto = String(lcc || '').trim().toUpperCase().replace(/^[A-Z]{1,3}/, '').replace(/^[^0-9]+/, '');
    return parseFloat(resto);
}

// Los incidentes CONOCIDOS, tal como los encontró la auditoría. Se fijan a mano (y no se releen de la caché)
// porque la caché ya está curada: el valor contaminado ya no está ahí para deducirlo.
const INCIDENTES = [
    {
        clase: 'QA', cduMala: '004.8:004.832.2',
        excluir: (d) => {
            const n = numeroLcc(d.lcc);
            if (Number.isNaN(n)) return '«QA» sin número: ¿matemática o informática?';
            if (n >= 75 && n < 77) return 'QA75-76 es informática: su 004 acierta la clase';
            return null;
        },
    },
    { clase: 'QC', cduMala: '519.6' },          // física clasificada como análisis numérico
    { clase: 'BL', cduMala: '141.333:2' },      // religión como ocultismo
    { clase: 'HG', cduMala: '658.2' },          // finanzas como gestión de locales
    { clase: 'JZ', cduMala: '340' },            // relaciones internacionales como derecho
    { clase: 'HN', cduMala: '610.8' },          // problemas sociales como medicina
    { clase: 'U', cduMala: '929:355.02' },      // ciencia militar como biografía
    // GN: NO — ver cabecera (mitad antropología física, mitad etnología).
];

let ultimoAviso = 0;
function progreso(i, total, t0) {
    if (Date.now() - ultimoAviso < 1500 && i < total) return;
    ultimoAviso = Date.now();
    const s = (Date.now() - t0) / 1000, ritmo = i / Math.max(s, 0.001);
    const falta = Math.round((total - i) / Math.max(ritmo, 0.001));
    process.stdout.write(`\r   ${i}/${total}  ·  ${ritmo.toFixed(1)}/s  ·  faltan ${Math.floor(falta / 60)}:${String(falta % 60).padStart(2, '0')}   `);
}

async function main() {
    const db = await conectarDB();
    const col = db.collection('biblioteca');

    console.log('\n🩹 Reparación de CDU heredadas de equivalencias contaminadas');
    console.log(`   Modo: ${EJECUTAR ? '⚠️  EJECUTAR (mueve carpetas)' : 'DRY-RUN (no toca nada)'}\n`);

    // 1) Selección: CDU mala exacta + clase LCC EXACTA (misma regla que la búsqueda) + exclusiones.
    const plan = [];
    const omitidos = {};
    for (const inc of INCIDENTES) {
        const candidatos = await col.find(
            { cdu: inc.cduMala, lcc: { $regex: `^${inc.clase}`, $options: 'i' } },
            { projection: { titulo: 1, cdu: 1, dewey: 1, lcc: 1, cdu_manual: 1, locked: 1, ruta_base: 1,
                portada: 1, imagenes: 1, obra: 1, coleccion: 1, ruta_fija: 1, naturaleza: 1, tipo_recurso: 1,
                isbn: 1, issn: 1, año_edicion: 1, mes_publicacion: 1, alertas_agente: 1, isbn_obra: 1,
                obra_titulo: 1, volumen_numero: 1 } },
        ).toArray();

        for (const d of candidatos) {
            if (claseLcc(d.lcc) !== inc.clase) continue;   // «UA…» no es la clase «U»
            const motivo = d.cdu_manual ? 'CDU fijada a mano' : d.locked ? 'documento bloqueado'
                : inc.excluir ? inc.excluir(d) : null;
            if (motivo) { omitidos[motivo] = (omitidos[motivo] || 0) + 1; continue; }
            plan.push({ doc: d, inc });
        }
    }

    console.log(`   A reparar: ${plan.length} documento(s)`);
    for (const [m, n] of Object.entries(omitidos)) console.log(`   Se dejan como están: ${n} — ${m}`);
    console.log('');

    // 2) CDU nueva de cada uno con el motor ya arreglado, sin IA.
    const cambios = [];
    let sinSolucion = 0;
    for (const p of plan) {
        const r = await resolverCDU({ dewey: p.doc.dewey, lcc: p.doc.lcc, titulo: p.doc.titulo, permitirIA: false }).catch(() => null);
        const nueva = r?.cdu;
        // Si el motor no da nada, o devolviera la misma CDU mala, no se toca: mejor igual que peor.
        if (!nueva || nueva === '000' || nueva === p.inc.cduMala) { sinSolucion++; continue; }
        cambios.push({ ...p, nueva });
    }

    // Resumen por transición (lo que de verdad hay que juzgar antes de ejecutar).
    const transiciones = {};
    for (const c of cambios) {
        const k = `${c.inc.clase}: «${c.inc.cduMala}» → «${c.nueva}»`;
        transiciones[k] = (transiciones[k] || 0) + 1;
    }
    console.log('   Transiciones:');
    for (const [k, n] of Object.entries(transiciones).sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}  ${k}`);
    if (sinSolucion) console.log(`\n   Sin CDU calculable (se dejan): ${sinSolucion}`);

    console.log('\n   Ejemplos:');
    for (const c of cambios.slice(0, 8)) console.log(`     [${c.doc.lcc}] ${String(c.doc.titulo).slice(0, 52)}  →  ${c.nueva}`);

    if (!EJECUTAR) {
        console.log(`\n   → Para aplicarlo: --ejecutar   (${cambios.length} documentos; mueve sus carpetas)\n`);
        process.exit(0);
    }

    // 3) SALVAGUARDA: ¿estamos en la máquina que TIENE las carpetas?
    // Si no (p. ej. lanzado desde el PC, donde DIR_CDU es un árbol de desarrollo), reubicarPorCdu cae en su modo
    // «sin carpeta en disco → solo BD»: cambiaría la ruta_base en Mongo SIN mover la carpeta real del NAS, y
    // base y disco quedarían desincronizados en cientos de documentos — sin un solo error. Se exige ver en disco
    // la carpeta de la mayoría de una muestra antes de tocar nada.
    const muestra = cambios.slice(0, 20);
    let vistas = 0;
    for (const c of muestra) if (await carpetaExiste(carpetaDeDoc(c.doc))) vistas++;
    if (muestra.length && vistas < Math.ceil(muestra.length / 2)) {
        console.error(`\n   ❌ Solo ${vistas} de ${muestra.length} carpetas de muestra existen en ESTA máquina.`);
        console.error('      Esto hay que ejecutarlo donde vive el árbol CDU, o se desincronizaría la base del disco:');
        console.error('      sudo docker exec gestor-biblioteca node scripts/reparar-cdu-contaminada.js --ejecutar\n');
        process.exit(1);
    }

    // 4) Aplicar por el camino del Conformador: SIN cdu_manual.
    console.log('');
    const t0 = Date.now();
    let hechos = 0, fallos = 0, movidos = 0;
    for (const c of cambios) {
        try {
            const reub = await reubicarPorCdu(c.doc, c.nueva);
            if (reub) {
                const docNuevo = { ...c.doc, ...reub.set };
                await aplicarCambio(col, c.doc, carpetaDeDoc(docNuevo), {
                    set: reub.set,
                    alertas: [`CDU reparada: «${c.inc.cduMala}» venía de una equivalencia de clase contaminada (lcc:${c.inc.clase.toLowerCase()}); → «${c.nueva}».`],
                });
                if (reub.set.ruta_base && reub.set.ruta_base !== c.doc.ruta_base) movidos++;
                hechos++;
            }
        } catch (e) {
            fallos++;
            console.warn(`\n   ⚠️  ${c.doc._id}: ${e.message}`);
        }
        progreso(hechos + fallos, cambios.length, t0);
    }

    console.log(`\n\n   ✔ Reparados: ${hechos}  ·  carpetas movidas: ${movidos}${fallos ? `  ·  ⚠️  fallos: ${fallos}` : ''}\n`);
    process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
