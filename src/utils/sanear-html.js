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
// Atributos permitidos POR etiqueta. Nada de style/class/id/on* (se caen todos los no listados).
const ATTRS_OK = { a: ['href'], img: ['src', 'alt'] };
// Se ELIMINAN por completo (contenido incluido): no se desenvuelven.
const TAGS_FUERA = new Set(['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'link', 'meta', 'svg', 'math', 'noscript', 'template']);

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
