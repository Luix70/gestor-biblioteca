/**
 * Deduce la EDITORIAL a partir del nombre de la COLECCIÓN (serie editorial). Muchas colecciones célebres son
 * marca de UNA casa concreta: «Biblioteca Clásica Gredos»→Gredos, «Áncora y Delfín»→Destino, «Letras
 * Hispánicas»→Cátedra… Es la vía MÁS BARATA para los libros sin editorial cuya colección ya está catalogada:
 * el dato ya está en Mongo, no hay que abrir el fichero ni gastar VISIÓN (que además no ve la colección, solo
 * la portada). Ver [[minimize-ai-ingestion]].
 *
 * Dos niveles:
 *   1) `editorialDeColeccionMapa` — MAPA determinista (GRATIS) de colecciones inequívocas → editorial.
 *   2) `editorialDeColeccionIA` — IA de TEXTO (barata, SIN visión) como último recurso: el modelo suele conocer
 *      la casa de una colección española por su nombre. Descarta respuestas de baja confianza o repackagers.
 */
import { conTexto, extraerJSON } from './vision.js';
import { esEditorialFalsa } from './editoriales-falsas.js';

// Mapa CONSERVADOR: solo colecciones célebres e inequívocas (la colección identifica a UNA editorial). Ante la
// duda, se deja fuera y decide la IA de texto. Los nombres no necesitan ser exactos: `resolverEditorial`
// (reclasificar-editorial) normaliza «Ediciones Destino»=«Destino», «Editorial Gredos»=«Gredos», etc.
const MAPA = [
    { re: /biblioteca\s+cl[aá]sica\s+gredos|^\s*gredos\b/i, editorial: 'Gredos' },
    { re: /[aá]ncora\s*(?:[&y]|_)\s*delf[ií]n/i, editorial: 'Ediciones Destino' },
    { re: /letras\s+hisp[aá]nicas|letras\s+universales/i, editorial: 'Cátedra' },
    { re: /\btus\s+libros\b/i, editorial: 'Anaya' },
    { re: /el\s+barco\s+de\s+vapor/i, editorial: 'SM' },
    { re: /\baustral\b/i, editorial: 'Espasa Calpe' },
    { re: /el\s+libro\s+de\s+bolsillo|alianza\s+(?:bolsillo|cien|literaria)/i, editorial: 'Alianza Editorial' },
    { re: /panorama\s+de\s+narrativas|narrativas\s+hisp[aá]nicas|\bcompactos\b/i, editorial: 'Anagrama' },
    { re: /\bandanzas\b/i, editorial: 'Tusquets' },
    { re: /biblioteca\s+de\s+autores\s+cristianos|^\s*bac\b/i, editorial: 'BAC' },
    { re: /\bbutxaca\b|\blabutxaca\b/i, editorial: 'La Butxaca' },
];

/** Nivel 1 (GRATIS): editorial de una colección famosa por el mapa determinista, o null si no está. */
export function editorialDeColeccionMapa(nombreColeccion) {
    const s = String(nombreColeccion || '').trim();
    if (!s) return null;
    for (const m of MAPA) if (m.re.test(s)) return m.editorial;
    return null;
}

/**
 * Nivel 2 (IA de TEXTO, barata): pregunta al modelo la editorial de la colección. Devuelve el nombre o null.
 * Solo acepta respuestas con confianza suficiente y que NO sean un repackager (ni cadena vacía/absurda).
 */
export async function editorialDeColeccionIA(nombreColeccion, { titulo = '', autor = '' } = {}) {
    const col = String(nombreColeccion || '').trim();
    if (col.length < 3) return null;
    const prompt = `¿De qué EDITORIAL (casa editora) es la colección o serie editorial llamada «${col}»?` +
        (titulo ? ` Un libro de esa colección es «${titulo}»${autor ? ` de ${autor}` : ''}.` : '') +
        `\nResponde SOLO un objeto JSON: {"editorial":"nombre de la editorial, o cadena vacía si no lo sabes con seguridad","confianza":0.0-1.0}.` +
        `\nNo inventes: si no estás seguro, deja "editorial" en "". NO son editoriales los grupos de maquetación de ebooks (ePubLibre, Lectulandia, DigiCat, Good Press…).`;
    let j;
    try { j = extraerJSON(await conTexto({ prompt, json: true, maxTokens: 200 })); } catch { return null; }
    if (!j) return null;
    const e = String(j.editorial || '').trim();
    const conf = Number(j.confianza) || 0;
    if (!e || e.length < 2 || conf < 0.6 || esEditorialFalsa(e)) return null;
    return e;
}
