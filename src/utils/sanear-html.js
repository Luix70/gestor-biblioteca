/**
 * SANEADOR DE HTML para las NOTAS de las fichas de lectura (texto enriquecido escrito por el admin).
 *
 * Aunque el contenido lo escribe el propietario, se sanea igualmente (defensa en profundidad): el HTML se
 * ALMACENA y se re-inyecta en la página, así que un `<script>` o un `onerror=` guardados serían un XSS
 * persistente. Se trabaja con LISTA BLANCA: solo sobreviven las etiquetas de formato de texto y sus atributos
 * seguros; todo lo demás se DESENVUELVE (se conserva su texto, no el marcado) o se elimina (script/style).
 *
 * Reutiliza cheerio (ya es dependencia; C-libre, apto para el Atom). El editor del cliente usa
 * execCommand con styleWithCSS=false → el formato llega como etiquetas SEMÁNTICAS (<b>/<i>/<h2>…), no como
 * `style="…"`, así que quitar los `style` NO pierde el formato.
 */
import * as cheerio from 'cheerio';

// Etiquetas de formato de texto permitidas. Nada de <script>, <style>, <iframe>, <form>, <input>…
const TAGS_OK = new Set([
    'p', 'br', 'div', 'span', 'h2', 'h3', 'h4', 'strong', 'b', 'em', 'i', 'u', 's', 'sub', 'sup',
    'ul', 'ol', 'li', 'blockquote', 'a', 'img', 'figure', 'figcaption', 'hr', 'pre', 'code', 'mark',
]);
// Atributos permitidos POR etiqueta. Nada de class/id/on* (se caen todos los no listados). El `style` se
// trata aparte: se PERMITE en cualquier etiqueta pero SANEADO a solo color/fondo (ver sanearStyle) — así el
// «texto de colores» del editor (span style="color:…") sobrevive sin abrir la puerta a un style arbitrario.
const ATTRS_OK = { a: ['href'], img: ['src', 'alt'] };
// Se ELIMINAN por completo (contenido incluido): no se desenvuelven.
const TAGS_FUERA = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'svg', 'math', 'noscript', 'template']);

// ÚNICAS propiedades CSS admitidas en `style` (color de texto y de fondo/subrayado). Nada de position, url(),
// expression(), etc. — no son formato de texto y sí vectores de abuso.
const CSS_OK = new Set(['color', 'background-color']);
// Valor CSS SEGURO: nombre de color (letras), #hex (3-8 díg.) o rgb()/rgba(). Nada de url()/expression()/`;`.
const VALOR_CSS_SEGURO = /^(#[0-9a-f]{3,8}|rgb\(\s*[\d\s,]+\)|rgba\(\s*[\d\s,.]+\)|[a-z]+)$/i;
/** Deja en `style` solo las declaraciones color/background-color con valor seguro. '' si no queda ninguna. */
function sanearStyle(valor) {
    const out = [];
    for (const decl of String(valor || '').split(';')) {
        const i = decl.indexOf(':');
        if (i < 0) continue;
        const prop = decl.slice(0, i).trim().toLowerCase();
        const val = decl.slice(i + 1).trim();
        if (CSS_OK.has(prop) && VALOR_CSS_SEGURO.test(val)) out.push(`${prop}: ${val}`);
    }
    return out.join('; ');
}

/**
 * Sanea `html` y devuelve HTML seguro (o '' si no hay nada). `maxLen` acota el tamaño persistido.
 */
export function sanearHtml(html, { maxLen = 400000 } = {}) {
    if (!html || typeof html !== 'string') return '';
    let $;
    try { $ = cheerio.load(html, null, false); } catch { return ''; }

    // 1) Fuera lo peligroso, con su contenido.
    for (const t of TAGS_FUERA) $(t).remove();

    // 2) Recorrido de más ANIDADO a menos (post-orden): así al desenvolver un padre no se re-visita a hijos ya
    //    tratados. Se materializa la lista antes de mutar.
    const elems = $('*').toArray().reverse();
    for (const el of elems) {
        if (el.type !== 'tag') continue;
        const tag = (el.tagName || el.name || '').toLowerCase();
        const $el = $(el);
        if (!TAGS_OK.has(tag)) { $el.replaceWith($el.contents()); continue; }   // desconocida → desenvolver
        // Atributos: conservar solo los de la lista blanca de ESTA etiqueta, y validar su valor.
        const permit = ATTRS_OK[tag] || [];
        for (const name of Object.keys(el.attribs || {})) {
            const val = el.attribs[name];
            // `style`: permitido en cualquier etiqueta pero SANEADO a color/fondo (texto de colores del editor).
            if (name === 'style') { const s = sanearStyle(val); if (s) $el.attr('style', s); else $el.removeAttr('style'); continue; }
            if (!permit.includes(name)) { $el.removeAttr(name); continue; }
            if (name === 'href' && !/^(https?:|mailto:)/i.test(val)) { $el.removeAttr('href'); }
            // Solo imágenes servidas por NOSOTROS (nada de http remoto ni data: — evita rastreo y payloads).
            if (name === 'src' && !/^\/recursos\//.test(val)) { $el.removeAttr('src'); }
        }
        if (tag === 'a' && el.attribs?.href) { $el.attr('target', '_blank'); $el.attr('rel', 'noopener noreferrer'); }
    }

    let out = ($.html() || '').trim();
    if (out.length > maxLen) out = out.slice(0, maxLen);
    return out;
}
