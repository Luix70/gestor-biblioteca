import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { reciclar } from './papelera.js';
import { ingestarRecurso } from '../servicio-ingesta.js';

/**
 * SANEAMIENTO de ficheros problemáticos de la Cuarentena (ilegibles / no-identificados / otros):
 * el usuario busca una COPIA SANA (enlaces a buscadores) y la sube; aquí se cataloga por el pipeline
 * normal y, si entra, se retira el depósito original (a la Papelera). 'duplicados' NO entra aquí
 * (tiene su comparador). Unifica lo que antes se repartía entre Cuarentena y _ER Room.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CUARENTENA = resolver(process.env.PATH_CUARENTENA, 'Cuarentena');

const DEFECTO_FUENTES = [
    { nombre: "Anna's Archive", url: 'https://annas-archive.gl/search?q={q}' },
    { nombre: 'Libgen', url: 'https://libgen.is/search.php?req={q}' },
    { nombre: 'Gutenberg', url: 'https://www.gutenberg.org/ebooks/search/?query={q}' },
];

/** Fuentes para "buscar copia" (config FUENTES_COPIA = JSON [{nombre,url}]; {q} = consulta). */
export function fuentesCopia() {
    try {
        const j = JSON.parse(process.env.FUENTES_COPIA || '');
        if (Array.isArray(j) && j.length) return j.filter(f => f && f.nombre && f.url);
    } catch { /* JSON inválido → defecto */ }
    return DEFECTO_FUENTES;
}

/**
 * Sanea un depósito de Cuarentena con la copia sana subida: la cataloga y, si entra, retira el
 * depósito original a la Papelera. idDeposito = '<categoria>/<carpeta>' (de listarCuarentena).
 */
export async function reemplazarConSano(idDeposito, rutaSubida, { ubicacion } = {}) {
    if (!rutaSubida) return { ok: false, motivo: 'no se recibió el fichero sano' };
    const partes = String(idDeposito || '').split('/').map(s => path.basename(s)).filter(Boolean);
    if (partes.length < 2) return { ok: false, motivo: 'identificador de depósito inválido' };
    if (partes[0] === 'duplicados') return { ok: false, motivo: 'los duplicados se resuelven desde su comparador' };
    const depDir = path.join(DIR_CUARENTENA, ...partes);
    try { await fs.access(depDir); } catch { return { ok: false, motivo: 'el depósito ya no existe' }; }

    // 1) Catalogar la copia sana por el pipeline compartido.
    let resultado;
    try {
        resultado = await ingestarRecurso({ rutas: [rutaSubida], contexto: ubicacion ? { ubicacion } : {} });
    } catch (e) {
        await reciclar([rutaSubida], 'saneamiento-fallido').catch(() => {});
        return { ok: false, motivo: `no se pudo catalogar la copia sana: ${e.message}` };
    }

    // 2) Éxito → retirar el depósito problemático a la Papelera y reciclar el temporal de subida.
    let archivos = [];
    try { archivos = (await fs.readdir(depDir)).map(n => path.join(depDir, n)); } catch { /* vacío */ }
    await reciclar(archivos, 'saneado-ilegible');
    await fs.rm(depDir, { recursive: true, force: true }).catch(() => {});
    await reciclar([rutaSubida], 'subida-saneamiento').catch(() => {});

    return {
        ok: true, operacion: resultado.operacion, estado: resultado.estado,
        id: String(resultado._id), titulo: resultado.documento?.titulo || null,
        isbn: resultado.isbn || null, ruta: resultado.rutaWeb || null,
    };
}
