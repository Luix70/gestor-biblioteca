import axios from 'axios';
import { medirImagen } from './medir-imagen.js';
import { rasterizarPaginas } from './rasterizar-pdf.js';

// Una portada legible es ancha. Objetivo deseable y mínimo aceptable (por debajo del mínimo
// la imagen se descarta: así cae el GIF 1x1 que OpenLibrary sirve como marcador de "sin portada").
const ANCHO_OBJETIVO = Number(process.env.PORTADA_ANCHO_OBJETIVO || 1000);
const ANCHO_MINIMO   = Number(process.env.PORTADA_ANCHO_MINIMO   || 100);
const ANCHO_DECENTE  = Number(process.env.PORTADA_ANCHO_DECENTE  || 500); // si ya hay algo así, no se descargan remotos

function evaluar(buffer, origen) {
    if (!buffer || !buffer.length) return null;
    const m = medirImagen(buffer);
    if (!m || m.width < ANCHO_MINIMO || m.height < ANCHO_MINIMO) return null; // degenerada / no legible
    return { base64: buffer.toString('base64'), origen, ancho: m.width, alto: m.height };
}

async function descargar(url) {
    try {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000 });
        return Buffer.from(res.data);
    } catch {
        return null;
    }
}

/**
 * Elige la MEJOR portada (la más ancha y legible) entre la cubierta embebida del archivo, las
 * portadas remotas (OpenLibrary/Google Books) y —solo si hace falta— el rasterizado del PDF.
 * Descarta imágenes degeneradas (el 1x1 de OpenLibrary) y evita descargas/rasterizados inútiles.
 *
 * @returns {{ portada: {base64,origen,ancho,alto}|null, extras: Array }}
 */
export async function resolverPortada({ tipo, rutas = [], numPaginas = 2, embebidaBase64 = null, remotos = [] }) {
    const candidatas = [];
    const extras = [];
    const mejor = () => candidatas.slice().sort((a, b) => b.ancho - a.ancho)[0] || null;

    // 1. Cubierta embebida en el archivo (EPUB): la fuente preferida y gratis.
    if (embebidaBase64) {
        const c = evaluar(Buffer.from(embebidaBase64, 'base64'), 'archivo');
        if (c) candidatas.push(c);
    }

    // 2. Portadas remotas: solo si aún no tenemos algo decente (evita descargas si el EPUB ya
    //    trae buena cubierta). Se para en cuanto una alcanza el objetivo.
    if (!mejor() || mejor().ancho < ANCHO_DECENTE) {
        for (const r of remotos) {
            const c = evaluar(await descargar(r.url), r.origen);
            if (c) {
                candidatas.push(c);
                if (c.ancho >= ANCHO_OBJETIVO) break;
            }
        }
    }

    // 3. Escalada PDF: si lo mejor no llega al objetivo, rasterizar páginas clave (poppler).
    //    La página 1 compite como portada; las demás (portadilla, contraportada) quedan de extra.
    if ((!mejor() || mejor().ancho < ANCHO_OBJETIVO) && tipo === 'pdf' && rutas[0]) {
        for (const p of await rasterizarPaginas(rutas[0], { numPaginas })) {
            const c = evaluar(p.buffer, `pdf:${p.etiqueta}`);
            if (!c) continue;
            if (p.etiqueta === 'portada') candidatas.push(c);
            else extras.push(c);
        }
    }

    return { portada: mejor(), extras };
}
