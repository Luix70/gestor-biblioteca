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
//   · intacta  → la carpeta es UNA COSA: se conserva ÍNTEGRA en el árbol CDU y deja UN registro que apunta a
//                ella (naturaleza:'material', con explorador de ficheros). Su contenido NO se procesa ni se
//                decide qué es. NO es transmedia: eso es una colección de ficheros de VARIOS tipos que se
//                catalogan POR SEPARADO (un doc por PDF, por audiolibro…). Enrutar `intacta` por transmedia era
//                el fallo del test 67: su análisis no cuenta las imágenes → una carpeta de 142 páginas
//                escaneadas salía con CERO documentos y quedaba invisible.
//   · obra     → TODOS los documentos de la carpeta son TOMOS de UNA obra multivolumen (título = la carpeta).
//   · software → paquete de software: se conserva VERBATIM en BLOQUE y se cataloga como UN registro
//                (naturaleza:'software'); su previsualización es un explorador de ficheros de solo lectura.
//   · libro-material → UN libro (el documento principal de la carpeta) + material auxiliar (código de ejemplo,
//                datasets, multimedia…). El LIBRO se cataloga por el PIPELINE NORMAL (ISBN/CDU/metadatos
//                completos → `tipo_recurso:'libro'` de pleno derecho, NO transmedia/colección/audiolibro), y el
//                material se conserva VERBATIM junto a él (ruta_fija) y se ve en el explorador «🗂️ Archivos».
export const ACCIONES_CARPETA = ['normal', 'omitir', 'aplanar', 'explotar', 'intacta', 'obra', 'software', 'libro-material'];

// Acciones por FICHERO (`archivos: { "X.iso": { accion: "software" } }`). Pensadas para los CONTENEDORES
// complejos (.iso .nrg .zip .rar .7z .ipa .dmg…), donde la máquina NO puede acertar sola: el MISMO .iso puede
// ser un archivo de documentos (→ abrir y catalogar su contenido) o una enciclopedia/instalador de software
// (→ conservarlo INTACTO como un registro; abrirlo metería cientos de vídeos/recursos como fichas sueltas).
// Solo el humano lo sabe, así que se elige en el Inspector ANTES de que el vigilante lo toque.
//   · expandir → se abre y su contenido se cataloga individualmente (comportamiento por defecto)
//   · software → NO se abre: se conserva verbatim y se cataloga como UN registro (naturaleza:'software')
//   · omitir   → no se cataloga (se deja en el Inbox)
export const ACCIONES_FICHERO = ['expandir', 'software', 'omitir'];

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
    const guia = { perfil: {}, accion: 'normal', adjuntar_a: null, archivos: {}, grupos: [] };
    if (!g || typeof g !== 'object') return guia;
    // GRUPOS de ficheros sueltos que forman UN documento (agrupado B del Inspector): audiolibro / obra.
    // `archivos` = nombres RELATIVOS a esta carpeta. El vigilante los mueve a una subcarpeta y los agrupa.
    if (Array.isArray(g.grupos)) {
        guia.grupos = g.grupos
            .filter((gr) => gr && ['audiolibro', 'obra'].includes(gr.tipo) && Array.isArray(gr.archivos) && gr.archivos.length)
            .map((gr) => ({
                tipo: gr.tipo,
                nombre: typeof gr.nombre === 'string' && gr.nombre.trim() ? gr.nombre.trim() : (gr.tipo === 'obra' ? 'Obra' : 'Audiolibro'),
                archivos: gr.archivos.filter((a) => typeof a === 'string' && a).map((a) => a.replace(/^[/\\]+/, '')),
            }));
    }
    guia.perfil = normalizarPerfil(g.perfil);
    if (ACCIONES_CARPETA.includes(g.accion)) guia.accion = g.accion;
    if (guia.accion === 'intacta' && g.adjuntar_a && typeof g.adjuntar_a === 'object') {
        const col = typeof g.adjuntar_a.coleccion === 'string' ? g.adjuntar_a.coleccion.trim() : '';
        const doc = typeof g.adjuntar_a.doc === 'string' ? g.adjuntar_a.doc.trim() : '';
        if (col) guia.adjuntar_a = { coleccion: col };
        else if (doc) guia.adjuntar_a = { doc };
    }
    // Overrides por FICHERO: `{ omitir:true }` (histórico) y/o `{ accion:'expandir'|'software'|'omitir' }`.
    if (g.archivos && typeof g.archivos === 'object') {
        for (const [nombre, spec] of Object.entries(g.archivos)) {
            if (!spec || typeof spec !== 'object') continue;
            const o = {};
            if (spec.omitir) o.omitir = true;
            if (ACCIONES_FICHERO.includes(spec.accion) && spec.accion !== 'expandir') o.accion = spec.accion; // 'expandir' = defecto: no se guarda
            if (Object.keys(o).length) guia.archivos[nombre] = o;
        }
    }
    return guia;
}

/**
 * ¿La guía expresa INTENCIÓN GRANULAR sobre la carpeta? (una acción distinta de «normal», grupos declarados,
 * o un perfil con pistas). El vigilante lo usa para decidir que una carpeta contenedora NO debe ser tragada
 * entera por la autodetección agresiva (colección de audiolibros / transmedia) cuando el usuario ha guiado su
 * interior: en ese caso se recurre en ella tratándola como un mini-Inbox. Una guía vacía/«normal» no cuenta.
 */
export function guiaEsSignificativa(g) {
    if (!g) return false;
    if (g.accion && g.accion !== 'normal') return true;
    if (Array.isArray(g.grupos) && g.grupos.length) return true;
    if (g.perfil && Object.keys(g.perfil).length) return true;
    if (g.archivos && Object.keys(g.archivos).length) return true;   // acciones por fichero (contenedores) = intención
    return false;
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

// ──────────────────────────────────────────────────────────────────────────────────────────────────
// EXPLORADOR del Inbox (para el panel): árbol de carpetas/ficheros + la guía actual de cada carpeta.
// ──────────────────────────────────────────────────────────────────────────────────────────────────
const EXT_DOC = new Set(['.epub', '.pdf', '.mobi', '.azw', '.azw3', '.cbr', '.cbz', '.cb7', '.djvu', '.chm', '.docx', '.doc']);
const EXT_IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.gif', '.bmp']);
// Mismo rango AMPLIADO que lector-audio.js (fuente única): Audible (.aax/.aa), Apple Lossless, .wma, etc.
const EXT_AUDIO = new Set(['.mp3', '.m4a', '.m4b', '.m4p', '.aac', '.ogg', '.oga', '.opus', '.flac', '.wav', '.wma', '.aax', '.aa', '.ape', '.alac', '.aiff', '.aif', '.mka', '.wv']);
const EXT_VIDEO = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm']);
// CONTENEDORES complejos: pueden traer documentos (→ abrir) o ser un paquete de software (→ intacto). El
// Inspector ofrece la acción por fichero (ACCIONES_FICHERO) justo para estos.
const EXT_COMPR = new Set(['.zip', '.rar', '.7z', '.iso', '.nrg', '.ipa', '.dmg', '.mdf', '.img', '.cdi', '.ccd', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.cab']);
const _ignorar = (n) => n.startsWith('@') || n.startsWith('.') || n.startsWith('#');

/** Clase de un fichero por su extensión (para colorear el explorador y marcar los NO CLASIFICABLES). */
export function claseFichero(ext) {
    ext = String(ext || '').toLowerCase();
    if (EXT_DOC.has(ext)) return 'doc';
    if (EXT_IMG.has(ext)) return 'imagen';
    if (EXT_AUDIO.has(ext)) return 'audio';
    if (EXT_VIDEO.has(ext)) return 'video';
    if (EXT_COMPR.has(ext)) return 'comprimido';
    return 'noclasificable';   // .txt/.lit/.docx/.nrg… → el usuario decide (omitir / catalogar por nombre)
}

/**
 * Árbol de `raizInbox` (recursivo). Cada CARPETA incluye su guía actual (perfil + acción). Ignora
 * ocultos/sistema y el propio _guia.json.
 *
 * EL TOPE ES POR CARPETA, NO GLOBAL. Antes había un contador ÚNICO para todo el recorrido (`maxNodos = 3000`)
 * y un `break` al agotarlo: una carpeta con miles de láminas («Grabados de l'Encyclopédie») se comía el cupo
 * ella sola y sus HERMANAS no llegaban a listarse — «si le doy al inspector solo me recupera la primera, y no
 * entera». Ahora cada carpeta tiene su propio cupo, así que todas salen.
 *
 * Y NUNCA SE RECORTA EN SILENCIO: lo que no se lista se RESUME (`total_hijos`, `truncado`, `resumen` por
 * clase) para que el Inspector lo diga. Enseñar un árbol incompleto sin avisar es peor que no enseñarlo: el
 * usuario decide qué hacer con una carpeta creyendo que la ve entera.
 *
 * Para el Inspector esto no pierde nada útil: la acción se le asigna a la CARPETA, no a cada una de sus 5.000
 * láminas. Solo los ficheros que admiten acción propia (contenedores) necesitan salir uno a uno.
 *
 * @param {object} [opts]
 * @param {number} [opts.maxHijos=200] - cuántas entradas se listan por carpeta antes de resumir el resto.
 * @param {number} [opts.maxNodos=20000] - tope global de seguridad (que la respuesta no se vaya a megas).
 * @param {string} [opts.desde] - carpeta por la que EMPEZAR (una rama, para la carga diferida). Las `ruta` de
 *        los nodos se siguen midiendo desde `raizInbox`: son la CLAVE con la que se guarda cada guía, así que
 *        tienen que ser las mismas se pida el árbol entero o una rama suelta.
 * @returns {Promise<{hijos: object[], truncado: boolean, nodos: number}>}
 */
export async function arbolInbox(raizInbox, { profundidad = 6, maxHijos = 200, maxNodos = 20000, desde = null } = {}) {
    let n = 0;
    let recortado = false;   // ¿se ha dejado algo fuera en ALGUNA parte del árbol?

    async function rec(dir, prof) {
        let entradas;
        try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { return { hijos: [], total: 0, truncado: false }; }
        const gCarp = await leerGuia(dir);   // UNA vez por carpeta: las acciones por FICHERO viven en su guía
        const utiles = entradas
            .filter((e) => !_ignorar(e.name) && e.name !== NOMBRE_GUIA)
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        const hijos = [];
        let i = 0;
        for (; i < utiles.length; i++) {
            if (hijos.length >= maxHijos || n >= maxNodos) break;   // el resto se resume, no se oculta
            const e = utiles[i];
            n++;
            const abs = path.join(dir, e.name);
            const rel = path.relative(raizInbox, abs).split(path.sep).join('/');
            if (e.isDirectory()) {
                const guia = await leerGuia(abs);
                // Si se agotó la profundidad NO se desciende, pero se marca `pendiente` para que el Inspector
                // la pida al desplegarla (carga diferida). Sin esta marca, una carpeta sin explorar y una
                // carpeta VACÍA se veían igual (`hijos: []`) — y eso es mentirle al usuario.
                const sub = prof > 0 ? await rec(abs, prof - 1) : null;
                hijos.push({
                    nombre: e.name, ruta: rel, tipo: 'dir',
                    guia: guia ? { perfil: guia.perfil, accion: guia.accion, adjuntar_a: guia.adjuntar_a } : null,
                    hijos: sub ? sub.hijos : [],
                    pendiente: sub ? undefined : true,
                    total_hijos: sub ? sub.total : undefined,
                    truncado: (sub && sub.truncado) || undefined,
                    resumen: sub ? sub.resumen : undefined,
                });
            } else {
                let tam = 0;
                try { tam = (await fs.stat(abs)).size; } catch { /* sin stat */ }
                const ext = path.extname(e.name).toLowerCase();
                // La acción por fichero (contenedores: expandir/software/omitir) vive en la guía de SU CARPETA
                // → se adjunta al nodo para que el Inspector la pinte ya elegida.
                const spec = gCarp?.archivos?.[e.name] || null;
                hijos.push({
                    nombre: e.name, ruta: rel, tipo: 'file', ext, tam, clase: claseFichero(ext),
                    accion: spec?.accion || (spec?.omitir ? 'omitir' : null),
                });
            }
        }

        // Lo que se queda fuera se CUENTA y se clasifica (sin stat: solo por extensión, para que sea barato).
        let resumen;
        if (i < utiles.length) {
            recortado = true;
            resumen = {};
            for (const e of utiles.slice(i)) {
                const k = e.isDirectory() ? 'carpetas' : claseFichero(path.extname(e.name).toLowerCase());
                resumen[k] = (resumen[k] || 0) + 1;
            }
        }
        return { hijos, total: utiles.length, truncado: i < utiles.length, resumen };
    }

    const raiz = await rec(desde || raizInbox, profundidad);
    return { hijos: raiz.hijos, truncado: recortado, nodos: n };
}

/** Resuelve `sub` DENTRO de `raizInbox` (anti path-traversal). Devuelve el absoluto, o null si escapa. */
export function rutaInboxSegura(raizInbox, sub) {
    const abs = path.resolve(raizInbox, String(sub || '').replace(/^[/\\]+/, ''));
    const raiz = path.resolve(raizInbox);
    return (abs === raiz || abs.startsWith(raiz + path.sep)) ? abs : null;
}
