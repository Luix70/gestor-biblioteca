// Antepone una marca de tiempo a cada console.log/info/warn/error del proceso.
// Importar lo PRIMERO en cada punto de entrada (app.js, vigilante.js). La hora es la LOCAL del
// contenedor: por defecto UTC; para verla en tu zona, añade TZ (p. ej. TZ=Europe/Madrid) al
// docker-compose. El guard evita doble prefijo si el módulo se evaluara más de una vez.
if (!console.__conTimestamp) {
    console.__conTimestamp = true;

    const dd = (n) => String(n).padStart(2, '0');
    const marca = () => {
        const d = new Date();
        return `${d.getFullYear()}-${dd(d.getMonth() + 1)}-${dd(d.getDate())} ` +
               `${dd(d.getHours())}:${dd(d.getMinutes())}:${dd(d.getSeconds())}`;
    };

    for (const metodo of ['log', 'info', 'warn', 'error']) {
        const original = console[metodo].bind(console);
        console[metodo] = (...args) => original(`[${marca()}]`, ...args);
    }
}
