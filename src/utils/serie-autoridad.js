/**
 * SERIE EDITORIAL POR AUTORIDAD — qué serie dicen el Fichero (series.db) y Crossref (crossref.db) que tiene un libro,
 * y si dos nombres de colección son la MISMA serie aunque estén escritos distinto.
 *
 * Regla del usuario para las colecciones (1-oct): manda la MANUAL, luego la EDITORIAL (la que dice la autoridad por el
 * ISBN) y por último la de la INGESTA (nombre de carpeta). Este módulo da las dos piezas para aplicarla:
 *   · seriesDeAutoridad(isbn)  → las series del libro según series.db y crossref.db (sin red, sin IA).
 *   · mismaSerie(a, b)         → «Oxford.Very Short Introduction» = «Very short introductions»;
 *                                «Osprey Men at Arms» = «Men-at-arms series»; «Valdemar: Gótica» = «Colección gótica n».
 *   · esSerieEditorial(nombre) → ¿existe una serie con ese nombre en el Fichero o en Crossref? (no es una carpeta).
 *
 * Consumidores: scripts/reorganizar-colecciones.js y la ingesta (motor-enriquecimiento: la serie de la autoridad
 * gana a la colección de carpeta).
 */
import { seriesDeISBN, buscarSeries, disponible as seriesDisponible } from './buscador-series.js';
import { libroCrossrefLocal, seriesCrossrefPorNombre, crossrefLocalDisponible } from './crossref-local.js';
import { limpiarNombreColeccion } from './colecciones.js';
import { tituloComparable, mismoLibroHolgado } from './titulo-libro.js';

// Palabras que no distinguen una serie de otra («Colección», «Series», «the», «de»…). «Biblioteca» se queda:
// «Biblioteca Oro» y «Oro» no son lo mismo.
const VACIAS = new Set([
    'coleccion', 'collection', 'coll', 'col', 'serie', 'series', 'collana', 'reihe', 'coleccio',
    'the', 'a', 'an', 'of', 'and', 'in', 'on', 'for', 'to', 'la', 'el', 'los', 'las', 'de', 'del', 'y', 'e', 'en',
    'le', 'les', 'des', 'du', 'et', 'der', 'die', 'das', 'und', 'von', 'n', 'no', 'nº', 'vol', 'volumen',
]);

// Palabras de MATERIA o de género: una «serie» hecha solo de ellas («Historia», «Narrativa», «English Literature»,
// «Cinema») no identifica una colección editorial — muchas editoriales tienen una «Historia» — ni una carpeta así lo es.
const GENERICAS = new Set([
    'historia', 'history', 'narrativa', 'narrative', 'ensayo', 'essay', 'essai', 'literatura', 'literature', 'novela',
    'novel', 'poesia', 'poetry', 'teatro', 'theatre', 'theater', 'ficcion', 'fiction', 'nonfiction', 'non', 'biblioteca',
    'library', 'clasico', 'classic', 'classique', 'contemporanea', 'contemporary', 'bolsillo', 'ciencia', 'science',
    'arte', 'art', 'filosofia', 'philosophy', 'cronica', 'biografia', 'biography', 'memoria', 'general', 'divulgacion',
    'mayor', 'menor', 'negra', 'policiaca', 'infantil', 'juvenil', 'obra', 'completa', 'texto', 'text', 'estudio',
    'studie', 'study', 'cinema', 'cine', 'film', 'music', 'musica', 'english', 'spanish', 'ancient', 'social',
    'quimica', 'chemistry', 'calculo', 'calculus', 'matematica', 'mathematic', 'fisica', 'physic', 'encyclopedia',
    'enciclopedia', 'cookbook', 'recipe', 'politica', 'politic', 'economia', 'economic', 'religion', 'psicologia',
    'psychology', 'derecho', 'law', 'medicina', 'medicine', 'educacion', 'education', 'book', 'libro', 'ebook',
    'otro', 'other', 'varios', 'various', 'misc', 'nueva', 'new', 'serie', 'mundo', 'world', 'universal', 'bestseller',
]);

/** ¿El nombre está hecho solo de palabras de materia o de género? («Historia», «English Literature»). */
export function esNombreGenerico(nombre) {
    const p = palabrasDeSerie(nombre);
    return !p.size || [...p].every((x) => GENERICAS.has(x));
}

/**
 * ¿Son el MISMO nombre de serie, admitiendo solo que uno lleve además el nombre de la EDITORIAL? Más estricto que
 * mismaSerie (que acepta una subserie dentro de su serie): para FUNDIR colecciones. «Valdemar: Gótica» ≡ «Gótica»
 * (Valdemar); «Osprey Men at Arms» ≡ «Men-at-Arms Series» (Osprey); «Breve historia: Conflictos» ≢ «Breve historia».
 */
export function mismoNombreDeSerie(a, b, { editoriales = [] } = {}) {
    const pe = new Set(editoriales.flatMap((e) => [...palabrasDeSerie(e)]));
    const quitar = (s) => new Set([...palabrasDeSerie(s)].filter((p) => !pe.has(p)));
    const pa = quitar(a);
    const pb = quitar(b);
    if (!pa.size || pa.size !== pb.size) return false;
    return [...pa].every((p) => pb.has(p));
}

/** Palabras significativas de un nombre de serie, sin acentos, sin plurales simples y sin las genéricas. */
export function palabrasDeSerie(nombre) {
    const base = String(limpiarNombreColeccion(nombre) || nombre || '')
        .toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[™®©]/g, '')
        .replace(/&/g, ' and ')
        .replace(/[^a-z0-9]+/g, ' ');
    const palabras = base.split(' ')
        .filter((p) => p.length >= 2 && !VACIAS.has(p) && !/^\d+$/.test(p))
        .map((p) => (p.length > 4 && p.endsWith('s') ? p.slice(0, -1) : p));   // introductions → introduction
    return new Set(palabras);
}

/**
 * ¿Son la misma serie? Lo son si las palabras de una están TODAS en la otra (una lleva además la editorial, el
 * nombre del grupo o un número: «Osprey Men at Arms» ⊇ «Men-at-arms»), y la más corta tiene alguna palabra con
 * cuerpo (4+ letras), para que «Social» no case con cualquier cosa que lleve «social».
 */
export function mismaSerie(a, b) {
    const pa = palabrasDeSerie(a);
    const pb = palabrasDeSerie(b);
    if (!pa.size || !pb.size) return false;
    if (pa.size === pb.size && [...pa].every((p) => pb.has(p))) return true;   // «Use R!» = «Use R!»
    const [menor, mayor] = pa.size <= pb.size ? [pa, pb] : [pb, pa];
    if (![...menor].some((p) => p.length >= 4)) return false;
    // Una sola palabra frente a un nombre largo es demasiado poco («Science» ⊂ «Popular Science Library»), salvo
    // que el largo solo añada una palabra (la editorial: «Valdemar: Gótica» ⊇ «Gótica»).
    if (menor.size === 1 && mayor.size > 2) return false;
    return [...menor].every((p) => mayor.has(p));
}

/**
 * ¿El título que la autoridad tiene para ese ISBN es el del libro? Holgado (subtítulos, artículos, grafías), pero
 * evita lo medido el 1-oct: el ISBN de relleno 978-1-2131-4151-3, compartido por decenas de libros distintos («The Tao
 * of Physics», «Dermatology»…), los metía a todos en la serie «Ungifted» (el libro que de verdad lleva ese ISBN).
 * Sin uno de los dos títulos no se puede juzgar: vale.
 */
export function tituloCompatible(a, b) {
    if (!a || !b) return true;
    if (mismoLibroHolgado(a, b)) return true;
    const palabras = (t) => new Set(String(tituloComparable(t) || '').split(' ').filter((w) => w.length > 3));
    const A = palabras(a);
    const B = palabras(b);
    if (!A.size || !B.size) return true;
    const [corto, largo] = A.size <= B.size ? [A, B] : [B, A];
    return [...corto].filter((w) => largo.has(w)).length / corto.size >= 0.5;
}

/**
 * Las series del libro según la autoridad: [{ nombre, numero, issn, registros, fuente }]. `registros` = cuántos
 * libros conoce el Fichero de esa serie (una «serie» de 1 registro suele ser ruido de catalogación). Con `titulo`, solo
 * las de registros cuyo título es el del libro (un ISBN equivocado o de relleno no arrastra la serie de otro libro).
 */
export function seriesDeAutoridad(isbn, { titulo = null } = {}) {
    const out = [];
    if (!isbn) return out;
    if (seriesDisponible()) {
        for (const s of seriesDeISBN(isbn)) {
            if (titulo && !tituloCompatible(titulo, s.titulo_libro)) continue;
            out.push({ nombre: limpiarNombreColeccion(s.nombre), numero: s.numero || null, issn: s.issn || null, registros: s.n || 0, fuente: 'fichero' });
        }
    }
    if (crossrefLocalDisponible()) {
        const c = libroCrossrefLocal([isbn]);
        if (c?.coleccion_nombre && (!titulo || tituloCompatible(titulo, c.titulo))) {
            out.push({ nombre: limpiarNombreColeccion(c.coleccion_nombre), numero: c.coleccion_numero || null, issn: c.coleccion_issn || null, registros: 0, fuente: 'crossref' });
        }
    }
    // Fuera las «series» que son ruido de catalogación: nombres de fichero («Untitled-9», hay una así en Crossref).
    return out.filter((s) => s.nombre && palabrasDeSerie(s.nombre).size && !RE_NOMBRE_BASURA.test(s.nombre));
}

const RE_NOMBRE_BASURA = new RegExp(String.raw`(untitled|^author:|^\d+$|_|\.pdf\b|\bebooks?\b)`, 'i');

/** Una serie de la autoridad es fiable si tiene ISSN o el Fichero le conoce 3+ libros. */
export const serieFiable = (s) => !!s && (!!s.issn || s.registros >= 3) && !esNombreGenerico(s.nombre);

/**
 * La serie que se adopta de entre las de la autoridad: la que case con `actual` (si se da), si no la que tenga ISSN,
 * si no la más nutrida. Solo fiables. Varias series que son la misma (Fichero + Crossref) se juntan: el nombre de
 * Crossref (bien escrito, con mayúsculas) y el número y los registros del Fichero.
 */
export function elegirSerie(series, actual = null) {
    const fiables = series.filter(serieFiable);
    if (!fiables.length) return null;
    if (actual) {
        const casa = fiables.find((s) => mismaSerie(s.nombre, actual));
        if (casa) return casa;
    }
    const orden = [...fiables].sort((a, b) => (!!b.issn - !!a.issn) || (b.registros - a.registros));
    const elegida = { ...orden[0] };
    for (const s of series) {
        if (s === orden[0] || !mismaSerie(s.nombre, elegida.nombre)) continue;
        if (s.fuente === 'crossref') elegida.nombre = s.nombre;
        elegida.issn = elegida.issn || s.issn;
        elegida.numero = elegida.numero || s.numero;
        elegida.registros = Math.max(elegida.registros, s.registros);
    }
    return elegida;
}

/**
 * ¿Hay una serie EDITORIAL con ese nombre en el Fichero o en Crossref? Distingue una colección de verdad (aunque
 * de ella solo tengamos un libro) de una carpeta. Con `editorial`, también se prueba el nombre sin ella
 * («Valdemar: Gótica» → «Gótica»).
 */
export function esSerieEditorial(nombre, { editorial = null } = {}) {
    const intentos = [nombre];
    if (editorial) {
        const sinEditorial = [...palabrasDeSerie(nombre)].filter((p) => !palabrasDeSerie(editorial).has(p)).join(' ');
        if (sinEditorial && sinEditorial !== [...palabrasDeSerie(nombre)].join(' ')) intentos.push(sinEditorial);
    }
    for (const texto of intentos) {
        if (crossrefLocalDisponible() && seriesCrossrefPorNombre(texto).length) return true;
        if (seriesDisponible()) {
            // Por sus palabras significativas: «Ancora & Delfin» busca «ancora delfin», no «ancora and delfin»
            // (la serie se llama «Áncora y delfín» y el «and» no está).
            const candidatas = buscarSeries([...palabrasDeSerie(texto)].join(' ') || texto, { limite: 10 });
            if (candidatas.some((s) => s.n >= 3 && mismaSerie(s.nombre, nombre))) return true;
            if (texto !== nombre && candidatas.some((s) => s.n >= 3 && mismaSerie(s.nombre, texto))) return true;
        }
    }
    return false;
}
