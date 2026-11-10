/**
 * LIBRO EN HTML — una carpeta que ES un libro hecho de páginas web (el CD de un manual: Cutnell «Physics 7e HTML»,
 * 10.000 ficheros con su `toc.htm`, solucionarios en PDF y simulaciones). No se trocea ni se cataloga página a página:
 * se conserva ÍNTEGRA en el árbol CDU (como una carpeta «intacta») con UNA ficha de libro de verdad —título, autores,
 * ISBN si lo trae, portada— y se lee abriendo su página de entrada en una pestaña del navegador.
 *
 * Detector compartido (regla «cada arreglo tiene su gemelo en la ingesta»): lo usan PreProceso (no lo retiene como
 * «capítulos sin coser» y le pone su guía), la inspección con IA (lo guía «intacta») y la ingesta «intacta» (que
 * cataloga como libro HTML lo que lo sea). Los metadatos se leen con el mismo lector que un CHM ya extraído (un CHM
 * es exactamente esto: un libro de páginas HTML), dándole la página de entrada como página inicial.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

// Nombres de página de entrada, por preferencia. La primera que exista en la RAÍZ de la carpeta es la entrada.
const ENTRADAS = [
    'index', 'default', 'toc', 'contents', 'content', 'start', 'home', 'main', 'inicio', 'indice', 'índice',
    'cover', 'title', 'titlepage', 'book',
];
// Documentos que, en la raíz, hacen que la carpeta sea otra cosa (un libro en PDF con su material, un ebook…).
const RE_DOC_RAIZ = /\.(pdf|epub|mobi|azw3?|djvu?|chm|cbz|cbr|cb7|docx?|rtf|odt)$/i;
const RE_HTML = /\.html?$/i;
// Un libro HTML tiene muchas páginas; una carpeta con un index.html suelto (la ficha de una descarga) no lo es.
const MIN_PAGINAS = 10;

const ignorar = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('#') || n.startsWith('_');

/** La página de entrada (nombre relativo a `dir`) o null: la preferida por nombre, o la única HTML de la raíz. */
export async function paginaEntradaHtml(dir) {
    const raiz = (await fs.readdir(dir, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isFile() && !ignorar(e.name) && RE_HTML.test(e.name))
        .map((e) => e.name);
    if (!raiz.length) return null;
    const base = (n) => n.replace(RE_HTML, '').toLowerCase();
    for (const preferida of ENTRADAS) {
        const n = raiz.find((x) => base(x) === preferida);
        if (n) return n;
    }
    return raiz.length === 1 ? raiz[0] : null;
}

/** Cuenta las páginas HTML del árbol, parando en `tope` (no hace falta recorrer 10.000 ficheros para decidir). */
async function contarPaginas(dir, tope) {
    let n = 0;
    const pila = [dir];
    while (pila.length && n < tope) {
        const d = pila.pop();
        const entradas = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
        for (const e of entradas) {
            if (ignorar(e.name)) continue;
            if (e.isDirectory()) pila.push(path.join(d, e.name));
            else if (RE_HTML.test(e.name) && ++n >= tope) break;
        }
    }
    return n;
}

/**
 * ¿`dir` es un libro en HTML? Página de entrada en la raíz, ningún documento de libro en la raíz y al menos
 * MIN_PAGINAS páginas en el árbol. Devuelve { entrada } o null.
 */
export async function esLibroHtml(dir) {
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) return null;
    const raiz = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    if (raiz.some((e) => e.isFile() && RE_DOC_RAIZ.test(e.name))) return null;
    const entrada = await paginaEntradaHtml(dir);
    if (!entrada) return null;
    if (await contarPaginas(dir, MIN_PAGINAS) < MIN_PAGINAS) return null;
    return { entrada };
}

// PÁGINAS WEB GUARDADAS (no un libro): las páginas y lo que cuelga de ellas (imágenes, estilos, scripts).
const RE_PAGINA_WEB = /\.(html?|xhtml|mht|mhtml)$/i;
const RE_RECURSO_WEB = /\.(jpe?g|gif|png|bmp|svg|webp|ico|css|js|swf|class|txt|xml)$/i;
const MAX_FICHEROS_WEB = 3000;   // un dosier de páginas guardadas es pequeño; más que esto es otra cosa

/**
 * ¿`dir` son PÁGINAS WEB guardadas — un artículo partido en varias .htm, un dosier de .mht, la web de una patente —
 * y nada más? Al menos una página, ningún documento (PDF, EPUB…) en todo el árbol y el resto solo recursos de esas
 * páginas. No es un libro HTML (pocas páginas o sin entrada clara), pero tampoco es basura: se conserva entera con
 * UNA ficha («intacta»). Sin esto el vigilante no veía nada catalogable en ella y la dejaba en el Inbox en silencio
 * (10-nov: «Fogal patents», «Hans Coler», «12-volt Guide», los .mht de Bedini).
 */
export async function esCarpetaWeb(dir) {
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) return false;
    // Las páginas han de estar en la RAÍZ (las subcarpetas son sus «_files»): una carpeta de materia que solo agrupa
    // varios dosieres web no es uno de ellos — cada dosier tiene su ficha.
    let enRaiz = 0, vistos = 0;
    const pila = [dir];
    while (pila.length) {
        const d = pila.pop();
        for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
            if (ignorar(e.name)) continue;
            if (e.isDirectory()) { pila.push(path.join(d, e.name)); continue; }
            if (++vistos > MAX_FICHEROS_WEB) return false;
            if (RE_PAGINA_WEB.test(e.name)) { if (d === dir) enRaiz++; }
            else if (!RE_RECURSO_WEB.test(e.name)) return false;   // un documento u otra cosa: no son solo páginas
        }
    }
    return enRaiz > 0;
}
