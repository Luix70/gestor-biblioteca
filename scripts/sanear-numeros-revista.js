/**
 * SANEAR NÚMEROS DE REVISTA contaminados con datos de catálogos de LIBROS (reparación).
 *
 * Hasta el 15-sep-2026 la ingesta buscaba cada número de revista por su TÍTULO en OpenLibrary y Google Books (y en
 * el Fichero), como si fuera un libro. Lo que encontraba era un libro HOMÓNIMO, y de él salían sinopsis, autor,
 * editorial, palabras clave, Dewey/LCC (→ CDU) y hasta el año. Caso que lo destapó: L'Histoire 2016, cuyos números
 * se llaman «1.pdf» … «12.pdf»: «11» → «11/22/63» de Stephen King, «12» → «12 Rules for Life», «1» → «Heartstopper»
 * (Dewey 741.5 → la cabecera nació con CDU 74). Medido ese día: 424 de 1.539 números afectados, desde junio.
 * La ingesta ya no lo hace (proveedor-metadatos · revista / tituloBuscable); esto limpia lo que quedó.
 *
 * NO TODO lo que lleva un número «contaminado» es basura (medido sobre una muestra): muchos tienen además una sinopsis
 * que la IA escribió después VIENDO el número («Este número de Fortean Times explora…»), la editorial real de la
 * revista (Kalmbach en Astronomy, Sandhills en CPU) y palabras clave de la IA. Eso se CONSERVA. Se retira:
 *   · autores (de TODOS los números, contaminados o no) — un número de revista no tiene autor; los que hay son de un
 *     libro homónimo o restos del nombre del fichero («Christmas 2015»);
 *   · la sinopsis que NO habla de la revista («This book explores…», el argumento de una novela) — la que menciona el
 *     número, la revista o su cabecera se queda, y la del propio fichero también;
 *   · la editorial que no es la de la revista: se queda la que comparten la MITAD o más de los números de su cabecera
 *     y la que leyó la visión en el propio número;
 *   · las palabras clave que son CATEGORÍAS de un catálogo de libros («American literature», «Electronic books»);
 *   · Dewey, LCC y lengua original (de un libro, siempre), y las contribuciones con rol que dio el catálogo;
 *   · el año que contradice al del NOMBRE del fichero («BBC History Magazine - January 2015» con año 2017): se toma el
 *     del nombre, y se rehacen la clave del número y el título compuesto.
 * La CDU no se toca (no se puede saber si salió del Dewey de un libro): el informe lista las cabeceras SOSPECHOSAS
 * para revisarlas a mano.
 *
 * MODOS
 *   --contaminadas            todos los números contaminados.
 *   --cabecera "<nombre>"     los números de UNA cabecera (autores fuera en todos), y además, si se indican:
 *       --nombre "<nuevo>"         renombra la cabecera (y el nombre que llevan sus números)
 *       --cdu <cdu>                CDU de la publicación: la cabecera y los números que no la tengan (MUEVE sus
 *                                  carpetas por el camino del Conformador: ejecutar en el NAS)
 *       --editorial "<nombre>"     editorial de la publicación: cabecera y números
 *       --idioma <iso>             idioma de los números (p. ej. fr)
 *       --descripcion "<texto>"    descripción de la cabecera
 *       --periodo 2016|2009-2016   años de la tirada: un año fuera se corrige (un solo año) o se retira
 *       --meses-del-nombre         los ficheros se llaman por el MES («1.pdf» … «12.pdf», «7-8.pdf»)
 *       --muestra 419@2016-01      nº y fecha de un número conocido: retira los nº imposibles para su fecha
 *       --periodicidad mensual     (para la comprobación de la muestra)
 *     Con fecha o nombre nuevos, el título compuesto («l'historie nº 419 (2018)») se rehace: «L'Histoire nº 419
 *     (enero 2016)»; la clave del número y el inventario de la cabecera se recalculan. La carpeta física de un número
 *     no se mueve por cambiar su año (su ruta_base sigue siendo válida).
 *
 *   node scripts/sanear-numeros-revista.js --contaminadas                 (DRY-RUN: informe)
 *   node scripts/sanear-numeros-revista.js --contaminadas --ejecutar
 *   node scripts/sanear-numeros-revista.js --cabecera "l'historie" --nombre "L'Histoire" --cdu 94 --editorial "Sophia Publications" \
 *        --idioma fr --periodo 2016 --meses-del-nombre --muestra 419@2016-01 --periodicidad mensual [--ejecutar]
 *
 * Toca Mongo (y el índice de búsqueda); los sidecars de cada carpeta los regenera después la campaña «sidecars»
 * (ve la fecha_actualizacion). Salvo --cdu, se puede ejecutar desde cualquier máquina. Reanudable: lo ya saneado
 * no tiene nada que retirar. Después, «limpiar-huerfanos» poda los autores y editoriales que se queden sin libros.
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { tituloDeNumero, tituloEsDelFichero, claveNumero, afinarFechaNumero, periodoDeTexto, pareceSerieLibros } from '../src/utils/revistas.js';
import { registrarNumeroEnColeccion } from '../src/utils/colecciones.js';
import { MES_NUM } from '../src/utils/parsear-nombre.js';
import { reubicarPorCdu, aplicarCambio, carpetaDeDoc, carpetaExiste } from '../src/mantenimiento/util-mantenimiento.js';

const args = process.argv.slice(2);
const valor = (flag) => { const i = args.indexOf(flag); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const CONTAMINADAS = args.includes('--contaminadas');
const CABECERA = valor('--cabecera');
const OPC = {
    nombre: valor('--nombre'),
    cdu: valor('--cdu'),
    editorial: valor('--editorial'),
    idioma: valor('--idioma'),
    descripcion: valor('--descripcion'),
    periodo: periodoDeTexto(valor('--periodo') || ''),
    mesesDelNombre: args.includes('--meses-del-nombre'),
    muestra: (() => {
        const m = String(valor('--muestra') || '').match(/^(\d+)@(\d{4})-(\d{1,2})$/);
        return m ? { numero: Number(m[1]), anio: Number(m[2]), mes: Number(m[3]) } : null;
    })(),
    periodicidad: valor('--periodicidad'),
};

// Marcas que deja la ingesta cuando un catálogo de LIBROS aportó datos (proveedor-metadatos).
const RE_CONTAMINADA = /^(Datos validados contra OpenLibrary|Datos complementados con Google Books|Datos del Fichero local)/;
const RE_SINOPSIS_FICHERO = /^Sinopsis conservada del archivo original/;
const RE_ROLES_CATALOGO = /^Roles (de contribuyentes de OpenLibrary|de la mención de la BNE)/;
const ALERTA = 'Datos de catálogos de LIBROS retirados: un número de revista no tiene autor, y la sinopsis/editorial/Dewey eran de un libro homónimo (sanear-numeros-revista).';

const norm = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const esContaminada = (d) => (d.alertas_agente || []).some((a) => RE_CONTAMINADA.test(a));

/** ¿La sinopsis habla de ESTE número / de la revista? (la de la IA que lo vio sí; la de un libro homónimo, no) */
const RE_HABLA_DE_REVISTA = /\b(revista|magazine|magazin|rivista|revue|n[úu]mero|issue|edici[óo]n|publicaci[óo]n|ejemplar|mensual|semanal)\b/i;
function sinopsisDeRevista(sinopsis, cabecera) {
    if (RE_HABLA_DE_REVISTA.test(sinopsis)) return true;
    const c = norm(cabecera);
    return c.length >= 3 && norm(sinopsis).includes(c);
}

/**
 * ¿Las palabras clave son CATEGORÍAS de un catálogo de libros? Google Books da una o dos, en inglés y con mayúscula
 * («American literature», «Language Arts & Disciplines», «Electronic books»); las de la IA son varias, en minúscula y
 * casi siempre en español («astronomía», «espacio»…).
 */
function sonCategoriasDeLibro(pc) {
    if (!Array.isArray(pc) || !pc.length || pc.length > 2) return false;
    return pc.every((p) => /^[A-Z][A-Za-z]*(?:[ ,&'-]+[A-Za-z]+)*$/.test(String(p).trim()));
}

/** ¿La visión (Conformador «enriquecido a fondo», o la ingesta) leyó la editorial en el propio número? */
const editorialPorVision = (alertas) => alertas.some((a) => /visi[óo]n\)?:[^|]*\beditorial\b/i.test(a));

/**
 * ¿Es de verdad un NÚMERO de revista, o un LIBRO que se catalogó como revista? El dry-run del 15-sep lo destapó:
 * «Algebraic Number Theory», «The Prisoner of Zenda», «Springer Proceedings in…» son revistas en la base, y SU Dewey,
 * autores y editorial son buenos (son libros). Esos no se tocan: se listan para revisarlos aparte. Es revista si su
 * cabecera tiene varios números o el número lleva mes o nº, no parece una serie de libros y el fichero no traía ISBN
 * propio. (Un año suelto no cuenta: los libros también tienen año.)
 */
function esNumeroDeRevista(d, numerosDeSuCabecera) {
    if (pareceSerieLibros(d.titulo) || pareceSerieLibros(d.coleccion_nombre)) return false;
    // La señal más fuerte es el NOMBRE: un mes, «2014-12» o «nº 157» marcan un número aunque sea el único de su
    // cabecera («2022-11-01 Destination USA.pdf», «Challenges No.420…»). Manda incluso sobre un ISBN en el texto
    // (el de un anuncio).
    if (/^\d{4}-\d{2}$|^n\d+/.test(String(d.clave_numero || '')) || senalDeNumero(d.nombre_archivo) || senalDeNumero(d.titulo)) return true;
    if (Array.isArray(d.isbn_candidatos) && d.isbn_candidatos.length) return false;
    return numerosDeSuCabecera >= 2;
}

// Meses: los nombres largos valen solos («November», incluso pegado: «CIODecember2014»); las abreviaturas, solo junto a
// un año («Nov-09», «OCT-2014»), que «may» o «mar» sueltos están en cualquier título.
const MESES_LARGOS = Object.keys(MES_NUM).filter((k) => k.length >= 6);
const MESES_MEDIOS = Object.keys(MES_NUM).filter((k) => k.length >= 4 && k.length < 6);
const RE_MES_CORTO = new RegExp(`(?:^|[^a-z])(?:${Object.keys(MES_NUM).filter((k) => k.length < 4).join('|')})[-_. ]?\\d{2,4}(?!\\d)`);

/** ¿El texto (nombre de fichero, título) lleva la fecha o el nº de un NÚMERO de revista? */
function senalDeNumero(texto) {
    const s = String(texto || '').replace(/\.[a-z0-9]{2,4}$/i, '')
        .replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')   // «CIODecember» → «CIO December»
        .normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toLowerCase();
    const palabras = s.split(/[^a-z]+/).filter(Boolean);
    if (MESES_LARGOS.some((m) => s.includes(m)) || palabras.some((p) => MESES_MEDIOS.includes(p))) return true;
    if (RE_MES_CORTO.test(s)) return true;
    if (/(?<!\d)(19|20)\d{2}[-_. ]?(0[1-9]|1[0-2])(?!\d)/.test(s) || /(?<!\d)(0[1-9]|1[0-2])[-_. ]?(19|20)\d{2}(?!\d)/.test(s)) return true;
    return /(?:^|[^a-z])(?:issue|n[ºo°]?|no|num|numero|nr|heft)\.?\s*[-_#]?\s*\d+/.test(s);
}

/** Año del NOMBRE del fichero, si lleva exactamente uno plausible («… - January 2015.pdf» → 2015). */
function anioDelNombre(nombre) {
    const p = periodoDeTexto(String(nombre || '').replace(/\.[^.]+$/, ''));
    return p && p.desde === p.hasta && p.desde <= new Date().getFullYear() + 1 ? p.desde : null;
}

/** ¿El título es uno COMPUESTO con el nombre de la cabecera («l'historie nº 419 (2018)»)? Entonces se puede rehacer. */
function tituloCompuesto(titulo, cabecera) {
    const t = norm(titulo), c = norm(cabecera);
    if (!c || !t.startsWith(c)) return false;
    return /^\s*(n[ºo°]?\s*\d+)?\s*(\([^)]*\))?\s*$/i.test(String(titulo).slice(String(cabecera).length));
}

/** Editorial «de la revista»: la que comparten la mitad o más de los números de la cabecera. */
function editorialComun(docs) {
    const cuenta = new Map();
    for (const d of docs) if (d.editorial) cuenta.set(String(d.editorial), (cuenta.get(String(d.editorial)) || 0) + 1);
    for (const [ed, n] of cuenta) if (docs.length >= 2 && n >= docs.length / 2) return ed;
    return null;
}

async function main() {
    if (!CONTAMINADAS && !CABECERA) {
        console.error('Uso: node scripts/sanear-numeros-revista.js --contaminadas | --cabecera "<nombre>" [--nombre …] [--cdu …] [--editorial …] [--idioma …]\n'
            + '       [--descripcion …] [--periodo 2016|2009-2016] [--meses-del-nombre] [--muestra 419@2016-01] [--periodicidad mensual] [--ejecutar]');
        process.exit(1);
    }
    const db = await conectarDB();
    const bib = db.collection('biblioteca');
    const cols = db.collection('colecciones');

    // ── Selección ──────────────────────────────────────────────────────────────────────────────────────
    let cab = null;
    let docs;
    if (CABECERA) {
        cab = await cols.findOne({ nombre: CABECERA, tipo: 'revista' }, { collation: { locale: 'es', strength: 1 } });
        if (!cab) { console.error(`\n   ❌ No hay ninguna cabecera de revista llamada «${CABECERA}».\n`); process.exit(1); }
        docs = await bib.find({ coleccion: cab._id, tipo_recurso: 'revista' }).sort({ nombre_archivo: 1 }).toArray();
    } else {
        // Los contaminados y, además, cualquier número con autores (una revista no tiene autor, venga de donde venga).
        docs = await bib.find({ tipo_recurso: 'revista', naturaleza: { $ne: 'comic' }, $or: [
            { alertas_agente: { $elemMatch: { $regex: RE_CONTAMINADA.source } } },
            { 'autores.0': { $exists: true } },
        ] }).toArray();
    }
    if (!docs.length) { console.log('\n   Nada que sanear.\n'); process.exit(0); }

    // Editorial «de la revista» y nº de números por cabecera, sobre TODOS sus números (no solo los seleccionados).
    const comunPorCab = new Map(), numerosPorCab = new Map();
    for (const id of new Set(docs.map((d) => String(d.coleccion || '')).filter(Boolean))) {
        const todos = await bib.find({ coleccion: docs.find((d) => String(d.coleccion) === id).coleccion }, { projection: { editorial: 1 } }).toArray();
        comunPorCab.set(id, editorialComun(todos));
        numerosPorCab.set(id, todos.length);
    }
    // En el modo general, lo que parece un LIBRO catalogado como revista se aparta (se lista, no se toca). Con
    // --cabecera no: ahí eres tú quien dice que esa cabecera es una revista.
    let apartados = [];
    if (!CABECERA) {
        apartados = docs.filter((d) => !esNumeroDeRevista(d, numerosPorCab.get(String(d.coleccion || '')) || 1));
        const fuera = new Set(apartados.map((d) => String(d._id)));
        docs = docs.filter((d) => !fuera.has(String(d._id)));
    }
    let editorialId = null;
    if (OPC.editorial) {
        const ex = await db.collection('editoriales').findOne({ nombre: OPC.editorial }, { collation: { locale: 'es', strength: 1 } });
        editorialId = ex ? ex._id : null;   // si no existe, se crea al ejecutar (no en el dry-run)
    }
    const nombreFinal = OPC.nombre || cab?.nombre || null;

    // ── Plan por número ───────────────────────────────────────────────────────────────────────────────
    const plan = [];
    for (const d of docs) {
        const set = {}, unset = {}, cambios = [];
        const contaminada = esContaminada(d);
        const alertas = d.alertas_agente || [];
        const cabNombre = d.coleccion_nombre || cab?.nombre || '';
        if (Array.isArray(d.autores) && d.autores.length) { unset.autores = ''; cambios.push(`autores (${d.autores.length})`); }
        if (contaminada) {
            if (d.sinopsis && !alertas.some((a) => RE_SINOPSIS_FICHERO.test(a)) && !sinopsisDeRevista(d.sinopsis, cabNombre)) { unset.sinopsis = ''; cambios.push('sinopsis de un libro'); }
            if (Array.isArray(d.contribuciones) && d.contribuciones.length && alertas.some((a) => RE_ROLES_CATALOGO.test(a))) { unset.contribuciones = ''; cambios.push('contribuciones'); }
            const comun = comunPorCab.get(String(d.coleccion || '')) || null;
            if (d.editorial && String(d.editorial) !== comun && !editorialPorVision(alertas) && !OPC.editorial) { unset.editorial = ''; cambios.push('editorial de un libro'); }
            if (sonCategoriasDeLibro(d.palabras_clave)) { unset.palabras_clave = ''; cambios.push('categorías de libro'); }
            for (const k of ['dewey', 'lcc', 'idioma_original']) if (d[k]) { unset[k] = ''; cambios.push(k); }
        }

        let nuevo = { ...d };
        // Año del NOMBRE del fichero (modo general): el catálogo de libros pudo rellenar el de un libro homónimo.
        if (contaminada && !CABECERA) {
            const a = anioDelNombre(d.nombre_archivo);
            if (a && Number(d.año_edicion) !== a) {
                set.año_edicion = a;
                cambios.push(`año ${d.año_edicion || '—'} → ${a} (el del nombre del fichero)`);
                nuevo = { ...d, año_edicion: a };
                const clave = claveNumero(nuevo);
                if (clave !== (d.clave_numero || null)) { if (clave) set.clave_numero = clave; else unset.clave_numero = ''; }
                if (cabNombre && tituloCompuesto(d.titulo, cabNombre)) {
                    const t = tituloDeNumero(cabNombre, nuevo);
                    if (t !== d.titulo) { set.titulo = t; cambios.push(`título «${d.titulo}» → «${t}»`); }
                }
            }
        }

        // Arreglos por cabecera (solo con --cabecera).
        if (CABECERA) {
            if (OPC.editorial && String(d.editorial || '') !== String(editorialId || '-')) { set.editorial = '(editorial)'; cambios.push(`editorial → «${OPC.editorial}»`); delete unset.editorial; }
            if (OPC.idioma && d.idioma !== OPC.idioma) { set.idioma = OPC.idioma; cambios.push(`idioma ${d.idioma || '—'} → ${OPC.idioma}`); }
            if (OPC.nombre && d.coleccion_nombre !== OPC.nombre) set.coleccion_nombre = OPC.nombre;
            // Fecha y nº con lo que sabe la carpeta (el mismo afinado que hace ya la ingesta).
            const perfil = { ...(OPC.mesesDelNombre ? { numeracion: 'mes' } : {}), ...(OPC.periodo ? { periodo: OPC.periodo } : {}),
                ...(OPC.muestra ? { muestra: OPC.muestra } : {}), ...(OPC.periodicidad ? { periodicidad: OPC.periodicidad } : {}) };
            const fecha = { año_edicion: d.año_edicion, mes_publicacion: d.mes_publicacion, mes_fin_publicacion: d.mes_fin_publicacion, numero_issue: d.numero_issue };
            const notas = afinarFechaNumero(fecha, { perfil, nombreFichero: d.nombre_archivo });
            for (const k of ['año_edicion', 'mes_publicacion', 'mes_fin_publicacion', 'numero_issue']) {
                if (fecha[k] === d[k]) continue;
                if (fecha[k] == null) unset[k] = ''; else set[k] = fecha[k];
            }
            if (notas.length) cambios.push(...notas.map((n) => n.replace(/\.$/, '')));
            // Campo a campo, no con «...fecha»: afinarFechaNumero BORRA la clave de lo que retira, y un spread dejaría
            // pasar el valor viejo del documento (el título saldría con el «nº 775» ya descartado).
            nuevo = { ...d };
            for (const k of ['año_edicion', 'mes_publicacion', 'mes_fin_publicacion', 'numero_issue']) nuevo[k] = fecha[k];
            const clave = claveNumero(nuevo);
            if (clave !== (d.clave_numero || null)) { if (clave) set.clave_numero = clave; else unset.clave_numero = ''; }
            // Título: se rehace el compuesto con la cabecera (o el que sea solo un resto del nombre del fichero).
            if (nombreFinal && (tituloEsDelFichero(d.titulo, d.nombre_archivo) || tituloCompuesto(d.titulo, cab.nombre) || tituloCompuesto(d.titulo, nombreFinal))) {
                const t = tituloDeNumero(nombreFinal, nuevo);
                if (t !== d.titulo) { set.titulo = t; cambios.push(`título «${d.titulo}» → «${t}»`); }
            }
        }
        const cduNueva = CABECERA && OPC.cdu && d.cdu !== OPC.cdu ? OPC.cdu : null;
        if (cduNueva) cambios.push(`CDU ${d.cdu} → ${cduNueva} (mueve la carpeta)`);
        if (Object.keys(set).length || Object.keys(unset).length || cduNueva) plan.push({ doc: d, set, unset, cambios, cduNueva, clave: set.clave_numero ?? (unset.clave_numero === '' ? null : d.clave_numero), nuevo });
    }

    // ── Informe ───────────────────────────────────────────────────────────────────────────────────────
    console.log(`\n📰 Sanear números de revista — ${CABECERA ? `cabecera «${cab.nombre}»${cab.issn ? ` (ISSN ${cab.issn})` : ''}${cab.cdu ? ` · CDU ${cab.cdu}` : ''}` : 'todos los contaminados'}`);
    console.log(`   ${docs.length} número(s) examinados · ${plan.length} con algo que cambiar\n`);
    if (CABECERA) {
        for (const p of plan) console.log(`   · ${p.doc.nombre_archivo}\n       ${p.cambios.join('\n       ') || '(solo inventario/nombre)'}`);
        const cabCambios = [OPC.nombre && OPC.nombre !== cab.nombre && `nombre «${cab.nombre}» → «${OPC.nombre}»`,
            OPC.cdu && OPC.cdu !== cab.cdu && `CDU ${cab.cdu || '—'} → ${OPC.cdu}`,
            OPC.editorial && `editorial → «${OPC.editorial}»`,
            !OPC.editorial && cab.editorial && String(cab.editorial) !== comunPorCab.get(String(cab._id)) && 'editorial retirada (era la de un libro homónimo)',
            OPC.descripcion && 'descripción'].filter(Boolean);
        console.log(`\n   Cabecera: ${cabCambios.join(' · ') || 'sin cambios'}`);
    } else {
        const porCab = new Map();
        for (const p of plan) {
            const k = p.doc.coleccion_nombre || '(sin cabecera)';
            const e = porCab.get(k) || { n: 0, campos: new Map() };
            e.n++;
            for (const c of p.cambios) { const b = c.replace(/ \(\d+\)$/, ''); e.campos.set(b, (e.campos.get(b) || 0) + 1); }
            porCab.set(k, e);
        }
        const orden = [...porCab.entries()].sort((a, b) => b[1].n - a[1].n);
        for (const [k, e] of orden.slice(0, 40)) console.log(`   · ${k}: ${e.n} nº — ${[...e.campos.entries()].map(([c, n]) => `${c} ${n}`).join(', ')}`);
        if (orden.length > 40) console.log(`   … y ${orden.length - 40} cabeceras más`);
        const tot = new Map();
        for (const p of plan) for (const c of p.cambios) {
            const b = c.replace(/ \(\d+\)$/, '').replace(/^año .*/, 'año corregido').replace(/^título .*/, 'título rehecho');
            tot.set(b, (tot.get(b) || 0) + 1);
        }
        console.log(`\n   Total: ${[...tot.entries()].map(([c, n]) => `${c} ${n}`).join(' · ')}`);

        // CABECERAS SOSPECHOSAS: alguno de sus números traía el Dewey/LCC de un libro, y de ahí pudo salir la CDU que
        // comparten todos (L'Histoire nació con 74 por el 741.5 de «Heartstopper»). No se corrige sola: revísala a mano.
        const sospechosas = new Map();
        for (const p of plan) {
            if (!p.doc.coleccion || !('dewey' in p.unset || 'lcc' in p.unset)) continue;
            const k = String(p.doc.coleccion);
            const e = sospechosas.get(k) || { codigos: new Set() };
            if (p.doc.dewey) e.codigos.add(`Dewey ${p.doc.dewey}`);
            if (p.doc.lcc) e.codigos.add(`LCC ${String(p.doc.lcc).split(/[.\s]/)[0]}`);
            sospechosas.set(k, e);
        }
        if (sospechosas.size) {
            const cabs = await cols.find({ _id: { $in: [...sospechosas.keys()].map((k) => docs.find((d) => String(d.coleccion) === k).coleccion) } }, { projection: { nombre: 1, cdu: 1 } }).toArray();
            console.log(`\n   ⚠️  ${cabs.length} cabecera(s) cuya CDU pudo salir del Dewey/LCC de un libro homónimo (revísalas en Colecciones):`);
            for (const c of cabs.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)))) {
                console.log(`      · «${c.nombre}» — CDU ${c.cdu || '—'} (sus números traían ${[...sospechosas.get(String(c._id)).codigos].slice(0, 3).join(', ')})`);
            }
        }
        if (apartados.length) {
            console.log(`\n   📚 ${apartados.length} documento(s) catalogados como revista que parecen LIBROS (NO se tocan; revísalos aparte):`);
            for (const d of apartados.slice(0, 40)) console.log(`      · «${String(d.titulo).slice(0, 80)}» (${d.nombre_archivo || d._id})`);
            if (apartados.length > 40) console.log(`      … y ${apartados.length - 40} más`);
        }
    }

    if (!EJECUTAR) {
        console.log('\n   (DRY-RUN: no se ha tocado nada. Haz una COPIA DE SEGURIDAD de la base y repite con --ejecutar.)\n');
        process.exit(0);
    }

    // SALVAGUARDA (como reunir-numeros-revista): cambiar la CDU mueve carpetas, y eso exige estar donde viven.
    const conCdu = plan.filter((p) => p.cduNueva);
    if (conCdu.length) {
        let vistas = 0;
        for (const p of conCdu) if (await carpetaExiste(carpetaDeDoc(p.doc))) vistas++;
        if (vistas < Math.ceil(conCdu.length / 2)) {
            console.error(`\n   ❌ Solo ${vistas} de ${conCdu.length} carpetas existen en ESTA máquina: con --cdu, ejecútalo en el NAS.\n`);
            process.exit(1);
        }
    }

    // ── Ejecución ─────────────────────────────────────────────────────────────────────────────────────
    if (OPC.editorial && !editorialId) editorialId = (await db.collection('editoriales').insertOne({ nombre: OPC.editorial })).insertedId;
    const t0 = Date.now();
    let hechos = 0, fallos = 0;
    for (const p of plan) {
        try {
            const set = { ...p.set };
            if (set.editorial) set.editorial = editorialId;
            if (p.cduNueva) {
                const reub = await reubicarPorCdu(p.doc, p.cduNueva);
                if (reub) await aplicarCambio(bib, p.doc, carpetaDeDoc(p.doc), { set: reub.set, alertas: reub.alertas });
            }
            const upd = { $set: { ...set, fecha_actualizacion: new Date(), alertas_agente: [...(p.doc.alertas_agente || []).filter((a) => a !== ALERTA), ALERTA] } };
            if (Object.keys(p.unset).length) upd.$unset = p.unset;
            await bib.updateOne({ _id: p.doc._id }, upd);
            if (p.doc.coleccion && (CABECERA || 'clave_numero' in p.set || 'clave_numero' in p.unset)) {
                await registrarNumeroEnColeccion(db, p.doc.coleccion, {
                    clave: p.clave, año: p.nuevo.año_edicion ?? null, mes: p.nuevo.mes_publicacion ?? null, numero_issue: p.nuevo.numero_issue ?? null,
                }, p.doc._id);
            }
            await indexarDoc(db, p.doc._id).catch(() => {});
            hechos++;
        } catch (e) {
            fallos++;
            console.warn(`\n   ⚠️  ${p.doc.nombre_archivo || p.doc._id}: ${e.message}`);
        }
        const n = hechos + fallos, seg = (Date.now() - t0) / 1000;
        const eta = n ? Math.round((plan.length - n) * seg / n) : 0;
        process.stdout.write(`\r   ${n}/${plan.length} (${Math.round(n * 100 / plan.length)} %) · ETA ${eta} s   `);
    }
    process.stdout.write('\n');

    // La cabecera.
    if (CABECERA) {
        const set = {}, unset = {};
        if (OPC.nombre && OPC.nombre !== cab.nombre) set.nombre = OPC.nombre;
        if (OPC.cdu && OPC.cdu !== cab.cdu) set.cdu = OPC.cdu;
        if (OPC.editorial) set.editorial = editorialId;
        else if (cab.editorial && String(cab.editorial) !== comunPorCab.get(String(cab._id))) unset.editorial = '';
        if (OPC.descripcion) set.descripcion = OPC.descripcion;
        if (Object.keys(set).length || Object.keys(unset).length) {
            await cols.updateOne({ _id: cab._id }, { $set: { ...set, fecha_actualizacion: new Date() }, ...(Object.keys(unset).length ? { $unset: unset } : {}) });
            console.log(`   ✔ Cabecera actualizada: ${Object.keys(set).concat(Object.keys(unset).map((k) => `−${k}`)).join(', ')}`);
        }
        // El nombre va denormalizado en TODOS sus números, también en los que no necesitaban otro cambio.
        if (set.nombre) {
            const r = await bib.updateMany({ coleccion: cab._id, coleccion_nombre: { $ne: set.nombre } }, { $set: { coleccion_nombre: set.nombre, fecha_actualizacion: new Date() } });
            if (r.modifiedCount) console.log(`   ✔ Nombre de la cabecera actualizado en ${r.modifiedCount} número(s) más.`);
        }
    } else {
        // Cabeceras cuya editorial era la de un libro homónimo (la heredaron de su primer número contaminado).
        let cabs = 0;
        const conEditorialRetirada = new Map();   // cabecera → editoriales retiradas de sus números
        for (const p of plan) {
            if (!p.doc.coleccion || p.unset.editorial !== '') continue;
            const k = String(p.doc.coleccion);
            if (!conEditorialRetirada.has(k)) conEditorialRetirada.set(k, { id: p.doc.coleccion, eds: new Set() });
            conEditorialRetirada.get(k).eds.add(String(p.doc.editorial));
        }
        for (const { id, eds } of conEditorialRetirada.values()) {
            const c = await cols.findOne({ _id: id }, { projection: { editorial: 1 } });
            if (c?.editorial && eds.has(String(c.editorial))) { await cols.updateOne({ _id: c._id }, { $unset: { editorial: '' }, $set: { fecha_actualizacion: new Date() } }); cabs++; }
        }
        if (cabs) console.log(`   ✔ Editorial retirada de ${cabs} cabecera(s) (era la de un libro homónimo).`);
    }
    console.log(`   ✔ Números saneados: ${hechos}${fallos ? ` · ⚠️ fallos: ${fallos}` : ''}. Los sidecars los pone al día la campaña «sidecars»; «limpiar-huerfanos» poda los autores/editoriales que queden sin libros.\n`);
    process.exit(fallos ? 1 : 0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
