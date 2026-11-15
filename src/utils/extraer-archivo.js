/**
 * Extrae un archivo COMPRIMIDO (.zip/.rar/.7z, y los cómics .cbr=RAR, .cb7=7z, .cbz=ZIP) a un directorio, y lista
 * su contenido sin extraerlo.
 *
 * Usa `bsdtar` (libarchive) como extractor PRINCIPAL porque, a diferencia de `unar` (The Unarchiver),
 * SÍ lee **RAR5** — el formato por defecto del RAR moderno (un .cbr de WinRAR reciente es RAR5 y unar
 * no lo abría). bsdtar maneja además RAR4/7z/ZIP. Si bsdtar falla, se intenta `unar` como respaldo
 * (algún RAR4/7z residual). Ambos son C nativo (aptos para el Atom) y vuelcan a disco (poca RAM).
 *
 * SIN TOPE DE TIEMPO; CON VIGILANTE DE AVANCE (15-nov). Antes había un tope fijo de 5 minutos para todo: DIY.zip
 * (52 GB), SCIENCE.zip (16,7 GB), ANTHOLOGIES.zip y NEWS.zip no se pueden extraer en 5 minutos en el Atom, así que
 * bsdtar moría a mitad, unar (que no lee esos ZIP enormes) fallaba también, y los cuatro acabaron en Cuarentena como
 * «dañados» estando sanos. Regla del usuario: «si se está descomprimiendo y han pasado 5 minutos no lo podemos
 * interrumpir». Ahora un proceso que AVANZA no se para nunca, dure lo que dure. Solo se para si se ATASCA: ni un
 * fichero nuevo extraído (bsdtar -v anuncia cada uno) ni el fichero en curso creciendo durante EXTRAER_SIN_AVANCE_MIN
 * (config.js). Un proceso parado así se marca `atascado` para que nadie lo tome por un fichero dañado.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

const TICK_MS = 30 * 1000;
const sinAvanceMs = () => Math.max(1, Number(process.env.EXTRAER_SIN_AVANCE_MIN || 20)) * 60 * 1000;

/**
 * Ejecuta `cmd args` vigilando que avance. «Avance» = una línea nueva en su salida (cada fichero que anuncia) o, si
 * no, que crezca el fichero que anunció el último (uno solo de 10 GB tarda en escribirse sin decir nada más).
 * @param {{ dirSalida?: string, nombreDeLinea?: (l:string)=>string|null, guardarSalida?: boolean }} opts
 *   dirSalida + nombreDeLinea: dónde mirar el fichero en curso; guardarSalida: devolver todas las líneas (listar).
 * @returns {Promise<{lineas: string[]}>}  lanza Error con `.atascado` si se paró por no avanzar.
 */
function ejecutarVigilado(cmd, args, { dirSalida = null, nombreDeLinea = null, guardarSalida = false } = {}) {
    return new Promise((resolve, reject) => {
        const hijo = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        const lineas = [];
        const cola = [];            // últimas líneas (para el mensaje de error)
        let resto = '';
        let enCurso = null;         // ruta del último fichero anunciado
        let ultimoAvance = Date.now();
        let tamEnCurso = -1;
        let atascado = false;

        const alLeer = (buf) => {
            const texto = resto + buf.toString('utf8');
            const partes = texto.split('\n');
            resto = partes.pop();
            for (const l of partes) {
                const linea = l.replace(/\r$/, '');
                if (!linea.trim()) continue;
                ultimoAvance = Date.now();
                if (guardarSalida) lineas.push(linea.trim());
                cola.push(linea.trim());
                if (cola.length > 5) cola.shift();
                const nombre = nombreDeLinea ? nombreDeLinea(linea) : null;
                if (nombre && dirSalida) { enCurso = path.join(dirSalida, nombre); tamEnCurso = -1; }
            }
        };
        hijo.stdout.on('data', alLeer);
        hijo.stderr.on('data', alLeer);

        const reloj = setInterval(async () => {
            if (enCurso) {
                const tam = await fs.stat(enCurso).then((s) => s.size, () => -1);
                if (tam > tamEnCurso) {
                    if (tamEnCurso >= 0) ultimoAvance = Date.now();
                    tamEnCurso = tam;
                }
            }
            if (Date.now() - ultimoAvance > sinAvanceMs()) {
                atascado = true;
                hijo.kill('SIGTERM');
                setTimeout(() => { try { hijo.kill('SIGKILL'); } catch { /* ya terminó */ } }, 10000).unref();
            }
        }, TICK_MS);
        reloj.unref();

        hijo.on('error', (e) => { clearInterval(reloj); reject(e); });
        hijo.on('close', (codigo) => {
            clearInterval(reloj);
            if (resto.trim()) alLeer(Buffer.from('\n'));
            if (codigo === 0 && !atascado) return resolve({ lineas });
            const err = new Error(atascado
                ? `se atascó: ${Math.round(sinAvanceMs() / 60000)} min sin avanzar (se paró; el fichero no tiene por qué estar dañado)`
                : `${cmd} terminó con error ${codigo}${cola.length ? ` — ${cola.join(' · ')}` : ''}`);
            err.atascado = atascado;
            reject(err);
        });
    });
}

// bsdtar -x -v anuncia cada entrada en stderr como «x ruta/del/fichero».
const nombreBsdtar = (l) => { const m = /^x (.+)$/.exec(l.trim()); return m ? m[1] : null; };

/**
 * Extrae `ruta` dentro de `dir`. Devuelve el extractor usado ('bsdtar'|'unar') o lanza si ninguno pudo. El error
 * lanzado lleva `atascado: true` si bsdtar se paró por no avanzar (entonces no se intenta unar: su fallo taparía la
 * causa real).
 */
export async function extraerArchivoComic(ruta, dir) {
    try {
        await ejecutarVigilado('bsdtar', ['-x', '-v', '-f', ruta, '-C', dir], { dirSalida: dir, nombreDeLinea: nombreBsdtar });
        return 'bsdtar';
    } catch (e1) {
        if (e1.atascado) throw Object.assign(new Error(`bsdtar: ${e1.message}`), { atascado: true });
        try {
            // Sin -quiet: unar escribe una línea por fichero, que es su señal de avance.
            await ejecutarVigilado('unar', ['-force-overwrite', '-no-directory', '-output-directory', dir, ruta]);
            return 'unar';
        } catch (e2) {
            throw Object.assign(new Error(`bsdtar: ${e1.message} · unar: ${e2.message}`), { atascado: Boolean(e2.atascado) });
        }
    }
}

/**
 * Solo los FICHEROS de un listado (rutas POSIX). bsdtar marca las carpetas con «/» final en un ZIP, pero en un RAR o
 * un 7z las lista SIN ella («Sakura Taisen 4» junto a «Sakura Taisen 4/001.jpg»): una entrada es carpeta si acaba en
 * «/» o si otra entrada cuelga de ella. Sin esto, cada carpeta de un RAR contaba como un fichero que «no salió».
 */
export function ficherosDelListado(entradas) {
    const norm = (entradas || []).map((x) => String(x).replace(/\\/g, '/'));
    const carpetas = new Set();
    for (const x of norm) {
        const partes = x.replace(/\/+$/, '').split('/');
        for (let i = 1; i < partes.length; i++) carpetas.add(partes.slice(0, i).join('/'));
    }
    return norm.filter((x) => x && !x.endsWith('/') && !carpetas.has(x));
}

/**
 * Lista las ENTRADAS de un comprimido sin extraerlo (rutas internas; las carpetas acaban en «/»). En un ZIP lee
 * solo el índice final, así que es rápido aunque pese 50 GB (un .tar.gz sí hay que recorrerlo entero: por eso
 * también va vigilado y sin tope). Sirve para saber QUÉ hay dentro antes de abrirlo (¿solo imágenes? → cómic) y
 * para distinguir un comprimido DAÑADO (no se puede listar) de uno sano que no se pudo extraer por otro motivo.
 * Devuelve el array con `.por` = 'bsdtar'|'lsar'. Lanza si no se puede leer.
 */
export async function listarComprimido(ruta) {
    try {
        const { lineas } = await ejecutarVigilado('bsdtar', ['-t', '-f', ruta], { guardarSalida: true });
        return Object.assign(lineas, { por: 'bsdtar' });
    } catch (e1) {
        try {
            // lsar (del paquete de unar): primera línea = el propio comprimido, el resto = sus entradas.
            const { lineas } = await ejecutarVigilado('lsar', [ruta], { guardarSalida: true });
            return Object.assign(lineas.slice(1), { por: 'lsar' });
        } catch (e2) {
            throw new Error(`bsdtar: ${e1.message} · lsar: ${e2.message}`);
        }
    }
}
