/**
 * Buscador en la Library of Congress (LOC) — fuente de Dewey y LCC para libros en inglés.
 *
 * Consulta el catálogo público de la LOC por ISBN y devuelve los códigos de
 * clasificación Dewey (DDC) y Library of Congress (LCC). Éstos se pasan luego al
 * clasificador CDU para convertirlos a CDU.
 *
 * API: https://catalog.loc.gov/vwebv/search (devuelve HTML), o bien
 *      https://lccn.loc.gov/<lccn>.mods.xml (MODS con Dewey y LCC).
 *
 * Usamos la API de catálogo vía formato JSON (SRU):
 *   https://catalog.loc.gov/vwebv/search?searchCode=ISAB&searchArg=<ISBN>&format=json
 *
 * Para libros marcados por OpenLibrary con LCC, obtenemos el LCCN y descargamos MODS.
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { esErrorDeRed } from '../errores.js';

const BASE_SRU = 'https://catalog.loc.gov/vwebv/search';
const BASE_MODS = 'https://lccn.loc.gov';
const TIMEOUT = Number(process.env.LOC_TIMEOUT_MS || 15000);

/**
 * Descarga el registro MODS de un LCCN y extrae Dewey y LCC.
 */
async function modsDesdeLC(lccn) {
    if (!lccn) return null;
    const id = String(lccn).trim().replace(/\s+/g, '');
    try {
        const res = await axios.get(`${BASE_MODS}/${id}.mods.xml`, { timeout: TIMEOUT });
        const $ = cheerio.load(res.data, { xmlMode: true });
        const dewey = $('classification[authority="ddc"]').first().text().trim() || null;
        const lcc = $('classification[authority="lcc"]').first().text().trim() || null;
        return (dewey || lcc) ? { dewey, lcc } : null;
    } catch { return null; }
}

/**
 * Busca el Dewey/LCC de un ISBN en el catálogo de la LOC.
 * @returns {Promise<{dewey:string|null, lcc:string|null}|null>}
 *   null = error de red (degradación elegante), {} vacío = no encontrado.
 */
export async function buscarEnLOC({ isbn, lccn }) {
    // Vía rápida: si ya tenemos el LCCN (p.ej. de OpenLibrary), descarga el MODS directamente.
    if (lccn) {
        try {
            const r = await modsDesdeLC(lccn);
            if (r) return r;
        } catch { /* sigue con búsqueda por ISBN */ }
    }

    if (!isbn) return null;
    const isbnLimpio = String(isbn).replace(/-/g, '');

    try {
        // El SRU de la LOC devuelve una página HTML con registros MARC embebidos en JSON.
        // Usamos el endpoint de búsqueda con formato brief para obtener el LCCN y luego
        // descargamos el MODS completo.
        const res = await axios.get(BASE_SRU, {
            params: {
                searchCode: 'ISAB',
                searchArg: isbnLimpio,
                searchType: '1',
                recCount: '1',
                filter: 'all',
            },
            timeout: TIMEOUT,
        });

        // El resultado es HTML; buscamos el enlace al registro para extraer el LCCN.
        const $ = cheerio.load(res.data);
        const lccnEncontrado = $('a[href*="bibId="]').first().attr('href')?.match(/bibId=(\d+)/)?.[1];
        if (!lccnEncontrado) return {};

        const mods = await modsDesdeLC(lccnEncontrado);
        return mods || {};
    } catch (e) {
        if (esErrorDeRed(e)) {
            console.warn(`⚠️  LOC inalcanzable (${e.code || e.response?.status}): omitido.`);
            return null;
        }
        return {};
    }
}
