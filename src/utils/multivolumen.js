import path from 'path';
import { validarISBN } from './identificadores.js';

/**
 * OBRAS MULTIVOLUMEN — discriminación e identificación.
 * Una obra multivolumen es UNA obra repartida en N tomos, con su propio "ISBN de obra" además
 * del ISBN de cada tomo. Distinta de una colección (serie editorial de obras independientes).
 *
 * Este módulo solo PARSEA (funciones puras, testeables); la decisión de tipo la toma el
 * discriminador del vigilante con esta info.
 */

/** Numeral romano (I, IV, XII…) o árabe → entero, o null. */
export function aArabigo(s) {
    if (s == null) return null;
    const t = String(s).trim();
    if (/^\d{1,4}$/.test(t)) return parseInt(t, 10);
    const u = t.toUpperCase();
    if (!/^[IVXLCDM]{1,7}$/.test(u)) return null;
    const R = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
    let total = 0;
    for (let i = 0; i < u.length; i++) {
        const v = R[u[i]], n = R[u[i + 1]] || 0;
        total += v < n ? -v : v;
    }
    return total || null;
}

// Palabras "tomo/volumen" en varios idiomas (ES/EN/FR/DE/PT/IT) seguidas de su número.
const VOL_RE = /\b(?:vols?|vol[úu]men|volume|tomo|tome|band|teil|livre|livro|fasc[íi]culo)\b\.?\s*([0-9]{1,3}|[IVXLCDM]{1,7})\b/i;

/**
 * Detecta "Vol. N - Título" en un nombre de fichero (o título). Devuelve
 *   { numero, titulo, etiqueta } | null
 * 'titulo' es el subtítulo del tomo (lo que sigue al número), si lo hay.
 */
export function parsearVolumen(nombre) {
    const base = String(nombre || '').replace(/\.[^.]+$/, '');
    const m = base.match(VOL_RE);
    if (!m) return null;
    const numero = aArabigo(m[1]);
    if (!numero) return null;
    const resto = base.slice(m.index + m[0].length).replace(/^[\s\-–—:._·]+/, '').trim();
    return { numero, titulo: resto || null, etiqueta: m[0].trim() };
}

// ISBN seguido (misma línea) de un rol entre paréntesis: "ISBN 84-03-04989-7 (obra completa)".
const ISBN_ROL_RE = /(?:ISBN(?:-1[03])?:?\s*)?((?:97[89][-\s]?)?(?:[0-9][-\s]?){9}[0-9Xx])\s*\(([^)]{1,40})\)/g;

/**
 * Extrae ISBN con su ROL desde el texto de créditos de una obra multivolumen.
 *   "ISBN 84-03-04989-7 (obra completa)" → { isbn, rol:'obra' }
 *   "ISBN 84-03-04071-7 (tomo I)"        → { isbn, rol:'volumen', numero:1 }
 * Devuelve [] si no hay ISBN con rol reconocible.
 */
export function extraerISBNsConRol(texto) {
    if (!texto) return [];
    const out = [];
    let m;
    ISBN_ROL_RE.lastIndex = 0;
    while ((m = ISBN_ROL_RE.exec(texto)) !== null) {
        const isbn = validarISBN(m[1]);
        if (!isbn) continue;
        const etq = m[2].trim();
        let rol = 'desconocido', numero = null;
        if (/obra\s*completa|o\.?\s*c\.?\b|complete\s*(work|set)?|\bset\b|colecci[óo]n completa/i.test(etq)) {
            rol = 'obra';
        } else {
            const mv = etq.match(/(?:tomo|vols?|vol[úu]men|volume|tome|t|band|parte?)\.?\s*([0-9]{1,3}|[ivxlcdm]{1,7})/i);
            if (mv) { rol = 'volumen'; numero = aArabigo(mv[1]); }
        }
        out.push({ isbn, rol, numero, etiqueta: etq });
    }
    return out;
}

/**
 * Decide si un conjunto de documentos (rutas) es UNA obra multivolumen y, en tal caso, devuelve
 *   { titulo_obra, carpeta, volumenes: [{ ruta, numero, titulo }] }
 * Criterio: ≥2 documentos con patrón "Vol. N" que DOMINAN el conjunto (≥ mitad) y comparten la
 * carpeta que los contiene (esa carpeta da el título de la obra). null si no aplica.
 */
export function discriminarMultivolumen(rutas) {
    const vols = (rutas || [])
        .map(r => ({ ruta: r, ...(parsearVolumen(path.basename(r)) || {}) }))
        .filter(v => v.numero != null);
    if (vols.length < 2 || vols.length < (rutas.length / 2)) return null;

    // Números distintos (evita que 3 ficheros "Vol. 1" cuenten como 3 volúmenes).
    const numeros = new Set(vols.map(v => v.numero));
    if (numeros.size < 2) return null;

    // La carpeta que contiene a los volúmenes da el título de la obra (la más profunda común).
    const carpetas = [...new Set(vols.map(v => path.dirname(v.ruta)))];
    const carpeta = carpetas.length === 1 ? carpetas[0] : carpetas.sort((a, b) => b.length - a.length)[0];

    return {
        titulo_obra: path.basename(carpeta),
        carpeta,
        volumenes: vols.sort((a, b) => a.numero - b.numero).map(v => ({ ruta: v.ruta, numero: v.numero, titulo: v.titulo })),
    };
}
