/**
 * Buscador en la Biblioteca Nacional de España (BNE).
 *
 * Estrategia (en orden de prioridad):
 *   1. SPARQL online (datos.bne.es) — si está disponible y no bloqueado.
 *   2. Colección local `bne_cdus` (MongoDB) — volcado importado con
 *      node scripts/importar-bne.js desde monomodernas-JSON.json.
 *
 * Devuelve un objeto BneResultado con CDU(s) y los campos adicionales
 * que BNE conoce y que no siempre están en las APIs externas:
 *   paginas, dimensiones, lengua, tema, genero_forma, fecha.
 */
import axios from 'axios';
import { esErrorDeRed } from '../errores.js';
import { conectarDB } from '../database.js';
import { variantesISBN } from './identificadores.js';

const SPARQL_BNE = 'https://datos.bne.es/sparql';
const TIMEOUT = Number(process.env.BNE_TIMEOUT_MS || 12000);
const COL_LOCAL = 'bne_cdus';

// Circuit-breaker de sesión: desactiva SPARQL tras la primera respuesta no-JSON.
let sparqlDesactivado = false;

function normalizarCDU(raw) {
    return String(raw || '').trim().replace(/^\(|\)$/g, '').trim();
}

async function buscarEnSPARQL(isbnLimpio) {
    if (sparqlDesactivado) return null;
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
        sparqlDesactivado = true;
        console.warn('⚠️  BNE SPARQL: respuesta no-JSON — usando solo caché local (MongoDB).');
        return null;
    }
    const bindings = res.data?.results?.bindings || [];
    const cdus = bindings.map(b => normalizarCDU(b.cdu?.value || '')).filter(Boolean);
    return cdus.length > 0 ? { cdus } : null;
}

async function buscarEnLocal(isbnLimpio) {
    const db = await conectarDB();
    const col = db.collection(COL_LOCAL);
    // Primero intento exacto (aprovecha el índice único); luego la variante 10↔13.
    let doc = await col.findOne({ isbn: isbnLimpio });
    if (!doc) {
        const variantes = variantesISBN(isbnLimpio).filter(v => v !== isbnLimpio);
        for (const v of variantes) {
            doc = await col.findOne({ isbn: v });
            if (doc) break;
        }
    }
    if (!doc || !doc.cdus?.length) return null;
    return {
        cdus:         doc.cdus,
        paginas:      doc.paginas      || null,
        dimensiones:  doc.dimensiones  || null,
        lengua:       doc.lengua       || null,
        tema:         doc.tema         || null,
        genero_forma: doc.genero_forma || null,
        fecha:        doc.fecha        || null,
    };
}

/**
 * Busca el registro BNE para un ISBN.
 *
 * @returns {Promise<BneResultado|null>}
 *   null  → no encontrado o error
 *   objeto → { cdus: string[], paginas?, dimensiones?, lengua?, tema?, genero_forma?, fecha? }
 *
 * @typedef {{ cdus: string[], paginas?: number, dimensiones?: string,
 *             lengua?: string, tema?: string, genero_forma?: string, fecha?: string }} BneResultado
 */
export async function buscarEnBNE(isbn) {
    if (!isbn) return null;
    const isbnLimpio = String(isbn).replace(/-/g, '');

    try {
        const r = await buscarEnSPARQL(isbnLimpio);
        if (r) return r;
    } catch (e) {
        if (!esErrorDeRed(e) && e.response?.status && e.response.status < 500) {
            sparqlDesactivado = true;
            console.warn(`⚠️  BNE SPARQL HTTP ${e.response.status}: desactivado, usando caché local.`);
        }
    }

    try {
        return await buscarEnLocal(isbnLimpio);
    } catch (eMongo) {
        console.warn(`⚠️  BNE local: error Mongo (${eMongo.message}): omitida.`);
        return null;
    }
}

/**
 * Compatibilidad con código anterior que espera string[].
 * Preferir buscarEnBNE() para acceder a todos los campos.
 */
export async function buscarCDUsEnBNE(isbn) {
    const r = await buscarEnBNE(isbn);
    return r ? r.cdus : (r === null ? null : []);
}
