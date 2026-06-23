/**
 * Buscador en la Bibliothèque nationale de France (BnF).
 *
 * La BnF expone un SRU público (Search/Retrieve via URL) que devuelve registros UNIMARC.
 * Mismo protocolo que la DNB (ver buscador-dnb.js), pero la BnF da el registro COMPLETO,
 * así que lo aprovechamos como fallback de huecos para libros francófonos + Dewey.
 *
 *   SRU: https://catalogue.bnf.fr/api/SRU
 *   query CQL: bib.isbn all "<isbn>"   ·   recordSchema=unimarcxchange
 *
 * Campos UNIMARC que extraemos (confirmados contra registros reales):
 *   200$a título · 200$e subtítulo · 700/701 $a,$b autores · 210$c editorial · 210$d año
 *   101$a lengua (ISO 639-2/B → ISO 639-1) · 215$a páginas · 215$d dimensiones · 225$a colección
 *   676$a Dewey (presente en buena parte de los registros) → alimenta la caché Dewey→CDU
 *   675$a CDU (rara vez poblado, pero si está es oro)
 * El campo 686 ("Cadre de classement de la Bibliographie nationale française") NO es Dewey/CDU
 * (sus números 8xx lo parecen pero son un esquema de estanterías propio): se IGNORA a propósito.
 *
 * Degradación elegante: error de red → null (se omite); ISBN no hallado → {} ; hallado → objeto.
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { esErrorDeRed } from '../errores.js';

const SRU = 'https://catalogue.bnf.fr/api/SRU';
const TIMEOUT = Number(process.env.BNF_TIMEOUT_MS || 15000);

// UNIMARC 101$a usa códigos ISO 639-2/B (3 letras). Mapeo a ISO 639-1 (2 letras) como el resto
// del pipeline; si no está en la tabla, se recorta a 2 letras como último recurso.
const LANG = {
    fre: 'fr', fra: 'fr', eng: 'en', spa: 'es', ger: 'de', deu: 'de', ita: 'it', por: 'pt',
    dut: 'nl', nld: 'nl', lat: 'la', grc: 'el', gre: 'el', rus: 'ru', cat: 'ca', glg: 'gl',
    baq: 'eu', eus: 'eu', jpn: 'ja', chi: 'zh', zho: 'zh', ara: 'ar', pol: 'pl',
};
function idioma639(cod) {
    const c = String(cod || '').trim().toLowerCase();
    return LANG[c] || (c ? c.slice(0, 2) : null);
}

// Recorta la puntuación ISBD final típica de MARC (" :", " /", " ;", " ,", " =", ".").
function limpiar(s) {
    const t = String(s == null ? '' : s).replace(/\s*[\/:;,.=]\s*$/, '').trim();
    return t || null;
}
function deweyLimpio(s) {
    if (!s) return null;
    // "390.400 0944" (Dewey + tabla geográfica) → "390.400"; "823.914 [22]" → "823.914".
    const t = String(s).replace(/\s*[\[{(].*/, '').trim().split(/\s+/)[0];
    return t || null;
}
const anioDe = (s) => { const m = String(s || '').match(/(1[4-9]\d{2}|20\d{2})/); return m ? Number(m[1]) : null; };
// 215$a ("97 p.", "1 vol. (152 p.)", "2 vol."): preferimos el nº seguido de "p"; si solo dice
// "N vol." sin páginas, devolvemos null (el "N" cuenta volúmenes, no páginas).
const paginasDe = (s) => {
    const t = String(s || '');
    const mp = t.match(/(\d{1,5})\s*(?:p\b|pages?|ff?\b|h\b|col\b)/i);
    if (mp) return Number(mp[1]);
    if (/\bvol\b|\bv\.|\btomes?\b|\bbd\b/i.test(t)) return null;
    const m = t.match(/(\d{1,5})/);
    return m ? Number(m[1]) : null;
};

/**
 * Busca un registro en la BnF por ISBN. Admite varios candidatos (10/13); la BnF indexa
 * un libro por una sola de sus formas, así que se prueba cada uno hasta el primer acierto.
 * @returns {Promise<object|null>} null=error de red · {}=no hallado · objeto=registro
 */
export async function buscarEnBNF({ isbns }) {
    const candidatos = [...new Set((Array.isArray(isbns) ? isbns : [isbns])
        .filter(Boolean).map(s => String(s).replace(/-/g, '')))];
    if (candidatos.length === 0) return {};

    for (const isbn of candidatos) {
        let res;
        try {
            res = await axios.get(SRU, {
                params: {
                    version: '1.2', operation: 'searchRetrieve',
                    query: `bib.isbn all "${isbn}"`,
                    recordSchema: 'unimarcxchange', maximumRecords: '1',
                },
                timeout: TIMEOUT,
            });
        } catch (e) {
            if (esErrorDeRed(e)) {
                console.warn(`⚠️  BnF inalcanzable (${e.code || e.response?.status}): omitida.`);
                return null;
            }
            continue; // error puntual de este ISBN → probar el siguiente candidato
        }

        // La BnF namespacia los elementos (srw:, mxc:…); cheerio en modo XML no resuelve prefijos,
        // así que los quitamos antes de parsear para poder seleccionar por nombre simple.
        const xml = String(res.data).replace(/<(\/?)[A-Za-z0-9]+:/g, '<$1');
        const $ = cheerio.load(xml, { xmlMode: true });
        if ((parseInt($('numberOfRecords').first().text(), 10) || 0) === 0) continue;

        const rec = $('record').first();
        const sub = (tag, code) => rec.find(`datafield[tag="${tag}"] subfield[code="${code}"]`).first().text().trim();

        // Autores: 700 (principal) + 701 (secundarios). $a=apellido, $b=nombre → "Apellido, Nombre".
        const autores = [];
        rec.find('datafield[tag="700"], datafield[tag="701"]').slice(0, 5).each((i, df) => {
            const a = $(df).find('subfield[code="a"]').first().text().trim();
            const b = $(df).find('subfield[code="b"]').first().text().trim();
            const nombre = limpiar([a, b].filter(Boolean).join(', '));
            if (nombre) autores.push(nombre);
        });

        return {
            isbn: limpiar(sub('010', 'a')) || isbn,
            titulo: limpiar(sub('200', 'a')),
            subtitulo: limpiar(sub('200', 'e')),
            autores,
            editorial: limpiar(sub('210', 'c')),
            año_edicion: anioDe(sub('210', 'd')),
            idioma: idioma639(sub('101', 'a')),
            paginas: paginasDe(sub('215', 'a')),
            dimensiones: limpiar(sub('215', 'd')),
            coleccion_nombre: limpiar(sub('225', 'a')),
            dewey: deweyLimpio(sub('676', 'a')),
            cdu: limpiar(sub('675', 'a')),
        };
    }
    return {}; // ningún candidato halló registro
}
