/**
 * Lectura LOCAL (offline, SIN IA) del código de barras EAN-13/EAN-8/UPC de las cubiertas, con zxing-wasm.
 * Es un PASO PREVIO a la visión en lector-barras.js: si el EAN se lee aquí, nos ahorramos una llamada de
 * IA (coste + 429). El EAN se interpreta luego con decodificarCodigoBarras (977→ISSN, 978/979→ISBN).
 *
 * DEGRADACIÓN ELEGANTE (imprescindible): si zxing-wasm no carga o el WASM no INSTANCIA (p. ej. usa SIMD y
 * el Atom D525 —solo SSSE3— no lo soporta), `leerBarrasLocal` devuelve null y el llamante sigue con la
 * visión. Nunca rompe la ingesta. Misma filosofía que buscador-local.js / el índice FTS.
 *
 * Nota Node: zxing-wasm intenta `fetch` del .wasm (pensado para navegador). En Node hay que darle el
 * binario LOCAL del propio paquete con setZXingModuleOverrides({wasmBinary}); si no, falla al instanciar.
 */
import { createRequire } from 'module';
import fs from 'fs';

const require = createRequire(import.meta.url);
const FORMATOS = ['EAN-13', 'EAN-8', 'UPC-A', 'UPC-E'];

let lector = null, intentado = false, disponible = false;

async function asegurar() {
    if (intentado) return disponible;
    intentado = true;
    try {
        const wasmBinary = fs.readFileSync(require.resolve('zxing-wasm/reader/zxing_reader.wasm'));
        const z = await import('zxing-wasm/reader');
        z.setZXingModuleOverrides({ wasmBinary });
        // Forzar la instanciación AHORA para detectar incompatibilidad (SIMD/Atom) y degradar una sola vez.
        if (z.getZXingModule) await z.getZXingModule();
        lector = z;
        disponible = true;
        console.log('🔦 Lector de barras local (zxing-wasm) listo.');
    } catch (e) {
        console.warn(`⚠️  Lector de barras local no disponible (${e.message}); se usará la visión para las barras.`);
        disponible = false;
    }
    return disponible;
}

/**
 * Intenta leer un EAN/UPC de uno o varios buffers de imagen (JPEG/PNG: recortes de cubierta).
 * @param {Buffer[]} buffers
 * @returns {Promise<{codigo_barras:string, add_on?:string}|null>} null = no leído / no disponible.
 */
export async function leerBarrasLocal(buffers) {
    if (!(await asegurar())) return null;
    for (const buf of (buffers || [])) {
        if (!buf || !buf.length) continue;
        try {
            const res = await lector.readBarcodes(new Blob([buf]), { formats: FORMATOS, tryHarder: true, eanAddOnSymbol: 'Read' });
            for (const r of (res || [])) {
                const txt = String(r.text || '').replace(/\D/g, '');
                if (txt.length === 15) return { codigo_barras: txt.slice(0, 13), add_on: txt.slice(13) }; // EAN-13 + add-on de 2
                if (txt.length >= 8) return { codigo_barras: txt };
            }
        } catch { /* probar con el siguiente recorte */ }
    }
    return null;
}

/** ¿Está operativo el lector local? (para logs/diagnóstico) */
export async function barrasLocalDisponible() { return asegurar(); }
