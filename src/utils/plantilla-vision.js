/**
 * Extracción de metadatos por VISIÓN con una PLANTILLA rica (una sola llamada que devuelve TODO lo útil, no
 * solo un CDU → no se desperdician tokens). A partir de VARIAS imágenes del mismo ejemplar (portada, lomo,
 * contraportada, portadilla, créditos) identifica: tipo de documento, título/subtítulo, colaboradores CON
 * ROL, colección/serie + nº, obra multivolumen + volumen, TODOS los identificadores (isbn/issn, varios),
 * sinopsis PARAFRASEADA (evita RECITATION), y —si es revista— issn de cabecera, temática, periodicidad,
 * fecha y nº del ejemplar. La visión va por rotación multi-proveedor (gratis→pago) en conVision.
 *
 * Este módulo aporta: el PROMPT, la NORMALIZACIÓN del JSON a la forma del pipeline, y un EVALUADOR DE
 * CALIDAD (mide si la extracción mereció la pena — para el balance auto/supervisado).
 */
import { conVision, extraerJSON } from './vision.js';
import { ROLES_VALIDOS } from './contribuciones.js';

// Plantilla JSON que se pide rellenar (documentada). Se envía compacta en el prompt.
export const PLANTILLA_JSON = {
    tipo_documento: '', // libro | revista | articulo | comic | otro
    titulo: '', subtitulo: '',
    titulo_original: '', titulos_originales: [], // obra traducida (uno) / antología de relatos traducidos (varios)
    contribuciones: [{ nombre: '', rol: '' }], // rol ∈ autor|traductor|ilustrador|editor|prologuista|anotador|compilador
    idioma: '', idioma_original: '',
    editorial: '', 'año_edicion': null,
    coleccion: { nombre: '', numero: '' },
    obra: { titulo: '', volumen: '', total_volumenes: '' },
    isbn: [], issn: [], isbn_obra: '', codigo_barras: '',
    cdu: '', palabras_clave: [], sinopsis: '',
    revista: { issn_cabecera: '', tematica: '', periodicidad: '', fecha_ejemplar: '', numero_ejemplar: '' },
    estado_verificacion: '', alertas: [],
};

export const PROMPT_VISION_COMPLETO = `Eres un bibliotecario experto en catalogación. Analiza TODAS las imágenes (son del MISMO ejemplar:
portada, lomo, contraportada, portadilla, página de créditos…) y CONSOLIDA todo en UN ÚNICO objeto JSON que
rellene la plantilla. NO inventes: lo que no leas con seguridad, déjalo vacío ("" o []).
Identifica primero el TIPO de documento (a partir del conjunto): "libro", "revista", "articulo" (artículo
suelto/separata), "comic" u "otro".
Si es LIBRO:
- Colaboradores con su ROL (autor, traductor, ilustrador, editor, prologuista, anotador, compilador), tal
  como aparecen (portada/portadilla/créditos). IGNORA la editorial (no es persona). Cada 'nombre' es UNA
  persona: si hay VARIOS unidos por "&"/";"/"y"/"/", devuelve UN objeto por cada una (no los juntes).
- EDITORIAL: la casa REAL de ESTA edición (créditos/colofón, o inferida de la colección: "Tus Libros"=Anaya,
  "Austral"=Espasa, "El Barco de Vapor"=SM…). Los maquetadores/re-editores de ebooks (ePubLibre, Lectulandia,
  DigiCat, Good Press, epubGratis, e-artnow, Musaicum) NO son editoriales: ignóralos y busca la real; "" si no.
- TÍTULO ORIGINAL (si es traducción): 'titulo_original' del bloque de créditos ("Título original:"). Si es una
  ANTOLOGÍA de relatos traducidos, cada relato lleva su original: recógelos todos en 'titulos_originales'.
- ¿Pertenece a una COLECCIÓN/SERIE? su nombre y el número que ocupa.
- ¿Es un VOLUMEN de una obra en varios tomos? título de la obra, número de volumen y total si se indica.
- Identificadores: TODOS los ISBN que veas (rústica, tapa dura, e-ISBN) y, si aparece, el ISBN de la OBRA
  completa. Solo dígitos, sin guiones.
- SINOPSIS: normalmente en la contraportada. Resúmela CON TUS PALABRAS (parafraseada), 2-4 frases.
  PROHIBIDO transcribir literalmente (evita bloqueos por copyright / RECITATION).
Si es REVISTA:
- ISSN de la cabecera, temática, periodicidad (semanal/mensual/…), fecha del ejemplar (AAAA-MM o
  AAAA-MM-DD) y número del ejemplar.
Siempre: idioma (ISO 639-1), idioma_original si es traducción y se indica, editorial, año de edición, CDU
(con rigor), palabras_clave (materias), y el código de barras EAN-13 (13 dígitos; puede estar girado;
977=revista, 978/979=libro).
Devuelve SOLO este JSON (sin markdown ni texto fuera):
{"tipo_documento":"","titulo":"","subtitulo":"","titulo_original":"","titulos_originales":[],"contribuciones":[{"nombre":"","rol":""}],"idioma":"","idioma_original":"","editorial":"","año_edicion":null,"coleccion":{"nombre":"","numero":""},"obra":{"titulo":"","volumen":"","total_volumenes":""},"isbn":[],"issn":[],"isbn_obra":"","codigo_barras":"","cdu":"","palabras_clave":[],"sinopsis":"","revista":{"issn_cabecera":"","tematica":"","periodicidad":"","fecha_ejemplar":"","numero_ejemplar":""},"estado_verificacion":"","alertas":[]}`;

const soloDigitos = (s) => String(s || '').replace(/[^0-9Xx]/g, '');
const limpio = (s) => String(s || '').trim();

/**
 * Normaliza el JSON crudo de la visión a una forma cómoda para el pipeline: separa autores de contribuciones
 * con rol, deduplica identificadores, y deja los bloques de colección/obra/revista solo si tienen contenido.
 * @returns objeto normalizado (nunca lanza).
 */
export function normalizarExtraccionVision(j) {
    if (!j || typeof j !== 'object') return null;
    const contribuciones = [];
    const autores = [];
    for (const c of Array.isArray(j.contribuciones) ? j.contribuciones : []) {
        const nombre = limpio(c && c.nombre);
        const rol = ROLES_VALIDOS.includes(c && c.rol) ? c.rol : (c && c.rol ? null : null);
        if (!nombre) continue;
        if (rol === 'autor' || !rol) autores.push(nombre);
        else contribuciones.push({ nombre, rol });
    }
    const isbns = [...new Set((Array.isArray(j.isbn) ? j.isbn : [j.isbn]).map(soloDigitos).filter((x) => x.length >= 10))];
    const issns = [...new Set((Array.isArray(j.issn) ? j.issn : [j.issn]).map((x) => limpio(x)).filter(Boolean))];
    const col = j.coleccion || {};
    const obra = j.obra || {};
    const rev = j.revista || {};
    const titulosOrig = [...new Set((Array.isArray(j.titulos_originales) ? j.titulos_originales : []).map(limpio).filter(Boolean))];
    return {
        tipo_documento: limpio(j.tipo_documento) || null,
        titulo: limpio(j.titulo) || null,
        subtitulo: limpio(j.subtitulo) || null,
        titulo_original: limpio(j.titulo_original) || (titulosOrig.length === 1 ? titulosOrig[0] : null),
        titulos_originales: titulosOrig,
        autores,
        contribuciones,
        idioma: limpio(j.idioma) || null,
        idioma_original: limpio(j.idioma_original) || null,
        editorial: limpio(j.editorial) || null,
        'año_edicion': Number(j['año_edicion']) || null,
        coleccion_nombre: limpio(col.nombre) || null,
        coleccion_numero: limpio(col.numero) || null,
        obra_titulo: limpio(obra.titulo) || null,
        volumen_numero: limpio(obra.volumen) || null,
        isbn: isbns,
        issn: issns,
        isbn_obra: soloDigitos(j.isbn_obra) || null,
        codigo_barras: soloDigitos(j.codigo_barras) || null,
        cdu: limpio(j.cdu) || null,
        palabras_clave: (Array.isArray(j.palabras_clave) ? j.palabras_clave : []).map(limpio).filter(Boolean),
        sinopsis: limpio(j.sinopsis) || null,
        revista: {
            issn_cabecera: limpio(rev.issn_cabecera) || null,
            tematica: limpio(rev.tematica) || null,
            periodicidad: limpio(rev.periodicidad) || null,
            fecha_ejemplar: limpio(rev.fecha_ejemplar) || null,
            numero_ejemplar: limpio(rev.numero_ejemplar) || null,
        },
    };
}

/**
 * Evalúa la CALIDAD/RIQUEZA de una extracción normalizada: ¿mereció la pena la llamada de IA o solo devolvió
 * un CDU/palabras clave? Puntúa 0-100 y marca `merecePena` (≥40 = aporta datos catalográficos de valor).
 * @returns {{ puntuacion:number, merecePena:boolean, señales:string[] }}
 */
export function evaluarCalidadExtraccion(n) {
    if (!n) return { puntuacion: 0, merecePena: false, señales: [] };
    let p = 0;
    const señales = [];
    if (n.titulo) { p += 20; señales.push('título'); }
    if (n.autores.length) { p += 10; señales.push(`${n.autores.length} autor(es)`); }
    if (n.contribuciones.length) { p += 15; señales.push(`${n.contribuciones.length} rol(es)`); }
    // Identidad del ejemplar: ISBN/ISSN/EAN o, en revistas, la fecha/nº del ejemplar (es su identidad).
    if (n.isbn.length || n.issn.length || n.codigo_barras || n.revista.fecha_ejemplar || n.revista.numero_ejemplar) {
        p += 15; señales.push('identificador(es)');
    }
    if (n.sinopsis && n.sinopsis.length >= 80) { p += 20; señales.push('sinopsis'); }
    if (n.coleccion_nombre || n.obra_titulo) { p += 10; señales.push(n.obra_titulo ? 'obra/volumen' : 'colección'); }
    if (n.revista.tematica || n.revista.fecha_ejemplar || n.revista.issn_cabecera) { p += 10; señales.push('datos de revista'); }
    if (n.palabras_clave.length >= 3) { p += 5; señales.push('palabras clave'); }
    if (n.cdu) { p += 5; señales.push('CDU'); }
    const puntuacion = Math.min(100, p);
    return { puntuacion, merecePena: puntuacion >= 40, señales };
}

/**
 * Extrae con la plantilla completa a partir de imágenes (Buffers). Devuelve { crudo, normalizado, calidad }.
 * @param {Array<{data:Buffer, mimeType?:string}>} imagenes
 */
export async function extraerConPlantilla(imagenes) {
    const partes = (imagenes || [])
        .filter((i) => i && i.data)
        .map(({ data, mimeType }) => ({ base64: data.toString('base64'), mimeType: mimeType || 'image/jpeg' }));
    if (!partes.length) return { crudo: null, normalizado: null, calidad: { puntuacion: 0, merecePena: false, señales: [] } };
    const crudo = extraerJSON(await conVision({ prompt: PROMPT_VISION_COMPLETO, imagenes: partes }));
    const normalizado = normalizarExtraccionVision(crudo);
    const calidad = evaluarCalidadExtraccion(normalizado);
    return { crudo, normalizado, calidad };
}
