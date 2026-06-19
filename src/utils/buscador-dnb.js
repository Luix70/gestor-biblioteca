/**
 * Buscador en la Deutsche Nationalbibliothek (DNB).
 *
 * La DNB expone un endpoint SRU público que devuelve MARCXML con DDC (campo 082).
 * Es útil para libros en alemán y para muchos títulos en inglés/europeos que
 * no están en OpenLibrary o cuyo Dewey no está en OL.
 *
 * SRU: https://services.dnb.de/sru/dnb
 * MARC 082 $a = DDC,  MARC 080 $a = CDU (rara vez presente)
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { esErrorDeRed } from '../errores.js';

const SRU = 'https://services.dnb.de/sru/dnb';
const TIMEOUT = Number(process.env.DNB_TIMEOUT_MS || 15000);

/**
 * Busca el Dewey/CDU de un ISBN en el catálogo de la DNB.
 * @returns {Promise<{dewey:string|null, cdu:string|null}|null>}
 *   null = error de red (degradación elegante)
 *   {} vacío = ISBN no encontrado en DNB
 */
export async function buscarEnDNB({ isbn }) {
    if (!isbn) return null;
    const isbnLimpio = String(isbn).replace(/-/g, '');

    try {
        const res = await axios.get(SRU, {
            params: {
                version: '1.1',
                operation: 'searchRetrieve',
                query: `isbn=${isbnLimpio}`,
                recordSchema: 'MARC21-xml',
                maximumRecords: '1',
            },
            timeout: TIMEOUT,
        });

        const $ = cheerio.load(res.data, { xmlMode: true });
        const num = parseInt($('numberOfRecords').text()) || 0;
        if (num === 0) return {};

        const rec = $('record').first();

        // DDC: campo 082 subfield $a (puede venir limpio o con edición: "823.914 [22]" → tomamos solo el código)
        const deweyRaw = rec.find('datafield[tag="082"] subfield[code="a"]').first().text().trim();
        const dewey = deweyRaw ? deweyRaw.replace(/\s*[\[{(].*/, '').trim() || null : null;

        // CDU: campo 080 subfield $a (poco frecuente en DNB pero lo capturamos)
        const cdu = rec.find('datafield[tag="080"] subfield[code="a"]').first().text().trim() || null;

        // LCC: campo 050 subfield $a
        const lcc = rec.find('datafield[tag="050"] subfield[code="a"]').first().text().trim() || null;

        if (!dewey && !cdu && !lcc) return {};
        return { dewey: dewey || null, cdu: cdu || null, lcc: lcc || null };
    } catch (e) {
        if (esErrorDeRed(e)) {
            console.warn(`⚠️  DNB inalcanzable (${e.code || e.response?.status}): omitida.`);
            return null;
        }
        return {};
    }
}
