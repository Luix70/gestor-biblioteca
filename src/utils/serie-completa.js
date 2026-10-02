/**
 * LA SERIE COMPLETA de una colección: todos los libros que la forman según la autoridad (Fichero/series.db, con su
 * número; Crossref/crossref.db, por el ISSN, sin número pero hasta hoy), marcando los que TIENES y dejando ver los
 * HUECOS. Sin red ni IA.
 *
 * Una «entrada» es un libro de la serie: { numero, titulo, anio, isbns:Set, ediciones, fuentes:Set }. Las ediciones de
 * un mismo número se juntan (y los registros sin número cuyo título es el de un número conocido son otra edición de
 * ese número), así que se tiene un libro de la serie si se tiene CUALQUIERA de sus ISBN (papel, ebook, otra edición).
 *
 * Consumidores: scripts/consultar-serie.js (consola) y GET /api/colecciones/:id/completa (panel: «👻 Ver colección
 * completa», con carátulas fantasma de los tomos que faltan, y «📋 Lista»).
 */
import { serie, librosDeSerie, buscarSeries, seriesDeISSN, seriesDeISBN, disponible as seriesDisponible } from './buscador-series.js';
import { crossrefLocalDisponible, librosDeSerieCrossrefLocal, seriesCrossrefPorNombre } from './crossref-local.js';
import { variantesISBN } from './identificadores.js';
import { ObjectId } from 'mongodb';
import { claveSerie } from './series-texto.js';
import { mismaSerie } from './serie-autoridad.js';

/** Título comparable: el mismo libro sale con grafías distintas («A course in arithmetic» / «course in arithmetic.»). */
export const claveTitulo = (t) => String(t || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/^\s*(a|an|the|el|la|los|las|le|les|der|die|das)\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();

const nueva = (titulo, anio, numero) => ({ numero, titulo, anio: anio || null, ediciones: 0, isbns: new Set(), fuentes: new Set() });
const anadir = (entrada, isbns, fuente) => {
    entrada.ediciones++;
    for (const x of isbns) for (const v of variantesISBN(x)) entrada.isbns.add(v);
    entrada.fuentes.add(fuente);
};

/**
 * ¿Qué serie de la autoridad es esta colección? En este orden: por su ISSN (la más nutrida del Fichero con ese ISSN);
 * por la serie que dicen los ISBN de SUS PROPIOS LIBROS (la mayoritaria, si la dicen 2+ y al menos un tercio de los
 * que tienen dato: «Post45» se llama «Post» en el Fichero, y «Valdemar: Gótica» no se parece a ningún nombre); y por
 * su nombre (exacto, o la mejor coincidencia que sea la misma serie y tenga 3+ libros). Devuelve { clave, issn } (clave
 * de series.db, o null si solo la conoce Crossref) o null.
 */
export function localizarSerie({ nombre = null, issn = null, isbnsMiembros = [] } = {}) {
    let clave = null;
    if (seriesDisponible()) {
        if (issn) clave = seriesDeISSN(issn)[0]?.clave || null;
        if (!clave && isbnsMiembros.length) {
            const votos = new Map();
            let conDato = 0;
            for (const isbn of isbnsMiembros) {
                const claves = new Set(seriesDeISBN(isbn).map((x) => x.clave));
                if (claves.size) conDato++;
                for (const k of claves) votos.set(k, (votos.get(k) || 0) + 1);
            }
            const [mejor, n] = [...votos.entries()].sort((a, b) => b[1] - a[1])[0] || [];
            if (mejor && n >= 2 && n / conDato >= 1 / 3) clave = mejor;
        }
        if (!clave && nombre) {
            const exacta = serie(claveSerie(nombre));
            if (exacta && exacta.n >= 2) clave = exacta.clave;
            else clave = buscarSeries(nombre, { limite: 10 }).find((s) => s.n >= 3 && mismaSerie(s.nombre, nombre))?.clave || null;
        }
    }
    let issnSerie = issn || (clave ? serie(clave)?.issn : null) || null;
    if (!issnSerie && nombre && crossrefLocalDisponible()) issnSerie = seriesCrossrefPorNombre(nombre)[0]?.issn || null;
    return clave || issnSerie ? { clave, issn: issnSerie } : null;
}

/**
 * Las entradas de una serie: { ficha, porNumero:Map(nº→entrada), sinNumero:Map(título→entrada),
 * soloCrossref:Map(título→entrada), reunidos, issn, registros, deCrossref }.
 */
export function entradasDeSerie({ clave = null, issn = null, editorial = null, conCrossref = true } = {}) {
    const ficha = clave ? serie(clave) : null;
    const libros = clave ? librosDeSerie(clave, { editorial }) : [];
    // Un número que llevan TODOS los libros de una editorial no es el de cada libro («Post 45» de Stanford): para esa
    // editorial se ignora la numeración. Se mira editorial a editorial (otras «Post» del Fichero sí tienen números).
    const numerosPorEditorial = new Map();
    for (const l of libros) {
        if (l.orden === null || l.orden === undefined) continue;
        const k = l.editorial || '';
        if (!numerosPorEditorial.has(k)) numerosPorEditorial.set(k, []);
        numerosPorEditorial.get(k).push(l.orden);
    }
    const editorialesConNumeroComun = new Set([...numerosPorEditorial].filter(([, ns]) => ns.length >= 3 && new Set(ns).size === 1).map(([k]) => k));
    const tieneNumero = (l) => l.orden !== null && l.orden !== undefined && !editorialesConNumeroComun.has(l.editorial || '');

    const porNumero = new Map();
    const sinNumero = new Map();
    for (const l of libros.filter(tieneNumero)) {
        if (!porNumero.has(l.orden)) porNumero.set(l.orden, nueva(l.titulo, l.anio, l.orden));
        anadir(porNumero.get(l.orden), [l.isbn], 'fichero');
    }
    // Título → número, solo si ese título es de UN solo número («Graph theory» es el 63, el 173 y el 244 de GTM).
    const numerosDeTitulo = new Map();
    for (const l of libros.filter(tieneNumero)) {
        const k = claveTitulo(l.titulo);
        if (!numerosDeTitulo.has(k)) numerosDeTitulo.set(k, new Set());
        numerosDeTitulo.get(k).add(l.orden);
    }
    const numeroUnico = (titulo) => {
        const s = numerosDeTitulo.get(claveTitulo(titulo));
        return s && s.size === 1 ? [...s][0] : null;
    };
    // Un registro SIN número con el título de un número conocido es otra edición de ese número.
    let reunidos = 0;
    for (const l of libros.filter((x) => !tieneNumero(x))) {
        const n = numeroUnico(l.titulo);
        if (n !== null) {
            anadir(porNumero.get(n), [l.isbn], 'fichero');
            reunidos++;
            continue;
        }
        const k = claveTitulo(l.titulo);
        if (!sinNumero.has(k)) sinNumero.set(k, nueva(l.titulo, l.anio, null));
        anadir(sinNumero.get(k), [l.isbn], 'fichero');
    }

    // CROSSREF por el ISSN: sin número, pero con títulos e ISBN (papel + ebook) hasta hoy. Cada libro se une a la
    // entrada con la que comparte un ISBN o el título; si no, es uno que el Fichero no conoce.
    const soloCrossref = new Map();
    const issnSerie = issn || ficha?.issn || null;
    let deCrossref = 0;
    if (conCrossref && issnSerie && crossrefLocalDisponible()) {
        const deLaSerie = librosDeSerieCrossrefLocal(issnSerie);
        deCrossref = deLaSerie.length;
        const entradaPorIsbn = new Map();
        for (const e of [...porNumero.values(), ...sinNumero.values()]) for (const v of e.isbns) entradaPorIsbn.set(v, e);
        for (const c of deLaSerie) {
            const variantes = c.isbns.flatMap((x) => variantesISBN(x));
            let entrada = variantes.map((v) => entradaPorIsbn.get(v)).find(Boolean);
            if (!entrada) {
                const n = c.coleccion_numero ? Number.parseInt(c.coleccion_numero, 10) : numeroUnico(c.titulo);
                const k = claveTitulo(c.titulo);
                entrada = (Number.isFinite(n) && porNumero.get(n)) || sinNumero.get(k) || soloCrossref.get(k);
                if (!entrada) {
                    entrada = nueva(c.titulo, c.año_edicion, null);
                    soloCrossref.set(k, entrada);
                }
            }
            anadir(entrada, c.isbns, 'crossref');
            for (const v of entrada.isbns) entradaPorIsbn.set(v, entrada);
        }
    }
    return { ficha, porNumero, sinNumero, soloCrossref, reunidos, issn: issnSerie, registros: libros.length, deCrossref };
}

/**
 * Pone en su número las entradas sin número que tus fichas sí numeran (coleccion_numero de los libros de la colección:
 * «Categories for the working mathematician» es el GTM 5). Cordura: el número no puede pasar mucho del mayor conocido
 * (fichas con un trozo de ISBN o ISSN como «número»). Devuelve cuántos se pusieron.
 */
export function numerosDeTusFichas(entradas, docs) {
    const { porNumero, sinNumero, soloCrossref } = entradas;
    const mayorConocido = Math.max(0, ...porNumero.keys());
    const tituloDeFicha = (t) => claveTitulo(String(t || '').replace(/\s+-\s+.*$/, '').replace(/\([^)]*\)/g, ''));
    const entradaPorIsbn = new Map();
    for (const e of [...sinNumero.values(), ...soloCrossref.values()]) for (const v of e.isbns) entradaPorIsbn.set(v, e);
    let puestos = 0;
    for (const d of docs) {
        const n = Number.parseInt(String(d.coleccion_numero ?? ''), 10);
        if (!Number.isFinite(n) || n < 1 || n > mayorConocido + 50 || porNumero.has(n)) continue;
        const k = tituloDeFicha(d.titulo);
        const entrada = variantesISBN(d.isbn).map((v) => entradaPorIsbn.get(v)).find(Boolean)
            || sinNumero.get(k) || soloCrossref.get(k);
        if (!entrada) continue;
        for (const lista of [sinNumero, soloCrossref]) for (const [clave, e] of lista) if (e === entrada) lista.delete(clave);
        entrada.numero = n;
        entrada.fuentes.add('ficha');
        porNumero.set(n, entrada);
        puestos++;
    }
    return puestos;
}

/** Números entre 1 y el mayor conocido que no están (la serie los tiene, pero no sabemos cuáles son). */
export function numerosDesconocidos(porNumero) {
    const max = Math.max(0, ...porNumero.keys());
    const faltan = [];
    for (let i = 1; i <= max; i++) if (!porNumero.has(i)) faltan.push(i);
    return faltan;
}

/** [1,2,3,5,7,8] → «1-3, 5, 7-8». */
export function rangos(lista) {
    const out = [];
    for (let i = 0; i < lista.length; i++) {
        let j = i;
        while (j + 1 < lista.length && lista[j + 1] === lista[j] + 1) j++;
        out.push(i === j ? `${lista[i]}` : `${lista[i]}-${lista[j]}`);
        i = j;
    }
    return out.join(', ');
}

/**
 * La serie completa de una COLECCIÓN de la biblioteca, lista para el panel: cada entrada con lo que tienes (el libro
 * de la biblioteca con alguno de sus ISBN, sea o no de la colección; o el miembro de la colección con ese número o
 * ese título), y aparte tus libros de la colección que la autoridad no conoce.
 */
export async function serieCompletaDeColeccion(db, coleccionId) {
    const c = await db.collection('colecciones').findOne({ _id: coleccionId });
    if (!c) return { ok: false, motivo: 'colección no encontrada' };
    const PROY = { titulo: 1, isbn: 1, coleccion_numero: 1, portada: 1, formatos: 1, año_edicion: 1 };
    const miembros = await db.collection('biblioteca').find({ coleccion: c._id }, { projection: PROY }).toArray();

    const ubicada = localizarSerie({ nombre: c.nombre, issn: c.issn, isbnsMiembros: miembros.map((m) => m.isbn).filter(Boolean) });
    if (!ubicada) return { ok: true, disponible: false, motivo: 'Ni el Fichero ni Crossref conocen esta serie por su nombre o su ISSN.' };
    // La editorial de la colección o, si no tiene, la de la mayoría de sus libros: separa series homónimas de editoriales
    // distintas («Post» de Stanford y de Post Yayın).
    let idEditorial = c.editorial || null;
    if (!idEditorial) {
        const votos = new Map();
        for (const m of await db.collection('biblioteca').find({ coleccion: c._id, editorial: { $ne: null } }, { projection: { editorial: 1 } }).toArray()) {
            votos.set(String(m.editorial), (votos.get(String(m.editorial)) || 0) + 1);
        }
        const [mejor] = [...votos.entries()].sort((a, b) => b[1] - a[1])[0] || [];
        if (mejor) idEditorial = new ObjectId(mejor);
    }
    const editorial = idEditorial ? (await db.collection('editoriales').findOne({ _id: idEditorial }, { projection: { nombre: 1 } }))?.nombre : null;
    const entradas = entradasDeSerie({ clave: ubicada.clave, issn: ubicada.issn });
    // Si filtrar por la editorial de la colección no deja nada, se usa la serie entera (las editoriales cambian de nombre).
    const conEditorial = editorial && ubicada.clave ? entradasDeSerie({ clave: ubicada.clave, issn: ubicada.issn, editorial }) : null;
    const e = conEditorial && conEditorial.registros >= 3 ? conEditorial : entradas;
    const deFichas = numerosDeTusFichas(e, miembros);

    // Lo que tienes: por ISBN en TODA la biblioteca (puede estar fuera de la colección) y por número o título entre los
    // miembros (un libro de la colección sin ISBN).
    const todas = [...e.porNumero.values(), ...e.sinNumero.values(), ...e.soloCrossref.values()];
    const isbns = [...new Set(todas.flatMap((x) => [...x.isbns]))];
    const docPorIsbn = new Map();
    for (let i = 0; i < isbns.length; i += 5000) {
        const docs = await db.collection('biblioteca').find({ isbn: { $in: isbns.slice(i, i + 5000) } }, { projection: { ...PROY, coleccion: 1 } }).toArray();
        // Si hay varios documentos con ese ISBN, el de la colección manda (los otros suelen ser duplicados).
        for (const d of docs) for (const v of variantesISBN(d.isbn)) {
            const ya = docPorIsbn.get(v);
            if (!ya || (String(d.coleccion) === String(c._id) && String(ya.coleccion) !== String(c._id))) docPorIsbn.set(v, d);
        }
    }
    const miembroPorNumero = new Map(miembros.filter((m) => m.coleccion_numero).map((m) => [String(m.coleccion_numero), m]));
    const miembroPorTitulo = new Map(miembros.map((m) => [claveTitulo(m.titulo), m]));
    const usados = new Set();
    const ficha = (d) => d && { _id: String(d._id), titulo: d.titulo, portada: d.portada || null, formatos: d.formatos || [], en_coleccion: String(d.coleccion || c._id) === String(c._id) };
    const resolver = (entrada) => {
        let d = [...entrada.isbns].map((v) => docPorIsbn.get(v)).find(Boolean)
            || (entrada.numero != null ? miembroPorNumero.get(String(entrada.numero)) : null)
            || miembroPorTitulo.get(claveTitulo(entrada.titulo));
        if (d) usados.add(String(d._id));
        return {
            numero: entrada.numero,
            titulo: entrada.titulo,
            anio: entrada.anio,
            isbn: [...entrada.isbns].find((v) => v.length === 13) || [...entrada.isbns][0] || null,
            ediciones: entrada.ediciones,
            fuentes: [...entrada.fuentes],
            tengo: ficha(d),
        };
    };
    const numeradas = [...e.porNumero.entries()].sort((a, b) => a[0] - b[0]).map(([, x]) => resolver(x));
    const sinNumero = [...e.sinNumero.values(), ...e.soloCrossref.values()].map(resolver)
        .sort((a, b) => (!!b.tengo - !!a.tengo) || ((a.anio || 9999) - (b.anio || 9999)));
    const fueraDeLaSerie = miembros.filter((m) => !usados.has(String(m._id))).map((m) => ficha({ ...m, coleccion: c._id }));
    const desconocidos = numerosDesconocidos(e.porNumero);
    return {
        ok: true,
        disponible: true,
        serie: { nombre: e.ficha?.nombre || c.nombre, issn: e.issn, registros: e.registros, de_crossref: e.deCrossref, editorial: conEditorial && e === conEditorial ? editorial : null },
        numeradas,
        sin_numero: sinNumero,
        fuera_de_la_serie: fueraDeLaSerie,
        numeros_desconocidos: desconocidos.length < 400 ? rangos(desconocidos) : null,
        resumen: {
            numeros_conocidos: numeradas.length,
            numeros_tenidos: numeradas.filter((x) => x.tengo).length,
            sin_numero: sinNumero.length,
            sin_numero_tenidos: sinNumero.filter((x) => x.tengo).length,
            de_tus_fichas: deFichas,
        },
    };
}
