/**
 * EJECUTOR de los scripts de scripts/ lanzados DESDE EL PANEL (Mantenimiento → «Ejecutar script»).
 *
 * Recibe un `id` YA validado contra la lista blanca (catalogo-scripts.js) y un ARGV YA construido (array de
 * argumentos, no una cadena). Lanza `node scripts/<id>.js …argv` con spawn SIN shell —así ningún valor puede
 * inyectar un comando— y vuelca su stdout/stderr, línea a línea, al MISMO buffer de logs que ve el panel
 * (registro-logs · anotar). Un solo trabajo a la vez: dos scripts moviendo carpetas a la vez se pisarían.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { anotar } from './registro-logs.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let actual = null;   // { id, aplicar, desde, lineas, hijo, terminado, codigo }

export function estadoEjecutor() {
    if (!actual) return { activo: false };
    return {
        activo: !actual.terminado,
        id: actual.id,
        aplicar: actual.aplicar,
        desde: actual.desde,
        lineas: actual.lineas,
        terminado: actual.terminado,
        codigo: actual.codigo,
    };
}

/**
 * Lanza un script. `id` y `argv` vienen ya validados/armados por el llamante (endpoint).
 * Devuelve { ok } o { ok:false, motivo } si ya hay uno en marcha.
 */
export function lanzarScript({ id, argv = [], aplicar = false }) {
    if (actual && !actual.terminado) {
        return { ok: false, motivo: `ya se está ejecutando «${actual.id}»; espera a que termine` };
    }
    const script = path.join(RAIZ, 'scripts', `${id}.js`);
    const cabecera = `📜 script «${id}» ${aplicar ? '⚙️ APLICAR' : '🔍 dry-run'} — node scripts/${id}.js ${argv.join(' ')}`;
    anotar(cabecera);

    // LOG_VERBOSE=1: algunos scripts miran esa variable para no auto-silenciarse; no estorba a los demás.
    const hijo = spawn(process.execPath, [script, ...argv], {
        cwd: RAIZ,
        env: { ...process.env, LOG_VERBOSE: '1' },
    });

    actual = { id, aplicar, desde: Date.now(), lineas: 0, hijo, terminado: false, codigo: null };

    // stdout/stderr → buffer de logs, respetando los saltos de línea (buffer parcial entre chunks).
    const volcar = (prefijo) => {
        let resto = '';
        return (chunk) => {
            resto += chunk.toString();
            const trozos = resto.split('\n');
            resto = trozos.pop();   // la última puede estar incompleta
            for (const l of trozos) {
                if (l.trim() === '') continue;
                anotar(`${prefijo}${l}`);
                if (actual) actual.lineas++;
            }
        };
    };
    hijo.stdout.on('data', volcar('   '));
    hijo.stderr.on('data', volcar('   ⚠ '));

    hijo.on('error', (e) => {
        anotar(`📜 script «${id}» NO se pudo lanzar: ${e.message}`);
        if (actual) { actual.terminado = true; actual.codigo = -1; }
    });
    hijo.on('close', (codigo) => {
        anotar(`📜 script «${id}» terminado (código ${codigo}).`);
        if (actual) { actual.terminado = true; actual.codigo = codigo; }
    });

    return { ok: true };
}

/** Corta el script en marcha (SIGTERM). Nunca lanza. */
export function detenerScript() {
    if (actual && !actual.terminado && actual.hijo) {
        try { actual.hijo.kill('SIGTERM'); } catch { /* ya estaba muerto */ }
        anotar(`📜 script «${actual.id}» detenido a petición del usuario.`);
        return { ok: true };
    }
    return { ok: false, motivo: 'no hay ningún script en marcha' };
}
