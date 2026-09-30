/**
 * EXTRACCIÓN DE ISBN desde el propio fichero, SIN IA ni red — parte PURA (sin BD) compartida por la ingesta de
 * colecciones (`transmedia.js`), el motor de re-identificación (`reidentificar-doc.js`) y su acción/backfill.
 *
 * Confianza del ISBN (misma política que el orquestador, para NO colgar un ISBN equivocado):
 *   · EPUB → dc:identifier del OPF (propio del libro) → se confía; si el OPF no lo trae, un ISBN del TEXTO
 *     (página de créditos) solo se acepta si CORROBORA por título contra el Fichero, como en un PDF.
 *   · MOBI/AZW → registro EXTH (propio) → se confía.
 *   · PDF → el ISBN PROPIO (nombre-es-ISBN / DOI / bloque CIP) se confía; un candidato del CUERPO del texto
 *     solo se acepta si CORROBORA por título contra el Fichero (`corroborarISBNporTitulo`).
 *   · Nombre de archivo → un ISBN incrustado en el nombre se trata como propio.
 *
 * Dos precauciones que enseñó el log completo de la pasada del 30-sep:
 *   · EL ISBN DEL CONJUNTO NO ES EL DEL LIBRO. La página de créditos de una obra en varios tomos o de una serie
 *     lista el ISBN del conjunto («ISBN 978-0-367-22090-7 (Set)») junto al del volumen. Se cogía el primero: ocho
 *     títulos distintos de «Routledge Library Editions» y los tomos de cuarenta enciclopedias recibieron el mismo
 *     ISBN (196 documentos). Ahora el del conjunto se devuelve aparte (`isbn_obra`) y el del libro se elige por su
 *     número de tomo; si no se sabe cuál es, no se asigna ninguno (misma regla que la ingesta).
 *   · EL NOMBRE Y EL CONTENIDO PUEDEN DISCREPAR. Un fichero «9780803296701.…Before_Jackie_Robinson….epub» traía
 *     dentro el ISBN de otro libro («Bambini sorriso di Dio») y se quedó con su título. Si los dos ISBN son de
 *     editoriales distintas, decide el Fichero por el título; sin respuesta, manda el del nombre.
 */
import path from 'node:path';
import { extraerMetadatosPdf, extraerISBNs } from './lector-pdf.js';
import { extraerMetadatosEpub, isbnsEnTextoEpub, textoInicialEpub } from './lector-epub.js';
import { leerMobi } from './lector-mobi.js';
import { corroborarISBNporTitulo } from './buscador-local.js';
import { parsearBloqueCatalogacion } from './cip.js';
import { validarISBN, variantesISBN } from './identificadores.js';
import { extraerISBNsConRol } from './multivolumen.js';

// Tipo por extensión — sin importar el orquestador (evita ciclos y peso; solo estos formatos dan un ISBN de
// texto/metadatos barato). Devuelve null para djvu/cbz/… (no soportados aquí).
export function tipoLibro(abs) {
    const ext = path.extname(abs || '').toLowerCase();
    if (ext === '.epub') return 'epub';
    if (ext === '.pdf') return 'pdf';
    if (['.mobi', '.azw', '.azw3', '.prc'].includes(ext)) return 'mobi';
    return null;
}

// El primer ISBN VÁLIDO de un texto (nombre de archivo), o null.
function isbnDeTexto(texto) {
    for (const x of extraerISBNs(String(texto || ''))) { const v = validarISBN(x); if (v) return v; }
    return null;
}

/** ¿Son el mismo ISBN (en su forma de 10 o de 13)? */
const mismoISBN = (a, b) => !!a && !!b && variantesISBN(a).some((v) => variantesISBN(b).includes(v));

/** Comienzo del ISBN-13 que identifica a la editorial (grupo + primeras cifras del registrante). */
function prefijoEditorial(isbn) {
    const de13 = variantesISBN(isbn).find((v) => String(v).replace(/[^0-9]/g, '').length === 13);
    return de13 ? String(de13).replace(/[^0-9]/g, '').slice(0, 7) : null;
}

/**
 * Entre el ISBN que declara el CONTENIDO y el que lleva el NOMBRE del fichero, ¿cuál es el de este libro?
 *   · si son el mismo, o solo hay uno → ese;
 *   · si el Fichero confirma uno por el título → ese;
 *   · si nadie confirma: de editoriales distintas → el del nombre (quien nombró el fichero partió del libro
 *     correcto; el de dentro es de otra obra); de la misma editorial → el del contenido (papel y ebook del mismo libro).
 */
async function elegirEntreContenidoYNombre(delContenido, delNombre, titulo) {
    if (!delContenido || !delNombre || mismoISBN(delContenido, delNombre)) return delContenido || delNombre || null;
    for (const candidato of [delContenido, delNombre]) {
        const confirmado = await corroborarISBNporTitulo({ candidatos: [candidato], titulo }).catch(() => null);
        if (confirmado) return candidato;
    }
    return prefijoEditorial(delContenido) === prefijoEditorial(delNombre) ? delContenido : delNombre;
}

/**
 * De los ISBN con ROL de la página de créditos, el de ESTE libro y el del conjunto.
 * @param roles   salida de extraerISBNsConRol: [{ isbn, rol: 'obra'|'volumen'|…, numero }]
 * @param volumen número de tomo de este documento, si se sabe
 * @returns {{ deObra: string|null, deVolumen: string|null, hayVolumenes: boolean }}
 */
export function isbnSegunRol(roles = [], volumen = null) {
    const deObra = roles.find((r) => r.rol === 'obra')?.isbn || null;
    const volumenes = roles.filter((r) => r.rol === 'volumen');
    let deVolumen = null;
    if (volumenes.length) {
        const numeros = new Set(volumenes.map((r) => r.numero));
        // Todos los ISBN de volumen llevan el MISMO número: son los de este libro (papel, ebook…) — el caso de una
        // serie («(Volume 12) (hbk)»). Si hay varios números, es la lista de todos los tomos: hay que saber cuál es.
        if (numeros.size === 1) deVolumen = volumenes[0].isbn;
        else if (volumen != null) deVolumen = volumenes.find((r) => r.numero === Number(volumen))?.isbn || null;
    }
    return { deObra, deVolumen, hayVolumenes: volumenes.length > 0 };
}

/**
 * Extrae el ISBN (y de paso título/autores/editorial del propio fichero) SIN IA ni red. Devuelve
 * { isbn, isbn_obra, titulo, autores, editorial } con lo que haya (todos opcionales). Best-effort: nunca lanza.
 * @param opts.volumen  número de tomo del documento (para elegir su ISBN entre los de la obra)
 */
export async function isbnDesdeArchivo(abs, { nombre = '', tituloRef = '', volumen = null } = {}) {
    const tipo = tipoLibro(abs);
    const base = path.basename(nombre || abs || '');
    // Un ISBN incrustado en el NOMBRE es propio (autoritativo), como en la ingesta.
    const isbnNombre = isbnDeTexto(base);
    if (!tipo) return { isbn: isbnNombre, isbn_obra: null, titulo: null, autores: [], editorial: null };

    try {
        if (tipo === 'epub') {
            const m = await extraerMetadatosEpub(abs);
            const ref = m?.titulo || tituloRef || base;
            let isbn = await elegirEntreContenidoYNombre(validarISBN(m?.isbn), isbnNombre, ref);
            let isbnObra = null;
            // El OPF no lo trae: mirar las PÁGINAS DE CRÉDITOS. El bloque CIP es el registro de catalogación de
            // ESTE libro → propio, se confía. Un ISBN suelto del texto, en cambio, puede ser el de otra obra
            // citada → solo se acepta si CORROBORA por título contra el Fichero (como el cuerpo de un PDF).
            if (!isbn) {
                const texto = await textoInicialEpub(abs);
                const rol = isbnSegunRol(texto ? extraerISBNsConRol(texto) : [], volumen);
                isbnObra = rol.deObra;
                const cip = texto ? parsearBloqueCatalogacion(texto) : null;
                isbn = rol.deVolumen
                    || cip?.isbns?.map((x) => validarISBN(x.isbn)).find((x) => x && !mismoISBN(x, rol.deObra)) || null;
                if (!isbn && !rol.hayVolumenes) {
                    const candidatos = (await isbnsEnTextoEpub(abs, { texto })).filter((x) => !mismoISBN(x, rol.deObra));
                    if (candidatos.length) isbn = await corroborarISBNporTitulo({ candidatos, titulo: ref }).catch(() => null);
                }
            }
            return { isbn: isbn || null, isbn_obra: isbnObra, titulo: m?.titulo || null, autores: m?.autores || [], editorial: m?.editorial || null };
        }
        if (tipo === 'mobi') {
            const m = await leerMobi(abs);
            const isbn = await elegirEntreContenidoYNombre(validarISBN(m?.isbn), isbnNombre, m?.titulo || tituloRef || base);
            return { isbn, isbn_obra: null, titulo: m?.titulo || null, autores: m?.autores || [], editorial: m?.editorial || null };
        }

        // PDF: propio (nombre/DOI/CIP) directo; candidato del cuerpo solo si corrobora por título.
        const d = await extraerMetadatosPdf(abs);
        const ref = d?.titulo || tituloRef || base;
        const rol = isbnSegunRol(d?.isbns_rol || [], volumen ?? d?.volumen_numero ?? null);
        const esDeObra = (x) => mismoISBN(x, rol.deObra);
        let isbn = isbnNombre && !esDeObra(isbnNombre) ? isbnNombre : null;          // 1) el del nombre
        if (!isbn) isbn = rol.deVolumen;                                              // 2) el de SU tomo
        if (!isbn && !rol.hayVolumenes) {
            // 3) el propio (DOI o bloque CIP) que no sea el del conjunto
            const propio = validarISBN(d?.isbn_propio);
            if (propio && !esDeObra(propio)) isbn = propio;
            else isbn = (d?.cip?.isbns || []).map((x) => validarISBN(x.isbn || x)).find((x) => x && !esDeObra(x)) || null;
        }
        // 4) un candidato del cuerpo, solo si el Fichero lo confirma por el título. Si los créditos listan los ISBN
        //    de varios tomos y no se sabe cuál es este, no se adivina.
        if (!isbn && !rol.hayVolumenes && d?.isbn_candidatos?.length) {
            const candidatos = d.isbn_candidatos.filter((x) => !esDeObra(x));
            if (candidatos.length) isbn = await corroborarISBNporTitulo({ candidatos, titulo: ref }).catch(() => null);
        }
        // OJO: el título del info-dict de un PDF es POCO FIABLE (a menudo un artefacto: «Keywords: …», el nombre
        // del fichero fuente, etc.) → NO se devuelve como título autoritativo (solo se usó arriba como referencia
        // para corroborar). El título bueno vendrá de la autoridad (Fichero/APIs por ISBN). En EPUB/MOBI sí es
        // fiable (OPF/EXTH). Los autores del info-dict ya vienen filtrados de artefactos por extraerMetadatosPdf.
        return { isbn: isbn || null, isbn_obra: rol.deObra, titulo: null, autores: d?.autores || [], editorial: null };
    } catch {
        return { isbn: isbnNombre, isbn_obra: null, titulo: null, autores: [], editorial: null };
    }
}
