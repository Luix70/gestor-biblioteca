/**
 * DATOS DE LA OBRA A PARTIR DE LAS EDICIONES CANDIDATAS (regla del usuario, 30-sep).
 *
 * Cuando no se sabe cuál es la edición de un ejemplar (varias candidatas de editoriales distintas, sin nada que
 * decida), las candidatas siguen siendo útiles: todas son ediciones de la MISMA OBRA. Lo que es de la obra no cambia
 * de una a otra, y cada una puede aportar lo que le falte a las demás (una la sinopsis, otra la lengua original):
 *
 *   DE LA OBRA (se toma de cualquier candidata, solo para HUECOS):
 *     · sinopsis        — de una candidata en la MISMA LENGUA que el ejemplar (la de otra lengua no sirve);
 *     · idioma_original — la lengua en que se escribió;
 *     · materias        — unión (se añaden, nunca se quitan);
 *     · CDU             — solo si las candidatas que la traen COINCIDEN (2+ y ninguna distinta): una edición
 *                         juvenil (087.5:82) y una de adultos (821.111) de la misma obra discrepan → no se aplica.
 *
 *   DE LA EDICIÓN (NUNCA de una candidata sin confirmar): ISBN, editorial, año, páginas, medidas, colección,
 *   portada y los COLABORADORES — traductor, ilustrador, prologuista, editor… cambian de una edición a otra y no se
 *   dan por buenos hasta que la edición se confirma (la eliges tú o una prueba la decide). El autor principal sí es
 *   de la obra, pero para identificar la edición el documento ya tiene que tenerlo: aquí no se toca.
 */
import { buscarAutoridadPorISBN, cduDeAutoridadFiable } from './autoridad-isbn.js';
import { variantesISBN } from './identificadores.js';
import { modernizarCDU } from './cdu-moderna.js';

const MAX_CANDIDATAS = 8;
const vacio = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const idioma2 = (i) => String(i || '').toLowerCase().slice(0, 2);

/**
 * @param doc         el documento (debe traer sinopsis, idioma, idioma_original, palabras_clave, cdu)
 * @param candidatos  [{ isbn, … }] (las ediciones posibles)
 * @param opts.enLinea  consultar la BNE en línea si el Fichero no tiene la ficha (por defecto sí)
 * @returns {Promise<{ set: object, cambios: Array<{campo, de, a}>, cdu: string|null, fichas: number }>}
 *          `set` = huecos de la obra; `cdu` = CDU de consenso (la aplica el llamante, por PRIORIDAD: mueve carpeta).
 */
export async function datosDeObraDeCandidatas(doc, candidatos = [], { enLinea = true } = {}) {
    const fichas = [];
    for (const c of candidatos.slice(0, MAX_CANDIDATAS)) {
        if (!c?.isbn) continue;
        const f = await buscarAutoridadPorISBN(variantesISBN(c.isbn), { enLinea }).catch(() => null);
        if (f && f.titulo) fichas.push(f);
    }

    const set = {};
    const cambios = [];
    const rellena = (campo, valor, etiqueta = valor) => {
        if (vacio(valor) || !vacio(doc[campo])) return;
        set[campo] = valor;
        cambios.push({ campo, de: null, a: etiqueta });
    };

    // Sinopsis: de una ficha en la lengua del ejemplar (o sin lengua declarada).
    const iDoc = idioma2(doc.idioma);
    const conSinopsis = fichas.filter((f) => f.sinopsis && (!iDoc || !f.idioma || idioma2(f.idioma) === iDoc));
    rellena('sinopsis', conSinopsis[0]?.sinopsis, '(de una de las ediciones candidatas)');

    // Lengua original: la primera que la diga, si es distinta de la del ejemplar (si coinciden, no es traducción).
    const original = fichas.map((f) => f.lengua_original || f.idioma_original).find(Boolean);
    if (original && idioma2(original) !== iDoc) rellena('idioma_original', original);

    // Materias: unión.
    const materias = fichas.flatMap((f) => Array.isArray(f.categorias) ? f.categorias : []).filter(Boolean);
    if (materias.length) {
        const previas = Array.isArray(doc.palabras_clave) ? doc.palabras_clave : [];
        const juntas = [...new Set([...previas, ...materias])];
        if (juntas.length > previas.length) {
            set.palabras_clave = juntas;
            cambios.push({ campo: 'palabras_clave', de: previas.join(', ') || null, a: juntas.join(', ') });
        }
    }

    // CDU de consenso: todas las fichas que traen CDU dicen la MISMA (y al menos dos).
    // (Solo de fichas cuyo título casa con el del documento: la misma salvaguarda que la CDU de autoridad.)
    const cdus = fichas
        .filter((f) => f.cdu && cduDeAutoridadFiable(doc, f))
        .map((f) => modernizarCDU(String(f.cdu).trim()));
    const distintas = [...new Set(cdus)];
    const cdu = cdus.length >= 2 && distintas.length === 1 ? distintas[0] : null;

    return { set, cambios, cdu, fichas: fichas.length };
}
