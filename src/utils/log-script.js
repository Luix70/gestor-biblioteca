/**
 * LOG ESTÁNDAR DE LOS SCRIPTS (scripts/*.js) — mecanismo ÚNICO para pantalla y fichero (requisito del usuario: cada
 * mensaje con su marca de tiempo, para ver al volver a la pantalla cuándo se produjo el último).
 *
 *   · PANTALLA: cada línea empieza por `[AAAA-MM-DD HH:MM:SS]` — el mismo formato que el log de la aplicación
 *     (utils/consola-timestamp.js). También la línea de PROGRESO que se repinta en su sitio (utils/progreso-cli.js):
 *     así se ve la hora de su última actualización (si lleva horas sin cambiar, algo va mal).
 *   · FICHERO: cada ejecución deja `logs/scripts/<script>-<AAAAMMDD-HHMMSS>.log` con la orden completa, todas las
 *     líneas terminadas (no los repintados del progreso) sin colores, y el tiempo total al acabar. Se borran solos
 *     los de más de 60 días (SCRIPT_LOG_DIAS).
 *
 * Se importa lo PRIMERO en cada script (`import '../src/utils/log-script.js';`). Intercepta process.stdout/stderr,
 * así que vale para console.log, console.error y los `process.stdout.write(...)` de las líneas de progreso, sin
 * tocar cómo escribe cada script. Desactiva el filtro de verbosidad de la app (en un script se ve todo).
 * La hora es la LOCAL del contenedor (UTC salvo que el docker-compose defina TZ, p. ej. TZ=Europe/Madrid).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const DIR_LOGS = (() => { const v = process.env.PATH_LOGS || 'logs'; return path.join(path.isAbsolute(v) ? v : path.resolve(RAIZ, v), 'scripts'); })();
const DIAS = Number(process.env.SCRIPT_LOG_DIAS || 60);

const dd = (n) => String(n).padStart(2, '0');
const marca = (d = new Date()) => `${d.getFullYear()}-${dd(d.getMonth() + 1)}-${dd(d.getDate())} ${dd(d.getHours())}:${dd(d.getMinutes())}:${dd(d.getSeconds())}`;
const sinAnsi = (s) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

if (!process.__logScript) {
    process.__logScript = true;
    // Que utils/consola-timestamp.js (si algún módulo lo importa) no ponga un 2.º prefijo ni oculte líneas.
    console.__conTimestamp = true;

    const nombre = path.basename(process.argv[1] || 'script', '.js');
    const inicio = new Date();
    let fichero = null;
    try {
        fs.mkdirSync(DIR_LOGS, { recursive: true });
        const sello = `${inicio.getFullYear()}${dd(inicio.getMonth() + 1)}${dd(inicio.getDate())}-${dd(inicio.getHours())}${dd(inicio.getMinutes())}${dd(inicio.getSeconds())}`;
        const ruta = path.join(DIR_LOGS, `${nombre}-${sello}.log`);
        fichero = fs.openSync(ruta, 'a');
        fs.writeSync(fichero, `[${marca(inicio)}] ▶ node ${[path.relative(RAIZ, process.argv[1] || ''), ...process.argv.slice(2)].join(' ')}\n`);
        process.__logScriptRuta = ruta;
        // Limpieza: fuera los registros de más de DIAS días.
        const limite = Date.now() - DIAS * 86400000;
        for (const f of fs.readdirSync(DIR_LOGS)) {
            const p = path.join(DIR_LOGS, f);
            try { if (fs.statSync(p).mtimeMs < limite) fs.rmSync(p, { force: true }); } catch { /* */ }
        }
    } catch { fichero = null; /* sin fichero: la pantalla sigue con marcas de tiempo */ }

    // Envuelve un flujo (stdout/stderr): marca de tiempo al empezar cada línea visible (también tras un «\r» de
    // repintado); las líneas TERMINADAS (con «\n») van además al fichero.
    const envolver = (flujo) => {
        const original = flujo.write.bind(flujo);
        let alInicio = true;       // la próxima salida visible empieza línea
        let pendiente = '';        // texto de la línea en curso (para el fichero)
        flujo.write = (trozo, ...resto) => {
            const texto = typeof trozo === 'string' ? trozo : Buffer.isBuffer(trozo) ? trozo.toString('utf8') : String(trozo);
            let salida = '';
            for (const parte of texto.split(/(\r|\n)/)) {
                if (parte === '\n') {
                    salida += '\n';
                    if (fichero) { try { fs.writeSync(fichero, `${sinAnsi(pendiente)}\n`); } catch { /* */ } }
                    pendiente = '';
                    alInicio = true;
                } else if (parte === '\r') {
                    salida += '\r';
                    pendiente = '';        // repintado: lo anterior de esta línea se descarta
                    alInicio = true;
                } else if (parte) {
                    // Secuencias de control al principio (p. ej. «\x1b[K» de borrar línea) antes de la marca.
                    const m = /^((?:\x1b\[[0-9;]*[A-Za-z])*)([\s\S]*)$/.exec(parte);
                    if (alInicio && m[2]) {
                        const sello = `[${marca()}] `;
                        salida += m[1] + sello + m[2];
                        pendiente += sello + m[2];
                        alInicio = false;
                    } else {
                        salida += parte;
                        pendiente += m ? m[2] : parte;
                    }
                }
            }
            return original(salida, ...resto);
        };
    };
    envolver(process.stdout);
    envolver(process.stderr);

    process.on('exit', (codigo) => {
        if (!fichero) return;
        const s = Math.round((Date.now() - inicio.getTime()) / 1000);
        try { fs.writeSync(fichero, `[${marca()}] ■ fin (código ${codigo}) · ${Math.floor(s / 60)}m ${s % 60}s\n`); fs.closeSync(fichero); } catch { /* */ }
    });
}
