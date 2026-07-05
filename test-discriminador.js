/**
 * TEST del DISCRIMINADOR UNIFICADO (fase 2·2). Pasa una tabla de casos REALES (de las pruebas del día) por
 *   interpretarIdentificadores(raw)  →  clasificarTipo(senales)
 * y comprueba tipo_recurso / naturaleza / multiparte y la identidad resuelta (isbn, isbn_obra, issn_clase).
 * No toca red ni Mongo. Ejecutar:  node test-discriminador.js
 *
 * Regla que valida: una señal DÉBIL (ISBN/ISSN del cuerpo, conjetura de la visión) nunca pisa a una FUERTE.
 */
import { interpretarIdentificadores } from './src/utils/interpretar-identificadores.js';
import { clasificarTipo } from './src/utils/discriminador.js';

// ISBN/ISSN con checksum VÁLIDO (si no, se descartan al validar y el caso mentiría).
const ISBN_A = '9780306406157', ISBN_B = '9783161484100';
const ISSN_REV = '1699-7913';   // revista (p. ej. Historia de Iberia Vieja)
const ISSN_SERIE = '1868-4513'; // serie de libros (Graduate Texts in Physics)
const ISSN_SERIE2 = '2197-6651'; // serie (Astronomers' Universe)

const CASOS = [
    {
        n: 'Revista fechada con ISBN en el CUERPO (anuncio interno)',
        raw: { esFechada: true, isbnCandidatos: [ISBN_A], pareceRevista: true, titulo: 'El Practico Español' },
        esp: { tipo: 'revista' },
    },
    {
        n: 'Monografía Springer: ISBN propio + CIP + ISSN de serie',
        raw: { isbnPropio: ISBN_B, cip: true, issnCandidatos: [ISSN_SERIE], titulo: 'Graduate Texts in Physics', pareceSerieLibros: true },
        esp: { tipo: 'libro', issn_clase: 'serie', isbn: ISBN_B },
    },
    {
        n: "Astronomers' Universe: ISBN propio + CIP + ISSN de serie 2197-6651",
        raw: { isbnPropio: ISBN_A, cip: true, issnCandidatos: [ISSN_SERIE2] },
        esp: { tipo: 'libro', issn_clase: 'serie' },
    },
    {
        n: 'Revista con 977 en el código de barras',
        raw: { issnBarras977: ISSN_REV },
        esp: { tipo: 'revista', issn_clase: 'revista' },
    },
    {
        n: 'Cómic-revista (nº de serie, sin ISBN)',
        raw: { esComic: true, comicSerie: true },
        esp: { tipo: 'revista', naturaleza: 'comic' },
    },
    {
        n: 'Cómic-libro (novela gráfica con ISBN propio)',
        raw: { esComic: true, isbnPropio: ISBN_A },
        esp: { tipo: 'libro', naturaleza: 'comic' },
    },
    {
        n: 'Libro multivolumen (ISBN propio + obra/tomo)',
        raw: { isbnPropio: ISBN_A, obraTitulo: 'Cálculo', volumenNumero: 2 },
        esp: { tipo: 'libro', multiparte: true },
    },
    {
        n: 'Libro digital normal (solo ISBN propio)',
        raw: { isbnPropio: ISBN_B },
        esp: { tipo: 'libro', isbn: ISBN_B },
    },
    {
        n: 'ISBN solo del cuerpo, título de libro → libro por defecto',
        raw: { isbnCandidatos: [ISBN_A] },
        esp: { tipo: 'libro', isbn: null }, // el ISBN del cuerpo NO es identidad
    },
    {
        n: 'ISBN solo del cuerpo + título de revista → revista',
        raw: { isbnCandidatos: [ISBN_A], pareceRevista: true },
        esp: { tipo: 'revista', isbn: null },
    },
    {
        n: 'La VISIÓN dice «revista» y no hay señal fuerte → revista',
        raw: { visionTipo: 'revista' },
        esp: { tipo: 'revista' },
    },
    {
        n: 'ISBN propio + ISSN impreso de serie → libro (ISSN a la colección)',
        raw: { isbnPropio: ISBN_B, issnImpreso: ISSN_SERIE },
        esp: { tipo: 'libro', issn_clase: 'serie' },
    },
    {
        n: 'ISSN impreso SIN ISBN (masthead de revista) → revista',
        raw: { issnImpreso: ISSN_REV, pareceRevista: true },
        esp: { tipo: 'revista', issn_clase: 'revista' },
    },
    {
        n: 'Multivolumen por ISBN-con-rol (obra + tomo)',
        raw: { isbnsRol: [{ numero: ISBN_A, rol: 'obra' }, { numero: ISBN_B, rol: 'volumen' }] },
        esp: { tipo: 'libro', multiparte: true, isbn: ISBN_B, isbn_obra: ISBN_A },
    },
];

let ok = 0, fallo = 0;
for (const c of CASOS) {
    const r = interpretarIdentificadores(c.raw);
    const cl = clasificarTipo(r.senales);
    const comprobar = [];
    if (c.esp.tipo != null) comprobar.push(['tipo', cl.tipo_recurso, c.esp.tipo]);
    if (c.esp.naturaleza != null) comprobar.push(['naturaleza', cl.naturaleza, c.esp.naturaleza]);
    if (c.esp.multiparte != null) comprobar.push(['multiparte', cl.multiparte, c.esp.multiparte]);
    if (c.esp.isbn !== undefined) comprobar.push(['isbn', r.identidad.isbn, c.esp.isbn]);
    if (c.esp.isbn_obra !== undefined) comprobar.push(['isbn_obra', r.identidad.isbn_obra, c.esp.isbn_obra]);
    if (c.esp.issn_clase !== undefined) comprobar.push(['issn_clase', r.identidad.issn_clase, c.esp.issn_clase]);
    const malas = comprobar.filter(([, got, exp]) => String(got) !== String(exp));
    if (malas.length === 0) {
        ok++;
        console.log(`✓ ${c.n}`);
    } else {
        fallo++;
        console.log(`✗ ${c.n}`);
        for (const [campo, got, exp] of malas) console.log(`    ${campo}: obtenido «${got}» · esperado «${exp}»`);
        console.log(`    notas: ${r.notas.join(' ')}`);
    }
}
console.log(`\n${ok}/${CASOS.length} OK${fallo ? ` · ${fallo} FALLO(S)` : ''}`);
process.exit(fallo ? 1 : 0);
