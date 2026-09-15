/**
 * Revistas — helpers de identidad de un NÚMERO dentro de su cabecera.
 *
 * La CABECERA (p. ej. "Historia de Iberia Vieja", ISSN 1699-7913) se modela como una COLECCIÓN
 * (colección tipo:'revista' con `issn` como AUTORIDAD; ver src/utils/colecciones.js). Cada NÚMERO es un
 * documento de 'biblioteca' miembro de esa cabecera (`doc.coleccion`), identificado por una CLAVE
 * estable dentro de ella. El ISSN es el pivote (igual que el ISBN para los libros): así el vínculo
 * título↔número no se fragmenta por el ruido de fechas/números en el título de cada uno.
 *
 * (resolverCabecera / registrarNumeroEnColeccion viven en colecciones.js — la cabecera ES una colección.)
 */
import { MES_NUM } from './parsear-nombre.js';

const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const normalizarAlnum = (s) => String(s || '').normalize('NFD').replace(new RegExp('[\\u0300-\\u036f]', 'g'), '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * Título legible de un NÚMERO a partir de su cabecera: «2DArtist nº 73 (enero 2012)», o «(julio-agosto 2016)» en
 * un número doble. Lo que falte se omite.
 */
export function tituloDeNumero(cabecera, { numero_issue, mes_publicacion, mes_fin_publicacion, año_edicion } = {}) {
    const m = parseInt(mes_publicacion, 10), mf = parseInt(mes_fin_publicacion, 10);
    const mes = m >= 1 && m <= 12 ? (mf > m && mf <= 12 ? `${MESES[m - 1]}-${MESES[mf - 1]}` : MESES[m - 1]) : null;
    const fecha = [mes, año_edicion || null].filter(Boolean).join(' ');
    const n = numero_issue != null && String(numero_issue).trim() ? ` nº ${String(numero_issue).trim()}` : '';
    return `${String(cabecera).trim()}${n}${fecha ? ` (${fecha})` : ''}`;
}

/**
 * ¿El título es solo un RESTO del nombre del fichero? («2DAIssue.073.» sacado de «2DAIssue.073.January.2012.pdf»).
 * Entonces no aporta nada y se puede sustituir por uno compuesto con la cabecera. Un título de verdad (el tema de
 * portada, «Especial Egipto») no está dentro del nombre del fichero y se conserva.
 */
export function tituloEsDelFichero(titulo, nombreArchivo) {
    const t = normalizarAlnum(titulo), f = normalizarAlnum(String(nombreArchivo || '').replace(/\.[^.]+$/, ''));
    return !t || (f.length > 0 && f.includes(t));
}

// ─── FECHA Y NÚMERO de un número con lo que sabe su CARPETA ─────────────────────────────────────────────
//
// El año de un número salía errático (medido, L'Histoire 2016: 2018, 2011, 1925, 1730, 2003…): no hay fecha en
// «7-8.pdf», y el hueco lo rellenaba el año de un libro homónimo. La carpeta sí lo sabe: la tirada viene agrupada
// por años («l'historie 2016», «L'Histoire 2009 - 2016») y la inspección de la carpeta dice qué significan los
// números de los ficheros y lee en la portada del primero su número y su fecha (la «muestra»). Todo local y sin IA
// al ingerir cada número: la IA se gastó UNA vez, al inspeccionar la carpeta.

const RE_ANIO = /(?<!\d)(1[89]\d{2}|20\d{2})(?!\d)/g;

/** Años escritos en un texto (un nombre de carpeta) → { desde, hasta }, o null si no hay ninguno. */
export function periodoDeTexto(texto) {
    const anios = [...String(texto || '').matchAll(RE_ANIO)].map((m) => Number(m[1]));
    if (!anios.length) return null;
    return { desde: Math.min(...anios), hasta: Math.max(...anios) };
}

/**
 * Periodo de la carpeta MÁS CERCANA al fichero que lleve años en el nombre. `rutaCarpetas` = la ruta relativa al
 * Inbox con « / » (perfil.materia_ruta: «_REVISTAS / L'Histoire 2009-2016 / 2012»): gana la carpeta más interna,
 * así «…/2012» manda sobre el «2009-2016» de su madre.
 */
export function periodoDeRuta(rutaCarpetas) {
    const partes = String(rutaCarpetas || '').split(/\s*[/\\]\s*/).filter(Boolean);
    for (let i = partes.length - 1; i >= 0; i--) {
        const p = periodoDeTexto(partes[i]);
        if (p) return p;
    }
    return null;
}

/**
 * Mes(es) de un nombre de fichero que es SOLO un número de mes: «1.pdf» → {mes:1}, «07.pdf» → {mes:7},
 * «7-8.pdf» → {mes:7, mes_fin:8} (número doble). Cualquier otra cosa → null. Que ese número sea un mes y no un
 * número de la revista lo decide la guía (perfil.numeracion), no esta función.
 */
export function mesesDeNombre(nombreFichero) {
    const base = String(nombreFichero || '').replace(/\.[^.]+$/, '').trim();
    const m = base.match(/^0?(\d{1,2})(?:\s*[-_&+y]\s*0?(\d{1,2}))?$/i);
    if (!m) return null;
    const mes = Number(m[1]), fin = m[2] ? Number(m[2]) : null;
    if (mes < 1 || mes > 12) return null;
    if (fin != null && (fin <= mes || fin > 12)) return null;
    return fin ? { mes, mes_fin: fin } : { mes };
}

/**
 * Nº de la revista de un nombre de fichero que es SOLO ese número («57.pdf», «0163.pdf»), o null. Estricto a
 * propósito: en «HIV_163_0719.pdf» el número final es la fecha, no el nº. Un año de 4 cifras no vale.
 */
export function numeroDeNombre(nombreFichero) {
    const base = String(nombreFichero || '').replace(/\.[^.]+$/, '').trim();
    if (!/^\d{1,5}$/.test(base)) return null;
    const n = Number(base);
    if (!n || (base.length === 4 && n >= 1800 && n <= 2100)) return null;
    return n;
}

// Meses entre dos números consecutivos según la periodicidad (para comprobar un nº de issue contra la muestra).
const MESES_POR_NUMERO = { semanal: 12 / 52, quincenal: 0.5, mensual: 1, bimestral: 2, trimestral: 3, semestral: 6, anual: 12 };

/**
 * Afina, EN SITIO, año / mes / nº de un número de revista con lo que sabe su carpeta. Devuelve las alertas.
 *
 *  · MES: si la guía dice que los números de los ficheros son MESES (perfil.numeracion:'mes'), «3.pdf» es marzo
 *    (y «7-8.pdf», julio-agosto). Manda sobre un mes leído del texto, que puede ser el de un artículo. Si dice que
 *    son el Nº (numeracion:'numero'), «57.pdf» es el nº 57 (solo rellena).
 *  · AÑO: la carpeta de un solo año lo fija; si la carpeta abarca varios, un año fuera de ese rango se retira (un
 *    año equivocado es peor que ninguno: da la clave del número y su carpeta física).
 *  · Nº: con la muestra de la portada (p. ej. nº 419 = enero de 2016) y la periodicidad, un nº de issue absurdo
 *    para su fecha (el «775» o el «94» que salieron del texto) se retira. No se inventa ninguno: los números dobles
 *    y los especiales descuadran la cuenta, así que solo se descarta lo que no cuadra NI de lejos.
 *
 * @param documento  el número (se modifica)
 * @param opts.perfil         perfil heredado de la guía (periodo, numeracion, muestra, periodicidad)
 * @param opts.nombreFichero  nombre del fichero del número
 * @param opts.rutaCarpetas   ruta de sus carpetas dentro del Inbox («A / B / C»), para el periodo por nombre
 */
export function afinarFechaNumero(documento, { perfil = {}, nombreFichero = '', rutaCarpetas = '' } = {}) {
    const alertas = [];

    // 1) Mes (o nº) por el nombre del fichero.
    if (perfil.numeracion === 'numero' && documento.numero_issue == null) {
        const n = numeroDeNombre(nombreFichero);
        if (n) { documento.numero_issue = n; alertas.push(`Nº ${n}, el del nombre del fichero (en esta carpeta los ficheros se llaman por el nº).`); }
    }
    if (perfil.numeracion === 'mes') {
        const mn = mesesDeNombre(nombreFichero);
        if (mn) {
            const previo = parseInt(documento.mes_publicacion, 10);
            if (previo && previo !== mn.mes) alertas.push(`Mes ${previo} (del texto) sustituido por ${mn.mes}: en esta carpeta el nombre del fichero es el mes.`);
            documento.mes_publicacion = mn.mes;
            if (mn.mes_fin) documento.mes_fin_publicacion = mn.mes_fin;
        }
    }

    // 2) Año dentro del periodo de la carpeta (el de su nombre; si no lo lleva, el que dejó la inspección).
    const periodo = periodoDeRuta(rutaCarpetas) || (perfil.periodo?.desde ? perfil.periodo : null);
    if (periodo) {
        const anio = parseInt(documento.año_edicion, 10);
        const dentro = anio >= periodo.desde && anio <= periodo.hasta;
        if (periodo.desde === periodo.hasta) {
            if (anio !== periodo.desde) {
                alertas.push(anio ? `Año ${anio} fuera del de la carpeta: ${periodo.desde}.` : `Año ${periodo.desde}, el de la carpeta.`);
                documento.año_edicion = periodo.desde;
            }
        } else if (anio && !dentro) {
            alertas.push(`Año ${anio} fuera del periodo de la carpeta (${periodo.desde}-${periodo.hasta}): se retira.`);
            delete documento.año_edicion;
        }
    }

    // 3) Nº de issue contra la muestra de la portada.
    const m = perfil.muestra, paso = MESES_POR_NUMERO[perfil.periodicidad] || (perfil.numeracion === 'mes' ? 1 : null);
    const num = parseInt(documento.numero_issue, 10), anio = parseInt(documento.año_edicion, 10), mes = parseInt(documento.mes_publicacion, 10);
    if (m?.numero && m.anio && m.mes && paso && num && anio && mes) {
        const meses = (anio - m.anio) * 12 + (mes - m.mes);
        const esperado = m.numero + meses / paso;
        // Holgura: los números dobles y los especiales van descuadrando la cuenta con los años.
        const holgura = 3 + Math.ceil(Math.abs(meses) / 12) * 2;
        if (Math.abs(num - esperado) > holgura) {
            alertas.push(`Nº ${num} imposible para ${mes}/${anio} (la muestra ${m.numero} es de ${m.mes}/${m.anio}; se esperaba ~${Math.round(esperado)}): se retira.`);
            delete documento.numero_issue;
        }
    }
    return alertas;
}

/**
 * Clave estable de un número dentro de su cabecera, en orden de fiabilidad:
 *   AAAA-MM  (año + mes)  →  n<nº de issue>  →  AAAA (solo año)  →  null (sin fecha/nº).
 * Un número con cabecera (ISSN) pero clave null se cuelga como miembro "sin fecha" (nunca se fusiona).
 */
export function claveNumero({ año_edicion, mes_publicacion, numero_issue } = {}) {
    const a = parseInt(año_edicion, 10);
    let m = parseInt(mes_publicacion, 10);
    if (!(m >= 1 && m <= 12) && mes_publicacion) m = MES_NUM[String(mes_publicacion).toLowerCase()] ?? NaN;
    if (a && m >= 1 && m <= 12) return `${a}-${String(m).padStart(2, '0')}`;
    const ni = numero_issue != null ? String(numero_issue).trim() : '';
    if (ni) return `n${ni}`;
    if (a) return String(a);
    return null;
}

/**
 * Título de la CABECERA a partir del título de un número: le quita la coletilla de fecha/número
 * ("Historia de Iberia Vieja nº145 – oct 2015" → "Historia de Iberia Vieja"). Heurístico y prudente:
 * si el recorte dejara algo demasiado corto, devuelve el título original sin tocar.
 */
export function tituloCabecera(titulo) {
    if (!titulo) return null;
    const orig = String(titulo).trim();
    const meses = Object.keys(MES_NUM).join('|');
    let t = orig;
    // nº / núm / No. / N° / issue / # + dígitos … hasta el final
    t = t.replace(/[\s\-–—,;:|]*\b(?:n[.ºo°]?\.?|n[úu]m(?:ero)?\.?|issue|#)\s*\d+\b.*$/i, '');
    // mes(es) por nombre [+ rango] + año  ("octubre 2015", "jul-ago 2020", "oct. 2015")
    t = t.replace(new RegExp(`[\\s\\-–—,;:|]*\\b(?:${meses})\\b(?:[\\s\\-/]+(?:${meses})\\b)?[\\s.,–-]*(?:19|20)\\d{2}.*$`, 'i'), '');
    // un año suelto al final
    t = t.replace(/[\s\-–—,;:|]*\b(?:19|20)\d{2}\b\s*$/, '');
    t = t.replace(/[\s\-–—,;:|]+$/, '').trim();
    return t.length >= 2 ? t : orig;
}

// Tokens INEQUÍVOCOS de libro/serie editorial académica en un título (editoriales, colecciones de
// monografías, marcas de edición). Sirven para distinguir un LIBRO con ISSN de SERIE (p. ej. Springer
// «Graduate Texts in Physics») de un número de revista, incluso cuando el ISSN tiene un solo documento.
const RE_SERIE_LIBROS = /\b(?:springer|elsevier|birkh[aä]user|wiley|de\s*gruyter|world\s+scientific|academic\s+press|crc\s+press|cambridge\s+university\s+press|oxford\s+university\s+press|north[-\s]?holland|morgan\s+kaufmann|o'?reilly|packt|apress|manning|lecture\s+notes|graduate\s+texts|undergraduate\s+texts|texts\s+and\s+readings|progress\s+in\s+(?:mathematics|physics|nonlinear)|studies\s+in\s+systems|understanding\s+complex\s+systems|springer\s+series|universitext)\b/i;
const RE_EDICION = /\b(?:\d+(?:st|nd|rd|th)|second|third|fourth|fifth|sixth)\s+edition\b/i;

/** ¿El título delata un LIBRO/serie editorial académica (no una revista)? Señal de alta precisión. */
export function pareceSerieLibros(titulo) {
    const t = String(titulo || '');
    return RE_SERIE_LIBROS.test(t) || RE_EDICION.test(t);
}

// Editoriales que publican SOLO libros (no journals/revistas): un nombre de archivo con este prefijo/marca
// es señal FUERTE de LIBRO aunque el ejemplar lleve un ISSN de SERIE (p. ej. las colecciones de informática
// de Apress con ISSN de serie). Lista CONSERVADORA a propósito: se EXCLUYEN las que también editan revistas
// científicas (Springer, Elsevier, Wiley, Cambridge, Oxford, IEEE, CRC…), donde un prefijo en el nombre no
// distingue un libro de un número de journal. También se evitan tokens ambiguos ('que', 'osborne'…).
// Fronteras con lookarounds (NO \b): el nombre de archivo separa con «_» y «.», que son caracteres de
// palabra para \b (Wrox_Professional no casaría con \bwrox\b). Aquí la frontera es «no letra/dígito».
const RE_EDITORIAL_LIBROS = /(?<![a-z0-9])(?:apress|wrox|o'?reilly|packt|manning|peachpit|sams|no[-\s._]?starch|course[-\s._]?technology|addison[-\s._]?wesley|prentice[-\s._]?hall|microsoft[-\s._]?press|new[-\s._]?riders|sybex)(?![a-z0-9])/i;

/**
 * ¿El texto (típicamente el NOMBRE DE ARCHIVO) contiene una EDITORIAL de solo-libros? Señal fuerte de libro
 * para el discriminador: una serie de libros con ISSN (Apress, Wrox…) NO es una revista aunque no traiga ISBN.
 */
export function esEditorialDeLibros(texto) {
    return RE_EDITORIAL_LIBROS.test(String(texto || ''));
}

/**
 * Discriminador REVISTA vs SERIE-DE-LIBROS para un grupo de documentos que comparten un mismo ISSN.
 *
 * Idea: un periódico genuino = UNA cabecera (un solo título de masthead) con MUCHOS números que solo
 * difieren por fecha/número. Una serie de monografías (p. ej. «Graduate Texts in Physics», ISSN de
 * serie) = MUCHOS títulos DISTINTOS bajo el mismo ISSN. Así, contando los títulos-de-cabecera distintos
 * (normalizados con tituloCabecera, sin distinción de mayúsculas) se separan limpiamente ambos casos.
 *
 * Corroboradores para grupos pequeños/ambiguos: Dewey/LCC en todos + ningún número con fecha ⇒ libros.
 *
 * @param {Array<{titulo?:string, obra_titulo?:string, dewey?:string, lcc?:string,
 *                año_edicion?:any, mes_publicacion?:any, numero_issue?:any}>} docs
 * @returns {{clase:'revista'|'serie-libros'|'ambiguo', n:number, distintos:number, conFecha:number,
 *            conDewey:number, titulos:string[]}}
 */
export function clasificarISSN(docs = []) {
    const n = docs.length;
    const titulosSet = new Set();
    for (const d of docs) {
        const t = (tituloCabecera(d.obra_titulo || d.titulo) || '').toLowerCase().trim();
        if (t) titulosSet.add(t);
    }
    const titulos = [...titulosSet];
    const distintos = titulos.length;
    const conFecha = docs.filter(d => claveNumero(d)).length;
    const conDewey = docs.filter(d => d.dewey || d.lcc).length;
    const algunoLibro = docs.some(d => pareceSerieLibros(d.obra_titulo || d.titulo));

    let clase;
    if (algunoLibro && conFecha === 0) {
        clase = 'serie-libros';                 // título inequívoco de libro/serie y ningún nº fechado
    } else if (distintos >= 2 && distintos >= Math.ceil(n * 0.6)) {
        clase = 'serie-libros';                 // muchos títulos distintos bajo un ISSN
    } else if (distintos <= 1 && n >= 2) {
        clase = 'revista';                      // un solo masthead, varios números
    } else {
        // Grupo pequeño / señales mixtas: corroboradores.
        const pareceLibro = n > 0 && conDewey >= n && conFecha === 0;
        clase = pareceLibro ? 'serie-libros' : (distintos <= 1 ? 'revista' : 'ambiguo');
    }
    return { clase, n, distintos, conFecha, conDewey, titulos };
}
