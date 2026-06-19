/**
 * Buscador en la Biblioteca Nacional de España (BNE).
 *
 * Estrategia (en orden de prioridad):
 *   1. Consulta SPARQL al nuevo endpoint oficial: https://bne.es
 *      Propiedades: bne:P3013 = ISBN, bne:P3011 = CDU, bne:P3001 = título.
 *   2. Si el SPARQL falla (403/timeout) → consulta la colección local `bne_cdus`
 *      (importada desde el volcado MARC21 de datos abiertos de la BNE).
 *
 * Para importar el volcado MARC21: node scripts/importar-bne.js
 */
import axios from 'axios';
import { esErrorDeRed } from '../errores.js';
import { conectarDB } from '../database.js';

const SPARQL_BNE = 'https://bne.es';
const TIMEOUT = Number(process.env.BNE_TIMEOUT_MS || 12000);
const COL_LOCAL = 'bne_cdus';

function normalizarCDU(raw) {
    return String(raw || '').trim().replace(/^\(|\)$/g, '').trim();
}

/** Búsqueda SPARQL contra el endpoint oficial de la BNE. */
async function buscarEnSPARQL(isbnLimpio) {
    const query = `
PREFIX bne: <http://bne.es>
SELECT DISTINCT ?cdu WHERE {
  ?libro bne:P3013 "${isbnLimpio}" .
  ?libro bne:P3011 ?cdu .
}
LIMIT 10`;
    const res = await axios.post(SPARQL_BNE, query, {
        timeout: TIMEOUT,
        headers: {
            'Content-Type': 'application/sparql-query',
            Accept: 'application/sparql-results+json',
        },
    });
    const bindings = res.data?.results?.bindings || [];
    return bindings.map(b => normalizarCDU(b.cdu?.value || '')).filter(Boolean);
}

/** Búsqueda en la colección MongoDB local importada del volcado BNE. */
async function buscarEnLocal(isbnLimpio) {
    const db = await conectarDB();
    const doc = await db.collection(COL_LOCAL).findOne({ isbn: isbnLimpio });
    return doc?.cdus || [];
}

/**
 * Busca los códigos CDU que la BNE asigna a un ISBN.
 * @returns {Promise<string[]|null>} Array de CDUs, vacío si no encontrado, null en error de red.
 */
export async function buscarCDUsEnBNE(isbn) {
    if (!isbn) return null;
    const isbnLimpio = String(isbn).replace(/-/g, '');

    // Intento 1: SPARQL online
    try {
        const cdus = await buscarEnSPARQL(isbnLimpio);
        if (cdus.length > 0) return cdus;
        // Si la respuesta llega pero no hay resultados, probamos MongoDB local
    } catch (eSPARQL) {
        if (!esErrorDeRed(eSPARQL) && eSPARQL.response?.status && eSPARQL.response.status < 500) {
            // Error de protocolo (4xx ≠ 403/429): no insistir
            console.warn(`⚠️  BNE SPARQL HTTP ${eSPARQL.response.status}: omitido.`);
        } else {
            console.warn(`⚠️  BNE SPARQL inalcanzable (${eSPARQL.code || eSPARQL.response?.status}): intentando caché local.`);
        }
    }

    // Intento 2: caché local (volcado MARC21)
    try {
        return await buscarEnLocal(isbnLimpio);
    } catch (eMongo) {
        // Error de Mongo no debe abortar la ingesta
        console.warn(`⚠️  BNE local: error Mongo (${eMongo.message}): omitida.`);
        return null;
    }
}
