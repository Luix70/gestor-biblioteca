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
 *   · TK5101-5105 son telecomunicaciones y redes de ordenadores: su «004.738» es correcto.
 *
 * SEGUNDA TANDA (30-sep): LAS CLASES QUE LA TABLA APLAZA A LA IA. Historia (D, E, F y sus subclases) y las
 * literaturas de varias lenguas (P, PA, PQ, PT, PG…) no tienen entrada en la tabla —cada libro necesita su
 * decisión—, así que la salvaguarda «la caché afina la tabla, no la contradice» no las cubría, y la decisión de UN
 * libro se sirvió a toda la clase: «lcc:e → 972.5» a 115 libros de historia de EE. UU., «pa → 791.43» (clásicos
 * grecolatinos como cine), «d → 93.04.2», «f → 918.3», «pq → 821.13»… El Conformador, además, movió allí libros
 * que ya estaban bien. Estos incidentes no se escriben a mano: se LEEN de la caché (toda equivalencia de CLASE,
 * aprendida de la IA, de una clase aplazada). Para cada documento afectado, por este orden:
 *   1. La CDU que TENÍA antes de que el Conformador se la cambiara (queda en su alerta «CDU actualizada: "X" →
 *      "972.5" [clasificador:cache:lcc]»): se le devuelve.
 *   2. Si no, la que dé el motor ya arreglado SIN IA (su Dewey, o lo aprendido por clase + número).
 *   3. Si no, se deja como está, se apunta en la selección «CDU por reclasificar (clase LCC contaminada)» y se
 *      le quita el sello de la tarea re-clasificar-cdu: el Conformador la recalculará con IA, ya libro a libro.
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
 * TERCERA TANDA (9-oct): LAS QUE RECHAZA LA REGLA DEL MOTOR. La auditoría de la CDU (scripts/auditar-cdu.js) halló
 * miles de libros heredando equivalencias que la salvaguarda dejaba pasar: LCC de clase entera que «afinaban» la tabla
 * («b → 141.4», 467 libros de filosofía como librepensamiento; «qh → 573.016», «hm → 316.774:32»…) y Dewey amplios
 * («973 → 39(73)», historia de EE. UU. como etnología; «193 → 19.035», una división que no existe; «520 → 522.2»).
 * El motor ya no las usa ni las aprende (clasificador-cdu·equivalenciaUsable); los incidentes se LEEN de la caché con
 * esa MISMA regla, así que lo que se repara es exactamente lo que el motor ya no haría. Mismo orden: la CDU de antes
 * (su alerta), la del motor sin IA, o a la selección para que el Conformador la reclasifique. Mismas exclusiones por
 * clase (GN, QA75-76, TK5101-5105). Con --solo-regla se hace solo esta tanda; --copia <sello> lee además las
 * equivalencias de una copia de la base (logs/copias-bd/<sello>) por si la caché viva ya se corrigió; --limite N
 * aplica solo N cambios por pasada (reanudable: relanzar sigue con los que quedan).
 *
 *   node scripts/reparar-cdu-contaminada.js              (DRY-RUN: enseña qué cambiaría, no toca nada)
 *   node scripts/reparar-cdu-contaminada.js --ejecutar   (mueve carpetas: haz copia de seguridad antes)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { resolverCDU, claseLcc, unidadLcc, cduBienFormada, buscarEquivalenciaExterna, equivalenciaUsable } from '../src/clasificador-cdu.js';
import { reubicarPorCdu, aplicarCambio, carpetaDeDoc, carpetaExiste } from '../src/mantenimiento/util-mantenimiento.js';
import { modernizarCDU, cduParaUbicar } from '../src/utils/cdu-moderna.js';
import { cduVacia, rangoFuente, fuenteCduDoc, RANGO_CDU } from '../src/utils/prioridad-cdu.js';
import { crearSeleccion } from '../src/utils/selecciones.js';
import { progreso } from '../src/utils/progreso-cli.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const SOLO_REGLA = process.argv.includes('--solo-regla');   // solo la tercera tanda

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
    {
        clase: 'TK', cduMala: '004.738',        // electrotecnia como redes de ordenadores (30-sep)
        excluir: (d) => {
            const n = numeroLcc(d.lcc);
            if (Number.isNaN(n)) return '«TK» sin número: ¿electrotecnia o redes?';
            if (n >= 5101 && n < 5106) return 'TK5101-5105 son telecomunicaciones y redes: su 004.738 es correcto';
            return null;
        },
    },
    // GN: NO — ver cabecera (mitad antropología física, mitad etnología).
];

const PROYECCION = {
    titulo: 1, cdu: 1, cdu_fuente: 1, dewey: 1, lcc: 1, cdu_manual: 1, locked: 1, ruta_base: 1,
    portada: 1, imagenes: 1, obra: 1, coleccion: 1, ruta_fija: 1, naturaleza: 1, tipo_recurso: 1,
    isbn: 1, issn: 1, año_edicion: 1, mes_publicacion: 1, alertas_agente: 1, isbn_obra: 1,
    obra_titulo: 1, volumen_numero: 1,
};

/**
 * Incidentes de la SEGUNDA TANDA, leídos de la caché: equivalencias aprendidas para una CLASE entera (solo letras)
 * de las que la tabla aplaza a la IA. El motor ya no las consulta (busca por clase + número).
 */
async function incidentesDeClasesAplazadas(db) {
    const lista = [];
    const aprendidas = await db.collection('equivalencias_cdu')
        .find({ sistema_origen: 'lcc', fuente: { $ne: 'Manual' } }).toArray();
    for (const e of aprendidas) {
        if (!/^[a-z]{1,3}$/.test(String(e.codigo_origen || ''))) continue;      // solo las de clase entera
        if (await buscarEquivalenciaExterna('lcc', e.codigo_origen)) continue;  // la tabla la cubre: no es de esta tanda
        lista.push({ clase: e.codigo_origen.toUpperCase(), cduMala: e.cdu, aplazada: true, usos: e.usos || 0 });
    }
    return lista.sort((a, b) => b.usos - a.usos);
}

/** Las exclusiones por clase LCC de los incidentes conocidos (QA75-76, TK5101-5105…) más GN, que no se toca en bloque. */
function exclusionPorClase(clase, d) {
    if (clase === 'GN') return 'GN: mitad antropología física (572), mitad etnología (39): no se arregla en bloque';
    const inc = INCIDENTES.find((i) => i.clase === clase && i.excluir);
    return inc ? inc.excluir(d) : null;
}

const normalizarCodigo = (c) => String(c || '').trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Las CLASES principales de CDU que admiten los códigos del propio libro (su Dewey y su LCC). La CDU nueva tiene que
 * caer en una de ellas: en el seco del 9-oct, «PQ3989» (literatura africana en francés) iba a «929:331.2» y «PQ7298»
 * (literatura mexicana) a «821.111(73)», sacadas de otras equivalencias aprendidas de UN libro. Sin códigos → null
 * (no se exige nada). La informática (004) se admite junto a 5/6, como en la tabla.
 */
/**
 * Dentro de la literatura, la FAMILIA de lenguas de su LCC: PQ románicas (821.13x), PT germánicas (821.11x), PG eslavas
 * (821.16x), PA clásicas (821.12x griega, 821.14 latina… y 821.124). En el seco del 9-oct, «PQ7298» (literatura
 * mexicana) y «PQ7798» (argentina) iban a «821.111(73)», estadounidense, desde equivalencias aprendidas de una
 * traducción. «82» a secas (literatura en general) vale siempre. Sin LCC de esas clases o sin 821 → true.
 */
const FAMILIAS_LITERATURA = { PQ: ['821.13'], PT: ['821.11'], PG: ['821.16'], PA: ['821.12', '821.14'] };
function literaturaDeSuFamilia(doc, cdu) {
    const familia = FAMILIAS_LITERATURA[claseLcc(doc.lcc)];
    const c = String(cduParaUbicar(cdu) || cdu);
    if (!familia || !c.startsWith('821')) return true;
    return familia.some((f) => c.startsWith(f));
}

async function clasesEsperadas(doc) {
    const clases = new Set();
    const d = (String(doc.dewey || '').match(/\d{3}/) || [])[0];
    if (d) clases.add(['004', '005', '006'].includes(d) ? '0' : d[0] === '4' ? '8' : d[0]);
    const letras = claseLcc(doc.lcc);
    if (letras) {
        const tabla = String(await buscarEquivalenciaExterna('lcc', letras) || '');   // la tabla del motor, por clase
        if (/^\d/.test(tabla)) clases.add(tabla[0]);
        else if (letras[0] === 'P') clases.add('8');                       // lenguas y literaturas (aplazadas)
        else if ('DEF'.includes(letras[0])) clases.add('9');               // historia (aplazada)
    }
    if (!clases.size) return null;
    if (clases.has('5') || clases.has('6')) clases.add('0');
    return clases;
}

/**
 * Incidentes de la TERCERA TANDA, leídos de la caché con la regla del motor (equivalenciaUsable): toda equivalencia
 * Dewey/LCC sin verificar que el motor ya no usaría. Las de clases aplazadas ya son de la segunda tanda.
 */
async function incidentesPorRegla(db, yaCubiertas) {
    const lista = [];
    const aprendidas = await db.collection('equivalencias_cdu')
        .find({ sistema_origen: { $in: ['dewey', 'lcc'] }, verificado: { $ne: true }, fuente: { $ne: 'Manual' } }).toArray();
    // --copia <sello>: también las de una COPIA anterior de la caché. Hace falta cuando la caché viva ya se corrigió
    // (p. ej. el 9-oct, un seco anterior pisó las malas con la CDU de la tabla) pero sus libros siguen con la CDU mala:
    // sin la copia ya no se sabría qué buscar.
    const sello = (() => { const i = process.argv.indexOf('--copia'); return i >= 0 ? process.argv[i + 1] : null; })();
    if (sello) {
        const { readFileSync } = await import('node:fs');
        const { gunzipSync } = await import('node:zlib');
        const { EJSON } = await import('bson');
        const ruta = new URL(`../logs/copias-bd/${sello}/equivalencias_cdu.jsonl.gz`, import.meta.url);
        const vivas = new Set(aprendidas.map((e) => `${e.sistema_origen}|${e.codigo_origen}`));
        let deCopia = 0;
        for (const linea of gunzipSync(readFileSync(ruta)).toString('utf8').split('\n')) {
            if (!linea.trim()) continue;
            const e = EJSON.parse(linea);
            if (!['dewey', 'lcc'].includes(e.sistema_origen) || e.verificado === true || e.fuente === 'Manual') continue;
            if (vivas.has(`${e.sistema_origen}|${e.codigo_origen}`)) continue;
            aprendidas.push(e);
            deCopia++;
        }
        console.log(`   + ${deCopia} equivalencia(s) sin verificar leídas de la copia ${sello} (ya no están así en la caché viva).`);
    }
    for (const e of aprendidas) {
        const uso = equivalenciaUsable(e.sistema_origen, e.codigo_origen, e);
        if (uso.usable) continue;
        const clave = `${e.sistema_origen}|${e.codigo_origen}`;
        if (yaCubiertas.has(clave)) continue;
        lista.push({
            sistema: e.sistema_origen, codigo: e.codigo_origen, cduMala: e.cdu, motivo: uso.motivo, usos: e.usos || 0,
            clase: e.sistema_origen === 'lcc' ? String(e.codigo_origen).toUpperCase() : `DEWEY ${e.codigo_origen}`,
            regla: true, aplazada: true,   // sin CDU calculable sin IA → a la selección (no «sin solución»)
        });
    }
    return lista.sort((a, b) => b.usos - a.usos);
}

/**
 * La CDU que el documento tenía ANTES de que el Conformador le pusiera la contaminada, según su propia alerta.
 * null si no hay alerta, o si la anterior estaba vacía o era otro invento.
 */
function cduAnteriorSegunAlerta(doc, cduMala) {
    for (const alerta of [...(doc.alertas_agente || [])].reverse()) {
        const m = String(alerta).match(/^CDU actualizada: "(.*)" → "(.*)" \[clasificador:cache:(?:lcc|dewey)\]/);
        if (!m || m[2] !== cduMala) continue;
        const anterior = m[1];
        if (cduVacia(anterior) || anterior === cduMala || !cduBienFormada(anterior)) return null;
        return modernizarCDU(anterior);
    }
    return null;
}

async function main() {
    const db = await conectarDB();
    const col = db.collection('biblioteca');

    console.log('\n🩹 Reparación de CDU heredadas de equivalencias contaminadas');
    console.log(`   Modo: ${EJECUTAR ? '⚠️  EJECUTAR (mueve carpetas)' : 'DRY-RUN (no toca nada)'}\n`);

    const aplazadas = SOLO_REGLA ? [] : await incidentesDeClasesAplazadas(db);
    const conocidos = SOLO_REGLA ? [] : INCIDENTES;
    const porRegla = await incidentesPorRegla(db, new Set(aplazadas.map((a) => `lcc|${a.clase.toLowerCase()}`)));
    console.log(`   Incidentes: ${conocidos.length} conocidos + ${aplazadas.length} de clases aplazadas a la IA + ${porRegla.length} que la regla del motor ya no usa (leídos de la caché).`);
    for (const a of aplazadas) console.log(`     lcc:${a.clase.toLowerCase().padEnd(3)} → «${a.cduMala}»  (${a.usos} usos)`);
    for (const a of porRegla.slice(0, 40)) console.log(`     ${a.sistema}:${String(a.codigo).padEnd(10)} → «${a.cduMala}»  (${a.usos} usos) — ${a.motivo}`);
    if (porRegla.length > 40) console.log(`     … y ${porRegla.length - 40} más`);
    console.log('');

    // 1) Selección: CDU mala exacta + clase LCC EXACTA (misma regla que la búsqueda) + exclusiones.
    const plan = [];
    const omitidos = {};
    const pIncidentes = progreso(conocidos.length + aplazadas.length + porRegla.length, 'Buscando los libros afectados');
    for (const inc of [...conocidos, ...aplazadas, ...porRegla]) {
        pIncidentes.paso(inc.clase);
        const esDewey = inc.sistema === 'dewey';
        const candidatos = await col.find(
            esDewey ? { cdu: inc.cduMala, dewey: { $exists: true, $ne: null } }
                : { cdu: inc.cduMala, lcc: { $regex: `^${inc.clase}`, $options: 'i' } },
            { projection: PROYECCION },
        ).toArray();

        for (const d of candidatos) {
            if (esDewey ? normalizarCodigo(d.dewey) !== inc.codigo : claseLcc(d.lcc) !== inc.clase) continue;   // «UA…» no es la clase «U»
            if (!esDewey && inc.regla) {
                const ex = exclusionPorClase(inc.clase, d);
                if (ex) { omitidos[ex] = (omitidos[ex] || 0) + 1; continue; }
            }
            // Una CDU de más rango que la del clasificador (impresa en el libro, de la BNE) no vino de la caché.
            const deMasRango = rangoFuente(fuenteCduDoc(d)) > RANGO_CDU.clasificador;
            const motivo = d.cdu_manual ? 'CDU fijada a mano' : d.locked ? 'documento bloqueado'
                : deMasRango ? 'CDU impresa en el libro o de la BNE (no vino de la caché)'
                : inc.excluir ? inc.excluir(d) : null;
            if (motivo) { omitidos[motivo] = (omitidos[motivo] || 0) + 1; continue; }
            plan.push({ doc: d, inc });
        }
    }
    pIncidentes.fin();

    console.log(`   A reparar: ${plan.length} documento(s)`);
    for (const [m, n] of Object.entries(omitidos)) console.log(`   Se dejan como están: ${n} — ${m}`);
    console.log('');

    // 2) CDU nueva de cada uno: la que tenía antes (según su alerta) o la del motor ya arreglado, sin IA.
    const cambios = [];
    const pendientes = [];   // sin CDU calculable sin IA: a la selección, para que el Conformador los reclasifique
    let sinSolucion = 0;
    let fueraDeClase = 0;    // la CDU nueva no casa con la clase de su propia Dewey/LCC
    const p1 = progreso(plan.length, 'Calculando la CDU');
    for (const p of plan) {
        p1.paso(p.doc.titulo);
        let nueva = cduAnteriorSegunAlerta(p.doc, p.inc.cduMala);
        let origen = 'la que tenía antes';
        if (!nueva) {
            const r = await resolverCDU({ dewey: p.doc.dewey, lcc: p.doc.lcc, titulo: p.doc.titulo, permitirIA: false, aprender: false }).catch(() => null);
            nueva = r?.cdu || null;
            origen = 'motor sin IA';
        }
        // Si no hay nada, o saliera la misma CDU mala, no se toca: mejor igual que peor.
        if (!nueva || nueva === '000' || nueva === p.inc.cduMala || !cduBienFormada(nueva)) {
            if (p.inc.aplazada) pendientes.push(p); else sinSolucion++;
            continue;
        }
        // Y tiene que caer en una clase que admitan los códigos del propio libro (ver clasesEsperadas): si no, se deja
        // al Conformador con IA en vez de cambiar un error por otro.
        const esperadas = await clasesEsperadas(p.doc);
        const claseNueva = (String(cduParaUbicar(nueva) || nueva).match(/^\d/) || [])[0];
        if ((esperadas && claseNueva && !esperadas.has(claseNueva)) || !literaturaDeSuFamilia(p.doc, nueva)) {
            fueraDeClase++;
            if (fueraDeClase <= 15) p1.nota(`   ↷ «${String(p.doc.titulo).slice(0, 40)}» [${p.doc.dewey || ''} ${p.doc.lcc || ''}]: «${nueva}» no es de su clase o su familia de lenguas → Conformador`);
            pendientes.push(p);
            continue;
        }
        cambios.push({ ...p, nueva, origen });
    }
    p1.fin();

    // Resumen por transición (lo que de verdad hay que juzgar antes de ejecutar).
    const transiciones = {};
    for (const c of cambios) {
        const k = c.inc.aplazada
            ? `${c.inc.clase.toLowerCase()}: «${c.inc.cduMala}» → ${c.inc.regla ? `«${c.nueva}» (${c.origen})` : c.origen}`
            : `${c.inc.clase}: «${c.inc.cduMala}» → «${c.nueva}»`;
        transiciones[k] = (transiciones[k] || 0) + 1;
    }
    console.log('\n   Transiciones:');
    for (const [k, n] of Object.entries(transiciones).sort((a, b) => b[1] - a[1])) console.log(`     ${String(n).padStart(4)}  ${k}`);
    if (sinSolucion) console.log(`\n   Sin CDU calculable (se dejan): ${sinSolucion}`);
    if (fueraDeClase) console.log(`\n   La CDU calculada no era de la clase de su propia Dewey/LCC (se dejan para el Conformador): ${fueraDeClase}`);
    if (pendientes.length) {
        console.log(`\n   Necesitan IA (se dejan, quedan en una selección y el Conformador los reclasificará): ${pendientes.length}`);
        const porClase = {};
        for (const p of pendientes) porClase[p.inc.clase] = (porClase[p.inc.clase] || 0) + 1;
        console.log(`     ${Object.entries(porClase).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}×${n}`).join('  ')}`);
    }

    console.log('\n   Ejemplos:');
    for (const c of cambios.slice(0, 12)) console.log(`     [${c.doc.lcc}] ${String(c.doc.titulo).slice(0, 52)}  «${c.doc.cdu}» → «${c.nueva}»`);

    if (!EJECUTAR) {
        console.log(`\n   → Para aplicarlo: --ejecutar   (${cambios.length} documentos; mueve sus carpetas)\n`);
        process.exit(0);
    }

    // 3) SALVAGUARDA: ¿estamos en la máquina que TIENE las carpetas?
    // Si no (p. ej. lanzado desde el PC, donde DIR_CDU es un árbol de desarrollo), reubicarPorCdu cae en su modo
    // «sin carpeta en disco → solo BD»: cambiaría la ruta_base en Mongo SIN mover la carpeta real del NAS, y
    // base y disco quedarían desincronizados en cientos de documentos — sin un solo error. Se exige ver en disco
    // la carpeta de la mayoría de una muestra antes de tocar nada.
    // --limite N: solo los N primeros cambios por pasada (estrategia de la CDU, regla 4: por tandas, comprobando entre
    // una y otra). Es reanudable: un libro reparado ya no tiene la CDU mala, así que la pasada siguiente no lo ve.
    const iLim = process.argv.indexOf('--limite');
    const LIMITE = iLim >= 0 ? Number(process.argv[iLim + 1]) || 0 : 0;
    const ultimaTanda = !LIMITE || cambios.length <= LIMITE;
    if (LIMITE) {
        cambios.splice(LIMITE);
        console.log(`\n   Tanda de ${cambios.length} (--limite ${LIMITE})${ultimaTanda ? ' — la última' : '; relanza para la siguiente'}.`);
    }

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
    let hechos = 0, fallos = 0, movidos = 0;
    const p2 = progreso(cambios.length, 'Reparando');
    for (const c of cambios) {
        p2.paso(c.doc.titulo);
        try {
            const reub = await reubicarPorCdu(c.doc, c.nueva);
            if (reub) {
                const docNuevo = { ...c.doc, ...reub.set };
                await aplicarCambio(col, c.doc, carpetaDeDoc(docNuevo), {
                    set: reub.set,
                    alertas: [`CDU reparada: «${c.inc.cduMala}» venía de una equivalencia contaminada (${c.inc.regla ? `${c.inc.sistema}:${c.inc.codigo}, ${c.inc.motivo}` : `lcc:${c.inc.clase.toLowerCase()}`}); → «${c.nueva}» (${c.origen}).`],
                });
                if (reub.set.ruta_base && reub.set.ruta_base !== c.doc.ruta_base) movidos++;
                hechos++;
            }
        } catch (e) {
            fallos++;
            p2.nota(`⚠️  ${c.doc._id}: ${e.message}`);
        }
    }
    p2.fin();

    // 5) Los que necesitan IA: sin sello en re-clasificar-cdu (el Conformador los recalcula, ya por clase + número)
    //    y a una selección, para verlos. Con --limite, solo en la ÚLTIMA tanda (si no, una selección por tanda).
    if (pendientes.length && ultimaTanda) {
        const ids = pendientes.map((p) => p.doc._id);
        await col.updateMany({ _id: { $in: ids } },
            { $set: { 'mantenimiento.re-clasificar-cdu': 0, mantenimiento_firma: 'pendiente-cdu-contaminada' } });
        const fecha = new Date().toISOString().slice(0, 10);
        await crearSeleccion(db, {
            nombre: `CDU por reclasificar (clase LCC contaminada) ${fecha}`,
            descripcion: 'Libros cuya CDU vino de una equivalencia aprendida para toda su clase LCC (historia, literaturas de varias lenguas) y que no se pueden recalcular sin IA. El Conformador los reclasifica (tarea re-clasificar-cdu).',
            docs: ids,
        });
        console.log(`\n   ${pendientes.length} documento(s) a la selección «CDU por reclasificar (clase LCC contaminada) ${fecha}»; el Conformador los recalculará.`);
    }

    console.log(`\n   ✔ Reparados: ${hechos}  ·  carpetas movidas: ${movidos}${fallos ? `  ·  ⚠️  fallos: ${fallos}` : ''}\n`);
    process.exit(fallos ? 1 : 0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
