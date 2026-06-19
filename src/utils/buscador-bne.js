/**
 * Buscador en la Biblioteca Nacional de España (BNE).
 *
 * Consulta el endpoint SPARQL de datos.bne.es por ISBN y extrae los códigos CDU
 * asignados por catalogadores profesionales de la BNE.
 *
 * Endpoint: http://datos.bne.es/sparql
 * Modelo de datos: el BNE usa propiedades propias bajo http://datos.bne.es/def/
 *   P1001 → ISBN
 *   P4020 → CDU (puede haber varios por obra)
 */
import axios from 'axios';
import { esErrorDeRed } from '../errores.js';

const SPARQL = 'http://datos.bne.es/sparql';
const TIMEOUT = Number(process.env.BNE_TIMEOUT_MS || 15000);

function normalizarCDU(raw) {
    // La BNE a veces devuelve "616.89" o "(616.89)" o "616.89:82-3"
    // Quitamos paréntesis externos y espacios, pero conservamos el código completo.
    return String(raw).trim().replace(/^\(|\)$/g, '').trim();
}

/**
 * Busca los códigos CDU que la BNE asigna a un ISBN.
 * @returns {Promise<string[]|null>} Array de CDUs (vacío si no encontrado) o null en error de red.
 */
export async function buscarCDUsEnBNE(isbn) {
    if (!isbn) return null;
    const isbnLimpio = String(isbn).replace(/-/g, '');

    const query = `
PREFIX bnedef: <http://datos.bne.es/def/>
SELECT DISTINCT ?cdu WHERE {
  ?rec bnedef:P1001 "${isbnLimpio}" .
  ?rec bnedef:P4020 ?cdu .
}
LIMIT 10`;

    try {
        const res = await axios.get(SPARQL, {
            params: { query, format: 'application/sparql-results+json' },
            timeout: TIMEOUT,
            headers: { Accept: 'application/sparql-results+json' },
        });

        const bindings = res.data?.results?.bindings || [];
        const cdus = bindings
            .map(b => normalizarCDU(b.cdu?.value || ''))
            .filter(Boolean);
        return cdus; // array vacío = ISBN no en BNE
    } catch (e) {
        if (esErrorDeRed(e)) {
            console.warn(`⚠️  BNE SPARQL inalcanzable (${e.code || e.response?.status}): omitido.`);
            return null; // error de red → degradación elegante
        }
        return []; // error de protocolo (mal query, etc.) → tratar como no encontrado
    }
}
