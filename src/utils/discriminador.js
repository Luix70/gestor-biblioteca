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
 *     isbnPropio, cip, pareceSerieLibros,             // libro FUERTE (T1)
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

    const libroFuerte = !!(s.isbnPropio || s.cip || s.pareceSerieLibros);   // identificador/serie PROPIOS de libro (T1)
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
