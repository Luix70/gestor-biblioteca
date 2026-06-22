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
    // 'prefijo' = título de la OBRA (lo que va ANTES de "Vol. N"), útil cuando un tomo se cataloga
    // suelto (sin contexto de carpeta): da nombre a la obra sin el sufijo del tomo.
    const prefijo = base.slice(0, m.index).replace(/[\s\-–—:._·,]+$/, '').trim();
    return { numero, titulo: resto || null, etiqueta: m[0].trim(), prefijo: prefijo || null };
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
            // Incluye la forma abreviada "v. N" / "v N" (créditos de Gale: "ISBN … (v. 1 : alk. paper)"),
            // además de tomo/vol/volume/tome/band/parte y "t." . El separador (espacio, ":", "-") puede
            // faltar; exige límite tras la palabra para no casar dentro de otra (p. ej. la "v" de "vol").
            const mv = etq.match(/\b(?:tomo|vol[úu]men|volume|vols?|tome|band|teil|parte?|[tv])\b\.?\s*([0-9]{1,3}|[ivxlcdm]{1,7})\b/i);
            if (mv) { rol = 'volumen'; numero = aArabigo(mv[1]); }
        }
        out.push({ isbn, rol, numero, etiqueta: etq });
    }
    return out;
}

/**
 * Total de tomos DECLARADO en el nombre de la obra/carpeta, si lo indica: "Vol 1-3", "Vols. 1-4",
 * "(3 vols)", "in 4 volumes", "obra completa en 5 tomos". Devuelve el entero o null.
 */
export function totalDeclarado(nombre) {
    const s = String(nombre || '');
    let m = s.match(/\b(?:vols?|vol[úu]menes|tomos?|volumes?)\.?\s*\d{1,3}\s*[-–—/]\s*(\d{1,3})\b/i);
    if (m) return parseInt(m[1], 10) || null;
    m = s.match(/\b(\d{1,3})\s*(?:vol[úu]menes|vols?|tomos?|volumes?)\b/i)
        || s.match(/\ben\s+(\d{1,3})\s+(?:tomos?|vol[úu]menes)\b/i);
    if (m) return parseInt(m[1], 10) || null;
    return null;
}

/**
 * Discrimina TODAS las obras multivolumen presentes en un conjunto de documentos, AGRUPÁNDOLAS POR
 * SU CARPETA INMEDIATA. Cada carpeta con ≥2 tomos de números DISTINTOS que la dominan (≥ mitad de
 * sus documentos) es UNA obra independiente — así dos obras soltadas en subcarpetas distintas del
 * mismo drop NO se funden en una sola con números duplicados (bug real: 1,1,2,2,3,3,4).
 *
 * @returns {{ obras: Array<{titulo_obra, carpeta, total, volumenes: [{ruta,numero,titulo}]}>,
 *             resto: string[] }}  'resto' = documentos que no pertenecen a ninguna obra.
 */
export function discriminarMultivolumenes(rutas) {
    const lista = rutas || [];
    const conVol = [];
    const resto = [];
    for (const r of lista) {
        const v = parsearVolumen(path.basename(r));
        if (v && v.numero != null) conVol.push({ ruta: r, ...v });
        else resto.push(r);
    }

    // Agrupar los candidatos por su carpeta inmediata.
    const porCarpeta = new Map();
    for (const v of conVol) {
        const c = path.dirname(v.ruta);
        if (!porCarpeta.has(c)) porCarpeta.set(c, []);
        porCarpeta.get(c).push(v);
    }

    const obras = [];
    for (const [carpeta, vols] of porCarpeta) {
        const numeros = new Set(vols.map(v => v.numero));
        const docsEnCarpeta = lista.filter(r => path.dirname(r) === carpeta).length;
        const esObra = vols.length >= 2 && numeros.size >= 2 && vols.length >= docsEnCarpeta / 2;
        if (esObra) {
            const ordenados = vols.sort((a, b) => a.numero - b.numero);
            obras.push({
                titulo_obra: path.basename(carpeta),
                carpeta,
                total: totalDeclarado(path.basename(carpeta)) || Math.max(...numeros),
                volumenes: ordenados.map(v => ({ ruta: v.ruta, numero: v.numero, titulo: v.titulo })),
            });
        } else {
            for (const v of vols) resto.push(v.ruta); // no es obra: vuelven al resto
        }
    }
    return { obras, resto };
}

/**
 * Compat: una sola obra (la primera detectada) o null. La discriminación real, que separa varias
 * obras por carpeta, es discriminarMultivolumenes().
 */
export function discriminarMultivolumen(rutas) {
    const { obras } = discriminarMultivolumenes(rutas);
    return obras[0] || null;
}
