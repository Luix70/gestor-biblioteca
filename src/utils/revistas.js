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

    let clase;
    if (distintos >= 2 && distintos >= Math.ceil(n * 0.6)) {
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
