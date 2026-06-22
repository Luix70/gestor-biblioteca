import { buscarMetadatosExternos } from './utils/proveedor-metadatos.js';
import { validarISBN, validarISSN, variantesISBN } from './utils/identificadores.js';

// "Editoriales" que en realidad son grupos de difusión/maquetación, no casas editoriales.
// Si el archivo trae una de estas, NO es autoritativa: una editorial real de las APIs prevalece.
const EDITORIALES_NO_VALIDAS = [
    /epub\s*libre/i,
    /lectulandia/i,
    /oz\s*epub/i,
    /todo\s*epub/i,
];

function esEditorialFalsa(nombre) {
    return !!nombre && EDITORIALES_NO_VALIDAS.some(re => re.test(String(nombre)));
}

/**
 * Devuelve el primer valor "con contenido" de la lista.
 * Trata null, undefined, '' y arrays vacíos como ausencia de dato.
 */
function primerValido(...valores) {
    for (const v of valores) {
        if (v === null || v === undefined) continue;
        if (typeof v === 'string' && v.trim() === '') continue;
        if (Array.isArray(v) && v.length === 0) continue;
        return v;
    }
    return undefined;
}

/**
 * Nivel 2: enriquece los datos crudos de un lector (EPUB/PDF/visión) con fuentes externas.
 *
 * PRINCIPIO RECTOR — CONSERVADURISMO: el archivo es la fuente de verdad. Todo dato que el
 * archivo ya aporta NUNCA se sobrescribe con datos de Internet/IA; las fuentes externas solo
 * rellenan huecos.
 *
 * @param datosBase  datos crudos del lector (titulo, autores, isbn, editorial, sinopsis, ...)
 * @param contexto   { tipo_recurso, formatos, ubicacion } que el orquestador fija según el tipo
 */
export async function enriquecerMetadatos(datosBase, contexto = {}) {
    // Sinopsis nativa del archivo: puede llegar como 'sinopsis' o 'sinopsis_nativa' (lector-epub).
    const sinopsisEpub = primerValido(datosBase.sinopsis, datosBase.sinopsis_nativa);

    let documento = {
        ...datosBase,
        tipo_recurso: primerValido(datosBase.tipo_recurso, contexto.tipo_recurso) || 'libro',
        formatos: primerValido(datosBase.formatos, contexto.formatos) || ['digital'],
        estado_verificacion: 'pendiente',
        alertas_agente: Array.isArray(datosBase.alertas_agente) ? [...datosBase.alertas_agente] : [],
        ubicacion: primerValido(datosBase.ubicacion, contexto.ubicacion)
            || { ambito: 'Biblioteca Digital', estanteria: 'NAS' }
    };
    if (sinopsisEpub) documento.sinopsis = sinopsisEpub;
    delete documento.sinopsis_nativa;

    console.log(`[Enriquecedor] Datos nativos para: "${documento.titulo}"`);

    // OBRA MULTIVOLUMEN: por drop de carpeta de tomos (contexto.obra) o por ISBN con rol en los
    // créditos. El nombre de carpeta / "(obra completa)" identifica la OBRA; "(tomo N)" el tomo.
    // El ISBN del tomo manda sobre el genérico del fichero; el título compuesto es autoritativo.
    const isbnsRol = Array.isArray(datosBase.isbns_rol) ? datosBase.isbns_rol : [];
    const isbnObraRol = isbnsRol.find(x => x.rol === 'obra');
    const isbnVolRol = isbnsRol.find(x => x.rol === 'volumen');
    if (contexto.obra || isbnObraRol) {
        documento.obra_titulo = contexto.obra?.titulo || documento.obra_titulo || documento.titulo;
        const numVol = contexto.obra?.numero ?? isbnVolRol?.numero ?? documento.volumen_numero ?? null;
        if (numVol != null) documento.volumen_numero = numVol;
        if (contexto.obra?.titulo_volumen) documento.volumen_titulo = contexto.obra.titulo_volumen;
        if (isbnObraRol) documento.isbn_obra = isbnObraRol.isbn;
        if (isbnVolRol) documento.isbn = isbnVolRol.isbn;
        if (documento.volumen_numero != null && documento.obra_titulo) {
            documento.titulo = `${documento.obra_titulo} — Vol. ${documento.volumen_numero}${documento.volumen_titulo ? `: ${documento.volumen_titulo}` : ''}`;
        }
    }

    // BLOQUE CIP (Catalogación en Publicación) leído del propio fichero: registro casi-MARC de
    // alta confianza. Es FUENTE DE ARCHIVO (no Internet), así que rellena huecos con prioridad
    // sobre las APIs y —lo más valioso— aporta Dewey/LC para clasificar la CDU SIN IA.
    const cip = datosBase.cip || null;
    if (cip) {
        const tituloEsId = !!(validarISBN(documento.titulo) || validarISSN(documento.titulo));
        if ((!primerValido(documento.titulo) || tituloEsId) && cip.titulo) documento.titulo = cip.titulo;
        if (cip.subtitulo && !primerValido(documento.subtitulo)) documento.subtitulo = cip.subtitulo;
        if ((!documento.autores || documento.autores.length === 0) && cip.autor) documento.autores = [cip.autor];
        if (!primerValido(documento.coleccion_nombre) && cip.serie) documento.coleccion_nombre = cip.serie;
        if (!primerValido(documento.isbn) && cip.isbns?.length) documento.isbn = cip.isbns[0].isbn;
        if (cip.lccn) documento.lccn = cip.lccn;
        // Materias LCSH → palabras_clave (se fusionan; no se pierden las del archivo).
        if (cip.materias?.length) {
            const previas = Array.isArray(documento.palabras_clave) ? documento.palabras_clave : [];
            documento.palabras_clave = [...new Set([...previas, ...cip.materias])];
        }
        documento.alertas_agente.push('Datos del bloque CIP del propio fichero.');
    }

    // Qué falta (solo eso justifica tocar la red / la IA).
    const faltaSinopsis = !primerValido(documento.sinopsis);
    const faltaCdu = !primerValido(documento.cdu);

    const autorPrincipal = (documento.autores && documento.autores.length > 0) ? documento.autores[0] : '';
    const imagen = primerValido(datosBase.cubierta_base64, datosBase.imagen_adicional) || null;

    // ISBN como pivote: reunimos todos los candidatos del archivo (lectura del texto/nombre
    // ya recolectados por el lector, más las formas 10/13 del isbn principal) para que las
    // APIs los prueben uno a uno. El ISBN es la clave de búsqueda más fiable del archivo.
    // EXCEPCIÓN: ninguna revista usa ISBN para las APIs — el ISBN extraído del texto de una
    // revista suele ser un código de barras de un producto anunciado, un catálogo editorial o
    // una suscripción, nunca el identificador del número concreto, y provoca lookups incorrectos
    // (datos de un libro ajeno, como se comprobó con "Direction Italie" → Renacimiento italiano).
    const esRevista = documento.tipo_recurso === 'revista';
    const isbnsArchivo = new Set();
    if (!esRevista) {
        for (const x of (datosBase.isbn_candidatos || [])) for (const v of variantesISBN(x)) isbnsArchivo.add(v);
        for (const v of variantesISBN(documento.isbn)) isbnsArchivo.add(v);
        for (const c of (cip?.isbns || [])) for (const v of variantesISBN(c.isbn)) isbnsArchivo.add(v);
    }
    if (esRevista) { delete documento.isbn; }

    // Pasar el idioma del archivo para filtrar la búsqueda por lengua: da con la edición en
    // español/inglés/etc. antes que con ediciones en otras lenguas (caso Anna Karenina).
    // El Dewey/LC del CIP (del propio fichero) se siembra como autoridad antes que las APIs.
    const datosExtra = await buscarMetadatosExternos(documento.titulo, autorPrincipal, imagen, {
        incluirSinopsis: faltaSinopsis,
        incluirCdu: faltaCdu,
        isbnsArchivo: [...isbnsArchivo],
        idioma: documento.idioma || null,
        cipDewey: cip?.dewey || null,
        cipLcc: cip?.lc || null,
    });

    // Título y autores: el archivo manda, SALVO que su "título" no sea fiable, es decir,
    // que falte o sea en realidad un identificador (p. ej. un PDF llamado "0071769234.pdf",
    // cuyo nombre-ISBN se guardó como título). En ese caso la autoridad lo sustituye.
    const tituloEsIdentificador = !!(validarISBN(documento.titulo) || validarISSN(documento.titulo));
    if (!primerValido(documento.titulo) || tituloEsIdentificador) {
        if (datosExtra.titulo) {
            if (tituloEsIdentificador) {
                documento.alertas_agente.push(`Título "${documento.titulo}" era un identificador; sustituido por el de la autoridad: "${datosExtra.titulo}".`);
            }
            documento.titulo = datosExtra.titulo;
        }
    }
    if ((!documento.autores || documento.autores.length === 0) && datosExtra.autores && datosExtra.autores.length > 0) {
        documento.autores = datosExtra.autores;
    }

    // Fusión CONSERVADORA: el dato del archivo manda; lo externo solo rellena huecos.
    documento.sinopsis    = primerValido(documento.sinopsis, datosExtra.sinopsis);

    // Editorial: excepción al conservadurismo. Si el archivo trae un grupo de difusión
    // (ePubLibre, etc.), una editorial real encontrada en las APIs tiene prioridad.
    if (esEditorialFalsa(documento.editorial)) {
        const editorialReal = primerValido(datosExtra.editorial);
        if (editorialReal) {
            documento.alertas_agente.push(`Editorial "${documento.editorial}" sustituida por la editorial real: "${editorialReal}".`);
            documento.editorial = editorialReal;
        }
        // Si las APIs no aportan una editorial real, se conserva la del archivo.
    } else {
        documento.editorial = primerValido(documento.editorial, datosExtra.editorial);
    }
    documento.año_edicion = primerValido(documento.año_edicion, datosExtra.año_edicion);
    documento.idioma      = primerValido(documento.idioma, datosExtra.idioma) || 'es';
    documento.cdu         = primerValido(documento.cdu, datosExtra.cdu);
    if (datosExtra.cdu_adicionales && datosExtra.cdu_adicionales.length > 0)
        documento.cdu_adicionales = datosExtra.cdu_adicionales;

    // Persistir los códigos de clasificación de origen (Dewey/LC) cuando son fiables: del CIP
    // del propio fichero o de una autoridad (OpenLibrary/DNB). Conservan la procedencia de la
    // CDU y permiten re-derivarla o auditarla sin volver a consultar. El archivo manda.
    documento.dewey = primerValido(documento.dewey, datosExtra.dewey);
    documento.lcc   = primerValido(documento.lcc, datosExtra.lcc);
    documento.palabras_clave = primerValido(documento.palabras_clave, datosExtra.categorias);

    // Colección/serie: el archivo (metadatos Calibre / nombre) manda; la visión rellena el hueco.
    // El número se guarda como cadena (preserva romanos como "XLVII" y árabes por igual).
    documento.coleccion_nombre = primerValido(documento.coleccion_nombre, datosExtra.coleccion_nombre);
    documento.coleccion_numero = primerValido(documento.coleccion_numero, datosExtra.coleccion_numero);
    if (documento.coleccion_numero != null) documento.coleccion_numero = String(documento.coleccion_numero);

    // Drop por CARPETA: el nombre de la carpeta es una agrupación EXPLÍCITA del usuario y manda
    // sobre cualquier colección deducida del archivo. El número de serie del archivo (si lo hay)
    // se conserva; si no, motor-catalogo asignará el siguiente incremental.
    if (contexto.coleccion) {
        documento.coleccion_nombre = contexto.coleccion;
    }
    // Campos físicos de la BNE: el archivo digital no los tiene; las APIs tampoco los aportan.
    if (datosExtra.paginas_bne && !documento.paginas)
        documento.paginas = datosExtra.paginas_bne;
    if (datosExtra.dimensiones_bne && !documento.dimensiones)
        documento.dimensiones = datosExtra.dimensiones_bne;

    // ISBN: si una autoridad resolvió un registro, su ISBN es el canónico/indexado y manda
    // (el archivo puede traer el de otra edición no indexada — case 14). Si ninguna API
    // resolvió, vale el del archivo. Se valida el dígito de control y se descarta si es basura.
    // Las revistas no tienen ISBN propio; cualquier ISBN que retorne la API para una búsqueda
    // por título de revista es de un libro homónimo, no del número de la publicación.
    if (!esRevista) {
        const isbnCandidato = primerValido(datosExtra.isbn, documento.isbn);
        if (isbnCandidato) {
            const isbnValido = validarISBN(isbnCandidato);
            if (isbnValido) documento.isbn = isbnValido;
            else {
                documento.alertas_agente.push(`ISBN descartado por dígito de control inválido: "${isbnCandidato}".`);
                delete documento.isbn;
            }
        } else {
            delete documento.isbn;
        }
    }

    // ISSN (revistas): misma validación.
    if (documento.issn) {
        const issnValido = validarISSN(documento.issn);
        if (issnValido) documento.issn = issnValido;
        else {
            documento.alertas_agente.push(`ISSN descartado por dígito de control inválido: "${documento.issn}".`);
            delete documento.issn;
        }
    }

    // Candidatos de portada remota para que el orquestador construya imagenes[] (campo interno).
    documento._portadas_remotas = datosExtra.portadas_remotas || [];

    // Trazabilidad.
    if (datosExtra.alertas && datosExtra.alertas.length > 0) {
        documento.alertas_agente.push(...datosExtra.alertas);
    }
    if (sinopsisEpub) {
        documento.alertas_agente.push("Sinopsis conservada del archivo original (no sobrescrita).");
    }

    // Estado de verificación: completado solo si hay título, CDU y un identificador válido
    // (ISBN para libros, ISSN para revistas).
    const tieneIdentificador = !!(documento.isbn || documento.issn);
    documento.estado_verificacion =
        (documento.titulo && documento.cdu && tieneIdentificador) ? 'completado' : 'pendiente';
    if (documento.estado_verificacion === 'pendiente') {
        documento.alertas_agente.push("Identificación incompleta (sin ISBN/ISSN o sin CDU): requiere revisión humana.");
    }

    // Limpieza 1: descartar campos internos de los lectores que no deben persistirse
    // (evita guardar la portada base64 completa o banderas de proceso en MongoDB).
    // OJO: _portadas_remotas lo necesita el orquestador y lo elimina él después.
    const CAMPOS_INTERNOS = ['cubierta_base64', 'imagen_adicional', 'sinopsis_nativa', 'texto_legible', 'paginas', '_error', 'isbn_candidatos', 'esFechada', 'isbns_rol', 'cip'];
    for (const k of CAMPOS_INTERNOS) delete documento[k];

    // Limpieza 2: ningún campo puede quedar como undefined/null/'' (rompería el $jsonSchema).
    Object.keys(documento).forEach(k => {
        const v = documento[k];
        if (v === undefined || v === null || v === '') delete documento[k];
    });

    return documento;
}
