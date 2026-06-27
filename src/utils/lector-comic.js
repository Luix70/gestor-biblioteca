/**
 * Lector de CÓMIC (.cbz/.cbr/.cb7) — un cómic es un archivo comprimido de imágenes (una por página).
 *
 *   .cbz = ZIP  → se abre con adm-zip (JS puro, sin dependencias de sistema).
 *   .cbr = RAR / .cb7 = 7z → se abren con `unar` (paquete Debian `unar`, libre; C plano sin SIMD →
 *                 apto para el Atom, igual que poppler). Si `unar` no está o falla, se cataloga por
 *                 NOMBRE (sin portada) — degradación segura, nunca rompe la ingesta.
 *
 * En los tres casos se extrae la PRIMERA imagen (orden natural) como PORTADA y se cuenta el nº de
 * páginas. Clasificación (auto): un NÚMERO de una serie (nº de ejemplar / fechado, p. ej. "Don Miki
 * Nº Extra 1986") → revista (cabecera-colección por serie); un ÁLBUM/novela gráfica suelto → libro.
 * Ambos llevan `naturaleza:'comic'`. Devuelve un datosBase compatible con el resto del pipeline.
 */
import AdmZip from 'adm-zip';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { parsearNombre } from './parsear-nombre.js';
import { extraerArchivoComic } from './extraer-archivo.js';

const ES_IMG = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;
const ORDEN = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp', '.avif': 'image/avif' };
const mimeDe = (n) => MIME[path.extname(n).toLowerCase()] || 'image/jpeg';
const PAG_FRENTE = Number(process.env.COMIC_PAGINAS_FRENTE || 5);   // como un PDF: créditos/ISBN viven al principio
const PAG_FONDO  = Number(process.env.COMIC_PAGINAS_FONDO  || 1);   // …y el código de barras suele ir en la contraportada

// Índices de las páginas de MUESTRA para la visión: las PAG_FRENTE primeras + las PAG_FONDO últimas.
function indicesMuestra(n) {
    const s = new Set();
    for (let i = 0; i < Math.min(PAG_FRENTE, n); i++) s.add(i);
    for (let i = Math.max(0, n - PAG_FONDO); i < n; i++) s.add(i);
    return [...s].sort((a, b) => a - b);
}

// Nº de ejemplar en el NOMBRE del cómic: "Nº 12", "N 3", "#5", "núm 7", o "Extra"/"Especial" (cómics
// con número simbólico). Un número/extra ⇒ es un EJEMPLAR de una serie (→ revista-colección).
function extraerNumeroComic(s) {
    if (!s) return null;
    const m = s.match(/(?:n[º°.]?|núm\.?|num\.?|#)\s*(\d{1,4})\b/i);
    if (m) return m[1];
    if (/\b(extra|especial|almanaque|anuario)\b/i.test(s)) return 'extra';
    return null;
}

// Nombre de la SERIE a partir del nombre del ejemplar: corta en el PRIMER marcador de número/ejemplar
// ("Don Miki N Extra Navidad 1986…" → "Don Miki"). Da una CABECERA limpia y ESTABLE para que los
// ejemplares de la misma serie agrupen juntos (sin esto, cada nº sería su propia cabecera). Prudente:
// si el recorte dejara algo demasiado corto, devuelve el original.
function serieComic(s) {
    let t = String(s || '');
    t = t.replace(/\s+\bn[º°.]?\b.*$/i, '');                                  // "N"/"Nº" (abrev. de número) y lo que siga
    t = t.replace(/\s+#?\d{1,4}\b.*$/, '');                                   // primer nº de 1-4 cifras y lo que siga
    t = t.replace(/\s+\b(extra|especial|almanaque|anuario)\b.*$/i, '');       // marcador simbólico y lo que siga
    t = t.replace(/[\s\-–—_]+$/, '').trim();
    return t.length >= 2 ? t : String(s || '').trim();
}

/** Lista recursiva de imágenes (rutas absolutas) bajo `dir`, en orden natural. */
async function listarImagenes(dir) {
    const out = [];
    let entradas;
    try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entradas) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) out.push(...await listarImagenes(p));
        else if (ES_IMG.test(e.name)) out.push(p);
    }
    return out.sort(ORDEN);
}

/** Portada + nº de páginas + páginas de MUESTRA (5 primeras + última, base64) de un CBZ (ZIP) vía adm-zip. */
function leerCbz(ruta) {
    const zip = new AdmZip(ruta);
    const imgs = zip.getEntries()
        .filter(e => !e.isDirectory && ES_IMG.test(e.entryName))
        .sort((a, b) => ORDEN(a.entryName, b.entryName));
    if (!imgs.length) return { paginas: 0 };
    const muestra = indicesMuestra(imgs.length).map(i => ({ base64: imgs[i].getData().toString('base64'), mimeType: mimeDe(imgs[i].entryName) }));
    return { paginas: imgs.length, cubierta_base64: imgs[0].getData().toString('base64'), muestra };
}

/** Igual para un CBR (RAR/RAR5) / CB7 (7z): extrae a un tmp efímero (bsdtar→unar) y lee portada + muestra. */
async function leerComprimido(ruta) {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'comic-'));
    try {
        await extraerArchivoComic(ruta, tmp);
        const imgs = await listarImagenes(tmp);
        if (!imgs.length) return { paginas: 0 };
        const muestra = [];
        for (const i of indicesMuestra(imgs.length)) muestra.push({ base64: (await fs.readFile(imgs[i])).toString('base64'), mimeType: mimeDe(imgs[i]) });
        const cubierta_base64 = (await fs.readFile(imgs[0])).toString('base64');
        return { paginas: imgs.length, cubierta_base64, muestra };
    } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
}

export async function extraerMetadatosComic(ruta) {
    const ext = path.extname(ruta).toLowerCase();
    const nombre = path.basename(ruta, ext);
    const datos = {
        titulo: null, autores: [], naturaleza: 'comic',
        formatos: [ext.slice(1)],            // cbz | cbr | cb7 (setup-mongo amplía el enum de formatos)
        texto_legible: false,
        alertas_agente: [],
    };

    // PORTADA + nº de páginas: CBZ con adm-zip; CBR/CB7 con unar. Cualquier fallo (archivo dañado,
    // unar ausente) degrada a "catalogado por nombre" sin romper la ingesta.
    try {
        const { paginas, cubierta_base64, muestra } = ext === '.cbz' ? leerCbz(ruta) : await leerComprimido(ruta);
        if (cubierta_base64) { datos.paginas = paginas; datos.cubierta_base64 = cubierta_base64; datos.muestra_paginas = muestra || []; }
        else datos.alertas_agente.push('Cómic sin imágenes legibles: catalogado por nombre.');
    } catch (e) {
        datos.alertas_agente.push(`No se pudo abrir el cómic (${e.message}): catalogado por nombre.`);
    }

    // Título / serie / nº a partir del NOMBRE (curador). Los cómics suelen usar '_' como separador. NO se
    // parten autores por " - " (en cómics suele ser "Serie - Álbum", no "Título - Autor"): el nombre
    // limpio ES el título; los autores los aportará la visión/APIs si acaso.
    const limpio = nombre.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    const p = parsearNombre(limpio);
    datos.titulo = limpio;
    if (p.coleccion_nombre) { datos.coleccion_nombre = p.coleccion_nombre; if (p.coleccion_numero) datos.coleccion_numero = p.coleccion_numero; }
    if (p.esFechada) { datos.esFechada = true; datos.año_edicion = p.año_edicion; if (p.mes_publicacion) datos.mes_publicacion = p.mes_publicacion; }
    const numero = extraerNumeroComic(limpio);
    if (numero) datos.numero_issue = numero;

    // SERIE (número de ejemplar / fechado) vs ÁLBUM suelto (novela gráfica). El discriminador decide el
    // tipo_recurso final; aquí se aporta la señal.
    datos.comic_serie = !!(numero || p.esFechada);
    // Para una SERIE, la CABECERA se resuelve de obra_titulo (nombre limpio de serie), no del título
    // ruidoso del ejemplar → los nº de la misma serie agrupan juntos.
    if (datos.comic_serie) {
        const serie = serieComic(limpio);
        if (serie && serie.toLowerCase() !== limpio.toLowerCase()) datos.obra_titulo = serie;
    }
    return datos;
}
