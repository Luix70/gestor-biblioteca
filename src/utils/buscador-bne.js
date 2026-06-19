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

const SPARQL_BNE = 'https://datos.bne.es/sparql';
const TIMEOUT = Number(process.env.BNE_TIMEOUT_MS || 12000);
const COL_LOCAL = 'bne_cdus';

// Circuit-breaker de sesión: tras la primera respuesta no-JSON del SPARQL
// (p.ej. Cloudflare devuelve HTML) se desactiva para no desperdiciar una
// petición HTTP en cada búsqueda.
let sparqlDesactivado = false;

function normalizarCDU(raw) {
    return String(raw || '').trim().replace(/^\(|\)$/g, '').trim();
}

/** Búsqueda SPARQL contra el endpoint de la BNE (puede estar bloqueado por Cloudflare). */
async function buscarEnSPARQL(isbnLimpio) {
    if (sparqlDesactivado) return [];
    const query = `
PREFIX bne: <http://datos.bne.es/def/>
SELECT DISTINCT ?cdu WHERE {
  ?libro bne:P1001 "${isbnLimpio}" .
  ?libro bne:P4020 ?cdu .
}
LIMIT 10`;
    const res = await axios.post(SPARQL_BNE, new URLSearchParams({ query }), {
        timeout: TIMEOUT,
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/sparql-results+json',
        },
    });
    const ct = res.headers['content-type'] || '';
    if (!ct.includes('json')) {
        // El endpoint devuelve HTML (Cloudflare o web normal): desactivar para esta sesión.
        sparqlDesactivado = true;
        console.warn('⚠️  BNE SPARQL: respuesta no-JSON — usando solo caché local (MongoDB).');
        return [];
    }
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
 * Estrategia: SPARQL online (si disponible) → MongoDB local (volcado BNE importado).
 * @returns {Promise<string[]|null>} Array de CDUs, vacío si no encontrado, null en error.
 */
export async function buscarCDUsEnBNE(isbn) {
    if (!isbn) return null;
    const isbnLimpio = String(isbn).replace(/-/g, '');

    // Intento 1: SPARQL (se desactiva solo tras primer fallo no-JSON)
    try {
        const cdus = await buscarEnSPARQL(isbnLimpio);
        if (cdus.length > 0) return cdus;
    } catch (e) {
        if (!esErrorDeRed(e) && e.response?.status && e.response.status < 500) {
            sparqlDesactivado = true;
            console.warn(`⚠️  BNE SPARQL HTTP ${e.response.status}: desactivado, usando caché local.`);
        }
        // Errores de red: silencioso, caemos a local
    }

    // Intento 2: caché local (volcado BNE importado en MongoDB)
    try {
        return await buscarEnLocal(isbnLimpio);
    } catch (eMongo) {
        console.warn(`⚠️  BNE local: error Mongo (${eMongo.message}): omitida.`);
        return null;
    }
}
