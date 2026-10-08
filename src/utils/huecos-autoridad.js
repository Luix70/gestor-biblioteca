/**
 * RELLENAR HUECOS con lo que devuelve una autoridad (Fichero, BNE, OpenLibrary, Google Books… vía
 * `buscarMetadatosExternos`). Fuente ÚNICA para todos los que aplican ese resultado a un documento ya
 * catalogado: «🔎 Extraer ISBN» (reidentificar-doc), el Enriquecedor de la ficha (reenriquecer), la tarea
 * re-enriquecer-degradados, la campaña «Huecos de metadatos» y la propuesta de «Enriquecer a fondo». Antes cada
 * uno rellenaba SU lista de campos (uno sin páginas, otro sin traductor…): una llamada a una API ya hecha
 * desperdiciaba lo demás.
 *
 * REGLA: solo HUECOS. Nada de lo que ya tiene el documento se sobrescribe aquí — ni aunque la autoridad diga
 * otra cosa. Lo conseguido por otros medios (a mano, del propio fichero, de otra fuente) no se pierde. Las
 * sustituciones deliberadas (título basura, autores artefacto…) las decide cada llamador con sus propias reglas.
 *   · Escalares: sinopsis, subtítulo, año de edición, idioma, idioma original, páginas, medidas, Dewey, LCC.
 *   · Materias: se AÑADEN las que falten (unión), nunca se quitan.
 *   · Contribuciones (traductor, ilustrador…): solo si el documento no tiene ninguna.
 *   · CDU de autoridad (la BNE cataloga en CDU): a `cdu_autoridad`, sin tocar `cdu` (cambiarla mueve la carpeta;
 *     la aplican «Investigar CDU» y la tarea re-clasificar-cdu, que la prefieren al crosswalk y a la IA).
 *
 * ⚠ El `doc` debe traer TODOS esos campos (documento completo, o una proyección que los incluya): un campo que
 * falte en el objeto se vería vacío y se rellenaría encima de lo que hay en la base.
 */
import { resolverPersona } from './resolver-persona.js';
import { cduDeAutoridadFiable } from './autoridad-isbn.js';
import { modernizarCDU } from './cdu-moderna.js';

const vacio = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Parte PURA (sin base de datos): escalares, materias y CDU de autoridad que faltan. La usan
 * `huecosDesdeAutoridad` y las propuestas que se revisan antes de aplicar («Enriquecer a fondo»).
 * @returns {{ set: object, cambios: Array<{campo, de, a}> }}
 */
export function huecosEscalares(doc, datos = {}) {
    const set = {};
    const cambios = [];
    const rellena = (campo, valor, etiqueta = valor) => {
        if (vacio(valor) || !vacio(doc[campo])) return;
        set[campo] = valor;
        cambios.push({ campo, de: null, a: etiqueta });
    };

    rellena('sinopsis', datos.sinopsis, '(añadida)');
    // El subtítulo, salvo que el título ya lo lleve dentro («Fichte. La libertad es el fundamento del conocimiento y de
    // la moral» + «la libertad es el fundamento…» saldría repetido).
    const plano = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
    if (!plano(doc.titulo).includes(plano(datos.subtitulo))) rellena('subtitulo', datos.subtitulo);
    rellena('año_edicion', datos.año_edicion);
    rellena('idioma', datos.idioma);
    rellena('paginas', datos.paginas_bne ?? datos.paginas);
    rellena('dimensiones', datos.dimensiones_bne ?? datos.dimensiones);
    rellena('dewey', datos.dewey ? String(datos.dewey).trim() : null);
    rellena('lcc', datos.lcc ? String(datos.lcc).trim() : null);
    // Idioma original: solo si es DISTINTO del de la edición (si coinciden no dice nada).
    if (datos.idioma_original && datos.idioma_original !== (doc.idioma || datos.idioma)) rellena('idioma_original', datos.idioma_original);

    // Materias: unión (se añaden las que falten; las que había se quedan).
    const nuevas = Array.isArray(datos.categorias) ? datos.categorias.filter(Boolean) : [];
    if (nuevas.length) {
        const previas = Array.isArray(doc.palabras_clave) ? doc.palabras_clave : [];
        const juntas = [...new Set([...previas, ...nuevas])];
        if (juntas.length > previas.length) {
            set.palabras_clave = juntas;
            cambios.push({ campo: 'palabras_clave', de: previas.join(', ') || null, a: juntas.join(', ') });
        }
    }

    // CDU de AUTORIDAD: se guarda aparte; nunca se toca `cdu` aquí. SOLO la de la BNE (catalogada por
    // bibliotecarios): una CDU del clasificador (equivalencia Dewey/LCC o IA) nunca pasa por «de autoridad».
    if (datos.cdu && datos.cdu_fuente === 'bne' && cduDeAutoridadFiable(doc, datos)
        && datos.cdu !== doc.cdu && datos.cdu !== doc.cdu_autoridad && !doc.cdu_manual) {
        set.cdu_autoridad = modernizarCDU(datos.cdu);
        cambios.push({ campo: 'cdu_autoridad', de: doc.cdu_autoridad || null, a: set.cdu_autoridad });
    }
    return { set, cambios };
}

/**
 * Todos los huecos, incluidas las contribuciones (traductor, ilustrador…) resueltas a personas.
 * @param opts.aplicar  false = prueba en seco: las contribuciones NO se resuelven a personas (eso las CREARÍA en
 *                      la base); solo se informa de ellas en `cambios`.
 * @param opts.conContribuciones  false = sin colaboradores: son de la EDICIÓN, y con una edición provisional o
 *                      dudosa no se dan por buenos (regla del usuario, 30-sep).
 * @returns {Promise<{ set: object, cambios: Array<{campo, de, a}> }>}
 */
export async function huecosDesdeAutoridad(db, doc, datos = {}, { aplicar = true, conContribuciones = true } = {}) {
    const { set, cambios } = huecosEscalares(doc, datos);
    if (!conContribuciones) return { set, cambios };

    // Una persona que es AUTORA del libro no es a la vez su traductora o editora: las fichas de autoridad a veces la
    // repiten con otro rol (medido el 29-sep: «Highsmith, Patricia (traductor)», «Powell, Anthony (traductor)»,
    // «Dante Alighieri (editor)»). Se compara por apellido + nombre sin acentos ni orden.
    const clavePersona = (n) => String(n || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/\(.*?\)|\d{3,4}-?\d{0,4}/g, ' ').split(/[^a-z]+/).filter((w) => w.length > 2).sort().join(' ');
    const autoresClave = new Set((Array.isArray(datos.autores) ? datos.autores : []).map(clavePersona).filter(Boolean));
    const conRol = (Array.isArray(datos.contribuciones_nombres) ? datos.contribuciones_nombres : [])
        .filter((c) => c?.nombre && c.rol && c.rol !== 'autor' && !autoresClave.has(clavePersona(c.nombre)));
    if (conRol.length && vacio(doc.contribuciones)) {
        const etiqueta = conRol.map((c) => `${c.nombre} (${c.rol})`).join(', ');
        if (!aplicar) {
            cambios.push({ campo: 'contribuciones', de: null, a: etiqueta });
            return { set, cambios };
        }
        const contribs = [];
        const vistos = new Set();
        for (const c of conRol) {
            const p = await resolverPersona(db, c.nombre).catch(() => null);
            const clave = p?._id ? `${p._id}|${c.rol}` : null;
            if (!clave || vistos.has(clave)) continue;
            vistos.add(clave);
            contribs.push({ persona: p._id, rol: c.rol });
        }
        if (contribs.length) {
            set.contribuciones = contribs;
            cambios.push({ campo: 'contribuciones', de: null, a: etiqueta });
        }
    }
    return { set, cambios };
}

const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');
const tokensNombre = (s) => String(s || '').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '')
    .replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 3);

/**
 * ¿Es la misma persona? Tolerante a orden, acentos y puntuación: «Ewers, Hanns Heinz» = «Hanns Heinz Ewers»,
 * «García Márquez, Gabriel» = «Gabriel Garcia Marquez». Basta que la mayoría de las palabras de la forma más
 * corta estén en la otra.
 */
export function mismoNombreAutor(a, b) {
    const A = new Set(tokensNombre(a)), B = new Set(tokensNombre(b));
    if (!A.size || !B.size) return false;
    const [chico, grande] = A.size <= B.size ? [A, B] : [B, A];
    let comunes = 0;
    for (const t of chico) if (grande.has(t)) comunes++;
    return comunes / chico.size >= 0.6;
}

/**
 * AUTORES con ancla de ISBN, sin perder coautores: la autoridad a menudo lista MENOS autores que el libro (la
 * BNE pone el principal en el 100 y el resto aparte; OpenLibrary a veces solo uno). Reemplazar la lista por la
 * suya borraría coautores reales. Así que:
 *   · Si comparten algún autor → se conservan TODOS los actuales y se AÑADEN los de la autoridad que falten.
 *   · Si no comparten ninguno → los actuales eran otra cosa (el caso real: «Men at Arms 058» como autor de un
 *     Osprey) y se sustituyen por los de la autoridad.
 * @param casa (a, b) → bool, comparación tolerante de nombres (por defecto, mismoNombreAutor)
 * @returns { nombres: string[], modo: 'igual'|'union'|'sustituir' }
 */
export function autoresConAncla(actuales = [], deAutoridad = [], casa = mismoNombreAutor) {
    if (!deAutoridad.length) return { nombres: actuales, modo: 'igual' };
    if (!actuales.length) return { nombres: deAutoridad, modo: 'sustituir' };
    const faltan = deAutoridad.filter((n) => !actuales.some((a) => casa(a, n)));
    const comparten = deAutoridad.length - faltan.length > 0;
    if (!comparten) return { nombres: deAutoridad, modo: 'sustituir' };
    if (!faltan.length) return { nombres: actuales, modo: 'igual' };
    return { nombres: [...actuales, ...faltan], modo: 'union' };
}
