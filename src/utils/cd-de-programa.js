/**
 * ¿Es esto el CD de un PROGRAMA (o el CD que acompaña a un libro)? (16-nov, regla del usuario)
 *
 * Un disco con `AUTORUN.INF` en su raíz es un CD que arranca solo: instaladores, ejemplos, un «START.PDF». Medido:
 * «Floyd - Electronic Devices CC 7e.iso» (Companion CD) trae AUTORUN.EXE/.INF, START.PDF, los instaladores de
 * Multisim 7 y de Acrobat y los circuitos de ejemplo (con un SOLUTION.ZIP protegido con contraseña). Abrirlo dejaba
 * cientos de ficheros sueltos y un zip que no se puede abrir, que retenía toda la carpeta en PreProceso. Lo correcto
 * es guardarlo INTACTO como UN registro de software (regla: «guiarlo como software y la regla del autorun.inf»).
 *
 * PRUDENCIA: un DVD de libros (colecciones de PDF) también puede llevar autorun. Solo se toma por programa si, además,
 * trae como mucho MAX_DOCUMENTOS documentos (el START.PDF / un manual); con más, se abre como siempre para catalogar
 * sus libros.
 *
 * Lo usan: vigilante·expandirUno (un .iso/.zip con autorun no se abre: se guarda como software), vigilante·
 * clasificarDirectorio y preproceso·prepararArbol (una carpeta ya abierta con autorun en su raíz → guía «software»).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { ficherosDelListado } from './extraer-archivo.js';

const MAX_DOCUMENTOS = 2;
const RE_AUTORUN = /^autorun\.inf$/i;
const RE_DOCUMENTO = /\.(pdf|epub|djvu?|chm|mobi|azw3?|docx?|cbz|cbr|cb7)$/i;
const MAX_RECORRIDO = 20000;   // ficheros que se miran como mucho en una carpeta

/**
 * Sobre el LISTADO de un comprimido/ISO (sin abrirlo). El autorun cuenta en la raíz o bajo una única carpeta de
 * primer nivel (que la extracción aplanaría).
 */
export function esCdDePrograma(entradas) {
    const ficheros = ficherosDelListado(entradas).map((x) => x.replace(/^(\.\/)+/, ''));
    const primerNivel = new Set(ficheros.map((f) => f.split('/')[0]));
    const prefijo = primerNivel.size === 1 && ficheros.every((f) => f.includes('/')) ? `${[...primerNivel][0]}/` : '';
    const enRaiz = (f) => (prefijo ? f.slice(prefijo.length) : f);
    const autorun = ficheros.some((f) => {
        const r = enRaiz(f);
        return !r.includes('/') && RE_AUTORUN.test(r);
    });
    if (!autorun) return false;
    return ficheros.filter((f) => RE_DOCUMENTO.test(f)).length <= MAX_DOCUMENTOS;
}

/** Sobre una CARPETA ya abierta: AUTORUN.INF en su raíz y como mucho MAX_DOCUMENTOS documentos en todo el árbol. */
export async function esCarpetaCdDePrograma(dir) {
    let raiz;
    try { raiz = await fs.readdir(dir, { withFileTypes: true }); } catch { return false; }
    if (!raiz.some((e) => e.isFile() && RE_AUTORUN.test(e.name))) return false;
    let documentos = 0, vistos = 0;
    const pila = [dir];
    while (pila.length && vistos < MAX_RECORRIDO) {
        const d = pila.pop();
        for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
            if (e.isDirectory()) { pila.push(path.join(d, e.name)); continue; }
            vistos++;
            if (RE_DOCUMENTO.test(e.name) && ++documentos > MAX_DOCUMENTOS) return false;
        }
    }
    return true;
}
