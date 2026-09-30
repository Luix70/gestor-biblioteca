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
 *   1. FICHERO local (SQLite, offline, gratis) por título+autor; y, si conocemos la editorial, también por
 *      título exacto (para los registros que entraron sin autor, como el «Vampiro» de Valdemar).
 *   2. En línea (solo si `online`), en el orden que dicta la LENGUA: español/catalán/gallego/euskera → BNE
 *      primero (su autoridad; busca sin ISBN y trae la CDU); el resto → OpenLibrary primero. Si la primera no
 *      lo resuelve, la siguiente. Cada candidato se verifica igual de estricto.
 *   3. IA (solo si `conIA`), como ÚLTIMO recurso y nunca como fuente: lo que diga solo se acepta si su ISBN
 *      es válido y aparece en el Fichero con el mismo título y autor. Una alucinación no pasa ese filtro.
 */
import { buscarEdicionesEnFichero, buscarTituloEnFichero, buscarEnFicheroLocal } from './buscador-local.js';
import { buscarPorCriterios } from './buscador-bibliografico.js';
import { buscarEdicionesEnBNE } from './buscador-bne-sru.js';
import { validarISBN, isbn10a13 } from './identificadores.js';
import { conGemini } from './gemini.js';
import { esEditorialFalsa } from './editoriales-falsas.js';

const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');
/** minúsculas, sin acentos ni puntuación, espacios colapsados. */
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '').replace(/[^a-z0-9]+/g, ' ').trim();
const palabras = (s) => norm(s).split(' ').filter((w) => w.length > 2);

// Códigos de idioma de las fuentes: MARC de 3 letras (spa/eng/fre…) y ISO de 2. Se comparan en ISO-2.
const IDIOMA2 = { spa: 'es', eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', cat: 'ca', dut: 'nl', nld: 'nl', rus: 'ru', lat: 'la' };
// «und» (indeterminado), «mul» (varios), «zxx» (sin contenido lingüístico): no dicen la lengua → desconocido,
// para que no «contradigan» a un candidato bueno (medido: la BNE marca «und» ediciones en español).
const SIN_LENGUA = new Set(['und', 'mul', 'zxx', 'mis', 'un', '']);
const idioma2 = (s) => {
    const v = String(s || '').toLowerCase().trim().slice(0, 3);
    if (SIN_LENGUA.has(v)) return null;
    return IDIOMA2[v] || v.slice(0, 2) || null;
};

// Palabras que no distinguen una editorial de otra («ediciones», «editorial», «books», «press»…).
const RUIDO_EDITORIAL = new Set(['ediciones', 'edicion', 'editorial', 'editores', 'editions', 'edition', 'books', 'book', 'press', 'publishing', 'publishers', 'publicaciones', 'grupo', 'the', 'and', 'company', 'verlag', 'libros', 'sa', 'sl', 'inc', 'ltd']);
const nucleoEditorial = (s) => palabras(s).filter((w) => !RUIDO_EDITORIAL.has(w));

// Palabras que aparecen en cientos de colecciones distintas y no identifican ninguna.
const GENERICAS_COLECCION = new Set(['coleccion', 'collection', 'serie', 'series', 'biblioteca', 'library', 'clasicos',
    'classics', 'grandes', 'obras', 'libros', 'books', 'nueva', 'nuevo', 'autores', 'literatura', 'bolsillo', 'edicion',
    'ediciones', 'the', 'del', 'los', 'las', 'une', 'des']);

/** ¿Señala este resto de título un tomo/parte/volumen concreto? (números, romanos, «tomo», «libros», «vol.») */
const esDeTomo = (resto) => /\b(vol|volumen|volume|tomo|tome|band|libro|libros|book|books|parte|part|partie|[ivxlcdm]{2,}|\d+)\b/.test(resto);

/** ¿El título del candidato es el mismo libro? Igualdad normalizada, o uno contiene al otro (subtítulo). */
// Indicación de MATERIAL DERIVADO (no el libro): solo cuenta DETRÁS de un separador («— test», «: workbook»,
// «(answer key)»), para no confundir títulos legítimos («The Test», «Examen de conciencia»).
const RE_MATERIAL = new RegExp(String.raw`^\s*(ejercicios|solucionario|soluciones|test|tests|examen|examenes|actividades|cuaderno( de actividades| de ejercicios)?|workbook|worksheets?|activity book|answer key|answers|key|teacher'?s (book|guide|notes)|guia didactica|guia del profesor|libro del profesor|study guide|quiz|quizzes)\b`, 'i');
export function esMaterialDerivado(titulo) {
    const t = String(titulo || '').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '');
    const partes = t.split(/\s[—–-]\s|:\s|[([]/).slice(1);
    return partes.some((p) => RE_MATERIAL.test(p));
}

function casaTitulo(titDoc, titCand, subCand) {
    const a = norm(titDoc);
    const b = norm([titCand, subCand].filter(Boolean).join(' '));
    const bSolo = norm(titCand);
    if (!a || !bSolo) return false;
    if (a === bSolo || a === b) return true;
    // Uno contiene al otro (subtítulo de más o de menos)… salvo que lo que sobra señale un TOMO o una PARTE:
    // «Historia romana. Libros XXXVI-XLV» NO es «Historia romana» a secas — en una obra en varios tomos cada
    // uno tiene su ISBN, y aceptar el de otro tomo es colgar un ISBN equivocado (medido con Dion Casio, Gredos).
    const sobra = (largo, corto) => largo.replace(corto, ' ');
    if (b.includes(a) && !esDeTomo(sobra(b, a))) return true;
    if (a.includes(bSolo) && !esDeTomo(sobra(a, bSolo))) return true;
    // Conjuntos de palabras casi iguales (tolera «El» / «:» / orden del subtítulo).
    const A = new Set(palabras(titDoc));
    const B = new Set(palabras([titCand, subCand].filter(Boolean).join(' ')));
    if (!A.size || !B.size) return false;
    let comunes = 0;
    for (const w of A) if (B.has(w)) comunes++;
    // Las palabras que solo están en uno de los dos tampoco pueden señalar un tomo (misma razón que arriba).
    const diferentes = [...A].filter((w) => !B.has(w)).concat([...B].filter((w) => !A.has(w)));
    if (esDeTomo(diferentes.join(' '))) return false;
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

    // TRADUCTOR (va primero: decide cómo pesa la editorial). Una traducción es de una edición concreta: si el
    // libro y la candidata comparten traductores es esa traducción; si los dos los nombran y no comparten
    // ninguno, es OTRA traducción ⇒ otra edición.
    const tDoc = tokensPersonas(doc.traductores), tCand = tokensPersonas(cand.traductores);
    if (tDoc.size && tCand.size) {
        const comunes = [...tDoc].filter((w) => tCand.has(w)).length;
        if (comunes >= 2 || (comunes === 1 && Math.min(tDoc.size, tCand.size) === 1)) señales.push('traductor');
        else if (comunes === 0) contradice = true;
    }

    // EDITORIAL: la del documento y las que sugiere SU COLECCIÓN (indicios aprendidos: «Solaris ficción» → La
    // Factoría de Ideas). Una «editorial» de maquetador (ePubLibre…) no dice nada: se trata como desconocida.
    // Casa con cualquiera de ellas ⇒ señal. No casa con ninguna ⇒ otra edición… salvo que el TRADUCTOR la
    // confirme: el campo editorial del documento puede venir de una API y estar mal (medido: «Los propios dioses»
    // con «Salamandra»), y la traducción la trae el propio fichero.
    const edCand = esEditorialFalsa(cand.editorial) ? [] : nucleoEditorial(cand.editorial);
    const pruebas = [doc.editorial, ...(doc.editoriales_coleccion || []), ...editorialesDelTitulo(doc.titulo)]
        .filter((e) => e && !esEditorialFalsa(e)).map(nucleoEditorial).filter((n) => n.length);
    if (pruebas.length && edCand.length) {
        if (pruebas.some((n) => n.some((w) => edCand.includes(w)))) señales.push('editorial');
        else if (!señales.includes('traductor')) contradice = true;   // Seix Barral ≠ Teide ⇒ otra edición
        else {
            // El traductor rescata la contradicción con el campo editorial del DOCUMENTO (puede venir de una API),
            // pero NO con las pruebas firmes: la editorial de SU COLECCIÓN o la escrita en el título. Una misma
            // traducción la reeditan varias casas (medido el 30-sep: «La hija del capitán», de la colección de
            // Anaya, recibió la edición de Paulinas con el mismo traductor).
            const firmes = [...(doc.editoriales_coleccion || []), ...editorialesDelTitulo(doc.titulo)]
                .filter((e) => e && !esEditorialFalsa(e)).map(nucleoEditorial).filter((n) => n.length);
            if (firmes.length && !firmes.some((n) => n.some((w) => edCand.includes(w)))) contradice = true;
        }
    }

    const iDoc = idioma2(doc.idioma), iCand = idioma2(cand.idioma);
    if (iDoc && iCand && iDoc !== iCand) contradice = true;   // otra lengua ⇒ otra edición

    // Año EXACTO. Una diferencia mayor no descarta (el año del doc suele ser el de la obra, no el de la
    // edición: «Vampiro» figura como 1920), pero tampoco confirma.
    const aDoc = parseInt(doc.anio, 10), aCand = parseInt(cand.anio, 10);
    if (aDoc && aCand && aDoc === aCand) señales.push('año');

    // La colección es una firma casi única de la edición («Valdemar: Gótica» ↔ «Colección gótica»), y su NÚMERO
    // ya la clava (Gótica nº 112 es un solo libro).
    // Solo cuentan palabras que DISTINGAN: «biblioteca», «clásicos», «colección»… las comparten cientos de
    // colecciones distintas. Hace falta una palabra propia en común, o varias.
    const cDoc = coleccionYNumero(doc.coleccion_nombre, doc.coleccion_numero);
    const cCand = coleccionYNumero(cand.coleccion_nombre, cand.coleccion_numero);
    const distintivas = (s) => palabras(s).filter((w) => !GENERICAS_COLECCION.has(w) && !/^\d+$/.test(w));
    const colDoc = distintivas(cDoc.nombre);
    const colCand = distintivas(cCand.nombre);
    const comunesCol = colDoc.filter((w) => colCand.includes(w));
    if (comunesCol.length >= (colDoc.length === 1 || colCand.length === 1 ? 1 : 2)) {
        señales.push('colección');
        const nDoc = cDoc.numero || '';
        const nCand = cCand.numero || '';
        if (nDoc && nCand && nDoc === nCand) señales.push('nº de colección');
    }

    return { señales, contradice };
}

// Palabras de una mención de traducción que no son nombres de persona.
const NO_PERSONA = new Set(['traduccion', 'traducido', 'traducida', 'traductor', 'traductora', 'traductores', 'trad',
    'translated', 'translation', 'translator', 'notas', 'prologo', 'introduccion', 'edicion', 'revision', 'revisada',
    'version', 'castellana', 'espanola', 'ingles', 'frances', 'aleman', 'italiano', 'original']);
/** Apellidos/nombres (≥ 4 letras) de una lista de personas, para comparar traductores entre fuentes. */
const tokensPersonas = (lista) => new Set((Array.isArray(lista) ? lista : [lista]).filter(Boolean)
    .flatMap((s) => palabras(s)).filter((w) => w.length >= 4 && !NO_PERSONA.has(w) && !/^\d+$/.test(w)));

/**
 * Traductor anotado en el TÍTULO por quien preparó el fichero: «Cuentos de Canterbury (Tr. Josefina Ferrer)»,
 * «Las amistades peligrosas (trad. Ángeles Caso)», «… [Traducción de X]». Es la pista que distingue la edición
 * cuando el libro no guardó sus contribuciones. [] si no hay.
 */
const RE_TRADUCTOR_TITULO = new RegExp(String.raw`[(\[]\s*(?:traducci[oó]n(?:\s+de)?|translated\s+by|transl|trad|tr)\b\.?\s*:?\s*([^)\]]{3,80})[)\]]`, 'i');
/** ¿Nombran la misma editorial? (sin acentos, mayúsculas ni relleno: «La Factoría de Ideas» = «La Factoria de Ideas»). */
export function mismaEditorial(a, b) {
    const na = nucleoEditorial(a), nb = nucleoEditorial(b);
    return na.length > 0 && nb.length > 0 && na.some((w) => nb.includes(w));
}

export function traductoresDelTitulo(titulo) {
    const m = RE_TRADUCTOR_TITULO.exec(String(titulo || ''));
    return m ? [m[1].trim()] : [];
}

/** Normaliza un candidato (Fichero, BNE, OpenLibrary) a una forma común. */
// Un ISBN-10 y su ISBN-13 son el MISMO libro: se normaliza todo a 13 para que no cuenten como dos ediciones
// (medido: «Misiones secretas» salía ambigua entre 8476330111 y 9788476330111).
const isbn13 = (v) => { const x = v ? validarISBN(v) : null; return x ? (isbn10a13(x) || x) : null; };

/**
 * Colección y número por separado. Las fuentes los escriben juntos de mil maneras: «Ancora y Delfin -- 85»
 * (OpenLibrary), «Colección gótica ; 112» (BNE), «Austral 1234», «Gótica nº 112». Si ya viene el número aparte,
 * se respeta.
 */
function coleccionYNumero(nombre, numero) {
    const n = String(numero ?? '').replace(/\D/g, '') || null;
    const t = String(nombre || '').trim();
    if (!t) return { nombre: null, numero: n };
    const m = t.match(/^(.*?)[\s,;:.\-–—]*(?:n[º°o.]*\s*|vol\.?\s*|#\s*)?(\d{1,5})\s*$/i);
    if (m && m[1].trim().length >= 3) return { nombre: m[1].trim(), numero: n || m[2] };
    return { nombre: t, numero: n };
}

const comoCandidato = (c, fuente) => ({
    isbn: isbn13(c.isbn),
    titulo: c.titulo || '', subtitulo: c.subtitulo || null,
    autores: Array.isArray(c.autores) ? c.autores : String(c.autores || '').split(/;/).map((x) => x.trim()).filter(Boolean),
    editorial: c.editorial || null, anio: c.anio || c.anio_edicion || c.año_edicion || null,
    ...(() => { const cn = coleccionYNumero(c.coleccion_nombre, c.coleccion_numero); return { coleccion_nombre: cn.nombre, coleccion_numero: cn.numero }; })(),
    idioma: c.idioma || null, cdu: c.cdu || null, fuente,
    traductores: Array.isArray(c.traductores) && c.traductores.length ? c.traductores
        : (c.contribuciones_nombres || []).filter((x) => x && x.rol === 'traductor').map((x) => x.nombre),
});

// REIMPRESORES BAJO DEMANDA: reeditan en facsímil obras de dominio público a partir de escaneos; su «edición» casi
// nunca es la de un EPUB/PDF de biblioteca. Solo se descartan si queda alguna edición de una editorial de verdad.
const RE_BAJO_DEMANDA = new RegExp([
    'creative media partners', 'independently published', 'createspace', 'kessinger', 'forgotten books', 'legare street',
    'wentworth', 'hansebooks', 'nabu press', 'bibliolife', 'general books', 'lulu', 'trieste publishing', 'alpha editions',
    'outlook verlag', 'sagwan', 'andesite', 'franklin classics', 'palala', 'gale ecco', "scholar'?s choice", 'books on demand',
    'tredition', 'literary licensing', 'wallachia', 'blurb', 'fb&c', 'hardpress', 'leopold classic', 'read books',
    'dalton house', 'double 9', 'lightning source', 'print on demand', 'amazon digital', 'kindle direct',
].join('|'), 'i');
const esBajoDemanda = (c) => RE_BAJO_DEMANDA.test(String(c.editorial || '')) || /^9798/.test(String(c.isbn || ''));

/**
 * Editorial o colección escrita ENTRE PARÉNTESIS en el título («Cuentos de terror (Penguin Clásicos)»): es una
 * prueba de la edición tan buena como la colección. Se ignoran los paréntesis que no lo son (traductor, ilustrado,
 * bilingüe, años…).
 */
export function editorialesDelTitulo(titulo) {
    const out = [];
    for (const m of String(titulo || '').matchAll(/\(([^()]{3,60})\)/g)) {
        const t = m[1].trim();
        if (/^(trad|tr\.|il\.|ilustr|biling|bilingüe|ed\.|edici|vol|tomo|\d)/i.test(t)) continue;
        out.push(t);
    }
    return out;
}

/**
 * Reduce las candidatas SIN pruebas a las plausibles: fuera las de OTRA LENGUA y las de OTRA TRADUCCIÓN (cuando se
 * sabe), y los reimpresores bajo demanda si queda alguna edición de una editorial real. Sin duplicados por ISBN.
 */
function reducirCandidatas(doc, casi) {
    const iDoc = idioma2(doc.idioma);
    const tDoc = tokensPersonas(doc.traductores);
    const pruebasEd = [...(doc.editoriales_coleccion || []), ...editorialesDelTitulo(doc.titulo)]
        .filter((e) => e && !esEditorialFalsa(e)).map(nucleoEditorial).filter((n) => n.length);
    let lista = unicosPorIsbn(casi).filter((c) => {
        if (esEdicionAudio(c)) return false;
        const iCand = idioma2(c.idioma);
        if (iDoc && iCand && iDoc !== iCand) return false;
        const edCand = esEditorialFalsa(c.editorial) ? [] : nucleoEditorial(c.editorial);
        if (pruebasEd.length && edCand.length && !pruebasEd.some((n) => n.some((w) => edCand.includes(w)))) return false;
        const tCand = tokensPersonas(c.traductores);
        return !(tDoc.size && tCand.size && ![...tDoc].some((w) => tCand.has(w)));
    });
    const reales = lista.filter((c) => !esBajoDemanda(c));
    if (reales.length) lista = reales;
    return lista;
}

/**
 * La edición MÁS PROBABLE de varias: más señales; misma lengua que el libro; editorial real (no bajo demanda); la
 * BNE antes que el Fichero y OpenLibrary (catalogación profesional); y, a igualdad, la MÁS RECIENTE (la que más
 * probablemente sirvió de base a un EPUB/PDF actual). Se asigna como PROVISIONAL: las demás quedan en la ficha.
 */
function masProbable(doc, lista, porQue) {
    const iDoc = idioma2(doc.idioma);
    const FUENTE = { bne: 3, fichero: 2, openlibrary: 1 };
    // Una edición «de verdad» va antes que la lengua: una autoedición o reimpresión bajo demanda (CreateSpace,
    // «Independently Published», 979-8…) casi nunca es la base de un EPUB/PDF de biblioteca, aunque declare la lengua
    // y sea la más reciente (medido el 30-sep: era la «más probable» de «Drácula», «Primer amor», «Catriona»).
    const puntos = (c) => [
        (c.señales || []).length,
        esBajoDemanda(c) || esEditorialFalsa(c.editorial) ? 0 : 1,
        iDoc && idioma2(c.idioma) === iDoc ? 1 : 0,
        FUENTE[c.fuente] || 0,
        parseInt(c.anio, 10) || 0,
    ];
    const orden = [...unicosPorIsbn(lista)].sort((a, b) => {
        const pa = puntos(a), pb = puntos(b);
        for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
        return 0;
    });
    const e = orden[0];
    return {
        estado: 'provisional', isbn: e.isbn, elegido: e, candidatos: orden, via: e.fuente,
        confirmada: (e.señales || []).length > 0,
        motivo: `la más probable de ${orden.length} ediciones (${porQue}): ${e.editorial || '?'}, ${e.anio || '?'}${e.señales?.length ? ' — casa ' + e.señales.join(' + ') : ''}; se asigna como PROVISIONAL`,
    };
}

/**
 * ISBN PROVISIONAL: varias ediciones posibles pero TODAS de la MISMA editorial (típico: reimpresiones o
 * reediciones — «Los propios dioses», La Factoría de Ideas 2005 y 2007). Cuál de ellas sea importa poco: el
 * autor, la editorial, la traducción, la sinopsis y la CDU son los mismos. Se elige una (la de más señales y, a
 * igualdad, la MÁS RECIENTE) para poder completar el registro, y se deja marcada como provisional con las demás
 * candidatas, por si quieres cambiarla. Con editoriales distintas NO: serían traducciones/ediciones distintas.
 */
function siMismaEditorial(buenos) {
    const u = unicosPorIsbn(buenos);
    if (u.length < 2) return null;
    const nucleos = u.map((c) => (esEditorialFalsa(c.editorial) ? [] : nucleoEditorial(c.editorial)));
    if (nucleos.some((n) => !n.length)) return null;
    if (!nucleos.every((n) => n.some((w) => nucleos[0].includes(w)))) return null;
    const elegido = [...u].sort((a, b) => b.señales.length - a.señales.length || (parseInt(b.anio, 10) || 0) - (parseInt(a.anio, 10) || 0))[0];
    return {
        estado: 'provisional', isbn: elegido.isbn, elegido, candidatos: u, via: elegido.fuente,
        confirmada: elegido.señales.length > 0,   // ¿alguna prueba (editorial, traductor…) respalda la edición?
        motivo: `${u.length} ediciones, todas de ${elegido.editorial}: se asigna la de ${elegido.anio || '?'} como PROVISIONAL (casa ${elegido.señales.join(' + ')})`,
    };
}

/**
 * Filtra y puntúa candidatos con las reglas estrictas de arriba.
 *
 * Un candidato SIN AUTORES (los hay: el «Vampiro» de Valdemar entró en OpenLibrary sin autor) no puede confirmar
 * la autoría. Se admite solo con más exigencia: TÍTULO EXACTO y MISMA EDITORIAL. El mismo título en la misma
 * casa, sin un autor que lo contradiga, es en la práctica el mismo libro.
 */
// Una edición en AUDIO («Penguin Random House Audio», audiolibro, Audible…) no es la de un libro en papel o
// electrónico (medido el 30-sep: «Sentido y sensibilidad» recibía el ISBN del audiolibro).
const RE_EDICION_AUDIO = new RegExp(String.raw`\baudio\b|audiolibro|audiobook|audible|\bcd\b`, 'i');
const esEdicionAudio = (c) => RE_EDICION_AUDIO.test(`${c.editorial || ''} ${c.subtitulo || ''}`);

function verificar(doc, candidatos) {
    const buenos = [];
    for (const c of candidatos) {
        if (!c.isbn) continue;
        if (esEdicionAudio(c)) continue;   // (este motor no identifica audiolibros: ver reidentificar-doc)
        if (!casaTitulo(doc.titulo, c.titulo, c.subtitulo)) continue;
        const sinAutor = !c.autores?.length;
        if (doc.autores?.length && !sinAutor && !casaAutor(doc.autores, c.autores)) continue;
        const { señales, contradice } = señalesEdicion(doc, c);
        if (contradice) continue;                 // otra lengua u otra editorial ⇒ otra edición
        if (!señales.length) continue;            // nada confirma que sea ESTA edición
        if (sinAutor && doc.autores?.length && !(norm(doc.titulo) === norm(c.titulo) && señales.includes('editorial'))) continue;
        buenos.push({ ...c, señales });
    }
    // Mejor primero: más señales; a igualdad, la que casa la editorial.
    buenos.sort((a, b) => b.señales.length - a.señales.length || (b.señales.includes('editorial') ? 1 : 0) - (a.señales.includes('editorial') ? 1 : 0));
    return buenos;
}

/** Los que solo fallaron por no confirmar edición: sirven para explicar por qué no se acepta nada. */
function casiCandidatos(doc, candidatos) {
    // Mismo título Y un autor que CASE (en los dos lados): un candidato sin autores no basta para asignar nada.
    return candidatos.filter((c) => c.isbn && casaTitulo(doc.titulo, c.titulo, c.subtitulo)
        && doc.autores?.length && c.autores?.length && casaAutor(doc.autores, c.autores));
}

// Lenguas cuya autoridad natural es la BNE (orden de consulta en línea).
const LENGUAS_BNE = new Set(['es', 'ca', 'gl', 'eu']);

// Tope de espera para OpenLibrary aquí: su cliente espera hasta 45 s (con reintentos) porque en la ingesta
// prima conseguir el dato; en «Extraer ISBN» un libro no puede bloquear el lote varios minutos.
const TOPE_OL_MS = Number(process.env.IDENTIFICAR_OL_TOPE_MS || 15000);

/** Ediciones de la BNE por título+autor (o +editorial). [] si no hay o la BNE no responde. */
async function candidatosBNE(doc, autor, caidas = []) {
    // Hasta 50: un clásico tiene decenas de ediciones y la buena puede venir la 26.ª (medido: la de Ángeles Caso de
    // «Las amistades peligrosas»).
    const r = await buscarEdicionesEnBNE({ titulo: doc.titulo, autor, editorial: doc.editorial, max: 50 }).catch(() => null);
    if (r === null) caidas.push('bne');   // null = la BNE no respondió (red o circuito abierto); [] = no lo tiene
    // Con el TRADUCTOR conocido, además una búsqueda dirigida por su apellido (la BNE indexa los 700): da justo
    // las ediciones de esa traducción aunque haya cien del mismo título.
    const extra = [];
    for (const t of (doc.traductores || []).slice(0, 2)) {
        const apellido = String(t).includes(',') ? String(t).split(',')[0] : String(t).trim().split(/\s+/).pop();
        if (!apellido || apellido.length < 3) continue;
        const x = await buscarEdicionesEnBNE({ titulo: doc.titulo, autor: apellido, max: 10 }).catch(() => null);
        if (x) extra.push(...x);
    }
    return [...(r || []), ...extra].map((x) => comoCandidato({ ...x, anio: x.año_edicion }, 'bne'));
}

/** La edición que elige OpenLibrary por título+autor (una), con tope de espera. */
async function candidatosOL(doc, autor, caidas = []) {
    // Un fallo de RED (lanza ErrorInfraestructura) o el tope de espera NO son «OpenLibrary no lo tiene»: se anotan
    // como fuente caída para que el libro se vuelva a intentar más tarde.
    const FALLO = Symbol('fallo');
    const tope = new Promise((res) => setTimeout(() => res(FALLO), TOPE_OL_MS));
    const consulta = buscarPorCriterios({ titulo: doc.titulo, autor, idioma: doc.idioma || null, incluirSinopsis: false }).catch(() => FALLO);
    const ol = await Promise.race([consulta, tope]);
    if (ol === FALLO) { caidas.push('openlibrary'); return []; }
    return ol?.isbn ? [comoCandidato({ ...ol, anio: ol.año_edicion }, 'openlibrary')] : [];
}

/** Sin duplicados por ISBN (la misma edición puede llegar del Fichero y de la BNE). */
const unicosPorIsbn = (lista) => [...new Map(lista.map((b) => [b.isbn, b])).values()];

/**
 * Si queda exactamente UNA edición verificada, esa es. DESEMPATE: si hay varias de la misma editorial pero solo
 * UNA casa además el año exacto o el nº de colección, es esa (p. ej. «Hive Mind», Stanford: la electrónica de
 * 2015, la tapa dura y la rústica de 2016 — el año decide). Si el empate persiste, no se elige ninguna.
 */
function siUnica(buenos, via) {
    const u = unicosPorIsbn(buenos).sort((a, b) => b.señales.length - a.señales.length);
    // Una edición de AUTOEDICIÓN o bajo demanda (979-8…, Creative Media Partners…) nunca es «única»: como mucho DUDOSA
    // (medido: «Nostromo (trad. Rafael Santervás)» → 979-8…).
    const elegir = (c, motivo) => (esBajoDemanda(c)
        ? { estado: 'dudoso', isbn: c.isbn, elegido: c, candidatos: u, via: c.fuente || via, confirmada: false, motivo: `${motivo}; edición de autoedición o bajo demanda: DUDOSA` }
        : { estado: 'unico', isbn: c.isbn, elegido: c, candidatos: u, via: c.fuente || via, motivo });
    if (u.length === 1) return elegir(u[0], `casa ${u[0].señales.join(' + ')}`);
    if (u.length > 1) {
        const [mejor, segundo] = u;
        const decisiva = mejor.señales.includes('editorial') && (mejor.señales.includes('año') || mejor.señales.includes('nº de colección'));
        if (decisiva && mejor.señales.length > segundo.señales.length) {
            return elegir(mejor, `casa ${mejor.señales.join(' + ')} (la única de ${u.length} ediciones de la misma editorial que casa también ${mejor.señales.includes('año') ? 'el año' : 'el nº de colección'})`);
        }
    }
    return null;
}

/**
 * @param doc { titulo, autores:[nombre], editorial, coleccion_nombre, coleccion_numero, anio, idioma }
 * @param opts online=false (BNE + OpenLibrary) · conIA=false (último recurso, verificado) · limite=40
 * @returns { estado:'unico'|'ambiguo'|'sin-candidatos', isbn?, elegido?, candidatos[], via?, motivo }
 */
export async function identificarEdicion(doc, { online = false, conIA = false, limite = 40 } = {}) {
    if (!doc?.titulo) return { estado: 'sin-candidatos', candidatos: [], motivo: 'el documento no tiene título' };
    // MATERIAL DERIVADO de un libro («The Eagle of the Ninth — ejercicios», «… — solucionario», «… — test»): NO es el
    // libro, aunque su título lo contenga y el autor case. Darle el ISBN del libro sería falso (y después la fusión
    // de versiones podría juntar ejercicios, solucionario y test en uno). Medido el 29-sep con Oxford Bookworms.
    if (esMaterialDerivado(doc.titulo)) {
        return { estado: 'sin-candidatos', candidatos: [], motivo: 'material derivado de un libro (ejercicios, solucionario, test…): no es la edición del libro' };
    }
    // SIN AUTOR NO SE IDENTIFICA UNA EDICIÓN. Solo con el título, cualquier libro homónimo «casa» (medido el 29-sep:
    // revistas y títulos genéricos —«Astronomy», «Computer Hoy», «Más Allá 5», «Nueva Dimensión 3»…— recibieron el
    // ISBN de libros sin relación). El autor es la prueba mínima de que es la misma obra.
    if (!(doc.autores || []).some((a) => String(a || '').trim())) {
        return { estado: 'sin-candidatos', candidatos: [], motivo: 'sin autor no se identifica la edición (solo con el título casaría cualquier homónimo)' };
    }
    // El traductor anotado en el título («… (trad. Ángeles Caso)») es una PRUEBA, no parte del título: se pasa a
    // `traductores` y se quita del título, o ninguna autoridad encuentra el libro (medido: la BNE no devolvía la
    // edición de Ángeles Caso y ganaba otra traducción).
    const delTitulo = traductoresDelTitulo(doc.titulo);
    if (delTitulo.length) {
        doc = {
            ...doc,
            titulo: String(doc.titulo).replace(RE_TRADUCTOR_TITULO, ' ').replace(/\s+/g, ' ').trim(),
            traductores: doc.traductores?.length ? doc.traductores : delTitulo,
        };
    }
    const autor = (doc.autores || [])[0] || null;
    // Fuentes que NO respondieron (Fichero no disponible, BNE u OpenLibrary caídas): un «no encontrado» con alguna
    // caída no es definitivo — quien llama puede volver a intentarlo más tarde (campaña «Recuperar ISBN»).
    const caidas = [];
    const conCaidas = (r) => ({ ...r, fuentesCaidas: [...new Set(caidas)] });

    // 1) FICHERO local (offline, gratis). Primero título+autor; si no sale nada verificado, SOLO título: un
    //    registro sin autor (los hay) no aparece en una búsqueda que exige el apellido.
    const delFichero = await buscarEdicionesEnFichero(doc.titulo, autor, { limite: Math.max(limite, 200) }).catch(() => null);
    if (delFichero === null) caidas.push('fichero');
    let candidatos = (delFichero || []).map((c) => comoCandidato(c, 'fichero'));
    let buenos = verificar(doc, candidatos);
    // Registros SIN AUTOR: solo se pueden aceptar con título exacto y MISMA editorial, así que esta segunda
    // búsqueda solo tiene sentido si conocemos una editorial real. Búsqueda exacta por la columna título (10-20 ms).
    if (!buenos.length && autor && doc.editorial && !esEditorialFalsa(doc.editorial)) {
        const soloTitulo = ((await buscarTituloEnFichero(doc.titulo).catch(() => null)) || [])
            .map((c) => comoCandidato(c, 'fichero'));
        candidatos = unicosPorIsbn([...candidatos, ...soloTitulo]);
        buenos = verificar(doc, candidatos);
    }
    let r = siUnica(buenos, 'fichero');
    if (r) return r;

    if (online) {
        // 2) FUENTES EN LÍNEA, en el orden que dicta la LENGUA: para un libro en español (o catalán, gallego,
        //    euskera) la BNE es la autoridad y va primero; para el resto, OpenLibrary. Si la primera no lo
        //    resuelve, se prueba la siguiente.
        // online === 'bne' → solo la BNE (la ingesta ya ha preguntado a OpenLibrary en su cascada).
        const fuentes = online === 'bne' ? ['bne']
            : LENGUAS_BNE.has(idioma2(doc.idioma)) ? ['bne', 'openlibrary'] : ['openlibrary', 'bne'];
        for (const fuente of fuentes) {
            const nuevos = fuente === 'bne' ? await candidatosBNE(doc, autor, caidas) : await candidatosOL(doc, autor, caidas);
            if (!nuevos.length) continue;
            candidatos = unicosPorIsbn([...candidatos, ...nuevos]);
            buenos = unicosPorIsbn([...buenos, ...verificar(doc, nuevos)]);
            r = siUnica(buenos, fuente);
            if (r) return r;
        }
    }

    // 4) IA, último recurso y NUNCA como fuente: propone un ISBN y solo se acepta si el Fichero lo confirma
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

    // ── DECIDIR SIN TI (regla del usuario: revisar a mano ~1.300 ediciones no es tarea para un humano) ──
    // 1) Con pruebas (buenos): todas de la MISMA editorial → PROVISIONAL; de editoriales distintas → la MÁS
    //    PROBABLE, también provisional (las demás quedan en la ficha para cambiarla).
    // 2) Sin pruebas (casi: mismo título y autor, nada más): se REDUCE la lista (fuera otras lenguas, otras
    //    traducciones y reimpresores bajo demanda si hay alguna edición «de verdad»). Queda UNA → se asigna marcada
    //    DUDOSA; quedan varias → la más probable, provisional.
    if (buenos.length > 1) {
        const prov = siMismaEditorial(buenos);
        if (prov) return conCaidas(prov);
        // Editoriales distintas: la más probable SOLO si alguna prueba la respalda (siempre las hay aquí: «buenos»
        // son los que casan editorial, traductor, año o colección); la elegida es la de más pruebas.
        return conCaidas(masProbable(doc, buenos, 'con pruebas, de editoriales distintas'));
    }
    const reducidas = reducirCandidatas(doc, casiCandidatos(doc, candidatos));
    if (reducidas.length === 1) {
        const c = reducidas[0];
        return conCaidas({ estado: 'dudoso', isbn: c.isbn, elegido: { ...c, señales: [] }, candidatos: [c], via: c.fuente,
            motivo: `única edición posible (${c.editorial || '?'}, ${c.anio || '?'}), sin nada que confirme que es la de este ejemplar: se asigna marcada como DUDOSA` });
    }
    if (reducidas.length > 1) {
        const conSeñales = reducidas.map((c) => ({ ...c, señales: c.señales || [] }));
        // SIN PRUEBAS no se elige ninguna «a ciegas»: con un clásico hay cientos de ediciones y la «más probable» es
        // lotería (medido el 29-sep: adaptaciones de Oxford Bookworms recibían el ISBN de ediciones completas de
        // Printers Row, Nasionale Boekhandel, Harvard…). Todas de la misma editorial → provisional (la edición da
        // igual); si no, se guardan las candidatas y eliges tú en la ficha.
        const mismaEd = siMismaEditorial(conSeñales);
        if (mismaEd) return conCaidas(mismaEd);
        // Aun así se señala la MÁS PROBABLE (`probable`), que el llamante guarda APARTE (isbn_probable): visible en la
        // ficha y buscable, pero no es el ISBN del documento — no se usa como pivote hasta que se confirme. Las
        // candidatas van ordenadas de más a menos probable.
        // Si hasta la mejor es una autoedición o reimpresión bajo demanda, la edición real no está entre las
        // candidatas: no hay «más probable» (señalar una de CreateSpace engañaría).
        const orden = masProbable(doc, conSeñales, 'sin pruebas');
        const real = !esBajoDemanda(orden.elegido) && !esEditorialFalsa(orden.elegido.editorial);
        return conCaidas({ estado: 'ambiguo', candidatos: orden.candidatos, probable: real ? orden.elegido : null,
            motivo: `${conSeñales.length} ediciones posibles de editoriales distintas y nada que confirme cuál: elige en la ficha`
                + (real ? ` (la más probable: ${orden.elegido.editorial || '?'}, ${orden.elegido.anio || '?'})` : ' (todas son autoediciones o bajo demanda: la tuya quizá no está entre ellas)') });
    }
    if (caidas.length) return conCaidas({ estado: 'sin-candidatos', candidatos: [], motivo: `no hallado, pero no respondió: ${[...new Set(caidas)].join(', ')}` });
    return conCaidas({ estado: 'sin-candidatos', candidatos: [], motivo: 'ninguna autoridad tiene esta edición' });
}

/**
 * Las candidatas de una identificación ambigua, en la forma en que se guardan en el documento
 * (`ediciones_candidatas`, máx. 8): lo justo para reconocerlas en la ficha y elegir.
 */
export function candidatasParaGuardar(candidatos = []) {
    return candidatos.slice(0, 8).map((c) => ({
        isbn: c.isbn, titulo: c.titulo || null, subtitulo: c.subtitulo || null,
        editorial: c.editorial || null, anio: c.anio || null, idioma: c.idioma || null,
        coleccion: [c.coleccion_nombre, c.coleccion_numero].filter(Boolean).join(' · ') || null,
        fuente: c.fuente || null, señales: c.señales || [],
    }));
}

/** ¿Es una lengua cuya autoridad natural es la BNE? (para decidir si consultarla en línea en la ingesta) */
export const lenguaDeBNE = (idioma) => LENGUAS_BNE.has(idioma2(idioma));

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
