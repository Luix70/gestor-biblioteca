import path from 'path';
import { arbolCDU } from './cdu-arbol.js';

// Nombres reservados de Windows que no pueden ser un segmento de ruta.
const RESERVADOS = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Caracteres prohibidos en un segmento: ilegales en FS (<>:"/\|?*), de CONTROL (0x00-0x1f) y los que
// ROMPEN una URL bajo /recursos (# = fragmento, % = inicio de %-escape). NO se tocan los espacios (válidos
// y ya en uso; el navegador los codifica). Se construye sin rangos accidentales para no mutilar dígitos.
const PROHIBIDOS = new RegExp('[\\x00-\\x1f<>:"/\\\\|?*#%]', 'g');

/**
 * Sanea un segmento de ruta para que sea válido en Windows y Linux Y SEGURO en una URL (se sirve bajo
 * /recursos). La CDU "141.78:81'37" → "141.78_81_37"; "The Sandman Universe #01" → "The Sandman Universe _01".
 */
export function sanitizarSegmento(s) {
    let limpio = String(s || '')
        .replace(PROHIBIDOS, '_')
        .replace(/['`]/g, '_')
        .replace(/\s+/g, ' ')
        .replace(/_+/g, '_')
        .trim()
        .replace(/[. ]+$/g, ''); // Windows no admite punto/espacio final
    if (!limpio) limpio = 'sin_nombre';
    if (RESERVADOS.test(limpio)) limpio = `_${limpio}`;
    return limpio.slice(0, 100);
}

/**
 * Construye la ruta de catálogo de un recurso siguiendo la estructura CDU jerárquica:
 *   libros:   <clase>/<division>/<cdu>/<libros>/<isbn|issn|id[-discriminador]>
 *   revistas: <clase>/<division>/<cdu>/<revistas>/<issn|titulo|id>/<año[-mes]>
 * Los 3 primeros segmentos (clase de 1 dígito · división de 2-3 dígitos · CDU limpio) los
 * calcula arbolCDU(), que recorta literales (nombres/títulos) y mojibake del CDU sucio.
 * Devuelve { segmentos, relativa, web } (web usa '/' para servir como estático).
 *
 * `discriminador` (libros): sufijo que distingue ediciones/versiones distintas que comparten
 * el mismo ISBN (p. ej. dos revisiones de ePubLibre del mismo libro → dos documentos Mongo,
 * pero el ISBN como hoja colisionaría). El llamante lo añade solo cuando detecta esa colisión.
 */
export function rutaCatalogo({ cdu, tipo_recurso, isbn, issn, id, año_edicion, mes_publicacion, titulo, discriminador, obra, volumen_numero, clave_numero }) {
    const cduSegs = arbolCDU(cdu || '').segmentos;   // [clase, division, cdu] (o [_sin_clasificar, …])

    // Tomo de obra multivolumen DE LIBROS: <clase>/<division>/<cdu>/obras/<obra>/<vol-N>/ (todos los
    // tomos de la obra juntos, bajo la CDU de la obra). 'obra' = isbn_obra | título | id de la obra.
    // ⚠ Las REVISTAS NO entran aquí aunque tengan obra (su cabecera): tienen su propia estructura
    // revistas/<issn>/<año-mes> (más abajo). Si entraran, TODOS sus números caerían en el mismo
    // 'vol-x' (volumen_numero es null) y se pisarían — regresión del modelo de cabeceras.
    if (obra && tipo_recurso !== 'revista') {
        const obraSeg = sanitizarSegmento(obra);
        // discriminador: dos tomos que caerían en el MISMO vol (p. ej. ambos sin volumen_numero → 'vol-x')
        // → cada documento conserva SU carpeta (1 doc ↔ 1 carpeta). Sin esto el sufijo se ignoraba y los
        // tomos sin número colisionaban en obras/<obra>/vol-x (lo aprovecha la red anti-colisión del servicio).
        let volSeg = sanitizarSegmento('vol-' + (volumen_numero != null ? String(volumen_numero) : 'x'));
        if (discriminador) volSeg = sanitizarSegmento(`${volSeg}-${discriminador}`);
        const segmentos = [...cduSegs, 'obras', obraSeg, volSeg];
        return { segmentos, relativa: path.join(...segmentos), web: '/recursos/' + segmentos.join('/') };
    }

    // Carpeta por tipo de documento. Los tipos nuevos (artículo/capítulo/apuntes) tienen su propia rama; el
    // resto (libro y cualquier tipo no listado) cae en 'libros'. Las revistas llevan además cabecera/año (abajo).
    const tipoSeg = { revista: 'revistas', articulo: 'articulos', capitulo: 'capitulos', apuntes: 'apuntes' }[tipo_recurso] || 'libros';

    if (tipo_recurso === 'revista') {
        const cabeceraSeg = sanitizarSegmento(issn || titulo || String(id));
        const segmentos = [...cduSegs, tipoSeg, cabeceraSeg];
        // Carpeta del NÚMERO. Se prefiere la fecha (AAAA-MM → AAAA), que ordena cronológicamente; si no se
        // conoce, vale la CLAVE del número (`n97`). Antes, sin año no se añadía segmento y TODOS los números
        // de la cabecera caían en la misma carpeta, resueltos a golpe de discriminador: 692 carpetas hermanas
        // «<issn>-<id>» para una sola colección (los Don Miki, de los que solo 150 de 692 traen año). La
        // identidad de un número ES (colección, clave_numero) — la carpeta debe poder reflejarla.
        // MISMA prioridad que `revistas.js · claveNumero`, que es quien define la identidad del número:
        // AAAA-MM → n<nº> → AAAA. Ojo con el orden: preferir el AÑO SUELTO al número metía los 52 ejemplares
        // de 1977 en una sola carpeta, cuando cada uno tiene su nº. El año solo manda si trae mes.
        const numeroSeg = (año_edicion && mes_publicacion)
            ? `${año_edicion}-${String(mes_publicacion).padStart(2, '0')}`
            : (clave_numero || (año_edicion ? String(año_edicion) : null));
        if (numeroSeg) segmentos.push(sanitizarSegmento(String(numeroSeg)));
        // discriminador: dos números que caerían en la MISMA carpeta (mismo año sin mes) → cada
        // documento conserva SU carpeta (1 doc ↔ 1 carpeta), sin pisar ficheros ni sidecars.
        if (discriminador) segmentos[segmentos.length - 1] = sanitizarSegmento(`${segmentos[segmentos.length - 1]}-${discriminador}`);
        return {
            segmentos,
            relativa: path.join(...segmentos),
            web: '/recursos/' + segmentos.join('/'),
        };
    }

    const baseLeaf = isbn || issn || String(id) || 'sin_id';
    const hojaSeg = sanitizarSegmento(discriminador ? `${baseLeaf}-${discriminador}` : baseLeaf);
    const segmentos = [...cduSegs, tipoSeg, hojaSeg];
    return {
        segmentos,
        relativa: path.join(...segmentos),
        web: '/recursos/' + segmentos.join('/'),
    };
}
