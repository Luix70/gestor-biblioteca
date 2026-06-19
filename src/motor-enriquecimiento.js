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

    // Qué falta (solo eso justifica tocar la red / la IA).
    const faltaSinopsis = !primerValido(documento.sinopsis);
    const faltaCdu = !primerValido(documento.cdu);

    const autorPrincipal = (documento.autores && documento.autores.length > 0) ? documento.autores[0] : '';
    const imagen = primerValido(datosBase.cubierta_base64, datosBase.imagen_adicional) || null;

    // ISBN como pivote: reunimos todos los candidatos del archivo (lectura del texto/nombre
    // ya recolectados por el lector, más las formas 10/13 del isbn principal) para que las
    // APIs los prueben uno a uno. El ISBN es la clave de búsqueda más fiable del archivo.
    const isbnsArchivo = new Set();
    for (const x of (datosBase.isbn_candidatos || [])) for (const v of variantesISBN(x)) isbnsArchivo.add(v);
    for (const v of variantesISBN(documento.isbn)) isbnsArchivo.add(v);

    const datosExtra = await buscarMetadatosExternos(documento.titulo, autorPrincipal, imagen, {
        incluirSinopsis: faltaSinopsis,
        incluirCdu: faltaCdu,
        isbnsArchivo: [...isbnsArchivo]
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
    documento.palabras_clave = primerValido(documento.palabras_clave, datosExtra.categorias);

    // ISBN: si una autoridad resolvió un registro, su ISBN es el canónico/indexado y manda
    // (el archivo puede traer el de otra edición no indexada — case 14). Si ninguna API
    // resolvió, vale el del archivo. Se valida el dígito de control y se descarta si es basura.
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
    const CAMPOS_INTERNOS = ['cubierta_base64', 'imagen_adicional', 'sinopsis_nativa', 'texto_legible', 'paginas', '_error', 'isbn_candidatos'];
    for (const k of CAMPOS_INTERNOS) delete documento[k];

    // Limpieza 2: ningún campo puede quedar como undefined/null/'' (rompería el $jsonSchema).
    Object.keys(documento).forEach(k => {
        const v = documento[k];
        if (v === undefined || v === null || v === '') delete documento[k];
    });

    return documento;
}
