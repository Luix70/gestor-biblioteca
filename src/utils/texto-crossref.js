/**
 * Texto de Crossref LIMPIO. Las editoriales depositan títulos con entidades HTML y marcas de formato
 * («Measure, Integration &amp; Real Analysis», «<i>p</i>-adic numbers», «C<sup>*</sup>-algebras»): medido el
 * 1-oct, 12.270 títulos de crossref.db. Sin limpiar entrarían así en las fichas.
 *
 * Lo usan el ETL (scripts/etl-crossref.js, para los próximos volcados) y la lectura de crossref.db
 * (utils/crossref-local.js, para el índice ya construido).
 */
const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…' };

/** Quita etiquetas (<i>, <sup>, <scp>…), traduce entidades (&amp;, &#39;, &#x2019;) y junta espacios. */
export function limpiarTextoCrossref(valor) {
    if (valor === null || valor === undefined) return valor;
    let s = String(valor);
    // Dos vueltas: algunas vienen doblemente escapadas («&amp;amp;»).
    for (let vuelta = 0; vuelta < 2 && s.includes('&'); vuelta++) {
        s = s
            .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
            .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
            .replace(/&([a-z]+);/gi, (m, nombre) => ENTIDADES[nombre.toLowerCase()] ?? m);
    }
    return s.replace(/<\/?[a-z][a-z0-9:-]*[^>]*>/gi, '').replace(/\s+/g, ' ').trim();
}
