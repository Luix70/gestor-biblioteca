/**
 * AGENTE DE ESTRUCTURA — interpreta un ÁRBOL DE CARPETAS y dice qué información aprovechar de él.
 *
 * LA APUESTA: alguien se tomó la molestia de ordenar esos documentos por editorial, serie, materia u obra. Esa
 * clasificación humana es información de primera, y hoy se pierde: la regla del vigilante «carpeta con 2+
 * documentos = colección» mete a todos los sueltos de un árbol profundo en UNA colección con el nombre de la
 * carpeta superior (así nació «Misc»). Y la materia de la carpeta —«Algebra/», «Topology/»— es justo la señal
 * que le falta a la ingesta sin IA para la CDU.
 *
 * POR QUÉ IA Y NO REGLAS: el usuario pidió algo ADAPTABLE. Las reglas que se fueron deduciendo a mano («es
 * editorial porque 24 de 25 comparten editorial», «es cajón porque se llama "useful"») fallan ante el siguiente
 * patrón que no se haya visto. Aquí esas reglas no desaparecen: se calculan en local, GRATIS, y se le entregan
 * a la IA como EVIDENCIA. La IA sintetiza; el código aporta los hechos.
 *
 * POR QUÉ COMPENSA: UNA llamada por árbol (bien alimentada) en lugar de muchas llamadas ciegas documento a
 * documento. Caso real que lo motivó: en la colección de matemáticas, 9 de 34 libros acabaron con una CDU de
 * otra rama (álgebra lineal como inteligencia artificial, criptografía como gestión) estando en una carpeta
 * que decía exactamente de qué iban.
 *
 * Este módulo NO escribe nada: devuelve una interpretación por carpeta. La convierten en `_guia.json` (el formato
 * que el vigilante ya obedece) utils/guias-estructura.js, y la lanzan el CLI scripts/inspeccionar-estructura.js y,
 * DE SERIE, el vigilante antes de ingerir cada carpeta compleja del Inbox (utils/inspeccion-auto.js).
 *
 * DOS DIMENSIONES por carpeta:
 *   · tipo      → cómo está ORGANIZADA (colección, serie, editorial, materia, obra, cajón…).
 *   · contenido → QUÉ CONTIENE (libros, revistas, audiolibro, software, libro desglosado…), que decide la RUTA
 *                 de ingesta. Para eso el esqueleto lleva el reparto por extensión y nombres de muestra también de
 *                 lo que no es documento: con solo «12 audio, 3 otros», un audiolibro y un curso eran indistinguibles.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { conTexto, extraerJSON } from './vision.js';
import { buscarEnFicheroLocal } from './buscador-local.js';
import { extraerISBNs } from './lector-pdf.js';
import { variantesISBN, validarISSN } from './identificadores.js';
import { parsearVolumen } from './multivolumen.js';

// Extensiones de DOCUMENTO (lo que se cataloga). Las imágenes sueltas se cuentan aparte: en un árbol de libros
// suelen ser portadas, y en otro pueden ser páginas escaneadas — la IA lo decide con el recuento a la vista.
const EXT_DOC = new Set(['.pdf', '.epub', '.mobi', '.azw', '.azw3', '.djvu', '.djv', '.cbz', '.cbr', '.cb7', '.chm', '.doc', '.docx', '.fb2', '.rtf', '.txt']);
const EXT_IMG = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.tif', '.tiff', '.bmp']);
const EXT_AUDIO = new Set(['.mp3', '.m4a', '.m4b', '.flac', '.ogg', '.wav', '.aac', '.aax']);

// Nombres que no son contenido: marcadores propios, metadatos de Synology y de sistemas operativos.
const esAccesorio = (n) => n.startsWith('.') || n.startsWith('_') || n.startsWith('@') || n.startsWith('#') || /^(thumbs\.db|desktop\.ini)$/i.test(n);

// Límites que acotan el TAMAÑO del esqueleto, y con él el coste. Un árbol de miles de carpetas no cabe entero: se
// recorta con aviso (la IA sabe que ve una muestra) en vez de reventar el prompt. 500 carpetas = 10 tandas de 50
// (~7-8 min): antes eran 120, de cuando todo iba en UNA llamada. Profundidad 8 = la misma a la que llega el
// vigilante al recorrer una carpeta (recopilarDocumentos, tieneDescendientesGuiados).
const LIMITES = { profundidad: 8, carpetas: 500, muestras: 5, isbnPorCarpeta: 8 };

/** Normaliza para agrupar variantes de lo mismo: «CAMBRIDGE UNIV PRESS» y «Cambridge University Press». */
const normEditorial = (s) => String(s || '').toLowerCase().replace(/\buniv(ersity)?\b\.?/g, 'university').replace(/\bpr(ess)?\b\.?/g, 'press').replace(/[^a-z0-9]+/g, ' ').trim();

/** Normaliza el nombre de serie del Fichero: quita el nº de volumen y la puntuación ISBD colgante. */
const normSerie = (s) => String(s || '').replace(/\s*--\s*\d+.*$/, '').replace(/[\s;:,.]+$/, '').trim();

/** El valor más repetido y su proporción sobre el total observado. */
function dominante(valores, normalizar = (x) => x) {
    if (!valores.length) return null;
    const cuenta = new Map(), original = new Map();
    for (const v of valores) {
        const k = normalizar(v);
        if (!k) continue;
        cuenta.set(k, (cuenta.get(k) || 0) + 1);
        if (!original.has(k)) original.set(k, v);
    }
    let mejor = null;
    for (const [k, n] of cuenta) if (!mejor || n > mejor.n) mejor = { k, n };
    return mejor ? { valor: original.get(mejor.k), veces: mejor.n, de: valores.length } : null;
}

/**
 * SEÑALES LOCALES de una carpeta (gratis, sin IA): tomos «Vol. N», ISBN en los nombres y, por ellos, la
 * editorial y la serie DOMINANTES según el Fichero local. Es la «serialización de ISBN» que distingue una
 * carpeta de editorial (24/25 «Cambridge University Press») de una de serie o de materia.
 */
async function senalesLocales(documentos) {
    // Tomos: se cuentan los DOCUMENTOS numerados, no solo los números distintos. «2 tomos» en una carpeta de 86
    // libros es que dos de ellos se llaman «… Vol. 1» y «… Vol. 2»: NO es una obra. El detector real
    // (multivolumen.js) exige que los tomos sean al menos la MITAD de la carpeta; la IA necesita esa proporción
    // a la vista para no confundir una carpeta de materia con una obra.
    const volumenes = new Set();
    let docsConVol = 0;
    for (const n of documentos) {
        const v = parsearVolumen(n);
        if (v?.numero != null) { volumenes.add(v.numero); docsConVol++; }
    }

    const editoriales = [], series = [];
    let conIsbn = 0;
    for (const n of documentos.slice(0, LIMITES.isbnPorCarpeta)) {
        const isbns = (extraerISBNs(n) || []).flatMap(variantesISBN);
        if (!isbns.length) continue;
        conIsbn++;
        const f = await buscarEnFicheroLocal({ isbns }).catch(() => null);
        if (f?.editorial) editoriales.push(f.editorial);
        if (f?.coleccion_nombre) series.push(normSerie(f.coleccion_nombre));
    }

    return {
        tomos_distintos: volumenes.size,                 // ≥2 números Y ≥ mitad de la carpeta → obra
        docs_con_volumen: docsConVol,
        isbn_en_nombre: `${conIsbn}/${Math.min(documentos.length, LIMITES.isbnPorCarpeta)}`,
        editorial_dominante: dominante(editoriales, normEditorial),
        serie_dominante: dominante(series, (s) => s.toLowerCase()),
        issn_en_nombre: issnsEnNombres(documentos),
    };
}

// ISSN escritos en los nombres («1699-7913_2019_01.pdf»). Solo la forma CON guion y con dígito de control
// válido: sin guion, ocho cifras seguidas casan con fechas y códigos que no son ISSN.
const RE_ISSN = /\b(\d{4}-\d{3}[\dXx])\b/g;
export function issnsEnNombres(nombres) {
    const vistos = new Set();
    for (const n of nombres) {
        for (const m of String(n).matchAll(RE_ISSN)) {
            const v = validarISSN(m[1]);
            if (v) vistos.add(v);
        }
    }
    return [...vistos];
}

// Extensiones de SOFTWARE: su presencia cambia por completo qué es una carpeta (un instalador no se lee).
const EXT_SOFTWARE = new Set(['.exe', '.msi', '.dll', '.iso', '.dmg', '.apk', '.app', '.bin', '.cab', '.ipa', '.jar', '.bat', '.sh', '.nrg', '.mdf', '.cue']);

/**
 * Qué DOMINA en tamaño: el documento más grande y cuántas veces pesa el siguiente. Un libro entero junto a sus
 * capítulos pesa varias veces cualquiera de ellos; en una colección, los tamaños son comparables. Es la misma
 * señal que usa el detector de libros desglosados (libro-desglosado.js), aquí como EVIDENCIA para la IA.
 */
async function dominioTamano(dir, documentos) {
    if (documentos.length < 2) return null;
    const tamanos = [];
    for (const n of documentos.slice(0, 300)) {           // tope: una carpeta de mil libros no necesita mil stat
        try { tamanos.push({ n, b: (await fs.stat(path.join(dir, n))).size }); } catch { /* ilegible: se ignora */ }
    }
    if (tamanos.length < 2) return null;
    tamanos.sort((a, b) => b.b - a.b);
    const ratio = tamanos[1].b > 0 ? tamanos[0].b / tamanos[1].b : 0;
    return ratio >= 1.5 ? { nombre: tamanos[0].n, veces: Math.round(ratio * 10) / 10 } : null;
}

/** Reparto por extensión, de más a menos frecuente («mp3×12 pdf×1»). Lo que más ayuda a saber QUÉ contiene. */
function repartoExtensiones(nombres, max = 6) {
    const cuenta = new Map();
    for (const n of nombres) {
        const ext = path.extname(n).toLowerCase().replace('.', '') || '(sin ext)';
        cuenta.set(ext, (cuenta.get(ext) || 0) + 1);
    }
    return [...cuenta].sort((a, b) => b[1] - a[1]).slice(0, max).map(([e, k]) => `${e}×${k}`).join(' ');
}

/** Orden de ÁRBOL (en profundidad) entre dos rutas relativas: la madre antes que sus hijas, y cada subárbol junto. */
function ordenArbol(a, b) {
    if (a === '.') return -1;
    if (b === '.') return 1;
    const x = a.split('/'), y = b.split('/');
    for (let i = 0; i < Math.min(x.length, y.length); i++) {
        if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    }
    return x.length - y.length;
}

/**
 * Recorre el árbol y construye su ESQUELETO: por carpeta, recuentos, unos pocos nombres de muestra y las
 * señales locales. No abre ningún documento: solo nombres de fichero y el Fichero local.
 *
 * QUÉ CARPETAS ENTRAN cuando el árbol es más grande que el tope: se eligen NIVEL A NIVEL (en anchura), primero
 * todas las de arriba. Antes el recorrido era en profundidad y alfabético, y al llegar al tope se perdían RAMAS
 * ENTERAS — las últimas del alfabeto: en un árbol como University Press Collection, las series de Stanford
 * podían quedarse sin ver. Las carpetas de arriba son las que más dicen (colección, serie, editorial, materia) y
 * sus guías se HEREDAN hacia abajo, así que lo que quede fuera en lo hondo va por las reglas con esas pistas.
 * Luego se presentan en orden de árbol, que es como las esperan el mapa y el troceo en tandas.
 *
 * @returns {Promise<{raiz, carpetas: object[], recortado: boolean, sin_ver: number}>}
 *   sin_ver = carpetas que se sabe que existen y quedaron fuera (sin contar lo que cuelga de ellas).
 */
export async function esqueletoArbol(raiz, limites = {}) {
    const lim = { ...LIMITES, ...limites };
    let recortado = false;

    // 1) SELECCIÓN en anchura. Se guarda el listado de cada carpeta elegida para no volver a leerla después.
    const elegidas = [];
    const cola = [{ dir: raiz, nivel: 0 }];
    while (cola.length) {
        if (elegidas.length >= lim.carpetas) { recortado = true; break; }
        const { dir, nivel } = cola.shift();
        let entradas;
        try { entradas = await fs.readdir(dir, { withFileTypes: true }); } catch { continue; }
        elegidas.push({ dir, nivel, entradas });
        const subs = entradas.filter((e) => e.isDirectory() && !esAccesorio(e.name)).map((e) => e.name).sort();
        if (nivel >= lim.profundidad) { if (subs.length) recortado = true; continue; }
        for (const s of subs) cola.push({ dir: path.join(dir, s), nivel: nivel + 1 });
    }
    const sinVer = cola.length;

    // 2) Orden de ÁRBOL para presentarlas.
    const relDe = (dir) => path.relative(raiz, dir).split(path.sep).join('/') || '.';
    elegidas.sort((a, b) => ordenArbol(relDe(a.dir), relDe(b.dir)));

    // 3) Señales de cada carpeta.
    const carpetas = [];
    for (const { dir, nivel, entradas } of elegidas) carpetas.push(await describirCarpeta(dir, relDe(dir), nivel, entradas, lim));
    return { raiz: path.basename(raiz), carpetas, recortado, sin_ver: sinVer };
}

/** Recuentos, muestras y señales locales de UNA carpeta del esqueleto. */
async function describirCarpeta(dir, rel, nivel, entradas, lim) {
    const docs = [], subcarpetas = [], ficheros = [], noDocs = [];
    let imagenes = 0, audios = 0, otros = 0;
    for (const e of entradas) {
        if (esAccesorio(e.name)) continue;
        if (e.isDirectory()) { subcarpetas.push(e.name); continue; }
        ficheros.push(e.name);
        const ext = path.extname(e.name).toLowerCase();
        if (EXT_DOC.has(ext)) docs.push(e.name);
        else if (EXT_IMG.has(ext)) imagenes++;
        else if (EXT_AUDIO.has(ext)) { audios++; noDocs.push(e.name); }
        // «Otros» (html, código, datos…): sin ellos una carpeta con los 13 libros de Euclides en HTML
        // aparecería como VACÍA, y la IA la tomaría por basura.
        else { otros++; noDocs.push(e.name); }
    }

    // Muestras de lo que NO es documento: sin nombres, un audiolibro («01 - Capítulo 1.mp3») o un programa
    // («setup.exe», «data1.cab») eran para la IA solo «12 audio» o «9 otros». Primero los ejecutables, que son
    // los que más cambian la lectura de la carpeta.
    const muestrasOtros = [
        ...noDocs.filter((n) => EXT_SOFTWARE.has(path.extname(n).toLowerCase())),
        ...noDocs.filter((n) => !EXT_SOFTWARE.has(path.extname(n).toLowerCase())),
    ].slice(0, 4);

    return {
        ruta: rel,
        nivel,
        documentos: docs.length,
        imagenes,
        audios,
        otros,
        subcarpetas: subcarpetas.length,
        extensiones: ficheros.length ? repartoExtensiones(ficheros) : '',
        muestras: docs.slice(0, lim.muestras),
        muestras_otros: muestrasOtros,
        dominio: await dominioTamano(dir, docs),
        ...(docs.length ? await senalesLocales(docs) : {}),
    };
}

// ─── La llamada a la IA ──────────────────────────────────────────────────────────────────────────────────

const TIPOS = ['coleccion', 'serie', 'editorial', 'materia', 'obra', 'cajon', 'mixta', 'raiz', 'parte'];

// QUÉ CONTIENE cada carpeta (segunda dimensión, independiente de cómo esté organizada). Decide la RUTA de
// ingesta: las que son una UNIDAD (audiolibro, software…) se ingieren enteras por su ruta propia, que ya existe
// en el vigilante; antes solo se llegaba a ellas por detectores fijos en cascada o por una guía hecha a mano.
export const CONTENIDOS = ['libros', 'revistas', 'comics', 'audiolibro', 'coleccion-audiolibros', 'transmedia',
    'software', 'libro-material', 'libro-desglosado', 'escaneo', 'mixta'];
const PERIODICIDADES = ['semanal', 'quincenal', 'mensual', 'bimestral', 'trimestral', 'semestral', 'anual', 'irregular'];

/**
 * Mapa COMPACTO de todo el árbol (solo rutas y nº de documentos) que acompaña a cada tanda cuando se trocea.
 *
 * Por qué hace falta (medido): en University Press Collection las 15 carpetas temáticas hermanas quedaron
 * repartidas entre dos tandas, y cada llamada las juzgó por su cuenta: «Philosophy» y «Regional History»
 * salieron MATERIA con su CDU, y sus gemelas «American History», «General History» y «Literary Studies»,
 * COLECCIÓN. Con el mapa a la vista, cada tanda sabe qué hermanas existen aunque no le toque interpretarlas.
 */
function mapaArbol(esq) {
    return esq.carpetas.map((c) => `  ${'  '.repeat(c.nivel)}${c.ruta === '.' ? esq.raiz : c.ruta.split('/').pop()} (${c.documentos})`).join('\n');
}

function construirPrompt(esq, carpetas = esq.carpetas, trozo = null) {
    // El esqueleto va COMPACTO (una línea por carpeta) para que un árbol de 100 carpetas quepa holgado.
    const lineas = carpetas.map((c) => {
        const s = [];
        if (c.tomos_distintos >= 2) s.push(`tomos:${c.docs_con_volumen} de ${c.documentos} docs (${c.tomos_distintos} números)`);
        if (c.isbn_en_nombre && !c.isbn_en_nombre.startsWith('0/')) s.push(`isbn:${c.isbn_en_nombre}`);
        if (c.editorial_dominante) s.push(`editorial:«${c.editorial_dominante.valor}» ${c.editorial_dominante.veces}/${c.editorial_dominante.de}`);
        if (c.serie_dominante) s.push(`serie:«${c.serie_dominante.valor}» ${c.serie_dominante.veces}/${c.serie_dominante.de}`);
        if (c.dominio) s.push(`dominante:«${c.dominio.nombre}» ×${c.dominio.veces}`);
        if (c.issn_en_nombre?.length) s.push(`issn:${c.issn_en_nombre.join(',')}`);
        if (c.extensiones) s.push(`ext:${c.extensiones}`);
        const cont = `${c.documentos} docs${c.imagenes ? `, ${c.imagenes} img` : ''}${c.audios ? `, ${c.audios} audio` : ''}${c.otros ? `, ${c.otros} otros ficheros` : ''}${c.subcarpetas ? `, ${c.subcarpetas} subcarpetas` : ''}`;
        const muestra = c.muestras.length ? ` | ej: ${c.muestras.map((m) => `«${m}»`).join(', ')}` : '';
        const muestraOtros = c.muestras_otros?.length ? ` | otros: ${c.muestras_otros.map((m) => `«${m}»`).join(', ')}` : '';
        return `- [${c.ruta}] (${cont})${s.length ? ` {${s.join('; ')}}` : ''}${muestra}${muestraOtros}`;
    }).join('\n');

    return `Eres un bibliotecario experto analizando un ÁRBOL DE CARPETAS que alguien organizó a mano, para
aprovechar esa organización al catalogarlo. Para CADA carpeta decide QUÉ ES:

- coleccion: agrupación propia del usuario que conviene conservar como colección
- serie: serie editorial real (p. ej. «Cultural Memory in the Present», «Cambridge History of…»)
- editorial: carpeta que agrupa por EDITORIAL (la editorial ya es un dato del libro: NO debe ser colección)
- materia: carpeta TEMÁTICA (Algebra, Topology, Religious Studies…): su nombre da la CDU de su contenido.
  Si una carpeta es a la vez TEMA y subdivisión de una serie o colección (p. ej. «American History» dentro de
  «Cambridge History Collection»), es MATERIA: su nombre aporta la CDU, y la pertenencia a la serie ya la
  expresa la carpeta madre
- obra: obra multivolumen (sus documentos son tomos de UNA misma obra)
- cajon: agrupación sin significado («useful», «misc», «nuevas descargas», «varios») o por TIPO DE SOPORTE
  («Audiolibros», «Revistas», «Programas», «PDF», «Cómics», «Libros»): el soporte ya lo dice cada documento, así
  que NO es una colección
- mixta: mezcla de varias de las anteriores
- raiz: la carpeta superior, si solo contiene otras
- parte: subcarpeta que es una PARTE de lo que contiene su madre, no algo por sí misma: «CD1», «Disco 2», «Audio»
  o «Extras» de un audiolibro o un curso, los años de una revista («2020/», «2021/»)

Y, aparte, di QUÉ CONTIENE cada carpeta («contenido»), que es independiente de lo anterior:
- libros: libros o documentos de lectura corrientes (lo habitual)
- revistas: números de una publicación periódica (una tirada, todas las ediciones de un año…). En
  «nombre_canonico» pon el nombre de la CABECERA, sin fecha ni número («Historia de Iberia Vieja», no «HIV
  2019 nº 163»; si los ficheros la abrevian —«2DAIssue.073»—, el nombre completo de la publicación); en
  «periodicidad», ${PERIODICIDADES.join('|')} si se deduce; en «anio», el año si la carpeta es de un solo año;
  y en «cdu», la CDU de la MATERIA de la publicación (se aplica a todos sus números). NO des el ISSN: se
  comprueba aparte contra fuentes fiables
- comics: cómics o novela gráfica
- audiolibro: UN audiolibro: el AUDIO es la obra. Puede traer portada y PDF ACCESORIOS (librillo, carátula,
  contraportada, portada, notas, inlay): siguen siendo un audiolibro, NO transmedia
- coleccion-audiolibros: VARIOS audiolibros (por autor u obra, cada uno en su carpeta o con la obra en el nombre)
- transmedia: UNA obra o curso en varios medios donde el TEXTO también es parte principal: el libro completo que
  se lee junto a su audio (lecturas graduadas), un curso con libro + audio + vídeo, un CD-ROM… Si los PDF son
  solo accesorios del audio (librillo, carátula), es audiolibro
- software: un programa, instalador o paquete de software (ejecutables, .dll, .cab, imagen de disco de instalación)
- libro-material: UN libro con material auxiliar (código de ejemplo, datos, ejercicios, contenido de su CD)
- libro-desglosado: UN libro partido en capítulos o partes sueltas (Chapter01…, «Introduction», «Index»…), esté o
  no el libro entero al lado (la señal «dominante» indica que lo está)
- escaneo: páginas escaneadas (imágenes) de un libro o documento
- mixta: mezcla de lo anterior (p. ej. audiolibros y libros corrientes juntos): cada parte se trata por su cuenta
- null: si solo contiene subcarpetas de cosas DISTINTAS. Si todas sus subcarpetas son partes de lo MISMO (los años
  de una revista, los CD de un audiolibro), da ese contenido: una carpeta «Muy Historia» con «2020/» y «2021/»
  dentro es revistas, con su cabecera
El contenido describe la carpeta ENTERA, no lo que hay en sus hijas. Un CAJÓN que agrupa varios programas, varios
audiolibros o varias revistas distintas NO es «software», «audiolibro» ni «revistas»: es cajón, con contenido null
o mixta, y cada hija lleva el suyo. Una carpeta de audiolibro, transmedia, software, libro-material o
libro-desglosado es UNA unidad que se ingiere entera: sus subcarpetas son de tipo «parte».

EVIDENCIA calculada en local para cada carpeta, entre llaves (úsala, es fiable):
- tomos:a de M docs (N números) → a de los M documentos llevan número de volumen. Es OBRA solo si son al
  menos la MITAD de la carpeta; «tomos:2 de 86» es una carpeta temática donde dos libros son de dos tomos
- isbn:a/b → a de b ficheros muestreados llevan ISBN en el nombre
- editorial:«X» a/b → editorial más frecuente según un catálogo bibliográfico (a de b); si coincide con el
  nombre de la carpeta, es carpeta de EDITORIAL
- serie:«X» a/b → serie más frecuente; si coincide con el nombre de la carpeta, es SERIE
- dominante:«X» ×R → el documento X pesa R veces más que el siguiente: típico de un libro entero junto a sus
  capítulos sueltos (en una colección los tamaños son parecidos)
- issn:NNNN-NNNN → ISSN escrito en los nombres de fichero (publicación periódica o serie)
- ext:pdf×12 mp3×3… → reparto de TODOS los ficheros de la carpeta por extensión
Tras «ej:» van nombres de documentos de muestra; tras «otros:», nombres de lo que no es documento (audio,
ejecutables, datos…).

Para las de tipo «materia» y las de contenido «revistas» da la CDU (Clasificación Decimal Universal) más PRECISA
que puedas justificar (p. ej. Algebra → 512, Topology → 515.1, Number theory → 511, Cryptography → 003.26; una
revista de historia → 94, de fotografía → 77, de dibujo e ilustración → 741). Si no basta para precisar, da la
división (p. ej. 51) — nunca inventes precisión.
MUY IMPORTANTE: notación CDU, NO Dewey. Se parecen y se confunden sobre todo en HISTORIA:
- En la CDU las divisiones 95, 96, 97, 98 y 99 NO EXISTEN (están vacías). «97» o «973» son Dewey.
- La historia de un lugar es 94 con auxiliar de lugar entre paréntesis: 94(410) Gran Bretaña, 94(73) Estados
  Unidos, 94(7) América, 94(51) China. NUNCA 941, 973 ni 951, que son Dewey.

Da «confianza» entre 0 y 1: baja cuando dudes entre dos tipos. Sé honesto: una carpeta que es decisión del
usuario (¿quiere conservar «University Press Collection» como colección?) debe llevar confianza baja.
Pon «razon» SOLO cuando la confianza sea menor que 0.6 (una frase); en las demás, «razon»: null. Así la
respuesta cabe entera aunque el árbol sea grande.

${trozo ? `MAPA COMPLETO DEL ÁRBOL (solo para que seas COHERENTE; NO interpretes estas carpetas, las verá otra
tanda). Las carpetas HERMANAS con el mismo patrón deben recibir el MISMO tipo, estén o no en tu tanda:
${mapaArbol(esq)}

` : ''}Árbol «${esq.raiz}»${esq.recortado ? ' (RECORTADO: solo ves una parte)' : ''}${trozo ? ` — TANDA ${trozo.n} de ${trozo.de}: interpreta SOLO estas ${carpetas.length} carpetas; cada una lleva su ruta COMPLETA desde la raíz` : ''}:
${lineas}

Responde SOLO con JSON, sin texto alrededor. «periodicidad» y «anio» solo en las de contenido revistas (en las
demás, null):
{"carpetas":[{"ruta":"…","tipo":"${TIPOS.join('|')}","contenido":"${CONTENIDOS.join('|')}|null","nombre_canonico":"…o null","cdu":"…o null","editorial":"…o null","periodicidad":"…o null","anio":0,"confianza":0.0,"razon":"…breve"}]}`;
}

/**
 * Pide a la IA la interpretación del árbol. UNA llamada. Devuelve { carpetas:[…] } alineado por `ruta` con el
 * esqueleto, o lanza si la IA no responde con JSON utilizable (mejor fallar a la vista que inventar).
 */
// Carpetas por llamada. Medido: 47 carpetas salieron en 41 s; 96 en una sola llamada acabaron en «fetch failed»
// (respuesta el doble de larga → tiempo de generación que corta la conexión). Troceando, cada llamada queda en
// terreno probado y un árbol de cientos de carpetas sigue siendo posible.
const CARPETAS_POR_LLAMADA = 50;

/**
 * Pide a la IA la interpretación del árbol. Una llamada si cabe; si no, varias TANDAS consecutivas en orden de
 * recorrido (que agrupa cada subárbol) — la ruta completa de cada carpeta conserva el contexto jerárquico.
 * Devuelve { carpetas, descartadas, aviso, llamadas }.
 */
export async function interpretarEstructura(esq, { esperasReintento = [20000, 45000] } = {}) {
    // `esperasReintento`: el CLI reintenta con paciencia (alguien está mirando y quiere el resultado). La
    // inspección automática del vigilante pasa UNA espera corta: tiene su propio reintento de fondo (cada 15 min) y,
    // mientras espera aquí, el vigilante no atiende las demás carpetas del Inbox.
    const tandas = [];
    for (let i = 0; i < esq.carpetas.length; i += CARPETAS_POR_LLAMADA) tandas.push(esq.carpetas.slice(i, i + CARPETAS_POR_LLAMADA));

    const carpetas = [], descartadas = [], fallidas = [];
    for (let n = 0; n < tandas.length; n++) {
        const trozo = tandas.length > 1 ? { n: n + 1, de: tandas.length } : null;
        // Pausa entre tandas: dos llamadas largas seguidas contra la misma clave acaban cortadas (medido: la
        // 1.ª tanda salió en 51 s y la 2.ª, lanzada justo detrás, falló con error de red).
        if (n > 0) await esperar(PAUSA_ENTRE_TANDAS_MS);
        try {
            const r = await conReintentos(() => interpretarTanda(esq, tandas[n], trozo), esperasReintento);
            carpetas.push(...r.carpetas);
            descartadas.push(...r.descartadas);
        } catch (e) {
            // Una tanda perdida NO se lleva por delante a las demás: lo obtenido se conserva y se avisa de lo que
            // falta. Antes, una excepción en la 2.ª tanda tiraba también los resultados buenos de la 1.ª.
            fallidas.push({ tanda: n + 1, carpetas: tandas[n].length, motivo: e.message });
        }
    }

    // Respuesta INCOMPLETA: se avisa en vez de devolver un resultado a medias como si fuera bueno. Es el fallo
    // que se escapó la primera vez: 0 carpetas interpretadas y ni un error — parecía que la IA no sabía nada.
    const avisos = [];
    if (fallidas.length) {
        avisos.push(`${fallidas.length} de ${tandas.length} tanda(s) fallaron tras reintentar (${fallidas.reduce((s, f) => s + f.carpetas, 0)} carpetas sin interpretar): ${fallidas[0].motivo}`);
    }
    const cubiertas = carpetas.length / Math.max(esq.carpetas.length, 1);
    if (!fallidas.length && cubiertas < 0.5) {
        avisos.push(`La IA solo interpretó ${carpetas.length} de ${esq.carpetas.length} carpetas: respuesta probablemente TRUNCADA o incompleta.`);
    }
    if (!carpetas.length && fallidas.length) throw new Error(avisos[0]);   // nada que enseñar: fallo a la vista
    return { carpetas, descartadas, aviso: avisos.join(' ') || null, llamadas: tandas.length, fallidas };
}

const PAUSA_ENTRE_TANDAS_MS = 8000;
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Reintenta una llamada que falla por causas PASAJERAS (cuota, error de red, respuesta cortada), con espera
 * creciente. Con los proveedores actuales —gratuitos con la cuota agotada y la clave de pago cortando alguna
 * conexión— un solo intento deja árboles a medias; tres con espera los completan casi siempre.
 */
async function conReintentos(fn, esperas = [20000, 45000]) {
    let ultimo;
    for (let i = 0; i <= esperas.length; i++) {
        try { return await fn(); } catch (e) {
            ultimo = e;
            if (i < esperas.length) {
                console.warn(`   ↻ tanda fallida (${String(e.message).slice(0, 80)}); reintento en ${esperas[i] / 1000} s…`);
                await esperar(esperas[i]);
            }
        }
    }
    throw ultimo;
}

async function interpretarTanda(esq, carpetasTanda, trozo) {
    // maxTokens AMPLIO a propósito: en Gemini 2.5 el razonamiento previo CUENTA dentro del límite de salida.
    // Con 8.000, un árbol de 47 carpetas se comía el presupuesto pensando y el JSON salía truncado — y la
    // primera prueba devolvió una lista VACÍA sin ningún error.
    const txt = await conTexto({ prompt: construirPrompt(esq, carpetasTanda, trozo), json: true, maxTokens: 32000 });
    const r = extraerJSON(txt);
    if (!r || !Array.isArray(r.carpetas)) throw new Error(`La IA no devolvió una interpretación con el formato esperado${trozo ? ` (tanda ${trozo.n})` : ''}.`);

    // Solo se aceptan carpetas que EXISTEN en el esqueleto y tipos conocidos: una ruta inventada o un tipo
    // raro se descartan en lugar de colarse en la propuesta. Pero la ruta se NORMALIZA antes de comparar,
    // porque la IA la devuelve con variantes inocentes: copia los corchetes con que el prompt las presenta
    // («[Algebra]»), antepone el nombre de la raíz («Collection…/Algebra»), añade «/» final o usa «\».
    // En la primera prueba real, sin esta normalización, se descartaron las 47 carpetas.
    const validas = new Set(carpetasTanda.map((c) => c.ruta));
    const raizNorm = esq.raiz.toLowerCase();
    const normalizarRuta = (rt) => {
        let s = String(rt || '').trim().replace(/^\[|\]$/g, '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim();
        if (s.toLowerCase() === raizNorm || s === '') return '.';
        if (s.toLowerCase().startsWith(raizNorm + '/')) s = s.slice(raizNorm.length + 1);
        return s;
    };

    const aceptadas = [], descartadas = [];
    for (const c of r.carpetas) {
        if (!c) continue;
        const ruta = normalizarRuta(c.ruta);
        // Confusión de CAMPOS: a veces la IA pone el contenido en «tipo» («tipo: software», «tipo:
        // libro-desglosado»). Medido: así se descartaban justo el programa y el libro desglosado del árbol. Si el
        // «tipo» no es un tipo pero sí un contenido válido, se recoloca: esa carpeta es UNA cosa (obra) con ese contenido.
        if (!TIPOS.includes(c.tipo) && CONTENIDOS.includes(c.tipo)) {
            c.contenido = c.contenido && CONTENIDOS.includes(c.contenido) ? c.contenido : c.tipo;
            c.tipo = 'obra';
        }
        if (validas.has(ruta) && TIPOS.includes(c.tipo)) {
            // El CONTENIDO es un dato más, no la llave de la carpeta: uno desconocido se anula (queda la regla por
            // defecto para esa parte) en vez de tirar también el tipo, que sí era válido.
            const contenido = CONTENIDOS.includes(c.contenido) ? c.contenido : null;
            const anio = Number.isInteger(Number(c.anio)) && Number(c.anio) >= 1800 && Number(c.anio) <= 2100 ? Number(c.anio) : null;
            aceptadas.push({
                ...c, ruta, contenido,
                periodicidad: contenido === 'revistas' && PERIODICIDADES.includes(c.periodicidad) ? c.periodicidad : null,
                anio: contenido === 'revistas' ? anio : null,
                confianza: Math.max(0, Math.min(1, Number(c.confianza) || 0)),
            });
        } else {
            descartadas.push({ ruta: c.ruta, tipo: c.tipo });   // se devuelven para poder VER qué no casó
        }
    }
    return { carpetas: aceptadas, descartadas };
}
