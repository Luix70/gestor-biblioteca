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

/** ¿Tiene `nombre` un nombre de página de entrada (index.html, toc.htm, START.HTM…)? */
const esNombreDeEntrada = (nombre) => ENTRADAS.includes(String(nombre || '').replace(RE_HTML, '').toLowerCase());

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

/**
 * Cuenta las páginas HTML del árbol, parando en `tope` (no hace falta recorrer 10.000 ficheros para decidir).
 * `excluir` = carpetas (rutas absolutas) cuyas páginas no cuentan: las de otro libro HTML que vive dentro.
 */
async function contarPaginas(dir, tope, excluir = new Set()) {
    let n = 0;
    const pila = [dir];
    while (pila.length && n < tope) {
        const d = pila.pop();
        const entradas = await fs.readdir(d, { withFileTypes: true }).catch(() => []);
        for (const e of entradas) {
            if (ignorar(e.name)) continue;
            if (e.isDirectory()) {
                const sub = path.join(d, e.name);
                if (!excluir.has(path.resolve(sub))) pila.push(sub);
            }
            else if (RE_HTML.test(e.name) && ++n >= tope) break;
        }
    }
    return n;
}

// Una página elegida como entrada SOLO por ser la única de la raíz (sin nombre de entrada: index, toc, start…) tiene
// que llevar a otras páginas del libro: al menos estas referencias a ficheros o carpetas suyos. Cuentan los href y
// también los src, porque muchos libros en CD cargan sus páginas en marcos (<frame src="page0001.htm">).
const MIN_ENLACES = 2;

/**
 * Las referencias (href / src) de la página de entrada que llevan a ficheros o carpetas que EXISTEN dentro de `dir`,
 * como rutas relativas a `dir` (como mucho `tope`). Las externas (http:, mailto:, javascript:), las anclas sueltas y lo
 * que sale de la carpeta no cuentan.
 */
async function referenciasLocales(dir, entrada, tope = 200) {
    let html = '';
    try {
        const fh = await fs.open(path.join(dir, entrada), 'r');
        try {
            const buf = Buffer.alloc(2 * 1024 * 1024);   // la portada/índice cabe de sobra en 2 MB
            const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
            html = buf.subarray(0, bytesRead).toString('latin1');
        } finally { await fh.close(); }
    } catch { return []; }
    const raiz = path.resolve(dir);
    const vistos = new Set();
    const existentes = [];
    for (const m of html.matchAll(/(?:href|src)\s*=\s*["']?([^"'\s>]+)/gi)) {
        let destino = m[1].replace(/[?#].*$/, '');
        if (!destino || /^[a-z][a-z0-9+.-]*:/i.test(destino) || destino.startsWith('//')) continue;
        try { destino = decodeURIComponent(destino); } catch { /* se deja tal cual */ }
        const abs = path.resolve(dir, destino);
        if (abs === raiz || !abs.startsWith(raiz + path.sep) || vistos.has(abs)) continue;
        vistos.add(abs);
        if (await fs.access(abs).then(() => true, () => false)) {
            existentes.push(path.relative(raiz, abs));
            if (existentes.length >= tope) break;
        }
    }
    return existentes;
}

/** ¿`dir` tiene, por sí sola, forma de libro HTML? (página de entrada + MIN_PAGINAS páginas, sin las de `excluir`) */
async function formaDeLibroHtml(dir, { excluir = new Set(), entrada = null } = {}) {
    const raiz = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    if (raiz.some((e) => e.isFile() && RE_DOC_RAIZ.test(e.name))) return null;
    entrada = entrada || await paginaEntradaHtml(dir);
    if (!entrada) return null;
    if (!esNombreDeEntrada(entrada) && (await referenciasLocales(dir, entrada, MIN_ENLACES)).length < MIN_ENLACES) return null;
    if (await contarPaginas(dir, MIN_PAGINAS, excluir) < MIN_PAGINAS) return null;
    return { entrada };
}

/**
 * ¿`dir` es un libro en HTML? Página de entrada en la raíz (si no tiene nombre de entrada y es solo «la única página
 * de la raíz», tiene que llevar a otras páginas suyas), ningún documento de libro en la raíz y al menos MIN_PAGINAS
 * páginas en el árbol, sin contar las de una subcarpeta que es por sí misma un libro HTML y a la que la página de
 * entrada no lleva (si lleva —«Digital Communications»: START.HTM abre PAGES/…, que tiene su propio índice—, es
 * parte del libro). Devuelve { entrada } o null.
 *
 * Incidente (15-nov): lo que quedó de «Medical/Combat Medical» (una página .html suelta, dos .txt, dos instaladores
 * .exe y la carpeta del libro HTML «Scuba Diving Explained») se catalogó como UN libro: la página suelta valía como
 * entrada por ser la única de la raíz, y las 103 páginas del libro de buceo contaban como suyas. Título y portada
 * salieron de dos libros distintos. Una carpeta así es un CONTENEDOR: el Vigilante entra y cataloga cada libro.
 */
export async function esLibroHtml(dir) {
    const st = await fs.stat(dir).catch(() => null);
    if (!st?.isDirectory()) return null;
    const entrada = await paginaEntradaHtml(dir);
    if (!entrada) return null;
    // Las subcarpetas de primer nivel a las que la entrada lleva son parte del libro.
    const referenciadas = new Set((await referenciasLocales(dir, entrada)).map((r) => r.split(path.sep)[0].toLowerCase()));
    // Las demás que son libros HTML por sí mismas no aportan páginas a esta: son otros libros.
    const subLibros = new Set();
    for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        if (!e.isDirectory() || ignorar(e.name) || referenciadas.has(e.name.toLowerCase())) continue;
        const sub = path.join(dir, e.name);
        if (await formaDeLibroHtml(sub)) subLibros.add(path.resolve(sub));
    }
    return formaDeLibroHtml(dir, { excluir: subLibros, entrada });
}
