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
 * Deposita un recurso fallido en una subcarpeta propia, junto a un estado.json con TODO
 * el trabajo realizado, de modo que un reintento pueda reanudar sin rehacer lo ya hecho.
 *
 * @param dirBase  carpeta destino (Cuarentena o Reintentos)
 * @param rutas    archivos originales del recurso
 * @param estado   { documento?, fase?, error?, identificador?, titulo?, motivo }
 * @param mover    true = mover (sacar del inbox); false = copiar (conservar original)
 */
async function depositar(dirBase, rutas, estado, mover) {
    const etiqueta = nombreSeguro(estado.identificador || estado.titulo || (rutas[0] && path.basename(rutas[0])) || 'recurso');
    const destino = path.join(dirBase, etiqueta);
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
        archivos,
        rutas_originales: rutas,
        fecha: new Date().toISOString(),
    };
    await fs.writeFile(path.join(destino, 'estado.json'), JSON.stringify(estadoCompleto, null, 2), 'utf8');
    return destino;
}

/** Identificación imposible → Cuarentena (se MUEVE; requiere intervención manual). */
export async function enviarACuarentena(rutas, estado) {
    return depositar(DIR_CUARENTENA, rutas, { motivo: 'identificacion', ...estado }, true);
}

/** Fallo transitorio (APIs/MongoDB inalcanzables) → Reintentos (se COPIA; se reprocesará). */
export async function enviarAReintentos(rutas, estado) {
    return depositar(DIR_REINTENTOS, rutas, { motivo: 'infraestructura', ...estado }, false);
}

export { DIR_CUARENTENA, DIR_REINTENTOS };
