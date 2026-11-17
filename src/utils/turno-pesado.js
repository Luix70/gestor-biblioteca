/**
 * TURNO DE TRABAJO PESADO — un solo trabajo que gasta memoria a la vez en el contenedor.
 *
 * El contenedor del NAS tiene un tope de 700 MB de RAM + 700 MB de swap (docker-compose.yml): el Atom solo tiene
 * 990 MB y, sin tope, una ingesta pesada congelaba el NAS entero. El 17-nov el tope saltó dos veces en una hora
 * («Memory cgroup out of memory»: primero mató un `pdftoppm` de 250 MB, después al propio node): con 4.707 unidades
 * en el Inbox, la ingesta rasterizaba portadas MIENTRAS PreProceso inspeccionaba con visión, pasaba escaneos a PDF o
 * cosía capítulos con qpdf. La ingesta y el mantenimiento ya compartían el cerrojo `procesando` del Vigilante, pero
 * PreProceso iba por libre.
 *
 * Este turno lo comparten la ingesta (UNA UNIDAD cada vez), el mantenimiento (Conformador, campañas) y los pasos
 * pesados de PreProceso. Es una cola FIFO: al soltar el turno, entra el que más lleva esperando, así que la ingesta y
 * PreProceso se alternan y ninguno deja al otro sin turno. Abrir comprimidos NO lo pide: bsdtar trabaja en streaming
 * con poca memoria, y un zip de 50 GB tardaría horas en devolver el turno.
 *
 * En memoria (un proceso): no hace falta más, todo corre dentro del mismo node.
 */

let dueno = null;          // quién tiene el turno ahora (texto, para el log y el panel), o null
const cola = [];           // [{ quien, entrar }] en orden de llegada

function siguiente() {
    const s = cola.shift();
    if (!s) { dueno = null; return; }
    dueno = s.quien;
    s.entrar();
}

/**
 * Pide el turno y espera a tenerlo. Devuelve la función que lo suelta (llamarla dos veces no hace nada).
 * @param {string} quien  qué lo pide («Ingesta del Inbox», «PreProceso: coser …»)
 */
export async function tomarTurno(quien) {
    if (!dueno) dueno = quien;
    else await new Promise((entrar) => cola.push({ quien, entrar }));
    let suelto = false;
    return () => {
        if (suelto) return;
        suelto = true;
        siguiente();
    };
}

/** Ejecuta `fn` con el turno y lo suelta pase lo que pase. */
export async function conTurno(quien, fn) {
    const soltar = await tomarTurno(quien);
    try { return await fn(); } finally { soltar(); }
}

/** El turno sin esperar: la función que lo suelta, o null si está ocupado (o hay cola). Para lo que puede esperar
 *  a la próxima vuelta, como el mantenimiento, en vez de quedarse bloqueado en la cola. */
export function intentarTurno(quien) {
    if (dueno || cola.length) return null;
    dueno = quien;
    let suelto = false;
    return () => {
        if (suelto) return;
        suelto = true;
        siguiente();
    };
}

/** Quién tiene el turno y cuántos esperan (para el log / panel). */
export function estadoTurno() {
    return { dueno, esperando: cola.map((s) => s.quien) };
}
