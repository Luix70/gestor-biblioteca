import { validarISBN } from './identificadores.js';

/**
 * Parser del BLOQUE DE CATALOGACIÓN EN PUBLICACIÓN (CIP) que muchos libros imprimen en la página
 * de créditos: un registro MARC casi completo, GRATIS y de alta confianza, leído del propio fichero.
 *
 * Extrae: autor (+fechas), título/subtítulo, serie, ISBN(s) con su etiqueta (encuadernación/rol),
 * materias (LCSH), clasificación LC (050), Dewey (082), LCCN (010) y año.
 *
 * Lo más valioso para NOSOTROS: Dewey y LC → CDU por el mapeo que ya tenemos (clasificador-cdu),
 * sin IA; e ISBN(s) para identificar. Devuelve null si el texto no contiene un bloque CIP.
 */

const MARCADORES = [
    { re: /Library of Congress Cataloging[- ]?in[- ]?Publication/i, fuente: 'cip-lc' },
    { re: /British Library Cataloguing[- ]?in[- ]?Publication/i,    fuente: 'cip-bl' },
    { re: /Cataloging[- ]?in[- ]?Publication Data/i,                fuente: 'cip-lc' },
    { re: /Catalogaci[óo]n en (?:la )?publicaci[óo]n|Datos de catalogaci[óo]n/i, fuente: 'cip-es' },
];

export function parsearBloqueCatalogacion(texto) {
    if (!texto) return null;
    const marcador = MARCADORES.find(m => m.re.test(texto));
    if (!marcador) return null; // no hay bloque CIP reconocible

    const idx = texto.search(marcador.re);
    const bloque = texto.slice(idx, idx + 1500); // el bloque CIP es corto
    const lineas = bloque.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const plano = bloque.replace(/\s+/g, ' ');

    const out = {
        fuente: marcador.fuente, autor: null, autor_fechas: null, titulo: null, subtitulo: null,
        serie: null, isbns: [], materias: [], lc: null, dewey: null, lccn: null, año: null,
    };

    // ── ISBN(s) con etiqueta (encuadernación o rol): "ISBN 0-7914-5259-X (alk. paper)" ──
    const isbnRe = /ISBN[:\s-]*((?:97[89][-\s]?)?(?:[0-9][-\s]?){9}[0-9Xx])\s*(?:\(([^)]{1,40})\))?/gi;
    let m;
    const vistos = new Set();
    while ((m = isbnRe.exec(plano)) !== null) {
        const isbn = validarISBN(m[1]);
        if (isbn && !vistos.has(isbn)) { vistos.add(isbn); out.isbns.push({ isbn, etiqueta: (m[2] || '').trim() || null }); }
    }

    // ── Materias (LCSH): "1. Tema. 2. Tema. … N. Tema." hasta "I. Title" ──
    const matM = plano.match(/\b1\.\s+([\s\S]+?)\b[IVX]+\.\s*(?:Title|T[íi]tulo|Series)/i);
    if (matM) {
        out.materias = matM[1].split(/\s*\d+\.\s+/)
            .map(s => s.replace(/\s+/g, ' ').trim().replace(/\.$/, ''))
            .filter(s => s.length > 2);
    }

    // ── Clasificación LC (050): "CB245.R68 2002" ──
    const lcM = bloque.match(/\b([A-Z]{1,3}\d{1,4}(?:\.[A-Z]\d+)?)\s+(\d{4})\b/);
    if (lcM) { out.lc = lcM[1]; out.año = parseInt(lcM[2]); }

    // ── Dewey (082): "909'.09821—dc21" / "909.09821 dc21" (quita marcas de segmentación) ──
    const dM = bloque.match(/(\d{1,3}(?:[.'’]+\d+)+|\d{3})\s*[—–-]*\s*d?dc\d*/i);
    if (dM) out.dewey = dM[1].replace(/['’]/g, '');

    // ── LCCN (010): run de 8-10 dígitos (suele ir junto al Dewey) ──
    const lccnM = bloque.match(/\b(\d{8,10})\b/);
    if (lccnM) out.lccn = lccnM[1];

    // ── Serie (490): "— (SUNY series in religious studies)" / "(… series …)" ──
    const sM = plano.match(/[—–-]\s*\(([^)]{3,80})\)/) || plano.match(/\(([^)]*\bseries\b[^)]*)\)/i);
    if (sM) out.serie = sM[1].trim();

    // ── Título / subtítulo: "Título : subtítulo / mención de responsabilidad" ──
    for (const l of lineas) {
        if (/ISBN|cm\.|p\.\s*cm|Library of Congress|Cataloging/i.test(l)) continue;
        const t = l.match(/^(.+?)\s*:\s*(.+?)\s*\/\s*.+$/);
        if (t) { out.titulo = t[1].trim(); out.subtitulo = t[2].trim(); break; }
        const t2 = l.match(/^(.+?)\s*\/\s*.+$/);
        if (t2 && !out.titulo) { out.titulo = t2[1].trim(); }
    }

    // ── Autor (encabezamiento principal): "Apellido, Nombre, 1947–" ──
    for (const l of lineas) {
        if (/series|title|congress|cataloging|ISBN/i.test(l)) continue;
        const a = l.match(/^([A-ZÁÉÍÓÚÑ][^,]+,\s*[^,0-9]+?)(?:,\s*(\d{4}\s*[–-]\s*\d{0,4}))?\.?$/);
        if (a) { out.autor = a[1].trim(); out.autor_fechas = a[2] ? a[2].replace(/\s+/g, '') : null; break; }
    }

    return out;
}
