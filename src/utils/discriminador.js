/**
 * DISCRIMINADOR de tipo de recurso — decisión ÚNICA y por CONFIANZA (libro · revista · obra multivolumen
 * · cómic), consolidando la lógica antes dispersa (orquestador `esLibro`/`pareceRevista`, reglas de
 * nombre fechado, etc.). Principio rector: una señal DÉBIL nunca pisa a una FUERTE.
 *
 * Jerarquía de señales (de más a menos fiable):
 *   T1 · identificador PROPIO leído con fiabilidad: código de barras (977→ISSN, 978/979→ISBN), bloque
 *        CIP (Dewey/LCC/ISBN-con-rol), un ISBN que ES el nombre de archivo o aparece en el título.
 *   T2 · convenciones del CURADOR (nombre/carpeta): "Título YYYY-MM"/"Mes Año" → número de revista;
 *        "Vol N"/"obra completa"+"tomo" → multivolumen.
 *   T3 · estructural: .cbr/.cbz/.cb7 → cómic.
 *   T4 · PISTAS (nunca clasifican ni identifican por sí solas): ISBN/ISSN del CUERPO del texto, metadatos
 *        del info-dict del PDF (Title/Author tipo "Acrobat Distiller") y conjeturas de la IA. Los
 *        metadatos del PDF NO son de fiar: van validados por esTituloArtefacto/esAutorArtefacto aguas
 *        arriba y aquí cuentan como pista, no como autoridad.
 *
 * Regla que mata la clase de error vista en pruebas: *un ISBN del cuerpo del texto es una PISTA, no una
 * identidad*. Solo es la identidad de un libro si está CORROBORADO (CIP, título, nombre, o barras 978), y
 * NUNCA pisa una señal de periódico (nombre fechado, ISSN 977/impreso) ni de multivolumen.
 */

/**
 * @param {object} s  señales ya extraídas/validadas:
 *   { esComic, esGrupoImagenes,                       // estructural (T3)
 *     isbnPropio, cip, pareceSerieLibros, editorialLibro,  // libro FUERTE (T1/T2: id propio, serie, editorial de libros)
 *     esFechada, issnFuerte,                          // periódico FUERTE (T1/T2: nombre fechado, 977/impreso)
 *     multiparte,                                      // obra multivolumen (T1/T2: ISBN-con-rol, "Vol N")
 *     pareceRevista, issnHint, isbnHint }             // PISTAS (T4)
 * @returns {{ tipo_recurso:'libro'|'revista', naturaleza:string|null, multiparte:boolean }}
 */
export function clasificarTipo(s = {}) {
    // T3 · estructural: CÓMIC (.cbz/.cbr/.cb7). Auto: un NÚMERO de serie (nº de ejemplar / fechado) y sin
    // ISBN propio → revista (cabecera-colección, como un magazine); un ÁLBUM/novela gráfica suelto (con
    // ISBN propio, o sin nº) → libro. Ambos llevan naturaleza:'comic'.
    if (s.esComic) {
        // Un ISBN PROPIO (978, leído del barras/créditos) ⇒ álbum/novela gráfica = libro. Un nº de serie,
        // un nombre fechado o un ISSN 977 (cómic-revista) y SIN ISBN propio ⇒ revista (cabecera-colección).
        const serie = (s.comicSerie || s.esFechada || s.issnFuerte) && !s.isbnPropio;
        return { tipo_recurso: serie ? 'revista' : 'libro', naturaleza: 'comic', multiparte: false };
    }

    // T1/T2 · multivolumen: ISBN con rol (obra completa + tomo) o "Vol N" en el nombre → obra de LIBRO.
    if (s.multiparte) return { tipo_recurso: 'libro', naturaleza: null, multiparte: true };

    // T1 · ARTÍCULO por DOI: el DOI es el identificador PROPIO del artículo, igual que el ISBN lo es del libro.
    // Un DOI de REVISTA (10.xxxx/… SIN ISBN incrustado) y SIN ISBN propio ⇒ artículo (journal-article o capítulo
    // suelto). Gana a las PISTAS débiles: un ISBN del CUERPO de un artículo es el de un LIBRO citado en las
    // referencias, no la identidad del artículo. Un DOI de LIBRO Springer lleva el ISBN incrustado (…/978…) →
    // rellena isbn_propio → NO cae aquí (queda libro). El caller (orquestador) calcula `articuloDoi` con esa guarda.
    if (s.articuloDoi) return { tipo_recurso: 'articulo', naturaleza: null, multiparte: false };

    const libroFuerte = !!(s.isbnPropio || s.cip || s.pareceSerieLibros || s.editorialLibro); // id/serie propios o editorial de-solo-libros
    const periodicoFuerte = !!(s.esFechada || s.issnFuerte);                // nombre fechado (T2) o ISSN fiable 977/impreso (T1)

    // LIBRO FUERTE manda (regla de CLAUDE.md: «un ISBN PROPIO o un bloque CIP ⇒ libro, aun con ISSN de
    // serie o nombre fechado»). El ISBN PROPIO (nombre/título/CIP — NO el del cuerpo, que es solo pista)
    // y el CIP son la señal de libro más fuerte: ganan a un nombre fechado (anuario con CIP) y al ISSN de
    // serie (monografía Springer con «Lecture Notes…»). Un nombre que acaba en año es el AÑO DE EDICIÓN de
    // un libro, no un número de revista, si el libro trae su propio identificador.
    if (libroFuerte) return { tipo_recurso: 'libro', naturaleza: null, multiparte: false };
    // Sin señal de libro: nombre fechado o ISSN fiable (977/impreso) → revista. Aquí cae el caso que
    // motivó esta rama: una revista fechada cuyo único ISBN venía del CUERPO (anuncio/reseña interna) ya
    // NO es libroFuerte (ese ISBN es pista), así que clasifica como revista correctamente.
    if (periodicoFuerte) return { tipo_recurso: 'revista', naturaleza: null, multiparte: false };

    // Sin señales fuertes → pistas (T4). Periódico-pista antes que libro-pista (un ISBN del cuerpo es lo
    // más débil); si nada apunta a periódico, un ISBN/CIP del cuerpo lo hace libro (caso libro normal).
    if (s.pareceRevista || s.issnHint) return { tipo_recurso: 'revista', naturaleza: null, multiparte: false };
    return { tipo_recurso: 'libro', naturaleza: null, multiparte: false };
}

// Umbrales de la política por nº de páginas (config.js · overridables por .env).
const PAG_PAPEL_MAX = Number(process.env.CLASIF_PAPEL_MAX_PAGINAS) || 12;      // escaneado < N pág → papel
const PAG_CAPITULO_MAX = Number(process.env.CLASIF_CAPITULO_MAX_PAGINAS) || 20; // legible < N pág → capítulo/artículo

/**
 * POLÍTICA POR NÚMERO DE PÁGINAS (solo PDF). Refina el tipo/formato YA decididos por `clasificarTipo` +
 * la identificación (ISBN/ISSN/visión), aplicando el criterio del usuario:
 *
 *   - ESCANEADO  · menos de PAG_PAPEL_MAX páginas ....... libro de 'papel'
 *                · PAG_PAPEL_MAX … PAG_CAPITULO_MAX ..... libro (pdf digital)
 *                · PAG_CAPITULO_MAX o más ............... libro/revista (por ISBN/ISSN)
 *   - LEGIBLE    · menos de PAG_CAPITULO_MAX páginas .... capítulo/artículo (si no hay ISBN/CIP propio)
 *                · PAG_CAPITULO_MAX o más ............... libro/revista (por ISBN/ISSN)
 *
 * Reglas:
 *  - Un ESCANEO fino (< PAG_PAPEL_MAX páginas) es casi siempre un folleto/ejemplar físico delgado → se
 *    cataloga como libro de 'papel'. El PDF se CONSERVA igualmente (servicio-ingesta copia el fichero
 *    fuente a la carpeta pase lo que pase con el formato: salvaguarda inherente).
 *  - Un PDF LEGIBLE y corto (< PAG_CAPITULO_MAX páginas) SIN identidad propia de libro (ISBN/CIP propio)
 *    es un fragmento: 'articulo' si trae DOI (identificador propio del artículo), si no 'capitulo'. Con
 *    ISBN/CIP propio es un LIBRITO real (mantiene 'libro').
 *  - A partir de PAG_CAPITULO_MAX páginas NO se toca nada: manda la decisión libro/revista del discriminador.
 *  - NUNCA reclasifica una REVISTA ya detectada (ISSN/fechada) ni una OBRA multivolumen.
 *
 * @param {{ paginas?:number, escaneado?:boolean, tipoActual?:string, doi?:string, idFuerte?:boolean, multiparte?:boolean }} s
 * @returns {{ tipo_recurso?:string, formato?:string, alerta?:string }}  cambios a aplicar (vacío = sin cambios)
 */
export function clasificarPorPaginas(s = {}) {
    const n = Number(s.paginas) || 0;
    // Sin nº de páginas fiable, o ya es revista/obra → no se toca (respetamos la identidad ya resuelta).
    if (!n || s.multiparte || s.tipoActual === 'revista') return {};

    // Escaneo fino → ejemplar físico → papel (el PDF se conserva).
    if (s.escaneado && n < PAG_PAPEL_MAX) {
        return {
            formato: 'papel',
            tipo_recurso: 'libro',
            alerta: `Escaneo de ${n} páginas (< ${PAG_PAPEL_MAX}) → libro de PAPEL (el PDF se conserva junto a las páginas).`,
        };
    }
    // Legible y corto, sin identidad propia de libro → capítulo/artículo (fragmento).
    if (!s.escaneado && n < PAG_CAPITULO_MAX && !s.idFuerte && s.tipoActual === 'libro') {
        const t = s.doi ? 'articulo' : 'capitulo';
        return {
            tipo_recurso: t,
            alerta: `Documento legible de ${n} páginas (< ${PAG_CAPITULO_MAX})${s.doi ? ' con DOI' : ' sin ISBN propio'} → clasificado como ${t}.`,
        };
    }
    return {};
}
