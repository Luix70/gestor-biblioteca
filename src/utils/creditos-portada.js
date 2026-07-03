/**
 * Lee los CRÉDITOS de la PORTADA/PORTADILLA de un libro (título + colaboradores con su función tal y como
 * están IMPRESOS) con la visión multi-proveedor (gratis→pago). Sirve para el enriquecimiento «a fondo»:
 * muchos libros llegan con el AUTOR puesto a la EDITORIAL (p. ej. «DK» = Dorling Kindersley) o sin roles,
 * cuando la portadilla del propio fichero sí lista a los verdaderos autores/ilustradores/traductores
 * («Stories retold by X», «Illustrations by Y», «Traducción de Z»). Eso —leer el documento en sí— es la
 * información que las APIs externas no tienen.
 *
 * NO inventa: devuelve solo lo impreso. El mapeo de la función impresa → rol canónico lo hacemos NOSOTROS
 * (más fiable que pedírselo al modelo). Roles canónicos: autor · traductor · ilustrador · prologuista ·
 * anotador · editor · compilador (los mismos de contribuciones.js).
 */
import { conVision, extraerJSON } from './vision.js';

// Nombres que suelen ser la EDITORIAL colada como «autor» (o autoría genérica sin persona). Si el autor de
// un libro es uno de estos, es candidato ideal a leer la portadilla para obtener los autores reales.
export const PLACEHOLDERS_AUTOR = [
    'dk', 'd.k.', 'dorling kindersley', 'vv.aa.', 'vv. aa.', 'vvaa', 'aa.vv.', 'aa. vv.', 'aavv',
    'varios autores', 'varios', 'autores varios', 'various', 'various authors', 'anonimo', 'anónimo', 'anonymous', 'colectivo',
    'the editors', 'editors of', 'staff', 'sin autor', 's.a.', 'n/a',
];

// Normaliza para comparar (minúsculas, sin acentos, espacios colapsados).
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/**
 * ¿El «autor» es en realidad la editorial o una autoría genérica (placeholder)?
 * @param {string} nombre   nombre del autor
 * @param {string} [editorial]  nombre de la editorial (si coincide con el autor, también es placeholder)
 */
export function esAutorPlaceholder(nombre, editorial = null) {
    const n = norm(nombre);
    if (!n) return true;
    if (PLACEHOLDERS_AUTOR.includes(n)) return true;
    if (editorial && norm(editorial) === n) return true; // el autor ES la editorial
    return false;
}

// Frase de función impresa (EN/ES) → rol canónico. Devuelve null si no reconoce una función de persona.
export function mapearRolPortada(funcion) {
    const s = norm(funcion);
    if (!s) return null;
    // Traducción
    if (/\btransl|traduc|traduccion|traducido|ubersetz/.test(s)) return 'traductor';
    // Ilustración / dibujo / arte
    if (/\billustrat|ilustrac|ilustrad|dibuj|\bart by|artwork|drawings?|grabad|laminas/.test(s)) return 'ilustrador';
    // Prólogo / introducción / prefacio
    if (/\bforeword|introduc|preface|prefac|prolog|prologue/.test(s)) return 'prologuista';
    // Notas / anotación
    if (/\bnotes by|annotat|anotad|\bnotas\b|comentari/.test(s)) return 'anotador';
    // Compilación / selección / antología
    if (/\bcompil|selecc|antolog|recopil|curated|gathered/.test(s)) return 'compilador';
    // Edición
    if (/\bedited by|\beditor|edicion de|\bedicion\b/.test(s)) return 'editor';
    // Texto / autoría / narración / adaptación (todo lo que "escribe" el contenido → autor)
    if (/\btext by|written by|\bwriter|stories|retold|retelling|adapt|narrac|narrad|version|texto|escrito|\bby\b|\bde\b|autor/.test(s)) return 'autor';
    return null;
}

// Prompt para leer la portada/portadilla/créditos. Pide la FUNCIÓN textual (la mapeamos nosotros).
const PROMPT_CREDITOS = `Eres un catalogador bibliográfico. En estas imágenes (PORTADA, PORTADILLA y/o página de créditos de un
libro) localiza las PERSONAS acreditadas y su FUNCIÓN tal y como está IMPRESA (por ejemplo: "stories retold
by", "all other text by", "illustrations by", "translated by", "edited by", "foreword by", "ilustraciones
de", "traducción de", "edición de"…).
Reglas:
- Incluye SOLO lo que esté impreso; NO inventes. Nombres COMPLETOS de persona.
- IGNORA la editorial y sus logos (p. ej. "DK", "Dorling Kindersley", "Penguin", "SM", "Alianza") — NO son
  personas.
- Si una función acredita a varias personas, crea una entrada por persona.
Devuelve SOLO un objeto JSON válido (sin markdown ni texto fuera):
{
  "titulo": "<título del libro tal como aparece; '' si no se ve>",
  "creditos": [ { "nombre": "<nombre completo de la persona>", "funcion": "<función impresa, textual>" } ]
}`;

/**
 * Lee los créditos de la portadilla a partir de imágenes (Buffers) de las primeras páginas.
 * @param {Array<{data:Buffer, mimeType?:string}>} imagenes
 * @returns {Promise<{ titulo:string|null, contribuciones:Array<{nombre:string, rol:string, funcion:string}> }>}
 */
export async function leerCreditosDeImagenes(imagenes) {
    const partes = (imagenes || [])
        .filter((i) => i && i.data)
        .slice(0, 4) // portada + portadilla + créditos suelen estar en las primeras páginas
        .map(({ data, mimeType }) => ({ base64: data.toString('base64'), mimeType: mimeType || 'image/jpeg' }));
    if (!partes.length) return { titulo: null, contribuciones: [] };

    let j;
    try {
        j = extraerJSON(await conVision({ prompt: PROMPT_CREDITOS, imagenes: partes }));
    } catch (e) {
        console.warn(`   ⚠️ lector de créditos (visión) falló: ${e.message}`);
        return { titulo: null, contribuciones: [] };
    }
    if (!j) return { titulo: null, contribuciones: [] };

    const vistos = new Set();
    const contribuciones = [];
    for (const c of Array.isArray(j.creditos) ? j.creditos : []) {
        const nombre = String(c?.nombre || '').replace(/\s+/g, ' ').trim();
        const rol = mapearRolPortada(c?.funcion);
        if (!nombre || nombre.length < 2 || !rol) continue;
        if (esAutorPlaceholder(nombre)) continue; // no metas la editorial como persona
        const clave = norm(nombre) + '|' + rol;
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        contribuciones.push({ nombre, rol, funcion: String(c?.funcion || '').trim() });
    }
    return { titulo: (j.titulo && String(j.titulo).trim()) || null, contribuciones };
}
