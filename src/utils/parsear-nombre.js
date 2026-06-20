// Parser de nombres de archivo. Distingue:
//   - libros: "Título - Autor1- Autor2"  → autores
//   - revistas fechadas: "Título - <Mes>-<Mes> <Año>" → año_edicion + idioma (NO son autores)
//   - el nombre ES un ISBN (p. ej. "0071769234.pdf") → identificador, NO título

import { validarISBN } from './identificadores.js';

const MESES = {
    fr: ['janvier', 'février', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'aout', 'septembre', 'octobre', 'novembre', 'décembre', 'decembre', 'janv', 'févr', 'fevr', 'avr', 'juil', 'sept', 'oct', 'nov', 'déc'],
    es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre', 'ene', 'feb', 'abr', 'ago', 'dic'],
    en: ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december', 'jan', 'apr', 'jun', 'jul', 'aug', 'sept', 'dec'],
};

/**
 * @returns { titulo, autores, año_edicion?, idioma?, esFechada }
 */
export function parsearNombre(nombreArchivo) {
    const base = String(nombreArchivo).replace(/\.[^.]+$/, '');

    // ¿El nombre del archivo ES en sí un ISBN válido? Entonces NO es un título: es un
    // identificador para consultar las APIs (el título real lo aportarán ellas).
    const isbnNombre = validarISBN(base);
    if (isbnNombre) {
        return { titulo: null, autores: [], isbn: isbnNombre, esFechada: false };
    }

    // Prefijo de fecha ISO: "2017-10-01 Direction Espagne" o "2017-10 Title"
    // Señal inequívoca de publicación periódica (el SO añade esta fecha para ordenar).
    const isoPrefix = base.match(/^((?:19|20)\d{2})[-_](\d{2})(?:[-_]\d{2})?\s+(.+)/);
    if (isoPrefix) {
        return {
            titulo: isoPrefix[3].trim(),
            autores: [],
            año_edicion: parseInt(isoPrefix[1]),
            mes_publicacion: parseInt(isoPrefix[2]),
            idioma: null,
            esFechada: true,
        };
    }

    // ¿Bloque de fecha "Mes[-Mes] Año" (señal fuerte de publicación periódica)?
    for (const [lang, meses] of Object.entries(MESES)) {
        const grupo = meses.join('|');
        const re = new RegExp(`(?:${grupo})[a-zà-ÿ]*(?:[-/\\s]+(?:${grupo})[a-zà-ÿ]*)?[\\s,.–-]*((?:19|20)\\d{2})`, 'i');
        const m = base.match(re);
        if (m) {
            let titulo = base.slice(0, m.index).replace(/[-–_\s]+$/, '').trim();
            if (!titulo) titulo = base.replace(re, '').replace(/[-–_\s]+$/, '').trim();
            return { titulo, autores: [], año_edicion: parseInt(m[1]), idioma: lang, esFechada: true, mes_publicacion: null };
        }
    }

    // Libro: separar título y autores por " - ".
    const partes = base.split(' - ');
    const autores = partes.length > 1
        ? partes.slice(1).join(' - ').split(/\s*-\s*/).map(s => s.trim()).filter(Boolean)
        : [];
    return { titulo: partes[0].trim(), autores, esFechada: false };
}
