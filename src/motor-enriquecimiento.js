import { buscarMetadatosExternos } from './utils/proveedor-metadatos.js';
import { validarISBN, validarISSN, variantesISBN } from './utils/identificadores.js';
import { esTituloArtefacto } from './utils/parsear-nombre.js';
import { parsearVolumen, totalDeclarado } from './utils/multivolumen.js';
import { tituloCabecera } from './utils/revistas.js';
import { buscarISSNporTitulo, buscarNombreDeISSNs } from './utils/buscador-issn-titulo.js';

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

    // Título NATIVO (del propio archivo), ANTES de enriquecer. Es normal que falte en PDFs sin
    // metadatos y nombrados por su ISBN: el título real se resuelve luego por identificador (no se
    // persiste nunca un título nulo — el $jsonSchema lo exige).
    const isbnPista = documento.isbn || (Array.isArray(datosBase.isbn_candidatos) && datosBase.isbn_candidatos[0]) || null;
    console.log(primerValido(documento.titulo)
        ? `[Enriquecedor] Título nativo del archivo: "${documento.titulo}"`
        : `[Enriquecedor] Sin título nativo en el archivo${isbnPista ? ` (ISBN ${isbnPista})` : ''}: se resolverá por identificador.`);

    // OBRA MULTIVOLUMEN: por drop de carpeta de tomos (contexto.obra) o por ISBN con rol en los
    // créditos. El nombre de carpeta / "(obra completa)" identifica la OBRA; "(tomo N)" el tomo.
    // El ISBN del tomo manda sobre el genérico del fichero; el título compuesto es autoritativo.
    const isbnsRol = Array.isArray(datosBase.isbns_rol) ? datosBase.isbns_rol : [];
    const isbnObraRol = isbnsRol.find(x => x.rol === 'obra');
    const rolVol = isbnsRol.filter(x => x.rol === 'volumen');
    // INDICIO DE TOMO POR TEXTO — común a TODOS los métodos de entrada (PDF/EPUB/imágenes/ISBN): si el
    // título, el subtítulo o el nombre de archivo traen "Vol./Tomo N" precedido del título de la OBRA, es
    // un tomo de obra multivolumen aunque NO venga por carpeta (contexto.obra) ni con ISBN-de-rol en los
    // créditos. Refuerza la detección para que sea igual sea cual sea la vía de entrada. Conservador:
    // solo si aún no hay volumen_numero (no pisa una detección estructurada previa: vision/carpeta/CIP) y
    // solo para libros no-cómic (una revista/número o un álbum de cómic suelto no son obras multivolumen).
    // Exige 'prefijo' (título de obra ANTES del "Vol N"): así "Vol. 3" a secas no inventa una obra sin nombre.
    let volTexto = null;
    if (documento.volumen_numero == null && documento.tipo_recurso !== 'revista' && documento.naturaleza !== 'comic') {
        for (const t of [documento.subtitulo, documento.nombre_archivo, datosBase.titulo, documento.titulo]) {
            const v = parsearVolumen(t);
            if (v && v.numero != null && v.prefijo) { volTexto = v; break; }
        }
    }
    if (contexto.obra || isbnObraRol || volTexto) {
        documento.obra_titulo = contexto.obra?.titulo || documento.obra_titulo || volTexto?.prefijo || documento.titulo;
        // nº total de tomos: del drop de carpeta o DECLARADO en el texto ("(3 vols)", "en 4 tomos").
        if (contexto.obra?.total) documento.obra_total = contexto.obra.total;
        else if (documento.obra_total == null) {
            const tot = totalDeclarado(documento.nombre_archivo) || totalDeclarado(datosBase.titulo);
            if (tot) documento.obra_total = tot;
        }
        // Número del tomo: del drop de carpeta (contexto), del propio fichero (volumen_numero ya fijado) o
        // del indicio de texto. NUNCA del "primer rol-volumen" de los créditos: ese número es del tomo 1,
        // no de ESTE tomo → un tomo suelto (sin contexto de carpeta) se catalogaba como Vol. 1 (caso real Vol 4→1).
        const numVol = contexto.obra?.numero ?? documento.volumen_numero ?? volTexto?.numero ?? null;
        if (numVol != null) documento.volumen_numero = numVol;
        if (contexto.obra?.titulo_volumen) documento.volumen_titulo = contexto.obra.titulo_volumen;
        else if (volTexto?.titulo && !primerValido(documento.volumen_titulo)) documento.volumen_titulo = volTexto.titulo;
        if (isbnObraRol) documento.isbn_obra = isbnObraRol.isbn;
        // ISBN del tomo = el de SU número. La página de créditos de CADA tomo lista TODOS los ISBN
        // del set ("ISBN … (Vol. 1)", "(Vol. 2)"…); coger el PRIMER rol-volumen hacía que todos los
        // tomos heredaran el ISBN del tomo 1 → colisión en el índice único `isbn` y fusión de tomos.
        // Se elige por número; si no hay match, NO se hereda un ISBN ajeno (el tomo va sin isbn:
        // lo identifica obra+volumen_numero).
        const isbnVolRol = numVol != null ? rolVol.find(x => x.numero === numVol) : null;
        if (isbnVolRol) documento.isbn = isbnVolRol.isbn;
        // Sin ISBN de rol para este tomo: NO heredar un ISBN arbitrario del texto (set, otro tomo, o
        // un código de barras espurio) — haría colisionar/fusionar los tomos. Un tomo confirmado por
        // carpeta (contexto.obra) o con otros ISBN de tomo en los créditos va SIN isbn (lo identifica
        // obra+volumen_numero); su ISBN propio se rellenará si más tarde aparece uno fiable.
        else if (rolVol.length > 0 || contexto.obra) delete documento.isbn;
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
    const esTomo = !!(documento.obra_titulo || documento.isbn_obra);
    const isbnsArchivo = new Set();
    if (!esRevista) {
        if (esTomo && documento.isbn) {
            // Tomo de obra: la API se consulta SOLO con el ISBN PROPIO del tomo, no con los del set
            // ni los de los otros tomos (todos aparecen en sus créditos). Si no, la API podría
            // devolver datos de otro tomo y acabarían todos con el mismo ISBN (colisión/fusión).
            for (const v of variantesISBN(documento.isbn)) isbnsArchivo.add(v);
        } else {
            for (const x of (datosBase.isbn_candidatos || [])) for (const v of variantesISBN(x)) isbnsArchivo.add(v);
            for (const v of variantesISBN(documento.isbn)) isbnsArchivo.add(v);
            for (const c of (cip?.isbns || [])) for (const v of variantesISBN(c.isbn)) isbnsArchivo.add(v);
        }
    }
    if (esRevista) { delete documento.isbn; }

    // Pasar el idioma del archivo para filtrar la búsqueda por lengua: da con la edición en
    // español/inglés/etc. antes que con ediciones en otras lenguas (caso Anna Karenina).
    // El Dewey/LC del CIP (del propio fichero) se siembra como autoridad antes que las APIs.
    // OVERRIDE sin_apis: NO se consulta a ninguna autoridad (el usuario fuerza los datos; evita que
    // un título genérico vuelva a confundirse con un homónimo). datosExtra queda vacío → no rellena.
    const datosExtra = contexto.sinApis
        ? { isbn: null, titulo: null, autores: [], sinopsis: null, editorial: null, año_edicion: null,
            idioma: null, categorias: [], dewey: null, lcc: null, portadas_remotas: [], cdu: null,
            cdu_adicionales: [], coleccion_nombre: null, coleccion_numero: null, alertas: ['Sin APIs (override manual).'] }
        : await buscarMetadatosExternos(documento.titulo, autorPrincipal, imagen, {
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
    // Título NO fiable = falta, es un identificador (ISBN/ISSN) o un artefacto del productor
    // ("C:\X.DVI", "…​.indd", "Microsoft Word - …"). En esos casos la autoridad lo sustituye.
    const tituloNoFiable = !!(validarISBN(documento.titulo) || validarISSN(documento.titulo) || esTituloArtefacto(documento.titulo));
    if (!primerValido(documento.titulo) || tituloNoFiable) {
        if (datosExtra.titulo) {
            if (tituloNoFiable) {
                documento.alertas_agente.push(`Título "${documento.titulo}" no fiable (identificador/artefacto); sustituido por el de la autoridad: "${datosExtra.titulo}".`);
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

    // Contribuciones con ROL (traductor/ilustrador/…) e IDIOMA ORIGINAL: el archivo manda; lo externo
    // rellena el hueco. `contribuciones_nombres` [{nombre,rol}] lo resuelve motor-catalogo a personas.
    documento.contribuciones_nombres = primerValido(documento.contribuciones_nombres, datosExtra.contribuciones_nombres);
    documento.idioma_original = primerValido(documento.idioma_original, datosExtra.idioma_original);

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
    if (datosBase._isbnBloqueado) {
        // Override "sin_isbn": el documento NO tiene ISBN; nunca se le adjudica el de un homónimo.
        delete documento.isbn;
    } else if (!esRevista) {
        // TOMO de obra: manda el ISBN de ROL del propio fichero ("… (Vol. N)"), NO la API. Las
        // autoridades suelen fundir todos los tomos en una sola edición y devuelven SIEMPRE el mismo
        // ISBN (el del set o el del tomo 1), lo que volvería a colisionar/fusionar los tomos.
        const isbnCandidato = esTomo
            ? primerValido(documento.isbn, datosExtra.isbn)
            : primerValido(datosExtra.isbn, documento.isbn);
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

    // Revista SIN ISSN (p. ej. cubierta sin código de barras legible): intentar resolverlo por el TÍTULO
    // (Wikidata) → así el número entra en su cabecera-colección por ISSN en vez de quedar suelto.
    // Conservador: solo periódicos con ISSN registrado en Wikidata; un fallo deja la revista sin ISSN.
    if (esRevista && !documento.issn && documento.titulo && !contexto.sinApis) {
        const cab = tituloCabecera(documento.titulo) || documento.titulo;
        const r = await buscarISSNporTitulo(cab, { idioma: documento.idioma });
        if (r?.issn) {
            documento.issn = r.issn;
            documento.alertas_agente.push(`ISSN ${r.issn} resuelto por título vía ${r.fuente}.`);
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

    // SERIE de LIBROS con ISSN de serie pero SIN nombre de colección válido (o con uno-artefacto del fichero
    // —p. ej. un DOI de Springer—): resuelve el NOMBRE AUTORITATIVO de la serie por ISSN vía Wikidata
    // («Studies in Big Data», ISSN 2197-6503) para NO nombrar la colección con el nombre críptico del
    // fichero. Conservador: solo libros, solo si falta un nombre válido y hay ISSN registrado en Wikidata;
    // un fallo deja la colección con su ISSN (recuperable). motor-catalogo 2e usa este coleccion_nombre.
    if (!esRevista && documento.issn && !contexto.sinApis
        && (!primerValido(documento.coleccion_nombre) || esTituloArtefacto(documento.coleccion_nombre))) {
        // Prueba TODOS los ISSN capturados (impreso + e-ISSN del CIP): uno puede no estar indexado y el otro sí.
        const issns = [documento.issn, ...(Array.isArray(datosBase.issn_candidatos) ? datosBase.issn_candidatos : [])];
        const r = await buscarNombreDeISSNs(issns, { idioma: documento.idioma });
        if (r?.nombre) {
            documento.coleccion_nombre = r.nombre;
            documento.alertas_agente.push(`Nombre de serie «${r.nombre}» resuelto por ISSN vía ${r.fuente}.`);
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

    // ISBNs ALTERNATIVOS (otras ediciones/encuadernaciones leídas de los créditos/CIP): se PERSISTEN con
    // su rol para no perderlos — el `isbn` primario es solo uno. Quedan drillables y buscables. Se
    // construyen de los `isbns_rol` ya extraídos del fichero (fuente de archivo), excluyendo el primario.
    {
        const vistos = new Set([documento.isbn].filter(Boolean));
        const alts = Array.isArray(documento.isbns_alternativos) ? [...documento.isbns_alternativos] : [];
        for (const x of isbnsRol) {
            const v = validarISBN(x.isbn); if (!v || vistos.has(v)) continue;
            vistos.add(v);
            const a = { isbn: v, rol: (x.rol && x.rol !== 'desconocido') ? x.rol : 'otro', fuente: 'cip' };
            if (x.etiqueta) a.etiqueta = String(x.etiqueta).slice(0, 40);
            alts.push(a);
        }
        if (alts.length) documento.isbns_alternativos = alts;
    }

    // Limpieza 1: descartar campos internos de los lectores que no deben persistirse
    // (evita guardar la portada base64 completa o banderas de proceso en MongoDB).
    // OJO: _portadas_remotas lo necesita el orquestador y lo elimina él después.
    const CAMPOS_INTERNOS = ['cubierta_base64', 'imagen_adicional', 'sinopsis_nativa', 'texto_legible', '_error', 'isbn_candidatos', 'isbn_propio', 'issn_candidatos', 'esFechada', 'isbns_rol', 'cip', 'comic_serie', 'muestra_paginas', '_isbnBloqueado'];
    for (const k of CAMPOS_INTERNOS) delete documento[k];

    // Limpieza 2: ningún campo puede quedar como undefined/null/'' (rompería el $jsonSchema).
    Object.keys(documento).forEach(k => {
        const v = documento[k];
        if (v === undefined || v === null || v === '') delete documento[k];
    });

    return documento;
}
