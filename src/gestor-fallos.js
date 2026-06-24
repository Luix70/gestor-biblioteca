import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');

function resolver(p, defecto) {
    const valor = p || defecto;
    return path.isAbsolute(valor) ? valor : path.resolve(RAIZ, valor);
}

const DIR_CUARENTENA = resolver(process.env.PATH_CUARENTENA, 'Cuarentena');
const DIR_REINTENTOS = resolver(process.env.PATH_REINTENTOS, 'Reintentos');

function nombreSeguro(s) {
    return String(s || 'recurso').replace(/[<>:"/\\|?*'\n\r]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

/**
 * Categoría de un depósito de Cuarentena, para agruparlos en subcarpetas:
 *   duplicados       — copia exacta de algo ya catalogado.
 *   no-identificados — no se pudo identificar (sin título/ISBN tras agotar archivo/APIs/IA).
 *   otros            — cualquier otro motivo.
 */
export function categoriaCuarentena(estado) {
    const tipo = (estado && (estado.error?.tipo || estado.motivo)) || '';
    if (tipo === 'duplicado_exacto' || tipo === 'duplicado') return 'duplicados';
    if (tipo === 'identificacion') return 'no-identificados';
    if (tipo === 'ilegible') return 'ilegibles';
    return 'otros';
}

/**
 * Deposita un recurso fallido en una subcarpeta propia, junto a un estado.json con TODO
 * el trabajo realizado, de modo que un reintento pueda reanudar sin rehacer lo ya hecho.
 *
 * @param dirBase  carpeta destino (Cuarentena o Reintentos)
 * @param rutas    archivos originales del recurso
 * @param estado   { documento?, fase?, error?, identificador?, titulo?, motivo }
 * @param mover    true = mover (sacar del inbox); false = copiar (conservar original)
 */
async function depositar(dirBase, rutas, estado, mover, categoria = null) {
    const etiqueta = nombreSeguro(estado.identificador || estado.titulo || (rutas[0] && path.basename(rutas[0])) || 'recurso');
    const base = categoria ? path.join(dirBase, categoria) : dirBase;
    const destino = path.join(base, etiqueta);
    await fs.mkdir(destino, { recursive: true });

    const archivos = [];
    for (const r of rutas) {
        try {
            const nombre = path.basename(r);
            await fs.copyFile(r, path.join(destino, nombre));
            archivos.push(nombre);
            if (mover) {
                await fs.chmod(r, 0o666).catch(() => {});
                await fs.unlink(r).catch(() => {});
            }
        } catch (e) {
            // No bloquear el guardado del estado por un archivo que no se pudo copiar.
        }
    }

    const estadoCompleto = {
        ...estado,
        categoria,
        archivos,
        rutas_originales: rutas,
        fecha: new Date().toISOString(),
    };
    await fs.writeFile(path.join(destino, 'estado.json'), JSON.stringify(estadoCompleto, null, 2), 'utf8');
    return destino;
}

/** Identificación imposible / duplicado → Cuarentena (se MUEVE; agrupado por categoría). */
export async function enviarACuarentena(rutas, estado) {
    const e = { motivo: 'identificacion', ...estado };
    return depositar(DIR_CUARENTENA, rutas, e, true, categoriaCuarentena(e));
}

/**
 * Fichero estructuralmente dañado (EPUB/PDF corrupto) o fantasma de 0 bytes → Cuarentena/ilegibles
 * como depósito con sidecar (estado.json). No es cuestión de catalogarlo a mano sino de conseguir
 * una COPIA SANA y reemplazarlo desde el panel. Unifica lo que antes iba al _ER Room.
 */
export async function enviarAIlegibles(rutas, estado = {}) {
    const e = {
        motivo: 'ilegible',
        titulo: estado.titulo || null,
        error: { tipo: 'ilegible', mensaje: estado.mensaje || estado.error?.mensaje || 'fichero ilegible o dañado' },
    };
    return depositar(DIR_CUARENTENA, rutas, e, true, 'ilegibles');
}

/** Fallo transitorio (APIs/MongoDB inalcanzables) → Reintentos (se COPIA; se reprocesará). */
export async function enviarAReintentos(rutas, estado) {
    return depositar(DIR_REINTENTOS, rutas, { motivo: 'infraestructura', ...estado }, false);
}

export { DIR_CUARENTENA, DIR_REINTENTOS };
