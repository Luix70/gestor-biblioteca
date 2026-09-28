/**
 * IDENTIFICAR LA EDICIÓN de un libro que NO trae ISBN en ninguna parte del fichero — el caso del ripeo que se
 * lo borró (típico de ePubLibre: «[Valdemar] [Gotica 112] Ewers, Hanns Heinz - Vampiro»). Lo que sí tenemos es
 * un título fiable, un autor, muchas veces la editorial y hasta la colección con su número: eso determina una
 * edición concreta. Aquí se busca ESA edición por autoridad y se devuelve su ISBN.
 *
 * LA REGLA QUE MANDA: un ISBN equivocado es MUCHO peor que ninguno (arrastra título, sinopsis, CDU y carpeta).
 * Medido: «Vampiro» de Ewers en el Fichero solo existe como edición INGLESA de Sojourner Books 2020; aceptar
 * ese candidato le habría colgado a la edición española de Valdemar el ISBN de otro libro. Por eso:
 *   · El TÍTULO y el AUTOR deben casar SIEMPRE (no basta el bm25 del buscador).
 *   · Y además debe casar al menos UNA SEÑAL DE EDICIÓN: editorial, idioma o año (±1). Un candidato suelto
 *     que no confirma ninguna NO se acepta: se devuelve como «ambiguo» para que lo mire una persona.
 *   · Un idioma que se CONTRADICE descarta el candidato de plano.
 *   · Si quedan varios, no se elige: se devuelven todos.
 *
 * Cascada, de lo barato a lo caro (principio del proyecto: fichero → local → APIs gratis → IA):
 *   1. FICHERO local (SQLite, offline, gratis) por título+autor.
 *   2. OpenLibrary por título+autor (solo si `online`), verificando la edición igual de estricto.
 *   3. IA (solo si `conIA`), como ÚLTIMO recurso y nunca como fuente: lo que diga solo se acepta si su ISBN
 *      es válido y aparece en el Fichero con el mismo título y autor. Una alucinación no pasa ese filtro.
 */
import { buscarTextoEnFichero, buscarEnFicheroLocal } from './buscador-local.js';
import { buscarPorCriterios } from './buscador-bibliografico.js';
import { validarISBN } from './identificadores.js';
import { conGemini } from './gemini.js';
import { esEditorialFalsa } from './editoriales-falsas.js';

const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');
/** minúsculas, sin acentos ni puntuación, espacios colapsados. */
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '').replace(/[^a-z0-9]+/g, ' ').trim();
const palabras = (s) => norm(s).split(' ').filter((w) => w.length > 2);

// Códigos de idioma de las fuentes: MARC de 3 letras (spa/eng/fre…) y ISO de 2. Se comparan en ISO-2.
const IDIOMA2 = { spa: 'es', eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', cat: 'ca', dut: 'nl', nld: 'nl', rus: 'ru', lat: 'la' };
const idioma2 = (s) => { const v = String(s || '').toLowerCase().slice(0, 3); return IDIOMA2[v] || v.slice(0, 2) || null; };

// Palabras que no distinguen una editorial de otra («ediciones», «editorial», «books», «press»…).
const RUIDO_EDITORIAL = new Set(['ediciones', 'edicion', 'editorial', 'editores', 'editions', 'edition', 'books', 'book', 'press', 'publishing', 'publishers', 'publicaciones', 'grupo', 'the', 'and', 'company', 'verlag', 'libros', 'sa', 'sl', 'inc', 'ltd']);
const nucleoEditorial = (s) => palabras(s).filter((w) => !RUIDO_EDITORIAL.has(w));

/** ¿El título del candidato es el mismo libro? Igualdad normalizada, o uno contiene al otro (subtítulo). */
function casaTitulo(titDoc, titCand, subCand) {
    const a = norm(titDoc);
    const b = norm([titCand, subCand].filter(Boolean).join(' '));
    const bSolo = norm(titCand);
    if (!a || !bSolo) return false;
    if (a === bSolo || a === b) return true;
    if (b.includes(a) || a.includes(bSolo)) return true;
    // Conjuntos de palabras casi iguales (tolera «El» / «:» / orden del subtítulo).
    const A = new Set(palabras(titDoc));
    const B = new Set(palabras([titCand, subCand].filter(Boolean).join(' ')));
    if (!A.size || !B.size) return false;
    let comunes = 0;
    for (const w of A) if (B.has(w)) comunes++;
    return comunes / Math.min(A.size, B.size) >= 0.85;
}

/**
 * ¿Es el mismo autor? Se compara por APELLIDO (la palabra larga que comparten «Ewers, Hanns Heinz» y
 * «Hanns Heinz Ewers») más otra palabra en común, para no casar a dos autores del mismo apellido.
 */
function casaAutor(autoresDoc, autoresCand) {
    const A = (autoresDoc || []).map(palabras).filter((x) => x.length);
    const B = (autoresCand || []).map(palabras).filter((x) => x.length);
    if (!A.length || !B.length) return false;
    for (const a of A) {
        for (const b of B) {
            const comunes = a.filter((w) => b.includes(w));
            if (!comunes.length) continue;
            // Un apellido solo basta si es el ÚNICO dato de alguna de las dos partes; si no, pedimos dos.
            if (comunes.length >= 2 || a.length === 1 || b.length === 1) return true;
        }
    }
    return false;
}

/**
 * Señales de EDICIÓN que CONFIRMAN o CONTRADICEN un candidato.
 *
 * El idioma NO confirma nada: casi todo el catálogo está en español, así que «coincide el idioma» no distingue
 * una edición de otra (medido: aceptaba «Pueblos y leyendas» de Seix Barral 1929 como la de Teide 1981, y el
 * «1984» de ePubLibre como el de Akal 2022). Solo sirve para DESCARTAR. Confirman la editorial o el año EXACTO;
 * y dos editoriales reales DISTINTAS descartan, porque son ediciones distintas por definición.
 */
function señalesEdicion(doc, cand) {
    const señales = [];
    let contradice = false;

    // Una «editorial» de maquetador (ePubLibre…) no dice nada de la edición: se trata como desconocida.
    const edDoc = esEditorialFalsa(doc.editorial) ? [] : nucleoEditorial(doc.editorial);
    const edCand = esEditorialFalsa(cand.editorial) ? [] : nucleoEditorial(cand.editorial);
    if (edDoc.length && edCand.length) {
        if (edDoc.some((w) => edCand.includes(w))) señales.push('editorial');
        else contradice = true;                       // Seix Barral ≠ Teide ⇒ otra edición
    }

    const iDoc = idioma2(doc.idioma), iCand = idioma2(cand.idioma);
    if (iDoc && iCand && iDoc !== iCand) contradice = true;   // otra lengua ⇒ otra edición

    // Año EXACTO. Una diferencia mayor no descarta (el año del doc suele ser el de la obra, no el de la
    // edición: «Vampiro» figura como 1920), pero tampoco confirma.
    const aDoc = parseInt(doc.anio, 10), aCand = parseInt(cand.anio, 10);
    if (aDoc && aCand && aDoc === aCand) señales.push('año');

    // La colección con su número es una firma casi única de la edición («Valdemar: Gótica»).
    const colDoc = palabras(doc.coleccion_nombre), colCand = palabras(cand.coleccion_nombre);
    if (colDoc.length && colCand.length && colDoc.some((w) => colCand.includes(w))) señales.push('colección');

    return { señales, contradice };
}

/** Normaliza un candidato del Fichero / de OpenLibrary a una forma común. */
const comoCandidato = (c, fuente) => ({
    isbn: c.isbn ? validarISBN(c.isbn) : null,
    titulo: c.titulo || '', subtitulo: c.subtitulo || null,
    autores: Array.isArray(c.autores) ? c.autores : String(c.autores || '').split(/[;,]/).map((x) => x.trim()).filter(Boolean),
    editorial: c.editorial || null, anio: c.anio || c.anio_edicion || c.año_edicion || null,
    coleccion_nombre: c.coleccion_nombre || null,
    idioma: c.idioma || null, fuente,
});

/** Filtra y puntúa candidatos con las reglas estrictas de arriba. */
function verificar(doc, candidatos) {
    const buenos = [];
    for (const c of candidatos) {
        if (!c.isbn) continue;
        if (!casaTitulo(doc.titulo, c.titulo, c.subtitulo)) continue;
        if (doc.autores?.length && !casaAutor(doc.autores, c.autores)) continue;
        const { señales, contradice } = señalesEdicion(doc, c);
        if (contradice) continue;                 // otra lengua ⇒ otra edición
        if (!señales.length) continue;            // nada confirma que sea ESTA edición
        buenos.push({ ...c, señales });
    }
    // Mejor primero: más señales; a igualdad, la que casa la editorial.
    buenos.sort((a, b) => b.señales.length - a.señales.length || (b.señales.includes('editorial') ? 1 : 0) - (a.señales.includes('editorial') ? 1 : 0));
    return buenos;
}

/** Los que solo fallaron por no confirmar edición: sirven para explicar por qué no se acepta nada. */
function casiCandidatos(doc, candidatos) {
    return candidatos.filter((c) => c.isbn && casaTitulo(doc.titulo, c.titulo, c.subtitulo)
        && (!doc.autores?.length || casaAutor(doc.autores, c.autores)));
}

/**
 * @param doc { titulo, autores:[nombre], editorial, coleccion_nombre, anio, idioma }
 * @param opts online=false (OpenLibrary) · conIA=false (último recurso, verificado) · limite=40
 * @returns { estado:'unico'|'ambiguo'|'sin-candidatos', isbn?, elegido?, candidatos[], via?, motivo }
 */
export async function identificarEdicion(doc, { online = false, conIA = false, limite = 40 } = {}) {
    if (!doc?.titulo) return { estado: 'sin-candidatos', candidatos: [], motivo: 'el documento no tiene título' };
    const consulta = [doc.titulo, ...(doc.autores || []).slice(0, 1)].join(' ');

    // 1) FICHERO local (offline, gratis).
    const delFichero = (await buscarTextoEnFichero(consulta, { limite }).catch(() => null)) || [];
    let candidatos = delFichero.map((c) => comoCandidato(c, 'fichero'));
    let buenos = verificar(doc, candidatos);
    if (buenos.length === 1) return { estado: 'unico', isbn: buenos[0].isbn, elegido: buenos[0], candidatos: buenos, via: 'fichero', motivo: `casa ${buenos[0].señales.join(' + ')}` };

    // 2) OpenLibrary por título+autor (solo si se permite la red). Devuelve UNA edición ya elegida por OL:
    //    se verifica con el mismo rasero, así que una edición de otra lengua/editorial no cuela.
    if (online && buenos.length !== 1) {
        try {
            const ol = await buscarPorCriterios({ titulo: doc.titulo, autor: (doc.autores || [])[0] || null, idioma: doc.idioma || null, incluirSinopsis: false });
            if (ol?.isbn) {
                const c = comoCandidato({ ...ol, anio: ol.año_edicion }, 'openlibrary');
                candidatos = [...candidatos, c];
                const v = verificar(doc, [c]);
                if (v.length) buenos = [...buenos, ...v];
            }
        } catch (e) { /* red caída / cuota: se sigue con lo que haya */ }
        const unicos = [...new Map(buenos.map((b) => [b.isbn, b])).values()];
        if (unicos.length === 1) return { estado: 'unico', isbn: unicos[0].isbn, elegido: unicos[0], candidatos: unicos, via: unicos[0].fuente, motivo: `casa ${unicos[0].señales.join(' + ')}` };
        buenos = unicos;
    }

    // 3) IA, último recurso y NUNCA como fuente: propone un ISBN y solo se acepta si el Fichero lo confirma
    //    con el mismo título y autor. Así una alucinación no llega nunca al catálogo.
    if (conIA && !buenos.length) {
        const propuesto = await preguntarIsbnALaIA(doc).catch(() => null);
        if (propuesto) {
            const ficha = await buscarEnFicheroLocal({ isbns: [propuesto] }).catch(() => null);
            const c = ficha ? comoCandidato({ ...ficha, anio: ficha.año_edicion || ficha.anio_edicion, isbn: propuesto }, 'ia+fichero') : null;
            const v = c ? verificar(doc, [c]) : [];
            if (v.length) return { estado: 'unico', isbn: v[0].isbn, elegido: v[0], candidatos: v, via: 'ia+fichero', motivo: `la IA propuso ${propuesto} y el Fichero lo confirma (${v[0].señales.join(' + ')})` };
            return { estado: 'ambiguo', candidatos: buenos, motivo: `la IA propuso ${propuesto}, pero no se pudo confirmar en el Fichero: no se aplica` };
        }
    }

    if (buenos.length > 1) {
        return { estado: 'ambiguo', candidatos: buenos, motivo: `${buenos.length} ediciones posibles: ` + buenos.slice(0, 5).map((c) => `${c.isbn} (${c.editorial || '?'}, ${c.anio || '?'})`).join(' · ') };
    }
    const casi = casiCandidatos(doc, candidatos);
    if (casi.length) {
        return { estado: 'ambiguo', candidatos: casi, motivo: `mismo título y autor pero nada confirma la edición (editorial/idioma/año): ` + casi.slice(0, 5).map((c) => `${c.isbn} (${c.editorial || '?'}, ${c.anio || '?'}, ${c.idioma || '?'})`).join(' · ') };
    }
    return { estado: 'sin-candidatos', candidatos: [], motivo: 'ninguna autoridad tiene esta edición' };
}

/** Pregunta a la IA el ISBN de ESTA edición. Su respuesta no se cree: la verifica el llamante. */
async function preguntarIsbnALaIA(doc) {
    const ficha = [
        `Título: ${doc.titulo}`,
        doc.autores?.length ? `Autor: ${doc.autores.join('; ')}` : null,
        doc.editorial ? `Editorial: ${doc.editorial}` : null,
        doc.coleccion_nombre ? `Colección: ${doc.coleccion_nombre}` : null,
        doc.anio ? `Año: ${doc.anio}` : null,
        doc.idioma ? `Idioma: ${doc.idioma}` : null,
    ].filter(Boolean).join('\n');
    const prompt = `Eres un bibliotecario. Dime el ISBN-13 de ESTA edición concreta (misma editorial, colección e idioma).
${ficha}

Responde SOLO con el ISBN-13, sin guiones ni texto. Si no estás seguro de la edición exacta, responde NO_SE.`;
    const texto = await conGemini({ model: 'gemini-2.5-flash' }, async (model) => {
        const r = await model.generateContent(prompt);
        return r.response.text();
    });
    const limpio = String(texto || '').replace(/[^0-9Xx]/g, '');
    return validarISBN(limpio);
}
