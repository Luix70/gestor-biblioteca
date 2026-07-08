/**
 * LECTOR DE METADATOS DE AUDIO — envuelve `music-metadata` (JS puro, apto para el Atom) para leer los tags
 * de un fichero de audio (ID3v1/v2 de MP3, átomos MP4 de M4A/M4B, FLAC, Ogg) y AGREGAR los de un audiolibro
 * entero (muchas pistas) en unos pocos datos de obra: título, autor, año, narrador, género, carátula embebida.
 *
 * Es la fuente de identificación MÁS BARATA de un audiolibro (local, sin IA): `album`→título de la obra,
 * `artist`→autor (con matices, ver abajo), `year`→año, `comment`→narrador («read by …»).
 */
import { parseFile } from 'music-metadata';
import path from 'node:path';

export const EXT_AUDIO = ['.mp3', '.m4a', '.m4b', '.ogg', '.oga', '.opus', '.wav', '.aac', '.flac', '.wma'];
export const esAudio = (n) => EXT_AUDIO.includes(path.extname(n).toLowerCase());

// Quita el sufijo de DISCO del álbum: «Le grand Meaulnes CD1» / «… (CD 2)» / «… Disco 3» → «Le grand Meaulnes».
export function limpiarAlbum(album) {
    return String(album || '')
        .replace(/\s*[([-]?\s*(cd|dis[ck]o?|parte?|vol(?:umen)?)\s*\.?\s*\d+\s*[)\]]?\s*$/i, '')
        .trim() || null;
}

// Narrador a partir de los comentarios: «read by X», «narrated by X», «leído por X», «narración de X».
// Ignora comentarios que sean URLs o basura de ripeo.
function extraerNarrador(comment) {
    const coms = (Array.isArray(comment) ? comment : [comment]).filter(Boolean).map(String);
    for (const c of coms) {
        const m = c.match(/(?:read by|narrated by|narrator[:\s]|le[íi]do por|narraci[óo]n de|voz[:\s])\s*(.+)/i);
        if (m) return m[1].trim().replace(/\s+/g, ' ');
    }
    return null;
}

/**
 * Lee los metadatos de UN fichero de audio. Best-effort: nunca lanza; ante error devuelve null.
 * @returns {Promise<null|{titulo,albumBruto,artista,albumArtist,anio,genero,narrador,pista,disco,duracion,portada}>}
 */
export async function leerMetadatosAudio(ruta) {
    try {
        const { common, format } = await parseFile(ruta, { duration: false }); // sin escanear todo el fichero (rápido)
        const pic = common.picture && common.picture[0];
        return {
            album: limpiarAlbum(common.album),          // título de la OBRA (sin sufijo « CDN»)
            tituloPista: (common.title || '').trim() || null, // título de ESTA pista (para la playlist)
            albumBruto: common.album || null,
            artista: (common.artist || '').trim() || null,
            albumArtist: (common.albumartist || '').trim() || null,
            anio: common.year || null,
            genero: (common.genre && common.genre[0]) || null,
            narrador: extraerNarrador(common.comment),
            pista: common.track?.no || null,
            disco: common.disk?.no || null,
            duracion: format?.duration || null,
            portada: pic?.data ? { buffer: Buffer.from(pic.data), mime: pic.format || 'image/jpeg' } : null,
        };
    } catch {
        return null;
    }
}

// El valor más frecuente (no nulo) de una lista; desempata por el primero visto.
function moda(valores) {
    const cuenta = new Map();
    for (const v of valores) if (v != null && v !== '') cuenta.set(v, (cuenta.get(v) || 0) + 1);
    let mejor = null, max = 0;
    for (const [v, n] of cuenta) if (n > max) { max = n; mejor = v; }
    return mejor;
}

/**
 * AGREGA los metadatos de todas las pistas de un audiolibro en datos de OBRA. Decisión clave sobre el autor:
 *   · Si TODAS las pistas comparten un mismo `artist` (o hay `albumartist`) → es el AUTOR (Borges, Plutarch,
 *     Fournier). `autorFuente:'id3'`.
 *   · Si el `artist` VARÍA entre pistas → son NARRADORES (p. ej. «From Shakespeare With Love», un actor por
 *     soneto): NO se toma como autor (se deja null para resolverlo por carpeta/ISBN/API) y se marca coral.
 * Nunca inventa: mejor sin autor que un autor falso (máxima del proyecto).
 *
 * @param {Array} pistas  metadatos por pista (de leerMetadatosAudio), en el orden de reproducción.
 */
export function agregarMetadatos(pistas) {
    const validas = pistas.filter(Boolean);
    const titulo = moda(validas.map((p) => p.album)); // título de la obra = álbum más frecuente
    const anio = moda(validas.map((p) => p.anio));
    const genero = moda(validas.map((p) => p.genero));

    const albumArtists = [...new Set(validas.map((p) => p.albumArtist).filter(Boolean))];
    const artistas = [...new Set(validas.map((p) => p.artista).filter(Boolean))];
    let autor = null, autorFuente = null, coral = false;
    if (albumArtists.length === 1) {
        autor = albumArtists[0]; autorFuente = 'id3-albumartist';
    } else if (artistas.length === 1) {
        autor = artistas[0]; autorFuente = 'id3-artist';
    } else if (artistas.length > 1) {
        coral = true; // varios «artist» = varios narradores, no un autor
    }

    // Narrador: el de los comentarios; si no hay y es coral, se listan los artistas (narradores).
    const narradores = [...new Set(validas.map((p) => p.narrador).filter(Boolean))];
    const narrador = narradores.length ? narradores.join(', ') : (coral ? artistas.join(', ') : null);

    const conPortada = validas.find((p) => p.portada);
    const duracionTotal = validas.reduce((s, p) => s + (p.duracion || 0), 0) || null;

    return { titulo, autor, autorFuente, coral, anio, genero, narrador, portadaEmbebida: conPortada?.portada || null, duracionTotal };
}
