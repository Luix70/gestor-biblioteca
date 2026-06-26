/**
 * Lector de CÓMIC (.cbz/.cbr/.cb7) — un cómic es un archivo comprimido de imágenes (una por página).
 *
 *   .cbz = ZIP  → se abre en el NAS con adm-zip (C ligero, sin SIMD → apto para el Atom): se extrae la
 *                 PRIMERA imagen como PORTADA y se cuenta el nº de páginas.
 *   .cbr = RAR / .cb7 = 7z → NO hay descompresor en el Atom (unrar es non-free; 7z aparte). No se extrae
 *                 portada en el servidor: se cataloga por NOMBRE (la previsualización la hará el navegador).
 *
 * Clasificación (auto): un NÚMERO de una serie (nº de ejemplar / fechado, p. ej. "Don Miki Nº Extra 1986")
 * → revista (cabecera-colección por serie); un ÁLBUM/novela gráfica suelto → libro. Ambos llevan
 * `naturaleza:'comic'`. Devuelve un datosBase compatible con el resto del pipeline.
 */
import AdmZip from 'adm-zip';
import path from 'path';
import { parsearNombre } from './parsear-nombre.js';

const ES_IMG = /\.(jpe?g|png|webp|gif|bmp|avif)$/i;

// Nº de ejemplar en el NOMBRE del cómic: "Nº 12", "N 3", "#5", "núm 7", o "Extra"/"Especial" (cómics
// con número simbólico). Un número/extra ⇒ es un EJEMPLAR de una serie (→ revista-colección).
function extraerNumeroComic(s) {
    if (!s) return null;
    const m = s.match(/(?:n[º°.]?|núm\.?|num\.?|#)\s*(\d{1,4})\b/i);
    if (m) return m[1];
    if (/\b(extra|especial|almanaque|anuario)\b/i.test(s)) return 'extra';
    return null;
}

// Nombre de la SERIE a partir del nombre del ejemplar: corta en el PRIMER marcador de número/ejemplar
// ("Don Miki N Extra Navidad 1986…" → "Don Miki"). Da una CABECERA limpia y ESTABLE para que los
// ejemplares de la misma serie agrupen juntos (sin esto, cada nº sería su propia cabecera). Prudente:
// si el recorte dejara algo demasiado corto, devuelve el original.
function serieComic(s) {
    let t = String(s || '');
    t = t.replace(/\s+\bn[º°.]?\b.*$/i, '');                                  // "N"/"Nº" (abrev. de número) y lo que siga
    t = t.replace(/\s+#?\d{1,4}\b.*$/, '');                                   // primer nº de 1-4 cifras y lo que siga
    t = t.replace(/\s+\b(extra|especial|almanaque|anuario)\b.*$/i, '');       // marcador simbólico y lo que siga
    t = t.replace(/[\s\-–—_]+$/, '').trim();
    return t.length >= 2 ? t : String(s || '').trim();
}

export function extraerMetadatosComic(ruta) {
    const ext = path.extname(ruta).toLowerCase();
    const nombre = path.basename(ruta, ext);
    const datos = {
        titulo: null, autores: [], naturaleza: 'comic',
        formatos: [ext.slice(1)],            // cbz | cbr | cb7 (setup-mongo amplía el enum de formatos)
        texto_legible: false,
        alertas_agente: [],
    };

    // PORTADA: solo CBZ (ZIP) se descomprime en el Atom. La 1ª imagen (orden natural) es la cubierta.
    if (ext === '.cbz') {
        try {
            const zip = new AdmZip(ruta);
            const imgs = zip.getEntries()
                .filter(e => !e.isDirectory && ES_IMG.test(e.entryName))
                .sort((a, b) => a.entryName.localeCompare(b.entryName, undefined, { numeric: true, sensitivity: 'base' }));
            if (imgs.length) {
                datos.paginas = imgs.length;
                datos.cubierta_base64 = imgs[0].getData().toString('base64'); // → portada (resolverPortada)
            } else {
                datos.alertas_agente.push('CBZ sin imágenes legibles: catalogado por nombre.');
            }
        } catch (e) {
            datos.alertas_agente.push(`CBZ no legible (${e.message}): catalogado por nombre.`);
        }
    } else {
        datos.alertas_agente.push(`${ext.slice(1).toUpperCase()} no se descomprime en el servidor: catalogado por nombre (previsualización en el navegador).`);
    }

    // Título / serie / nº a partir del NOMBRE (curador). Los cómics suelen usar '_' como separador. NO se
    // parten autores por " - " (en cómics suele ser "Serie - Álbum", no "Título - Autor"): el nombre
    // limpio ES el título; los autores los aportará la visión/APIs si acaso.
    const limpio = nombre.replace(/_+/g, ' ').replace(/\s+/g, ' ').trim();
    const p = parsearNombre(limpio);
    datos.titulo = limpio;
    if (p.coleccion_nombre) { datos.coleccion_nombre = p.coleccion_nombre; if (p.coleccion_numero) datos.coleccion_numero = p.coleccion_numero; }
    if (p.esFechada) { datos.esFechada = true; datos.año_edicion = p.año_edicion; if (p.mes_publicacion) datos.mes_publicacion = p.mes_publicacion; }
    const numero = extraerNumeroComic(limpio);
    if (numero) datos.numero_issue = numero;

    // SERIE (número de ejemplar / fechado) vs ÁLBUM suelto (novela gráfica). El discriminador decide el
    // tipo_recurso final; aquí se aporta la señal.
    datos.comic_serie = !!(numero || p.esFechada);
    // Para una SERIE, la CABECERA se resuelve de obra_titulo (nombre limpio de serie), no del título
    // ruidoso del ejemplar → los nº de la misma serie agrupan juntos.
    if (datos.comic_serie) {
        const serie = serieComic(limpio);
        if (serie && serie.toLowerCase() !== limpio.toLowerCase()) datos.obra_titulo = serie;
    }
    return datos;
}
