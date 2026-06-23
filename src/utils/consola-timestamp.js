// Antepone una marca de tiempo a cada console.log/info/warn/error del proceso.
// Importar lo PRIMERO en cada punto de entrada (app.js, vigilante.js). La hora es la LOCAL del
// contenedor: por defecto UTC; para verla en tu zona, añade TZ (p. ej. TZ=Europe/Madrid) al
// docker-compose. El guard evita doble prefijo si el módulo se evaluara más de una vez.
import { anotar } from './registro-logs.js';

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
            original(`[${m}]`, ...args);                          // salida a stdout (docker) como siempre
            try { anotar(`[${m}] ` + args.map(txt).join(' ')); }  // copia al panel (buffer + fichero)
            catch { /* el log nunca debe romper la app */ }
        };
    }
}
