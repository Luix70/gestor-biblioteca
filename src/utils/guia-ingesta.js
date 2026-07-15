/**
 * GUÍA DE INGESTA — sidecar autoritativo POR CARPETA (`_guia.json`) que el usuario define (explorador del
 * panel o a mano) y el VIGILANTE OBEDECE. Unifica las dos caras de la «ingesta guiada»:
 *
 *   1) PERFIL (pistas): sesgan tipo/APIs/prompts de IA, pero son señales DÉBILES (T4). La realidad se impone:
 *      un ISBN/CIP/ISSN propio o el Fichero SIEMPRE ganan a la pista (ver discriminador · clasificarTipo).
 *   2) ACCIÓN de la carpeta: qué hacer con ESTA carpeta antes/al catalogar.
 *
 * Formato de `_guia.json` (todos los campos opcionales):
 * {
 *   "perfil": {
 *     "tipo_probable": "comic"|"revista"|"libro"|"articulo"|"apuntes"|"capitulo",
 *     "naturaleza": "comic"|"novela-grafica"|"academico"|…,
 *     "coleccion": "…", "obra": "…", "enciclopedia": "…",
 *     "idioma_probable": "es", "editorial_probable": "…", "materia_cdu": "82"
 *   },
 *   "accion": "normal"|"omitir"|"aplanar"|"explotar"|"intacta",
 *   "adjuntar_a": { "coleccion": "…" } | { "doc": "<nombre_archivo|isbn>" },   // solo para accion:"intacta"
 *   "archivos": { "<nombre>": { "omitir": true } }                             // overrides por fichero
 * }
 *
 * Cada carpeta lleva su PROPIO `_guia.json` (recursivo): las subcarpetas se guían con el suyo. El sidecar es
 * un ACCESORIO (empieza por «_») → el recolector del vigilante ya lo ignora y no se cataloga.
 */
import fs from 'fs/promises';
import path from 'path';

export const NOMBRE_GUIA = '_guia.json';

// Acciones de carpeta que entiende el vigilante:
//   · normal   → clasificación habitual (colección / obra / doc suelto / libro escaneado).
//   · omitir   → NO catalogar nada de esta carpeta (se deja intacta en el Inbox).
//   · aplanar  → si contiene UNA sola subcarpeta, sube su contenido un nivel (deshace anidamientos inútiles).
//   · explotar → libera SUS ficheros en la carpeta que la contiene y la elimina (los trata como sueltos allí).
//   · intacta  → NO se procesa su contenido: se conserva VERBATIM (como transmedia) adjunta a un doc/colección
//                (p. ej. carpeta de código junto a un PDF de programación, multimedia de una colección).
export const ACCIONES_CARPETA = ['normal', 'omitir', 'aplanar', 'explotar', 'intacta'];

const TIPOS_PROBABLES = ['comic', 'revista', 'libro', 'articulo', 'apuntes', 'capitulo'];

/** Normaliza (y valida laxamente) el objeto perfil. Descarta campos vacíos/desconocidos. Devuelve {} si nada. */
export function normalizarPerfil(p) {
    if (!p || typeof p !== 'object') return {};
    const out = {};
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    if (TIPOS_PROBABLES.includes(p.tipo_probable)) out.tipo_probable = p.tipo_probable;
    for (const k of ['naturaleza', 'coleccion', 'obra', 'enciclopedia', 'idioma_probable', 'editorial_probable', 'materia_cdu']) {
        const v = str(p[k]);
        if (v) out[k] = v;
    }
    return out;
}

/** Normaliza una guía cruda (de disco o del explorador). Devuelve un objeto guía siempre válido. */
export function normalizarGuia(g) {
    const guia = { perfil: {}, accion: 'normal', adjuntar_a: null, archivos: {} };
    if (!g || typeof g !== 'object') return guia;
    guia.perfil = normalizarPerfil(g.perfil);
    if (ACCIONES_CARPETA.includes(g.accion)) guia.accion = g.accion;
    if (guia.accion === 'intacta' && g.adjuntar_a && typeof g.adjuntar_a === 'object') {
        const col = typeof g.adjuntar_a.coleccion === 'string' ? g.adjuntar_a.coleccion.trim() : '';
        const doc = typeof g.adjuntar_a.doc === 'string' ? g.adjuntar_a.doc.trim() : '';
        if (col) guia.adjuntar_a = { coleccion: col };
        else if (doc) guia.adjuntar_a = { doc };
    }
    if (g.archivos && typeof g.archivos === 'object') {
        for (const [nombre, spec] of Object.entries(g.archivos)) {
            if (spec && typeof spec === 'object' && spec.omitir) guia.archivos[nombre] = { omitir: true };
        }
    }
    return guia;
}

/** Lee el `_guia.json` de `carpeta`. Devuelve la guía normalizada, o null si no existe / no se puede leer. */
export async function leerGuia(carpeta) {
    if (!carpeta) return null;
    try {
        const txt = await fs.readFile(path.join(carpeta, NOMBRE_GUIA), 'utf8');
        return normalizarGuia(JSON.parse(txt));
    } catch {
        return null; // sin guía → comportamiento normal
    }
}

/** Escribe (o reemplaza) el `_guia.json` de `carpeta` con la guía normalizada. */
export async function escribirGuia(carpeta, guia) {
    const g = normalizarGuia(guia);
    await fs.writeFile(path.join(carpeta, NOMBRE_GUIA), JSON.stringify(g, null, 2), 'utf8');
    return g;
}

/**
 * Vuelca las pistas del PERFIL en el `contexto` de ingesta (lo que ya viaja por el pipeline). Solo RELLENA
 * huecos: no pisa un contexto ya fijado (p. ej. la colección real de un drop-por-carpeta manda sobre la pista).
 * Deja las pistas «probables» en `contexto.perfil` para que el discriminador/enriquecedor/prompts las usen.
 */
export function aplicarPerfilAContexto(contexto, perfil) {
    const p = normalizarPerfil(perfil);
    if (!Object.keys(p).length) return contexto;
    const ctx = { ...contexto };
    if (p.coleccion && !ctx.coleccion) { ctx.coleccion = p.coleccion; ctx.serieAuto = true; }
    if (p.obra && !ctx.obra) ctx.obra = { titulo: p.obra };
    if (p.idioma_probable && !ctx.idioma) ctx.idioma_probable = p.idioma_probable;
    // Las pistas «probables» (tipo/naturaleza/materia/editorial/enciclopedia) NO fijan nada por sí solas:
    // viajan en contexto.perfil para SESGAR (T4) el discriminador, las búsquedas y los prompts de IA.
    ctx.perfil = { ...(ctx.perfil || {}), ...p };
    return ctx;
}
