// Antepone una marca de tiempo a cada console.log/info/warn/error del proceso.
// Importar lo PRIMERO en cada punto de entrada (app.js, vigilante.js). La hora es la LOCAL del
// contenedor: por defecto UTC; para verla en tu zona, añade TZ (p. ej. TZ=Europe/Madrid) al
// docker-compose. El guard evita doble prefijo si el módulo se evaluara más de una vez.
import { anotar } from './registro-logs.js';

// VERBOSIDAD: por defecto OFF (log SIMPLE: solo titulares + avisos/errores). LOG_VERBOSE=1 arranca en
// modo detallado (todo). Se puede cambiar en caliente desde el panel (setVerboso). En modo simple se
// ocultan las líneas "de detalle" (pasos internos de los módulos, sin marcador); warn/error SIEMPRE pasan.
let verboso = process.env.LOG_VERBOSE === '1' || process.env.LOG_VERBOSE === 'true';
export const setVerboso = (v) => { verboso = !!v; };
export const getVerboso = () => verboso;

// Marcadores de "titular" (resultado/estado): si una línea de log/info los lleva, se muestra también en
// modo simple. Substring match (robusto con emojis multi-código). Los pasos internos no los llevan.
const MARCAS = ['✅', '⚠', '❌', '⛔', '🚫', '🔁', '📛', '👻', '📥', '📭', '📊', '🧹', '👁', '🎛', '▶', '⏸', '♻', '🗑', '🛠', '📚', 'Lote', 'RESUMEN', 'Inbox vacío'];
const esTitular = (s) => MARCAS.some(m => s.includes(m));

if (!console.__conTimestamp) {
    console.__conTimestamp = true;

    const dd = (n) => String(n).padStart(2, '0');
    const marca = () => {
        const d = new Date();
        return `${d.getFullYear()}-${dd(d.getMonth() + 1)}-${dd(d.getDate())} ` +
               `${dd(d.getHours())}:${dd(d.getMinutes())}:${dd(d.getSeconds())}`;
    };
    // Aplana un argumento a texto para el buffer/fichero (la consola conserva su formato nativo).
    const txt = (a) => typeof a === 'string' ? a
        : (() => { try { return JSON.stringify(a); } catch { return String(a); } })();

    for (const metodo of ['log', 'info', 'warn', 'error']) {
        const original = console[metodo].bind(console);
        console[metodo] = (...args) => {
            const m = marca();
            const linea = args.map(txt).join(' ');
            // Modo simple: ocultar log/info de detalle (sin marcador de titular). warn/error siempre pasan.
            if (!verboso && (metodo === 'log' || metodo === 'info') && !esTitular(linea)) return;
            original(`[${m}]`, ...args);                          // salida a stdout (docker) como siempre
            try { anotar(`[${m}] ` + linea); }                    // copia al panel (buffer + fichero)
            catch { /* el log nunca debe romper la app */ }
        };
    }
}
