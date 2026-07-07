/**
 * INGESTA TRANSMEDIA — una estructura de carpetas (p. ej. «Oxford Bookworms Library»: PDFs de lectura +
 * tests/ejercicios/soluciones + audios + portadas) se cataloga como UNA colección cuya estructura de disco
 * se conserva VERBATIM, colgando de una sola rama CDU. NO se reorganiza nada.
 *
 * Principio rector: AÑADIR siempre, BORRAR nunca, VERIFICAR la copia íntegra ANTES de borrar el origen.
 * Cada PDF es un documento PLANO miembro de la colección, con `ruta_fija:true` (Integridad/Conformador no
 * lo mueven ni podan) y etiquetas `nivel` (Stage) · `unidad` (el libro) · `rol_material` (lectura / test /
 * ejercicios / solucionario / glosario / guia). Los audios de cada unidad se enlazan (`audios[]`) para
 * reproducirlos. Una unidad con audio y SIN PDF de lectura = audiolibro (`naturaleza:'audiolibro'`).
 *
 * Identificación 100% ESTRUCTURAL, SIN IA (una colección puede tener cientos de PDFs): autor/título del
 * nombre de la carpeta de unidad, nivel de la carpeta «Stage N», rol del nombre/subcarpeta.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { conectarDB } from '../database.js';
import { DIR_CDU, MARCA_RUTA_FIJA } from '../mantenimiento/util-mantenimiento.js';
import { arbolCDU } from './cdu-arbol.js';
import { resolverCabecera } from './colecciones.js';
import { calcularHashArchivo } from './hash-archivo.js';
import { reciclarCarpeta } from './papelera.js';
import { resolverPersona } from './resolver-persona.js';

const EXT_AUDIO = ['.mp3', '.m4a', '.m4b', '.ogg', '.oga', '.opus', '.wav', '.aac', '.flac', '.wma'];
const ext = (n) => path.extname(n).toLowerCase();
const esPdf = (n) => ext(n) === '.pdf';
const esAudio = (n) => EXT_AUDIO.includes(ext(n));
const ignorar = (n) => n.startsWith('.') || n.startsWith('@') || n.startsWith('#');

// Segmentos web (/recursos/...) de una ruta absoluta dentro del árbol CDU.
const webDe = (abs) => '/recursos/' + path.relative(DIR_CDU, abs).split(path.sep).join('/');

/** Recorre un árbol y devuelve TODOS los ficheros con su ruta relativa a `raiz` (POSIX). Nunca lanza. */
async function listarFicheros(raiz) {
    const salida = [];
    const pila = [raiz];
    while (pila.length) {
        const dir = pila.pop();
        let entradas;
        try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entradas) {
            if (ignorar(e.name)) continue;
            const abs = path.join(dir, e.name);
            if (e.isDirectory()) { pila.push(abs); continue; }
            salida.push({ abs, rel: path.relative(raiz, abs).split(path.sep).join('/'), nombre: e.name });
        }
    }
    return salida;
}

/** ¿Una carpeta es un TRANSMEDIA? Heurística: hay AUDIO en el árbol (los libros/cómics normales no lo llevan)
 *  o un marcador `.transmedia` en la raíz. Un audiolibro (solo audio) también cuenta. */
export async function esCarpetaTransmedia(dir) {
    try { if (await fs.access(path.join(dir, '.transmedia')).then(() => true, () => false)) return true; } catch { /* */ }
    const ficheros = await listarFicheros(dir);
    return ficheros.some((f) => esAudio(f.nombre));
}

// ── Deducción de metadatos ESTRUCTURALES (sin IA) ──────────────────────────────────────────────────────

/** Nivel de dificultad: un segmento «Stage N» o un prefijo «SN » en la carpeta de unidad → «Stage N». */
function nivelDe(segmentos) {
    for (const s of segmentos) {
        const m = s.match(/stage\s*(\d+)/i) || s.match(/^S(\d+)\b/i);
        if (m) return `Stage ${m[1]}`;
    }
    return null;
}

/** Rol del material a partir de la ruta+nombre (Activities/Tests → test; Exercise Answers → solucionario…). */
function rolMaterial(rutaLower) {
    if (/exercise answers|answer key/.test(rutaLower)) return 'solucionario';
    if (/\btests?\b/.test(rutaLower)) return 'test';
    if (/activity worksheet|worksheets?\b/.test(rutaLower)) return 'ejercicios';
    if (/glossary|glosario/.test(rutaLower)) return 'glosario';
    if (/teaching tool kit|syllabus|introducing|welcome to|using the|resources for|chart|readers \[/.test(rutaLower)) return 'guia';
    return 'lectura';
}

/** Autor y título de la carpeta de unidad: «S0 Christine Lindop - Red Roses» → {autor, titulo}. */
function parseUnidad(nombreCarpeta) {
    const limpio = String(nombreCarpeta || '').replace(/^S\d+\s+/i, '').trim(); // quita el prefijo de stage
    const i = limpio.indexOf(' - ');
    if (i > 0) return { autor: limpio.slice(0, i).trim(), titulo: limpio.slice(i + 3).trim(), unidad: limpio };
    return { autor: null, titulo: limpio, unidad: limpio };
}

/** Título de PDF de lectura sin adornos: «Red Roses [1].pdf» → «Red Roses». */
function tituloDeArchivo(nombre) {
    return path.basename(nombre, path.extname(nombre)).replace(/\s*\[\d+\]\s*$/, '').trim();
}

/** CDU deducida (editable después). Heurística ligera por palabras clave; por defecto 82 (literatura). */
function deducirCdu(nombreColeccion, muestraNombres) {
    const t = (nombreColeccion + ' ' + muestraNombres.join(' ')).toLowerCase();
    if (/english|inglés|graded reader|bookworms|readers?\b/.test(t)) return '811.111'; // inglés (lengua)
    if (/français|french/.test(t)) return '811.133.1';
    if (/deutsch|german/.test(t)) return '811.112.2';
    return '82'; // literatura / narrativa, por defecto
}

/**
 * ANALIZA (sin efectos secundarios: no copia, no toca la BD) una carpeta transmedia y devuelve el PLAN:
 * nombre de colección, CDU deducida, idioma, y la lista de miembros (un PDF = un miembro) con sus etiquetas,
 * más las unidades audio-only (audiolibros). Ideal para un dry-run.
 */
export async function analizarTransmedia(dirOrigen, { idioma = 'en' } = {}) {
    // La colección es la carpeta soltada; si envuelve una ÚNICA subcarpeta (y solo metadatos sueltos), se
    // desciende a ella (caso «52.Archivos transmedia/Oxford Bookworms Library»).
    let raiz = dirOrigen;
    const enRaiz = (await fs.readdir(raiz, { withFileTypes: true }).catch(() => []))
        .filter((e) => !ignorar(e.name));
    const subdirs = enRaiz.filter((e) => e.isDirectory());
    const ficherosRaiz = enRaiz.filter((e) => e.isFile() && (esPdf(e.name) || esAudio(e.name)));
    if (subdirs.length === 1 && ficherosRaiz.length === 0) raiz = path.join(raiz, subdirs[0].name);

    const nombreColeccion = path.basename(raiz);
    const ficheros = await listarFicheros(raiz);
    const pdfs = ficheros.filter((f) => esPdf(f.nombre));
    const audios = ficheros.filter((f) => esAudio(f.nombre));
    const covers = ficheros.filter((f) => /^cover\.(jpe?g|png|webp)$/i.test(f.nombre)); // solo la portada, no páginas

    // Índice del segmento que es la CARPETA DE UNIDAD del libro. El marcador MÁS fiable es que EMPIECE por
    // «Sx » (S0..S6 «Autor - Título»): funciona tanto bajo «Stage N/» como bajo «Without Book/» (audiolibros).
    // Si no lo hay, se usa la hija de «Stage N»; y si tampoco, la carpeta de primer nivel.
    const idxUnidad = (segs) => {
        const i = segs.findIndex((s) => /^S\d+[\s.\-]/i.test(s));
        if (i >= 0) return i;
        const st = segs.findIndex((s) => /stage\s*\d+/i.test(s));
        if (st >= 0 && segs.length > st + 1) return st + 1;
        return segs.length >= 2 ? 0 : -1;
    };
    const unidadDe = (rel) => { const segs = rel.split('/'); const i = idxUnidad(segs); return i >= 0 ? segs[i] : null; };
    const carpetaUnidadDe = (rel) => { const segs = rel.split('/'); const i = idxUnidad(segs); return i >= 0 ? segs.slice(0, i + 1).join('/') : null; };

    // Índice de covers y audios por carpeta de unidad (para enlazarlos al doc de lectura/audiolibro).
    const coverPorUnidad = new Map();
    for (const c of covers) {
        const u = carpetaUnidadDe(c.rel);
        if (u && !coverPorUnidad.has(u)) coverPorUnidad.set(u, c.rel);
    }
    const audiosPorUnidad = new Map();
    for (const a of audios.sort((x, y) => x.rel.localeCompare(y.rel, 'es', { numeric: true }))) {
        const u = carpetaUnidadDe(a.rel);
        if (!u) continue;
        if (!audiosPorUnidad.has(u)) audiosPorUnidad.set(u, []);
        audiosPorUnidad.get(u).push(a.rel);
    }

    // Un miembro por PDF.
    const miembros = pdfs.map((f) => {
        const segs = f.rel.split('/');
        const nivel = nivelDe(segs);
        const carpetaUnidad = carpetaUnidadDe(f.rel);
        const nombreUnidad = unidadDe(f.rel);
        const { autor, titulo: tituloUnidad } = parseUnidad(nombreUnidad || '');
        const rol = rolMaterial(f.rel.toLowerCase());
        const esLectura = rol === 'lectura';
        const titulo = esLectura
            ? (tituloUnidad || tituloDeArchivo(f.nombre))
            : `${tituloUnidad || tituloDeArchivo(f.nombre)} — ${rol}`;
        return {
            rel: f.rel,
            nombre_archivo: f.nombre,
            nivel,
            unidad: nombreUnidad || null,
            rol_material: rol,
            titulo,
            autores: esLectura && autor ? [autor] : [],
            // La lectura de una unidad lleva su portada y sus audios; los materiales, solo la portada.
            portada_rel: carpetaUnidad ? (coverPorUnidad.get(carpetaUnidad) || null) : null,
            audios_rel: esLectura && carpetaUnidad ? (audiosPorUnidad.get(carpetaUnidad) || []) : [],
        };
    });

    // Audiolibros: unidades con AUDIO pero SIN ningún PDF de lectura → un documento audio-only por unidad.
    const unidadesConLectura = new Set(
        miembros.filter((m) => m.rol_material === 'lectura' && m.unidad).map((m) => carpetaUnidadDe(m.rel)),
    );
    const audiolibros = [];
    for (const [carpetaUnidad, lista] of audiosPorUnidad) {
        if (unidadesConLectura.has(carpetaUnidad)) continue; // ya lo lleva su lectura
        const nombreUnidad = carpetaUnidad.split('/').pop();
        const { autor, titulo } = parseUnidad(nombreUnidad);
        audiolibros.push({
            unidad: nombreUnidad,
            carpeta_rel: carpetaUnidad,
            nivel: nivelDe(carpetaUnidad.split('/')),
            titulo,
            autores: autor ? [autor] : [],
            portada_rel: coverPorUnidad.get(carpetaUnidad) || null,
            audios_rel: lista,
        });
    }

    const cdu = deducirCdu(nombreColeccion, pdfs.slice(0, 30).map((f) => f.nombre));
    return {
        raiz, nombreColeccion, cdu, idioma,
        totales: { pdfs: pdfs.length, audios: audios.length, covers: covers.length, audiolibros: audiolibros.length },
        miembros, audiolibros,
    };
}

// ── Ejecución: copiar VERBATIM + crear colección + insertar miembros + reciclar origen ──────────────────

/** Copia un árbol de origen→destino y VERIFICA que el nº de ficheros y los bytes coinciden. Nunca borra. */
async function copiarVerificado(origen, destino) {
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await fs.cp(origen, destino, { recursive: true, force: false, errorOnExist: false });
    const [a, b] = await Promise.all([huella(origen), huella(destino)]);
    return a.n === b.n && a.bytes === b.bytes; // íntegra si coinciden nº de ficheros y bytes totales
}
async function huella(dir) {
    let n = 0, bytes = 0;
    const pila = [dir];
    while (pila.length) {
        const d = pila.pop();
        let ents; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { continue; }
        for (const e of ents) {
            if (ignorar(e.name)) continue;
            const p = path.join(d, e.name);
            if (e.isDirectory()) pila.push(p);
            else { try { const s = await fs.stat(p); n++; bytes += s.size; } catch { /* */ } }
        }
    }
    return { n, bytes };
}

/**
 * Ingesta REAL de una carpeta transmedia. Copia el árbol verbatim a `<cdu>/transmedia/<colección>/`, crea la
 * colección `tipo:'transmedia'` y un documento por PDF (+ audiolibros), y solo tras VERIFICAR la copia recicla
 * el origen del Inbox. Dedup por hash: PDFs de igual hash → un solo documento (ambos ficheros permanecen).
 * @returns {Promise<{ok:boolean, coleccion?:string, insertados?:number, motivo?:string}>}
 */
export async function ingestarTransmedia(dirOrigen, { db: dbArg, reciclarOrigen = true } = {}) {
    const db = dbArg || await conectarDB();
    const plan = await analizarTransmedia(dirOrigen);
    if (!plan.miembros.length && !plan.audiolibros.length) return { ok: false, motivo: 'no hay PDFs ni audios que catalogar' };

    // Destino: <árbol CDU>/transmedia/<nombre-colección>/… (una sola rama; la estructura interna se preserva).
    const segsCdu = arbolCDU(plan.cdu).segmentos;
    const carpetaColeccion = path.join(DIR_CDU, ...segsCdu, 'transmedia', plan.nombreColeccion);
    const webColeccion = webDe(carpetaColeccion);

    // 1) COPIA VERBATIM + verificación (nunca se borra el origen si la copia no quedó íntegra).
    const integra = await copiarVerificado(plan.raiz, carpetaColeccion);
    if (!integra) return { ok: false, motivo: 'la copia al árbol CDU no quedó íntegra (nº de ficheros/bytes no coincide): se CONSERVA el origen' };
    // Marcador que protege TODO el subárbol de Integridad/Conformador (no podar/mover/reciclar).
    await fs.writeFile(path.join(carpetaColeccion, MARCA_RUTA_FIJA), `transmedia: ${plan.nombreColeccion}\n`).catch(() => {});

    // 2) Colección tipo:'transmedia' (CDU deducida, editable después).
    const { _id: coleccionId } = await resolverCabecera(db, {
        nombre: plan.nombreColeccion, tipo: 'transmedia', cdu: plan.cdu,
        descripcion: `Colección transmedia · ${plan.totales.pdfs} PDF · ${plan.totales.audios} audios.`,
    });
    await db.collection('colecciones').updateOne({ _id: coleccionId }, { $set: { raiz_web: webColeccion, ruta_fija: true } });

    const bib = db.collection('biblioteca');
    const webDeRel = (rel) => rel ? `${webColeccion}/${rel}` : null;                       // fichero
    const carpetaWebDeRel = (rel) => rel ? `${webColeccion}/${rel.split('/').slice(0, -1).join('/')}`.replace(/\/$/, '') : webColeccion; // su carpeta

    // Resuelve nombres de autor → ObjectId (check-then-create, insensible a grafía). autores es array de
    // ObjectId en el $jsonSchema; se cachean para no re-resolver el mismo nombre en cientos de docs.
    const cacheAutores = new Map();
    const resolverAutores = async (nombres) => {
        const ids = [];
        for (const nom of nombres || []) {
            if (!cacheAutores.has(nom)) { const r = await resolverPersona(db, nom).catch(() => null); cacheAutores.set(nom, r?._id || null); }
            const id = cacheAutores.get(nom);
            if (id) ids.push(id);
        }
        return ids;
    };

    // 3) Documentos por PDF (dedup por hash) + audiolibros. Se calcula el hash sobre el fichero YA copiado.
    const hashesVistos = new Set();
    let insertados = 0, deduplicados = 0;

    const baseDoc = (extra) => ({
        cdu: plan.cdu, idioma: plan.idioma, ubicacion: { ambito: 'Sin asignar', estanteria: 'Sin asignar' },
        coleccion: coleccionId, coleccion_nombre: plan.nombreColeccion, ruta_fija: true,
        estado_verificacion: 'completado', fecha_creacion: new Date(), ...extra,
    });

    for (const m of plan.miembros) {
        const abs = path.join(carpetaColeccion, ...m.rel.split('/'));
        const hash = await calcularHashArchivo(abs).catch(() => null);
        if (hash && hashesVistos.has(hash)) { deduplicados++; continue; } // igual hash → un solo doc (fichero intacto)
        if (hash) hashesVistos.add(hash);
        const autores = await resolverAutores(m.autores);
        const audios = (m.audios_rel || []).map((r, i) => ({ ruta: webDeRel(r), titulo: tituloDeArchivo(path.basename(r)), orden: i + 1 }));
        const doc = baseDoc({
            titulo: m.titulo, tipo_recurso: 'libro', formatos: ['pdf'],
            autores: autores.length ? autores : undefined,
            nombre_archivo: m.nombre_archivo, ruta_base: carpetaWebDeRel(m.rel),
            nivel: m.nivel || undefined, unidad: m.unidad || undefined, rol_material: m.rol_material,
            portada: webDeRel(m.portada_rel) || undefined,
            audios: audios.length ? audios : undefined,   // una lectura con audio se deja como libro (+ audios)
            hash_contenido: hash || undefined,
        });
        await bib.insertOne(limpiarUndefined(doc));
        insertados++;
    }

    for (const a of plan.audiolibros) {
        const autores = await resolverAutores(a.autores);
        const doc = baseDoc({
            titulo: a.titulo, tipo_recurso: 'libro', naturaleza: 'audiolibro', formatos: ['audio'],
            autores: autores.length ? autores : undefined,
            ruta_base: webDeRel(a.carpeta_rel), rol_material: 'audiolibro',
            nivel: a.nivel || undefined, unidad: a.unidad || undefined,
            portada: webDeRel(a.portada_rel) || undefined,
            audios: a.audios_rel.map((r, i) => ({ ruta: webDeRel(r), titulo: tituloDeArchivo(path.basename(r)), orden: i + 1 })),
        });
        await bib.insertOne(limpiarUndefined(doc));
        insertados++;
    }

    // 4) Solo AHORA (todo copiado y catalogado) se recicla el origen del Inbox a la Papelera (recuperable).
    if (reciclarOrigen) await reciclarCarpeta(dirOrigen, 'transmedia-ingerido').catch(() => {});

    return { ok: true, coleccion: plan.nombreColeccion, cdu: plan.cdu, insertados, deduplicados, web: webColeccion };
}

/** Quita las claves con valor undefined (para no persistir campos vacíos y no violar el $jsonSchema). */
function limpiarUndefined(obj) {
    const salida = {};
    for (const [k, v] of Object.entries(obj)) if (v !== undefined) salida[k] = v;
    return salida;
}
