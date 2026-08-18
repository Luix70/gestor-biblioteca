/**
 * Re-enriquecimiento de UN documento desde la ficha del panel ("Enriquecedor"): vuelve a consultar las
 * fuentes (Fichero local → OpenLibrary/Google Books → …) con el ISBN como ancla y MEJORA el registro.
 *
 * Dos modos según la fiabilidad del identificador:
 *   · ANCLADO POR ISBN (el doc tiene un ISBN VÁLIDO que resuelve en una autoridad, y el ISBN resuelto
 *     coincide con el del doc): el ISBN identifica la EDICIÓN sin ambigüedad, así que aplicamos el
 *     título, los autores, la editorial y la colección/serie AUTORITATIVOS (sobrescriben lo que hubiera),
 *     salvo que ya coincidan (comparación tolerante → sin cambios espurios). Este es el modo que arregla
 *     los libros mal catalogados cuyo título quedó como el sello ("Osprey") y cuyos "autores" eran en
 *     realidad la colección/nº ("Men at Arms 058") o el propio título ("The Landsknechts").
 *   · CONSERVADOR (sin ISBN fiable): como siempre — solo rellena HUECOS y solo SOBRESCRIBE
 *     título/autor/editorial si el actual es BASURA (nombre de archivo, identificador, "código").
 *
 * En ningún caso toca el fichero físico. Cada cambio se registra en `cambios` (se muestra en la ficha) y
 * se deja un rastro permanente con los valores anteriores en `alertas_agente` (auditoría, nunca se pierde
 * el dato de partida). Si cambia el título o faltaba la CDU, des-sella `re-clasificar-cdu` para que el
 * Conformador re-clasifique y mueva la carpeta con el dato ya bueno.
 *
 * Devuelve { ok, cambios:[{campo,de,a}], reclasificar } o { ok:false, motivo }.
 * Comparte criterio con scripts/re-enriquecer-degradados.js.
 */
import { buscarMetadatosExternos } from './proveedor-metadatos.js';
import { resolverColeccion } from './colecciones.js';
import { variantesISBN, validarISBN, validarISSN } from './identificadores.js';

const norm = (s) => String(s || '').toLowerCase().replace(/\.[^.]+$/, '').replace(/[^a-z0-9]/g, '');

// CDU «pobre»: ausente o el cajón de sastre 000/00/0 (mismo criterio que mantenimiento/tareas.js). Un doc con
// CDU pobre pero con Dewey/LCC disponibles debe re-clasificarse (355.3 → 355, determinista y gratis).
const cduPobre = (c) => !c || ['0', '00', '000'].includes(String(c).trim());

// Normalización TOLERANTE para comparar textos sin churn (minúsculas, sin acentos ni puntuación, espacios
// colapsados). Mismo criterio que utils/buscador-local.js, para que "casar" signifique lo mismo en todo el sistema.
const RE_DIACR = new RegExp('[\\u0300-\\u036f]', 'g');
const normTexto = (s) => String(s || '').toLowerCase().normalize('NFD').replace(RE_DIACR, '')
    .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// ¿Casan dos textos? ≥60% de los tokens (≥3 letras) del más corto están en el otro (subconjunto tolerante).
function textoCasa(a, b) {
    const ta = new Set(normTexto(a).split(' ').filter((t) => t.length >= 3));
    const tb = new Set(normTexto(b).split(' ').filter((t) => t.length >= 3));
    if (!ta.size || !tb.size) return false;
    const [chico, grande] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
    let inter = 0;
    for (const t of chico) if (grande.has(t)) inter++;
    return inter / chico.size >= 0.6;
}

// ¿Son los títulos MANIFIESTAMENTE distintos? (criterio para FORZAR el título autoritativo con ancla de ISBN).
// No fuerza por un plural, un subtítulo o una variante menor: solo cuando ni uno contiene al otro ni comparten
// tokens. Así "Osprey" → "The Landsknechts" SÍ (nada en común), pero "The Landsknecht(s)" o "Título: subtítulo"
// NO se tocan. Con el título actual vacío/basura se decide aparte (ahí sí se rellena).
function titulosManifiestamenteDistintos(actual, nuevo) {
    const a = normTexto(actual), b = normTexto(nuevo);
    if (!a || !b || a === b) return false;
    if (a.includes(b) || b.includes(a)) return false;   // uno contenido en el otro (subtítulo, plural, "… series")
    return !textoCasa(actual, nuevo);                    // sin solapamiento de tokens → manifiestamente distinto
}

// ¿Son EQUIVALENTES dos listas de nombres (autores)? Mismo número y cada uno con pareja tolerante en la otra
// (insensible a acentos, grafía y orden). Así "García Márquez" == "Garcia Marquez" y no reescribimos autores iguales.
function mismosNombres(a = [], b = []) {
    const A = a.map(normTexto).filter(Boolean);
    const B = b.map(normTexto).filter(Boolean);
    if (A.length !== B.length) return false;
    if (!A.length) return true;
    const usados = new Array(B.length).fill(false);
    for (const x of A) {
        const j = B.findIndex((y, i) => !usados[i] && (y === x || textoCasa(x, y)));
        if (j < 0) return false;
        usados[j] = true;
    }
    return true;
}

// ¿Dos ISBN son el mismo (comparando sus variantes 10/13)?
function mismoISBN(a, b) {
    if (!a || !b) return false;
    const va = new Set(variantesISBN(a));
    return variantesISBN(b).some((v) => va.has(v));
}

/** ¿El título es en realidad basura (nombre de archivo, identificador o un código)? */
function tituloNoFiable(doc) {
    const t = doc.titulo || '';
    if (!t.trim()) return true;
    if (validarISBN(t) || validarISSN(t)) return true;
    if (doc.nombre_archivo && norm(t) === norm(doc.nombre_archivo)) return true;
    if (!/\s/.test(t) && /\d/.test(t) && /[_\-.]/.test(t) && t.length > 8) return true;
    return false;
}

async function resolverAutores(db, nombres) {
    const out = [];
    for (const n of nombres) {
        const ex = await db.collection('autores').findOne({ nombre: n });
        out.push(ex ? ex._id : (await db.collection('autores').insertOne({ nombre: n })).insertedId);
    }
    return out;
}
async function resolverEditorial(db, nombre) {
    const ex = await db.collection('editoriales').findOne({ nombre });
    return ex ? ex._id : (await db.collection('editoriales').insertOne({ nombre })).insertedId;
}

/** Nombres de los autores ACTUALES del doc (doc.autores = ObjectId[]), preservando su orden. */
async function nombresAutoresActuales(db, doc) {
    if (!Array.isArray(doc.autores) || !doc.autores.length) return [];
    const filas = await db.collection('autores').find({ _id: { $in: doc.autores } }).project({ nombre: 1 }).toArray();
    const porId = new Map(filas.map((a) => [String(a._id), a.nombre]));
    return doc.autores.map((id) => porId.get(String(id))).filter(Boolean);
}

/** Nombre de la editorial ACTUAL del doc (sea ObjectId o, en datos antiguos, una cadena). */
async function nombreEditorialActual(db, doc) {
    if (!doc.editorial) return '';
    if (typeof doc.editorial === 'string') return doc.editorial;
    const e = await db.collection('editoriales').findOne({ _id: doc.editorial }, { projection: { nombre: 1 } });
    return e?.nombre || '';
}

export async function reenriquecerDoc(db, doc, { aplicar = true, sinIA = false } = {}) {
    const col = db.collection('biblioteca');
    const isbnValido = doc.isbn && validarISBN(doc.isbn);
    const isbnVar = isbnValido ? variantesISBN(doc.isbn) : [];

    let datos;
    try {
        // `sinIA` (opción del usuario): la ÚNICA IA que puede gastar el enriquecimiento es clasificar la CDU por
        // TEXTO cuando el Fichero/crosswalk determinista no la resuelven. Con sinIA=true no se permite → gratis.
        datos = await buscarMetadatosExternos(doc.titulo || '', '', null, {
            incluirSinopsis: !doc.sinopsis, incluirCdu: !doc.cdu, isbnsArchivo: isbnVar, idioma: doc.idioma || null, sinIA,
        });
    } catch (e) { return { ok: false, motivo: `la consulta a las fuentes falló: ${e.message}` }; }

    // ANCLA POR ISBN: la autoridad devolvió título Y el ISBN que resolvió coincide con el del doc → los datos
    // son de la EDICIÓN exacta (no de una coincidencia por título) y podemos aplicarlos como autoritativos.
    const anclaISBN = isbnValido && !!datos.titulo && mismoISBN(doc.isbn, datos.isbn);
    const garbage = tituloNoFiable(doc);

    // Estado actual (para comparar sin churn y para dejar constancia del valor anterior en el diff/auditoría).
    const autoresActuales = await nombresAutoresActuales(db, doc);
    const editorialActual = await nombreEditorialActual(db, doc);

    const set = {};
    const cambios = [];
    const anota = (campo, de, a) => cambios.push({ campo, de: de ?? null, a });

    // ── Título / autores / editorial ──
    // Con ancla: aplica el AUTORITATIVO si el actual es basura O manifiestamente distinto (no por un plural/subtítulo).
    // Sin ancla: solo si el actual es basura.
    const forzarTitulo = anclaISBN
        ? (garbage || titulosManifiestamenteDistintos(doc.titulo, datos.titulo))
        : (garbage && datos.titulo !== doc.titulo);
    if (datos.titulo && forzarTitulo) { set.titulo = datos.titulo; anota('titulo', doc.titulo, datos.titulo); }
    if (datos.autores?.length && (anclaISBN ? !mismosNombres(autoresActuales, datos.autores) : garbage)) {
        set.autores = await resolverAutores(db, datos.autores);
        anota('autores', autoresActuales.join(', ') || null, datos.autores.join(', '));
    }
    if (datos.editorial && (anclaISBN ? !textoCasa(editorialActual, datos.editorial) : garbage)) {
        set.editorial = await resolverEditorial(db, datos.editorial);
        anota('editorial', editorialActual || null, datos.editorial);
    }

    // ── Colección / serie ── con ancla: la de la AUTORIDAD manda: se FUERZA si difiere del nombre actual
    // (aunque se parezca — p. ej. "Osprey Men at Arms" → "Men-at-arms series"), no solo si falta. Sin ancla:
    // comportamiento conservador, solo rellena hueco.
    const forzarColeccion = anclaISBN
        ? normTexto(doc.coleccion_nombre) !== normTexto(datos.coleccion_nombre)
        : !doc.coleccion;
    if (datos.coleccion_nombre && forzarColeccion) {
        const edId = set.editorial || (typeof doc.editorial !== 'string' ? doc.editorial : null);
        const { _id } = await resolverColeccion(db, datos.coleccion_nombre, edId);
        set.coleccion = _id; set.coleccion_nombre = datos.coleccion_nombre;
        if (datos.coleccion_numero) set.coleccion_numero = String(datos.coleccion_numero);
        anota('coleccion', doc.coleccion_nombre || null, datos.coleccion_nombre);
    }

    // ── Huecos puros (solo si faltan) ──
    if (datos.sinopsis && !doc.sinopsis) { set.sinopsis = datos.sinopsis; anota('sinopsis', null, '(añadida)'); }
    if (datos.año_edicion && !doc.año_edicion) { set.año_edicion = datos.año_edicion; anota('año_edicion', null, datos.año_edicion); }
    if (datos.idioma && !doc.idioma) { set.idioma = datos.idioma; anota('idioma', null, datos.idioma); }
    if (datos.categorias?.length && !(doc.palabras_clave?.length)) { set.palabras_clave = datos.categorias; anota('palabras_clave', null, datos.categorias.join(', ')); }
    if (datos.dewey && !doc.dewey) { set.dewey = datos.dewey; anota('dewey', null, datos.dewey); }
    if (datos.lcc && !doc.lcc) { set.lcc = datos.lcc; anota('lcc', null, datos.lcc); }
    // Paginación / dimensiones del registro MARC (BNE/OL): dato físico útil, rellena hueco.
    if (datos.paginas_bne && !doc.paginas) { set.paginas = datos.paginas_bne; anota('paginas', null, datos.paginas_bne); }
    if (datos.dimensiones_bne && !doc.dimensiones) { set.dimensiones = datos.dimensiones_bne; anota('dimensiones', null, datos.dimensiones_bne); }

    // Re-clasificar la CDU si cambió el título, o si la CDU es POBRE (000/00/0/ausente) y hay Dewey/LCC/CDU con
    // que deducir una buena. El Conformador (re-clasificar-cdu) la resuelve (Fichero→Dewey/LCC→…) y MUEVE la
    // carpeta al árbol nuevo. Incluye doc.dewey/doc.lcc: el 355.3 ya en el doc basta para sacar la CDU 355.
    const reclasificar = !!set.titulo
        || (cduPobre(doc.cdu) && !!(datos.cdu || datos.dewey || datos.lcc || set.dewey || set.lcc || doc.dewey || doc.lcc));

    if (Object.keys(set).length === 0 && !reclasificar) return { ok: true, cambios: [], resumen: 'sin mejora disponible' };

    if (reclasificar) {
        set['mantenimiento.re-clasificar-cdu'] = 0;
        set.mantenimiento_firma = 'pendiente-re-enriquecido';
    }
    set.fecha_actualizacion = new Date();
    // Rastro PERMANENTE con los valores anteriores → nunca se pierde el dato de partida (auditoría en el doc).
    const resumenCambios = cambios.map((c) => `${c.campo}: "${c.de ?? '∅'}"→"${c.a}"`).join(' · ');
    const nota = `Re-enriquecido manualmente${anclaISBN ? ' (autoritativo por ISBN)' : ''}` + (resumenCambios ? `: ${resumenCambios}.` : '.');
    set.alertas_agente = [...(doc.alertas_agente || []), nota];
    if (!aplicar) return { ok: true, cambios, reclasificar, anclaISBN, dryRun: true };
    await col.updateOne({ _id: doc._id }, { $set: set });
    return { ok: true, cambios, reclasificar, anclaISBN };
}
