/**
 * Ajustes de INGESTA modificables EN CALIENTE desde el panel (sin reiniciar):
 *   · `cduSinIA`     — si la ingesta gasta o no IA en la CDU (INGESTA_CDU_SIN_IA en config/.env).
 *   · `inspeccionIA` — si las carpetas COMPLEJAS del Inbox se inspeccionan con IA antes de ingerirlas
 *                      (agente de estructura, INSPECCION_IA en config/.env; ver utils/inspeccion-auto.js).
 * Se guarda un valor EN MEMORIA (lo lee la ingesta, que corre en el mismo proceso que la API) y se PERSISTE en
 * Mongo (`ajustes/_id:'ingesta'`) para que sobreviva a los reinicios. El valor inicial es el del entorno
 * (config.js/.env); el panel lo puede cambiar y su elección (BD) manda a partir de entonces.
 */
import { conectarDB } from '../database.js';

let _cduSinIA = process.env.INGESTA_CDU_SIN_IA === '1'; // arranque = entorno; la BD lo pisa al cargar
let _inspeccionIA = process.env.INSPECCION_IA !== '0';   // DE SERIE: activa salvo INSPECCION_IA=0

/** Carga los ajustes persistidos (llamar UNA vez al arrancar). Lo que no esté guardado se queda con el entorno. */
export async function cargarAjustesIngesta() {
    try {
        const d = await (await conectarDB()).collection('ajustes').findOne({ _id: 'ingesta' });
        if (d && typeof d.cduSinIA === 'boolean') _cduSinIA = d.cduSinIA;
        if (d && typeof d.inspeccionIA === 'boolean') _inspeccionIA = d.inspeccionIA;
    } catch { /* sin BD todavía: se queda el valor del entorno */ }
    return _cduSinIA;
}

/** ¿Se inspeccionan con IA las carpetas complejas del Inbox antes de ingerirlas? Lo lee el vigilante. */
export function inspeccionIAActiva() { return _inspeccionIA; }

/** Cambia el ajuste de la inspección con IA (memoria + BD). Devuelve el nuevo valor. */
export async function setInspeccionIA(activo) {
    _inspeccionIA = !!activo;
    try {
        await (await conectarDB()).collection('ajustes').updateOne(
            { _id: 'ingesta' }, { $set: { inspeccionIA: _inspeccionIA } }, { upsert: true });
    } catch { /* best-effort: al menos queda en memoria para esta sesión */ }
    return _inspeccionIA;
}

/** ¿La ingesta debe RESOLVER la CDU SIN IA (solo caché + crosswalk determinista)? Lo lee motor-enriquecimiento. */
export function cduSinIAActivo() { return _cduSinIA; }

/** Cambia el ajuste (memoria + BD). Devuelve el nuevo valor. */
export async function setCduSinIA(activo) {
    _cduSinIA = !!activo;
    try {
        await (await conectarDB()).collection('ajustes').updateOne(
            { _id: 'ingesta' }, { $set: { cduSinIA: _cduSinIA } }, { upsert: true });
    } catch { /* best-effort: al menos queda en memoria para esta sesión */ }
    return _cduSinIA;
}
