/**
 * MATERIAL NO CATALOGABLE — ¿hay en esta carpeta algo que la biblioteca sepa catalogar?
 *
 * Lo usan PreProceso (no pasa al Inbox lo que no se puede catalogar), la inspección de carpetas (no le pone una guía
 * de unidad: «omitir» con el motivo) y el Vigilante (avisa una vez en vez de saltarse la carpeta en silencio).
 * Casos medidos el 3-nov en Physics: un curso en vídeo (25 .m4v) con guía «obra» se saltaba sin decir nada; 8 .dvi,
 * igual; y «Microwave Engineering» era una descarga INCOMPLETA (su .sfv lista los PDF, que no estaban: solo quedaban un
 * lector de DjVu, el .nfo y el .sfv) a la que la inspección puso guía «software».
 *
 * Decisión del usuario (3-nov): los cursos en vídeo no se catalogan por ahora. Lo no catalogable se queda donde está y
 * se avisa en el log y con un fichero `.NO_CATALOGABLE.txt` en la carpeta. Empieza por punto para que ningún recorrido
 * lo tome por material (todos ignoran los ocultos); en Windows y en File Station se ve igual.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { esDocumentoLeible, esImagenArchivo, esMaterialNotable, esVideo } from './criba-material.js';
import { esAudio } from './lector-audio.js';

export const AVISO_NO_CATALOGABLE = '.NO_CATALOGABLE.txt';

// Lo que sí lleva a un registro aunque no sea un documento con lector: comprimidos (se expanden), un libro en HTML
// (va «intacto») y programas (van como software).
const RE_CATALOGABLE_EXTRA = /\.(zip|rar|7z|tar|tgz|gz|html?|exe|msi|apk|jar)$/i;
const MAX_FICHEROS = 50000;   // «Computers» tiene 49.000: se mira entero, pero nunca sin límite

/** ¿Este fichero (ruta relativa POSIX + bytes) acaba en un registro de la biblioteca? */
export function esFicheroCatalogable(rel, bytes = null) {
    const nombre = rel.split('/').pop();
    if (esVideo(nombre)) return false;   // decisión del usuario: los vídeos no se catalogan
    return esDocumentoLeible(nombre) || esAudio(nombre) || esImagenArchivo(nombre)
        || RE_CATALOGABLE_EXTRA.test(nombre) || esMaterialNotable(rel, bytes);
}

/** Recorre el árbol (los ocultos y los de sistema no cuentan) y devuelve [{ rel, bytes }]. */
async function ficherosDe(raiz) {
    const out = [];
    const pila = [''];
    while (pila.length && out.length < MAX_FICHEROS) {
        const rel = pila.pop();
        let entradas;
        try { entradas = await fs.readdir(path.join(raiz, rel), { withFileTypes: true }); } catch { continue; }
        for (const e of entradas) {
            if (/^[.@#]/.test(e.name) || e.name === '_guia.json' || /^(thumbs\.db|desktop\.ini)$/i.test(e.name)) continue;
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { pila.push(r); continue; }
            if (!e.isFile()) continue;
            let bytes = null;
            try { bytes = (await fs.stat(path.join(raiz, r))).size; } catch { /* sin stat */ }
            out.push({ rel: r, bytes });
        }
    }
    return out;
}

/**
 * Ficheros que lista un .sfv (comprobación de una descarga) y que no están. Solo cuentan los documentos: que falte un
 * .nfo o un .txt de la descarga da igual; que falte el libro, no.
 */
async function faltanDelSfv(raiz, ficheros) {
    const faltan = [];
    for (const f of ficheros.filter((x) => /\.sfv$/i.test(x.rel))) {
        let texto;
        try { texto = await fs.readFile(path.join(raiz, f.rel), 'latin1'); } catch { continue; }
        const dirSfv = path.posix.dirname(f.rel);
        for (const linea of texto.split(/\r?\n/)) {
            // Línea de datos: «ruta\con\barras crc32»; los comentarios empiezan por «;».
            const m = linea.match(/^([^;].*?)\s+[0-9a-f]{8}\s*$/i);
            if (!m) continue;
            const listado = m[1].trim().replace(/\\/g, '/');
            if (!esDocumentoLeible(listado)) continue;
            const rel = dirSfv === '.' ? listado : `${dirSfv}/${listado}`;
            const esta = await fs.access(path.join(raiz, ...rel.split('/'))).then(() => true).catch(() => false);
            if (!esta) faltan.push(listado);
        }
    }
    return faltan;
}

/**
 * Examina una carpeta (o un fichero suelto). Devuelve { total, catalogables, porExtension, faltanSfv, motivo };
 * `motivo` es null si hay algo catalogable y la descarga está completa, o el porqué de que no lo sea. Una carpeta vacía
 * no es asunto de esta comprobación (motivo null).
 */
export async function examinarCatalogable(ruta) {
    const st = await fs.stat(ruta).catch(() => null);
    if (!st) return { total: 0, catalogables: 0, porExtension: {}, faltanSfv: [], motivo: null };
    const ficheros = st.isDirectory() ? await ficherosDe(ruta) : [{ rel: path.basename(ruta), bytes: st.size }];
    const porExtension = {};
    let catalogables = 0, videos = 0;
    for (const f of ficheros) {
        if (esFicheroCatalogable(f.rel, f.bytes)) { catalogables++; continue; }
        const ext = path.extname(f.rel).toLowerCase() || '(sin extensión)';
        porExtension[ext] = (porExtension[ext] || 0) + 1;
        if (esVideo(f.rel)) videos++;
    }
    const faltanSfv = st.isDirectory() ? await faltanDelSfv(ruta, ficheros) : [];

    let motivo = null;
    if (faltanSfv.length) {
        motivo = `descarga INCOMPLETA: su .sfv lista ${faltanSfv.length} documento(s) que no están (p. ej. «${faltanSfv[0]}»)`;
    } else if (ficheros.length && !catalogables) {
        const lista = Object.entries(porExtension).sort((a, b) => b[1] - a[1]).map(([e, n]) => `${n} ${e}`).join(', ');
        motivo = `nada catalogable (${lista})${videos ? '; los vídeos no se catalogan' : ''}`;
    }
    return { total: ficheros.length, catalogables, porExtension, faltanSfv, motivo };
}

/**
 * Deja el aviso en la carpeta (o, para un fichero suelto, en su carpeta, nombrándolo). Solo reescribe si cambia el
 * texto, para no alterar la carpeta en cada pasada (PreProceso la reanaliza si cambia).
 */
export async function escribirAvisoNoCatalogable(ruta, examen, { donde = '' } = {}) {
    const esDir = (await fs.stat(ruta).catch(() => null))?.isDirectory();
    const dir = esDir ? ruta : path.dirname(ruta);
    const destino = path.join(dir, AVISO_NO_CATALOGABLE);
    const lineas = [
        `NO CATALOGABLE${esDir ? '' : ` · «${path.basename(ruta)}»`}`,
        '',
        `Motivo: ${examen.motivo}`,
        ...(Object.keys(examen.porExtension).length
            ? ['', 'Ficheros que la biblioteca no cataloga:', ...Object.entries(examen.porExtension).map(([e, n]) => `  · ${n} ${e}`)] : []),
        ...(examen.faltanSfv.length
            ? ['', 'Faltan (según el .sfv):', ...examen.faltanSfv.slice(0, 30).map((f) => `  · ${f}`),
                ...(examen.faltanSfv.length > 30 ? [`  · … y ${examen.faltanSfv.length - 30} más`] : [])] : []),
        '',
        `Qué pasa: ${donde || 'no se cataloga'}. Nada se borra.`,
        'Qué hacer: sácala de aquí si no la quieres en la biblioteca, o complétala (la descarga que falta, el formato',
        'que sí se cataloga). Al cambiar la carpeta se vuelve a examinar; este aviso se puede borrar.',
    ];
    const texto = lineas.join('\n') + '\n';
    const previo = await fs.readFile(destino, 'utf8').catch(() => null);
    if (previo === texto) return;
    // Varios ficheros sueltos de una misma carpeta: se acumulan en el mismo aviso (cada uno una vez).
    if (!esDir && previo?.includes(`«${path.basename(ruta)}»`)) return;
    const final = !esDir && previo ? `${previo}\n${'─'.repeat(40)}\n${texto}` : texto;
    await fs.writeFile(destino, final).catch(() => {});
}
