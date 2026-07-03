import { conectarDB } from '../database.js';
import { buscarEnFicheroLocal } from './buscador-local.js';
import { buscarMetadatosExternos } from './proveedor-metadatos.js';
import { validarISBN, isbn10a13, isbn13a10 } from './identificadores.js';
import { sanitizarCDU } from './cdu-arbol.js';
import { portadasPorISBN } from './portadas-isbn.js';

// Descripción legible (ES) de un código CDU desde la caché 'cdu_descripciones' — SOLO lectura, sin generar
// nada (evita depender de IA en el alta por ISBN). Duplicado deliberadamente pequeño de la de api-panel.js.
async function cduDescCache(db, cdu) {
    if (!cdu) return null;
    const codigo = sanitizarCDU(cdu);
    if (!codigo) return null;
    return await db.collection('cdu_descripciones').findOne(
        { codigo }, { projection: { titulo_es: 1, descripcion_es: 1 } });
}

/**
 * Busca UN ISBN: 1) Fichero local (offline, instantáneo) — autoridad principal. 2) ONLINE (OpenLibrary +
 * Google Books + DNB/BnF, vía buscarMetadatosExternos) si el Fichero no encontró NADA, o si lo encontró
 * pero le faltan huecos que esa edición concreta no trae en el volcado (sinopsis/colección/CDU/portada:
 * frecuente en reimpresiones de bolsillo antiguas). Un acierto del Fichero NUNCA se pisa: el online solo
 * RELLENA lo vacío. Compartida entre el lookup individual (GET /isbn/:isbn) y el lote (iniciarLoteISBN).
 */
export async function buscarUnISBN(rawIsbn) {
    const limpio = String(rawIsbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();
    if (!validarISBN(limpio)) {
        return { ok: false, motivo: 'ISBN no válido (dígito de control incorrecto)' };
    }
    const isbn13 = limpio.length === 13 ? limpio : isbn10a13(limpio);
    const isbn10 = limpio.length === 10 ? limpio : isbn13a10(limpio);
    const isbns = [isbn13, isbn10, limpio].filter(Boolean);

    // PROCEDENCIA por campo — para colorear cada dato en el panel según cuánto fiarse de él:
    //   'fichero' = autoridad (volcado OL+BNE local) → negro    · 'online' = APIs gratuitas (OL/Google
    //   Books/DNB/BnF) → azul    · 'ia' = derivado por IA (solo la CDU cuando no hay Dewey/LCC) → rojo.
    // Un campo escrito/corregido a mano en el panel pasa a 'manual' (lo marca el cliente). Se anota la
    // procedencia SOLO de campos con valor (no se pisa una ya anotada: gana la fuente más autoritativa,
    // que siempre se consulta antes).
    const procedencia = {};
    const CAMPOS = ['titulo', 'subtitulo', 'autores', 'editorial', 'año_edicion', 'idioma', 'cdu', 'dewey', 'lcc', 'sinopsis', 'coleccion_nombre', 'categorias', 'palabras_clave'];
    const tieneValor = (v) => !(v == null || v === '' || (Array.isArray(v) && !v.length));
    const marcar = (obj, origen, campos = CAMPOS) => {
        for (const c of campos) if (tieneValor(obj[c]) && !procedencia[c]) procedencia[c] = origen;
    };

    let meta = await buscarEnFicheroLocal({ isbns });
    let fuenteMeta = meta && meta.titulo ? 'fichero' : null;
    if (meta) marcar(meta, 'fichero'); // lo que traiga el Fichero es autoritativo

    const faltaHueco = !meta || !meta.titulo
        || !meta.sinopsis || !meta.coleccion_nombre || !meta.cdu || !meta.portada_url;
    if (faltaHueco) {
        const online = await buscarMetadatosExternos(meta?.titulo || null, (meta?.autores || [])[0] || null, null, {
            isbnsArchivo: isbns,
            incluirSinopsis: true,
            incluirCdu: !(meta && meta.cdu),
        }).catch(() => null);
        // La CDU es lo único que puede venir de IA en este camino (sin imagen no hay visión): 'ia' si
        // resolverCDU la dedujo por IA; 'online' si salió de una equivalencia en caché/API o de la BnF.
        const cduOrigen = online && String(online.cdu_fuente || '').startsWith('ia') ? 'ia' : 'online';
        if (online && online.titulo && (!meta || !meta.titulo)) {
            // El Fichero no tenía NADA → el online pasa a ser la base completa.
            const portadaOnline = online.portadas_remotas?.find((p) => p && p.url)?.url || null;
            meta = {
                isbn: online.isbn || isbn13 || limpio,
                titulo: online.titulo,
                subtitulo: null,
                autores: online.autores || [],
                contribuciones_nombres: online.contribuciones_nombres || [],
                editorial: online.editorial || null,
                año_edicion: online.año_edicion || null,
                idioma: online.idioma || null,
                dewey: online.dewey || null,
                lcc: online.lcc || null,
                cdu: online.cdu || null,
                paginas: online.paginas_bne || null,
                dimensiones: online.dimensiones_bne || null,
                categorias: online.categorias || [],
                palabras_clave: online.palabras_clave || [],
                coleccion_nombre: online.coleccion_nombre || null,
                sinopsis: online.sinopsis || null,
                portada_url: portadaOnline,
                fuentes: ['online'],
            };
            fuenteMeta = 'online';
            marcar(meta, 'online');                     // todo lo demás es de APIs gratuitas
            if (tieneValor(meta.cdu)) procedencia.cdu = cduOrigen; // salvo la CDU, que puede ser IA
            // Las palabras_clave, si vienen, las dedujo la IA en la misma llamada de la CDU.
            if (tieneValor(meta.palabras_clave)) procedencia.palabras_clave = 'ia';
        } else if (online && meta && meta.titulo) {
            // El Fichero SÍ tenía título: el online solo RELLENA lo que faltaba, sin pisar nada.
            if (!meta.sinopsis && online.sinopsis) { meta.sinopsis = online.sinopsis; procedencia.sinopsis = 'online'; fuenteMeta = 'fichero+online'; }
            if (!meta.coleccion_nombre && online.coleccion_nombre) { meta.coleccion_nombre = online.coleccion_nombre; procedencia.coleccion_nombre = 'online'; fuenteMeta = 'fichero+online'; }
            if (!meta.cdu && online.cdu) { meta.cdu = online.cdu; procedencia.cdu = cduOrigen; fuenteMeta = 'fichero+online'; }
            if ((!meta.palabras_clave || !meta.palabras_clave.length) && online.palabras_clave?.length) { meta.palabras_clave = online.palabras_clave; procedencia.palabras_clave = 'ia'; }
            if (!meta.dewey && online.dewey) { meta.dewey = online.dewey; procedencia.dewey = 'online'; }
            if (!meta.lcc && online.lcc) { meta.lcc = online.lcc; procedencia.lcc = 'online'; }
            if (!meta.portada_url) {
                const portadaOnline = online.portadas_remotas?.find((p) => p && p.url)?.url || null;
                if (portadaOnline) { meta.portada_url = portadaOnline; fuenteMeta = 'fichero+online'; }
            }
        }
    }

    const portadas = await portadasPorISBN(isbn13, isbn10, meta && meta.portada_url);
    let cdu_desc = null;
    if (meta && meta.cdu) {
        try { cdu_desc = await cduDescCache(await conectarDB(), meta.cdu); } catch { /* caché opcional */ }
    }
    return {
        ok: true,
        isbn: isbn13 || limpio,
        encontrado: !!(meta && meta.titulo),
        fuente: fuenteMeta,
        meta: meta || null,
        procedencia,   // { campo: 'fichero'|'online'|'ia' } — el cliente lo usa para colorear
        portadas,
        cdu_desc,
    };
}

// Estado del trabajo de LOTE (en memoria; un lote a la vez — mismo patrón que utils/saneamiento.js).
let trabajo = { enCurso: false, total: 0, hechos: 0, resultados: [] };
export function estadoLoteISBN() { return trabajo; }

const MAX_LOTE = 200;

/**
 * Lanza en segundo plano la búsqueda (SIN crear nada) de una lista de ISBNs, uno a uno — secuencial, para
 * no ráfagas contra APIs con límite de tasa y no disparar el circuit-breaker de OpenLibrary de golpe.
 * Devuelve de inmediato; el progreso y los resultados se consultan con estadoLoteISBN(). Cada resultado
 * queda etiquetado con la `entrada` tal como la escribió/pegó el usuario (para poder señalar cuál falló).
 */
export function iniciarLoteISBN(entradas) {
    if (trabajo.enCurso) return { ok: false, motivo: 'ya hay una búsqueda de lote en curso' };
    const lista = (Array.isArray(entradas) ? entradas : [])
        .map((s) => String(s || '').trim())
        .filter(Boolean);
    if (!lista.length) return { ok: false, motivo: 'no se indicó ningún ISBN' };
    if (lista.length > MAX_LOTE) return { ok: false, motivo: `demasiados ISBN de una vez (máx. ${MAX_LOTE})` };

    trabajo = { enCurso: true, total: lista.length, hechos: 0, resultados: [] };
    (async () => {
        for (const entrada of lista) {
            let r;
            try { r = await buscarUnISBN(entrada); }
            catch (e) { r = { ok: false, motivo: e.message }; }
            trabajo.resultados.push({ entrada, ...r });
            trabajo.hechos++;
        }
        trabajo.enCurso = false;
        console.log(`🔢 Lote de ISBN terminado: ${trabajo.hechos}/${trabajo.total} buscados.`);
    })();
    return { ok: true, ...trabajo };
}
