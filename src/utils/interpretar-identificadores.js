// ── INTÉRPRETE UNIFICADO DE IDENTIFICADORES ─────────────────────────────────────────────────────────
// «Identificar PRIMERO, clasificar DESPUÉS»: reúne TODOS los ISBN/ISSN captados por CUALQUIER medio (texto,
// nombre, DOI, CIP, código de barras, visión, IA) y decide QUÉ ES CADA UNO y qué significan EN CONJUNTO,
// antes de discriminar el tipo. Produce (a) la IDENTIDAD resuelta (isbn propio, isbn de obra, issn) y
// (b) las SEÑALES por confianza que consume `clasificarTipo` (discriminador.js). Una señal DÉBIL (ISBN/ISSN
// del cuerpo del texto, conjetura de la visión) nunca pisa a una FUERTE (ISBN propio/CIP, ISSN 977/impreso).
//
// Este módulo NO llama a red ni a IA: opera sobre lo YA extraído/validado aguas arriba (lectores + visión +
// corroboración por el Fichero). Es la pieza «fase 2·2»: centraliza la interpretación de identificadores
// que antes estaba dispersa en orquestador.js (los cómputos inline previos a cada clasificarTipo).
import { normalizarIdentificador, validarISBN, validarISSN } from './identificadores.js';
import { pareceSerieLibros } from './revistas.js';

const uniq = (a) => [...new Set(a)];
const norm = (v) => normalizarIdentificador(v);
const isbnOk = (v) => v && validarISBN(norm(v));
const issnOk = (v) => v && validarISSN(v);

/**
 * @param {object} raw  identificadores y pistas ya extraídos (todo opcional):
 *   // ── ISBN ──
 *   isbnCandidatos: string[]        todos los ISBN vistos (cuerpo, nombre, incrustado, visión) — se validan aquí
 *   isbnPropio: string|null         ISBN ya CORROBORADO como del documento (CIP · nombre-es-ISBN · título en Fichero)
 *   isbnsRol: [{numero, rol}]        ISBN con rol ('obra'|'volumen') del CIP o de la visión
 *   isbnObra: string|null           ISBN de la OBRA completa (multivolumen)
 *   barrasISBN: string|null         978/979 leído del código de barras de la cubierta (señal FUERTE)
 *   cip: boolean                    hay bloque CIP (Dewey/LCC/ISBN-con-rol) → señal fuerte de libro
 *   // ── ISSN ──
 *   issnCandidatos: string[]        todos los ISSN vistos
 *   issnBarras977: string|null      ISSN del código de barras 977 (revista, señal FUERTE)
 *   issnImpreso: string|null        ISSN impreso en portada/masthead (revista si NO hay ISBN/CIP propio)
 *   // ── Convenciones / estructura / pistas ──
 *   esFechada: boolean              el nombre/carpeta es «Título AAAA-MM» / «Mes Año» (periódico, T2)
 *   volumenNumero, obraTitulo       indicios de multivolumen
 *   esComic, comicSerie, esGrupoImagenes
 *   pareceRevista: boolean          heurística de título de revista (T4)
 *   pareceSerieLibros: boolean|null override; si null se calcula del título
 *   visionTipo: 'libro'|'revista'|null   conjetura de la VISIÓN (PISTA T4: cuenta, no manda)
 *   titulo, nombre: string
 * @returns {{ identidad:object, senales:object, visionTipo:string|null, notas:string[] }}
 */
export function interpretarIdentificadores(raw = {}) {
    const notas = [];
    const isbnsValidos = uniq((raw.isbnCandidatos || []).filter(isbnOk).map(norm));
    const issnsValidos = uniq((raw.issnCandidatos || []).filter(issnOk).map((v) => norm(v)));

    // ── ISBN PROPIO (el del propio documento) por orden de fiabilidad: barras 978/979 > corroborado
    // (CIP/nombre/título) > ISBN-con-rol 'volumen'. El resto de ISBN válidos son PISTAS (p. ej. un libro
    // anunciado/reseñado dentro de una revista) — nunca la identidad.
    let isbnPropio = null, fuentePropio = null;
    if (isbnOk(raw.barrasISBN)) { isbnPropio = norm(raw.barrasISBN); fuentePropio = 'barras'; }
    else if (isbnOk(raw.isbnPropio)) { isbnPropio = norm(raw.isbnPropio); fuentePropio = 'corroborado'; }

    // ── ISBN de la OBRA completa (multivolumen) y desambiguación por rol.
    let isbnObra = isbnOk(raw.isbnObra) ? norm(raw.isbnObra) : null;
    for (const r of raw.isbnsRol || []) {
        if (!isbnOk(r.numero)) continue;
        const n = norm(r.numero);
        if (/obra|completa|set/i.test(r.rol || '') && !isbnObra) isbnObra = n;
        else if (/vol|tomo|parte/i.test(r.rol || '') && !isbnPropio) { isbnPropio = n; fuentePropio = 'rol-volumen'; }
    }
    if (isbnPropio) notas.push(`ISBN propio (${fuentePropio}): ${isbnPropio}.`);
    if (isbnObra) notas.push(`ISBN de obra completa: ${isbnObra}.`);

    const cip = !!raw.cip;
    const hayIdPropioLibro = !!(isbnPropio || cip);
    // ISBN-pista: existe algún ISBN válido en el cuerpo/nombre aunque no sea el propio.
    const isbnHint = isbnsValidos.length > 0;

    // ── ISSN: ¿de REVISTA (fuerte) o de SERIE de libros (débil)? EN CONJUNTO manda el ISBN propio/CIP:
    //   · 977 del barras                     → SIEMPRE ISSN de revista (una revista no lleva 978).
    //   · ISSN impreso y SIN ISBN/CIP propio → ISSN de revista (masthead sin identificador de libro).
    //   · ISSN impreso CON ISBN/CIP propio   → ISSN de SERIE (Springer «Lecture Notes…» 1868-…): el libro
    //     conserva su ISBN y el ISSN vive en la colección — NO convierte el libro en revista.
    let issnMagazine = null, issnSerie = null;
    if (issnOk(raw.issnBarras977)) { issnMagazine = norm(raw.issnBarras977); notas.push(`ISSN de revista (barras 977): ${issnMagazine}.`); }
    else if (issnOk(raw.issnImpreso) && !hayIdPropioLibro) { issnMagazine = norm(raw.issnImpreso); notas.push(`ISSN de revista (impreso, sin ISBN/CIP): ${issnMagazine}.`); }
    // Cualquier ISSN válido restante, con ISBN/CIP propio, es de SERIE.
    const issnRestante = issnsValidos.find((x) => x !== issnMagazine) || (issnOk(raw.issnImpreso) ? norm(raw.issnImpreso) : null);
    if (!issnMagazine && issnRestante && hayIdPropioLibro) { issnSerie = issnRestante; notas.push(`ISSN tratado como de SERIE (hay ISBN/CIP propio): ${issnSerie}.`); }
    else if (!issnMagazine && issnRestante) { issnSerie = issnRestante; } // sin ISBN propio: será pista de periódico

    const multiparte = !!(isbnObra || (raw.isbnsRol && raw.isbnsRol.length > 1) || raw.volumenNumero != null || raw.obraTitulo);

    // La conjetura de la VISIÓN es una PISTA (T4): si dice «revista» y no hay señal fuerte, inclina a revista;
    // nunca convierte en revista algo con ISBN/CIP propio (eso lo garantiza clasificarTipo: libroFuerte manda).
    const pareceRevista = !!raw.pareceRevista || raw.visionTipo === 'revista';

    const senales = {
        esComic: !!raw.esComic,
        comicSerie: !!raw.comicSerie,
        esGrupoImagenes: !!raw.esGrupoImagenes,
        multiparte,
        isbnPropio,                                    // string|null (clasificarTipo lo trata como booleano)
        cip,
        pareceSerieLibros: raw.pareceSerieLibros != null ? !!raw.pareceSerieLibros : pareceSerieLibros(raw.titulo || ''),
        esFechada: !!raw.esFechada,
        issnFuerte: !!issnMagazine,                    // 977/impreso-sin-ISBN → periódico fuerte
        pareceRevista,
        issnHint: !!(issnSerie && !hayIdPropioLibro) || (!!issnRestante && !hayIdPropioLibro),
        isbnHint,
    };

    return {
        identidad: {
            isbn: isbnPropio,
            isbn_obra: isbnObra,
            issn: issnMagazine || issnSerie || null,
            issn_clase: issnMagazine ? 'revista' : issnSerie ? 'serie' : null,
            isbns_validos: isbnsValidos,
            issns_validos: issnsValidos,
        },
        senales,
        visionTipo: raw.visionTipo || null,
        notas,
    };
}
