/**
 * OBRAS PARTIDAS — una obra multivolumen catalogada como DOS (o más) obras: cada tomo deduce el título de la obra
 * de su carpeta / nombre de fichero, y basta una variante («Gale - Schlager - Science and Its Times» frente a
 * «Science and Its Times», «0521086914.Cambridge.University.Press.The.Cambridge.Ancient.History», «The Complete
 * Sherlock Holmes» / «Complete Sherlock Holmes») para que resolverObra no la reconozca y cree otra.
 *
 * Detector compartido por:
 *   · scripts/fusionar-obras-partidas.js — repara lo ya catalogado (fusiona los grupos SEGUROS, el resto a revisar);
 *   · la ingesta (obras.js·resolverObra → obraGemela) — antes de CREAR una obra, busca una con la misma clave de
 *     título donde el tomo encaja (gemelo de la reparación: que no vuelva a pasar).
 *
 * Comparar solo títulos da falsos positivos («Science», «Chemistry», «The Napoleonic Wars» son el final de muchos
 * títulos que no tienen nada que ver), así que un par es SEGURO solo si además:
 *   · sus tomos NO se solapan (cada número de tomo está en una sola de las dos);
 *   · no tienen isbn_obra distintos, ni un total de tomos distinto;
 *   · los corrobora la EDITORIAL (la misma) o el registrante del ISBN de sus tomos (mismos 9 primeros dígitos
 *     del ISBN-13) — la regla de siempre: nombre solo, nunca; nombre + identificador, sí;
 *   · si los títulos no son iguales sino uno el final del otro, el corto tiene al menos 3 palabras.
 * Lo que solo cumple el parecido de título va a «revisar» (selección), nunca se fusiona solo.
 */
import { isbn10a13, validarISBN } from './identificadores.js';

/** Clave de comparación del título de una obra: sin ISBN delante, sin puntos/guiones bajos de nombre de fichero,
 *  sin acentos ni mayúsculas, sin artículo inicial. «0521086914.Cambridge.University.Press.The.Cambridge.Ancient.History»
 *  → «cambridge university press the cambridge ancient history». */
export function claveTituloObra(titulo) {
    let t = String(titulo || '').replace(/[._]+/g, ' ');
    t = t.replace(/^\s*(97[89][\s-]?)?\d[\d\s-]{7,}[\dXx]\b\s*[-:]?\s*/, '');
    t = t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    t = t.replace(/[^a-z0-9]+/g, ' ').trim();
    return t.replace(/^(the|a|an|el|la|los|las|le|les|il|lo|der|die|das)\s+/, '');
}

const palabras = (clave) => (clave ? clave.split(' ').length : 0);
const RE_SERIE = /\b(library|series|collection|coleccion|biblioteca|studies in)\b/;

/** ¿Los títulos dicen que podría ser la misma obra? 'igual' | 'final' (uno es el final del otro) | null. */
export function parecidoTitulos(a, b) {
    const ka = claveTituloObra(a), kb = claveTituloObra(b);
    if (!ka || !kb) return null;
    if (ka === kb) return 'igual';
    const [larga, corta] = ka.length >= kb.length ? [ka, kb] : [kb, ka];
    if (corta.length >= 6 && larga.endsWith(' ' + corta)) return 'final';
    return null;
}

/** Registrante del ISBN (9 primeros dígitos del ISBN-13), o null. */
export function registranteISBN(isbn) {
    const v = validarISBN(isbn);
    if (!v) return null;
    const i13 = v.length === 13 ? v : isbn10a13(v);
    return i13 ? i13.slice(0, 9) : null;
}

/**
 * Juicio sobre un par de obras ya «parecidas» por título. Cada obra viene con sus datos resumidos:
 *   { _id, titulo, isbn_obra, total_volumenes, editoriales:Set<string>, registrantes:Set<string>, numeros:Set<number>, tomos:number }
 * Devuelve { clase: 'segura'|'revisar'|'distinta', motivo }.
 */
export function juzgarPar(a, b, parecido) {
    if (a.isbn_obra && b.isbn_obra && a.isbn_obra !== b.isbn_obra) return { clase: 'distinta', motivo: 'isbn_obra distintos' };
    const solape = [...a.numeros].filter((n) => b.numeros.has(n));
    if (solape.length) return { clase: 'revisar', motivo: `tomos repetidos (${solape.join(', ')})` };
    if (!a.tomos || !b.tomos) return { clase: 'revisar', motivo: 'una de las dos no tiene tomos' };
    // El total de tomos solo cuenta si es un dato CONOCIDO: el inventario lo sube al mayor tomo presente, así que
    // «total 1» en una obra que solo tiene el tomo 1 no dice nada (Encyclopedia of Toxicology: 1 / 2-3-4).
    const maxA = Math.max(0, ...a.numeros), maxB = Math.max(0, ...b.numeros);
    const totA = a.total_volumenes > maxA ? a.total_volumenes : null;
    const totB = b.total_volumenes > maxB ? b.total_volumenes : null;
    if ((totA && totB && totA !== totB) || (totA && maxB > totA) || (totB && maxA > totB)) {
        return { clase: 'revisar', motivo: `total de tomos distinto (${a.total_volumenes} / ${b.total_volumenes})` };
    }
    // Un nombre de SERIE no es una obra: los «tomos» de «The Loeb Classical Library» (2, 3, 199) son obras distintas
    // mal agrupadas, y juntarlas solo agranda el error.
    if (RE_SERIE.test(claveTituloObra(a.titulo)) || RE_SERIE.test(claveTituloObra(b.titulo))) {
        return { clase: 'revisar', motivo: 'el título parece una serie, no una obra' };
    }
    const misma = (x, y) => [...x].some((v) => y.has(v));
    const corrobora = misma(a.editoriales, b.editoriales) || misma(a.registrantes, b.registrantes);
    if (!corrobora) return { clase: 'revisar', motivo: 'ni la editorial ni el ISBN de los tomos lo confirman' };
    if (parecido === 'final') {
        const corta = Math.min(palabras(claveTituloObra(a.titulo)), palabras(claveTituloObra(b.titulo)));
        if (corta < 3) return { clase: 'revisar', motivo: 'título corto (menos de 3 palabras)' };
        // Lo que el título largo añade delante tiene que ser un NOMBRE de los tomos (editorial, autor, editor):
        // «Gale - Schlager - Science and Its Times», «Cassius Dio's Roman History», «Pausanias: Description of
        // Greece». Si no, es OTRO título que acaba igual: «Meshfree Methods for Partial Differential Equations»,
        // «U•X•L Encyclopedia of World Biography» (otra enciclopedia de la misma editorial).
        const [larga, cortaK] = [claveTituloObra(a.titulo), claveTituloObra(b.titulo)].sort((x, y) => y.length - x.length);
        const prefijo = larga.slice(0, larga.length - cortaK.length).trim().split(' ').filter((p) => p.length >= 3);
        const nombres = new Set([...a.nombres, ...b.nombres]);
        if (!prefijo.some((p) => nombres.has(p))) {
            return { clase: 'revisar', motivo: 'el título largo añade algo que no es un nombre de editorial ni de autor' };
        }
    }
    return { clase: 'segura', motivo: parecido === 'igual' ? 'mismo título' : 'un título es el final del otro (con editorial/autor delante)' };
}

/** Palabras (≥ 3 letras, normalizadas) de un nombre de editorial o autor. */
function palabrasDeNombre(nombre) {
    return claveTituloObra(nombre).split(' ').filter((p) => p.length >= 3);
}

/** Datos resumidos de TODAS las obras de libros (una consulta a obras + una agregación de tomos). */
export async function resumenObras(db) {
    const obras = await db.collection('obras')
        .find({ tipo: { $ne: 'revista' } })
        .project({ titulo: 1, titulos_alt: 1, isbn_obra: 1, editorial: 1, total_volumenes: 1, fecha_creacion: 1, cdu: 1 })
        .toArray();
    const tomos = await db.collection('biblioteca')
        .find({ obra: { $exists: true } })
        .project({ obra: 1, volumen_numero: 1, isbn: 1, editorial: 1, autores: 1 })
        .toArray();
    // Nombres de editoriales y autores (para corroborar lo que un título añade delante: «Gale - Schlager - …»).
    const idsEd = [...new Set([...obras.map((o) => o.editorial), ...tomos.map((t) => t.editorial)].filter(Boolean).map(String))];
    const idsAu = [...new Set(tomos.flatMap((t) => t.autores || []).filter(Boolean).map(String))];
    const nombreDe = new Map();
    const { ObjectId } = await import('mongodb');
    const aOid = (ids) => ids.filter((x) => ObjectId.isValid(x)).map((x) => new ObjectId(x));
    for (const e of await db.collection('editoriales').find({ _id: { $in: aOid(idsEd) } }).project({ nombre: 1 }).toArray()) nombreDe.set(String(e._id), e.nombre);
    for (const p of await db.collection('autores').find({ _id: { $in: aOid(idsAu) } }).project({ nombre: 1 }).toArray()) nombreDe.set(String(p._id), p.nombre);
    const porObra = new Map();
    for (const t of tomos) {
        const k = String(t.obra);
        if (!porObra.has(k)) porObra.set(k, []);
        porObra.get(k).push(t);
    }
    return obras.map((o) => {
        const suyos = porObra.get(String(o._id)) || [];
        const editoriales = new Set([o.editorial, ...suyos.map((t) => t.editorial)].filter(Boolean).map(String));
        const registrantes = new Set(suyos.map((t) => registranteISBN(t.isbn)).filter(Boolean));
        const numeros = new Set(suyos.map((t) => t.volumen_numero).filter((n) => Number.isFinite(n)));
        const nombres = new Set([...editoriales, ...suyos.flatMap((t) => (t.autores || []).map(String))]
            .flatMap((id) => palabrasDeNombre(nombreDe.get(id))));
        return { ...o, editoriales, registrantes, numeros, nombres, tomos: suyos.length, idsTomos: suyos.map((t) => t._id) };
    });
}

/** La obra que se CONSERVA en un grupo: la que tiene isbn_obra, si no la de más tomos, si no la más antigua. */
export function elegirDestino(grupo) {
    return [...grupo].sort((a, b) =>
        (!!b.isbn_obra - !!a.isbn_obra)
        || (b.tomos - a.tomos)
        || (new Date(a.fecha_creacion || 0) - new Date(b.fecha_creacion || 0)))[0];
}

/**
 * Agrupa las obras partidas. Une solo pares SEGUROS (y vuelve a comprobar el grupo entero: la unión es transitiva
 * y A~B, B~C no garantiza que A y C no compartan un número de tomo). Devuelve
 *   { seguros: [{ obras, destino, motivo }], revisar: [{ a, b, motivo }] }
 */
export async function gruposObrasPartidas(db, { alPaso = null } = {}) {
    const obras = await resumenObras(db);
    const padre = new Map(obras.map((o) => [String(o._id), String(o._id)]));
    const raiz = (k) => { while (padre.get(k) !== k) k = padre.get(k); return k; };
    const motivoDe = new Map();
    const revisar = [];
    const claves = obras.map((o) => [o.titulo, ...(o.titulos_alt || [])]);

    for (let i = 0; i < obras.length; i++) {
        alPaso?.(obras[i].titulo);
        for (let j = i + 1; j < obras.length; j++) {
            let parecido = null;
            for (const ta of claves[i]) {
                for (const tb of claves[j]) {
                    const p = parecidoTitulos(ta, tb);
                    if (p === 'igual') { parecido = 'igual'; break; }
                    if (p) parecido = p;
                }
                if (parecido === 'igual') break;
            }
            if (!parecido) continue;
            const juicio = juzgarPar(obras[i], obras[j], parecido);
            if (juicio.clase === 'segura') {
                const ra = raiz(String(obras[i]._id)), rb = raiz(String(obras[j]._id));
                if (ra !== rb) padre.set(rb, ra);
                motivoDe.set(ra, juicio.motivo);
            } else if (juicio.clase === 'revisar') {
                revisar.push({ a: obras[i], b: obras[j], motivo: juicio.motivo });
            }
        }
    }

    const grupos = new Map();
    for (const o of obras) {
        const r = raiz(String(o._id));
        if (!grupos.has(r)) grupos.set(r, []);
        grupos.get(r).push(o);
    }
    const seguros = [];
    for (const [r, g] of grupos) {
        if (g.length < 2) continue;
        // Comprobación del grupo entero: ningún número de tomo en dos obras, un solo isbn_obra.
        const vistos = new Set();
        let choca = false;
        for (const o of g) for (const n of o.numeros) { if (vistos.has(n)) choca = true; vistos.add(n); }
        const isbns = new Set(g.map((o) => o.isbn_obra).filter(Boolean));
        if (choca || isbns.size > 1) {
            for (let i = 1; i < g.length; i++) revisar.push({ a: g[0], b: g[i], motivo: 'grupo de 3+ obras con tomos repetidos o varios isbn_obra' });
            continue;
        }
        seguros.push({ obras: g, destino: elegirDestino(g), motivo: motivoDe.get(r) || '' });
    }
    return { seguros, revisar };
}

/**
 * GEMELO EN LA INGESTA: antes de crear una obra nueva, ¿hay una con la MISMA clave de título (no «el final de»:
 * aquí no hay tomos que comparar todavía) en la que este tomo encaje? Encaja si su número no está ocupado, la
 * editorial no contradice y el isbn_obra no contradice. Devuelve la obra o null. Solo se llama al ir a crear
 * (pocas veces), así que recorrer las obras es asumible.
 */
export async function obraGemela(db, { titulo, isbn_obra = null, editorialId = null, volumen = null }) {
    const clave = claveTituloObra(titulo);
    if (palabras(clave) < 2) return null;
    const candidatas = await db.collection('obras')
        .find({ tipo: { $ne: 'revista' } })
        .project({ titulo: 1, titulos_alt: 1, isbn_obra: 1, editorial: 1, volumenes: 1, cdu: 1 })
        .toArray();
    for (const o of candidatas) {
        const igual = [o.titulo, ...(o.titulos_alt || [])].some((t) => claveTituloObra(t) === clave);
        if (!igual) continue;
        if (isbn_obra && o.isbn_obra && o.isbn_obra !== isbn_obra) continue;
        if (editorialId && o.editorial && String(o.editorial) !== String(editorialId)) continue;
        if (Number.isFinite(volumen) && (o.volumenes || []).some((v) => v.numero === volumen && v._id)) continue;
        return o;
    }
    return null;
}
