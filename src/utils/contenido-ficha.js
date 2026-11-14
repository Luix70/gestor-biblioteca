/**
 * ¿COINCIDE EL CONTENIDO DEL FICHERO CON SU FICHA?
 *
 * Caso que lo motivó (14-nov): «The Cambridge Companion - Hobbes On Rhetoric.pdf» (17 páginas, el capítulo 13 del
 * *Cambridge Companion to Hobbes*) estaba catalogado como «Cambridge Companion to the Violin», con su ISBN, su CDU
 * (787.2), su sinopsis y su portada: la ingesta aceptó un resultado de OpenLibrary por título que solo CONTENÍA el
 * título leído del nombre. La ingesta ya no lo hace (titulo-libro·tituloCasaBusqueda), pero lo ya catalogado sigue
 * mal: medido ese día, 706 de 59.861 fichas con ISBN tenían un título sin ninguna palabra en común con su fichero.
 *
 * Aquí se comparan las palabras con cuerpo del TÍTULO de la ficha con las del NOMBRE del fichero y, si el nombre
 * no lo confirma, con el TEXTO de sus primeras páginas (PDF con capa de texto, EPUB). Veredictos:
 *   · 'casa'      — el nombre o el texto traen la mayoría de las palabras del título;
 *   · 'no-casa'   — ni el nombre ni el texto traen casi ninguna (o el título es un artefacto: «Opener», «Authors»);
 *   · 'dudoso'    — no hay texto con que confirmarlo (escaneo sin OCR, formato sin lector aquí) o el parecido es
 *                   parcial: se revisa a mano;
 *   · 'sin-datos' — no hay fichero o el título no tiene palabras con cuerpo («1984», «Ü»).
 *
 * Consumidores: scripts/detectar-contenido-discrepante.js (selección para revisar) y la acción de la ficha
 * «🧹 Reidentificar desde el contenido» (muestra el veredicto y las pistas). Gemelo en la ingesta: la guarda de las
 * búsquedas por título (proveedor-metadatos·resultadoDeEsteLibro), que es por donde entraban estos casos.
 * Sin IA, sin red: solo poppler y la lectura del EPUB.
 */
import path from 'node:path';
import { textoPagina } from './lector-pdf.js';
import { textoInicialEpub } from './lector-epub.js';
import { esTituloArtefacto } from './parsear-nombre.js';
import { ficheroDelDoc } from './hash-doc.js';

const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');

// Palabras que no distinguen un libro de otro: gramaticales y las «de serie» que comparten cientos de títulos
// («The Cambridge Companion to…», «A Very Short Introduction», «Handbook of…»). Si el título solo tiene estas,
// no se puede afirmar nada por él.
const VACIAS = new Set((
    'the and for with from into over under about this that these those your their what when where which '
    + 'una unos unas para por con del los las que como sobre entre desde hasta pero sino este esta estos estas '
    + 'dans pour avec sous sans leur leurs cette ces des une aux '
    + 'der die das und mit fur vom zum zur eine einer eines '
    + 'della delle degli dello nella nelle '
    + 'edition edicion volume volumen tome tomo band book books libro libros part parte chapter capitulo '
    + 'cambridge oxford companion companions introduction introduccion handbook manual guide guia series serie '
    + 'press university universidad '
).split(' '));

/** Raíces (5 primeras letras) de las palabras con cuerpo de un texto: 4+ letras, sin las vacías. */
export function raicesDe(texto) {
    return new Set(String(texto || '').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '')
        .split(/[^a-z]+/).filter((w) => w.length >= 4 && !VACIAS.has(w)).map((w) => w.slice(0, 5)));
}

/** Qué parte de las raíces de `a` están en `b` (0-1). */
function cobertura(a, b) {
    if (!a.size) return 0;
    let n = 0;
    for (const r of a) if (b.has(r)) n++;
    return n / a.size;
}

/** El nombre del fichero sin extensión, con «_» y «.» como espacios («Eye,_The_-_OxfordUP.VSI»). */
const nombreLegible = (nombre) => path.basename(String(nombre || ''), path.extname(String(nombre || ''))).replace(/[_.]+/g, ' ');

/**
 * Texto de las primeras páginas del fichero, página a página (para ver las cabeceras que se repiten).
 * PDF: las `paginas` primeras con capa de texto. EPUB: su texto inicial como una sola «página». Otros: [].
 */
export async function paginasIniciales(abs, { paginas = 4 } = {}) {
    if (!abs) return [];
    const ext = path.extname(abs).toLowerCase();
    if (ext === '.pdf') {
        const out = [];
        for (let n = 1; n <= paginas; n++) {
            const t = await textoPagina(abs, n).catch(() => '');
            if (n > 1 && !t) break;   // fuera de rango (documento más corto)
            out.push(t || '');
        }
        return out;
    }
    if (ext === '.epub') {
        const t = await textoInicialEpub(abs, { maxDocs: 8 }).catch(() => '');
        return t ? [t.slice(0, 20000)] : [];
    }
    return [];
}

/**
 * Compara la ficha con su fichero. `abs`/`paginas` opcionales (si el llamador ya los tiene).
 * @returns {Promise<{veredicto:'casa'|'no-casa'|'dudoso'|'sin-datos', motivo:string, enNombre:number, enTexto:number|null, conTexto:boolean}>}
 */
export async function cotejarContenido(doc, { abs, paginas } = {}) {
    const titulo = String(doc.titulo || '');
    if (esTituloArtefacto(titulo)) {
        return { veredicto: 'no-casa', motivo: `el título «${titulo}» es un artefacto (no es un título)`, enNombre: 0, enTexto: null, conTexto: false };
    }
    const delTitulo = raicesDe(titulo);
    if (!delTitulo.size) return { veredicto: 'sin-datos', motivo: 'el título no tiene palabras con que comparar', enNombre: 0, enTexto: null, conTexto: false };

    const enNombre = cobertura(delTitulo, raicesDe(nombreLegible(doc.nombre_archivo)));
    if (enNombre >= 0.5) return { veredicto: 'casa', motivo: 'el nombre del fichero trae el título', enNombre, enTexto: null, conTexto: false };

    if (abs === undefined) abs = await ficheroDelDoc(doc).catch(() => null);
    if (!abs) return { veredicto: 'sin-datos', motivo: 'no se encuentra el fichero', enNombre, enTexto: null, conTexto: false };
    if (paginas === undefined) paginas = await paginasIniciales(abs);
    const texto = paginas.join('\n');
    if (texto.replace(/\s+/g, '').length < 200) {
        return { veredicto: 'dudoso', motivo: 'el fichero no tiene texto legible con que confirmarlo (¿escaneo sin OCR?)', enNombre, enTexto: null, conTexto: false };
    }
    const enTexto = cobertura(delTitulo, raicesDe(texto));
    if (enTexto >= 0.5) return { veredicto: 'casa', motivo: 'las primeras páginas traen el título', enNombre, enTexto, conTexto: true };
    if (enNombre === 0 && enTexto < 0.25) {
        return { veredicto: 'no-casa', motivo: 'ni el nombre del fichero ni sus primeras páginas traen las palabras del título', enNombre, enTexto, conTexto: true };
    }
    return { veredicto: 'dudoso', motivo: 'el parecido es parcial', enNombre, enTexto, conTexto: true };
}

// ── PISTAS para reidentificar ─────────────────────────────────────────────────────────────────────────────

// Una línea sin los números de página que la rodean («33O THE CAMBRIDGE…», «Hobbes on rhetoric 331»; el OCR
// lee a veces «O» por «0»).
const sinFolio = (l) => l.replace(/^\s*[\dOoIl]*\d[\dOoIl]*\s+/, '').replace(/\s+[\dOoIl]*\d[\dOoIl]*\s*$/, '').trim();
const clave = (l) => sinFolio(l).toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '').replace(/[^a-z]+/g, ' ').trim();
// Pies de página de plataforma y copyright: se repiten en todas las páginas pero no son un título.
const RE_PIE = /©|\(c\)\s*\d{4}|copyright|online|downloaded|all rights|todos los derechos|www\.|https?:/i;
// Un nombre de autor tal como lo imprime la primera página de un capítulo: 2-4 palabras, sin cifras, sin
// palabras gramaticales («VICTORIA SILVER», «A. J. Ayer»).
const RE_NOMBRE = /^(?:[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ'.-]*\.?\s+){1,3}[A-ZÁÉÍÓÚÑ][A-Za-zÁÉÍÓÚÑáéíóúñ'-]+$/;
const GRAMATICALES = /\b(the|of|and|on|in|to|for|de|la|el|los|las|y|en|del)\b/i;

/**
 * Lo que dice el propio fichero de sí mismo, para que la persona lo confirme o corrija al reidentificar:
 *   · `lineas`: las primeras líneas con texto de la primera página;
 *   · `cabeceras`: las líneas que se repiten en 2+ páginas (cabeceras de página: el libro y el capítulo);
 *   · `sugerencia`: título / autor / libro al que pertenece, si se deducen sin dudas. Nunca se aplica sola.
 */
export function pistasDelContenido(paginas = []) {
    const lineasDe = (t) => String(t || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length >= 3);
    // Solo las líneas CORTAS (títulos, nombres, cabeceras): un párrafo del cuerpo no identifica nada.
    const primera = lineasDe(paginas[0]).slice(0, 14).filter((l) => l.length <= 100).slice(0, 8);

    // Cabeceras: misma línea (sin folio) en dos o más páginas, de 6 a 90 letras.
    const vistas = new Map();   // clave → { texto, paginas:Set }
    paginas.forEach((t, i) => {
        const ls = lineasDe(t);
        // Solo el principio y el final de cada página: ahí van las cabeceras y los pies.
        for (const l of [...ls.slice(0, 3), ...ls.slice(-3)]) {
            const k = clave(l);
            if (k.length < 6 || k.length > 90) continue;
            if (!vistas.has(k)) vistas.set(k, { texto: sinFolio(l), paginas: new Set() });
            vistas.get(k).paginas.add(i);
        }
    });
    // Una cabecera de página es la misma en las pares (el libro) o en las impares (el capítulo): basta con 2.
    const cabeceras = [...vistas.values()].filter((v) => v.paginas.size >= 2).map((v) => v.texto);

    // Sugerencia: el capítulo es una cabecera que también encabeza la primera página («13 Hobbes on rhetoric»); el
    // libro, la otra cabecera que no es un pie; el autor, un nombre suelto en las primeras líneas.
    const utiles = cabeceras.filter((c) => !RE_PIE.test(c));
    const clavesPrimera = new Set(primera.map(clave));
    const capitulo = utiles.find((c) => clavesPrimera.has(clave(c))) || null;
    const libro = utiles.find((c) => c !== capitulo && clave(c).split(' ').length >= 3) || null;
    const autor = primera.find((l) => RE_NOMBRE.test(l) && !GRAMATICALES.test(l) && clave(l) !== clave(capitulo || '')) || null;

    const capitalizar = (s) => (s && s === s.toUpperCase()
        ? s.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
        : s);
    return {
        lineas: primera,
        cabeceras: cabeceras.slice(0, 8),
        sugerencia: {
            titulo: capitulo ? capitalizar(capitulo) : null,
            autor: autor ? capitalizar(autor) : null,
            libro: libro ? capitalizar(libro) : null,
        },
    };
}
