/**
 * CONVERTIR A PDF documentos de texto (.doc, .docx, .rtf, .odt) con LibreOffice, en el propio NAS.
 *
 * Para qué: qpdf solo cose PDF, y un libro partido en capítulos .doc esperaba en el Inbox a que el PC los convirtiera
 * con Word (scripts/convertir-partes-word.ps1). Probado en el Atom D525 el 3-nov (scripts/probar-libreoffice-nas.sh):
 * LibreOffice 7.0 de bullseye convierte en 8-15 s por fichero, incluidos los .doc antiguos que Word bloquea.
 *
 * Seguridad: los ficheros vienen de internet. Cada conversión usa un perfil propio y desechable con las macros
 * desactivadas de forma explícita (DisableMacrosExecution).
 *
 * Una sola conversión a la vez (LibreOffice no admite dos instancias con el mismo perfil, y el Atom no da para más).
 * Si LibreOffice no está instalado, `hayLibreOffice()` es false y nada se rompe: el libro espera, como antes.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paginasPdf } from './qpdf.js';

const ejecutar = promisify(execFile);
const TIEMPO_MS = Number(process.env.LIBREOFFICE_TIMEOUT_MS || 300000);   // 5 min por fichero: medido 8-15 s
export const EXT_CONVERTIBLES = new Set(['.doc', '.docx', '.rtf', '.odt']);

let _hay = null;
export async function hayLibreOffice() {
    if (_hay !== null) return _hay;
    try { await ejecutar('soffice', ['--version'], { timeout: 60000 }); _hay = true; }
    catch { _hay = false; }
    return _hay;
}

const CONFIG_SIN_MACROS = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
</oor:items>
`;

// Cola: una conversión detrás de otra.
let cola = Promise.resolve();

/**
 * Convierte `ruta` en «<mismo nombre>.pdf» dentro de `dirSalida` (por defecto, junto al original). El original no se
 * toca. Devuelve { ok, pdf, paginas } o { ok:false, motivo }.
 */
export function convertirAPdf(ruta, dirSalida = path.dirname(ruta)) {
    const tarea = cola.then(() => convertirUno(ruta, dirSalida));
    cola = tarea.catch(() => {});
    return tarea;
}

async function convertirUno(ruta, dirSalida) {
    if (!EXT_CONVERTIBLES.has(path.extname(ruta).toLowerCase())) return { ok: false, motivo: 'formato no convertible' };
    if (!(await hayLibreOffice())) return { ok: false, sinLibreOffice: true, motivo: 'LibreOffice no está instalado' };
    const perfil = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-perfil-'));
    const salida = await fs.mkdtemp(path.join(os.tmpdir(), 'lo-salida-'));
    const destino = path.join(dirSalida, `${path.parse(ruta).name}.pdf`);
    try {
        await fs.mkdir(path.join(perfil, 'user'), { recursive: true });
        await fs.writeFile(path.join(perfil, 'user', 'registrymodifications.xcu'), CONFIG_SIN_MACROS);
        // Se escribe en una carpeta temporal y solo al final se mueve: el vigilante nunca ve un PDF a medio escribir.
        await ejecutar('soffice', [`-env:UserInstallation=file://${perfil}`, '--headless', '--norestore',
            '--convert-to', 'pdf', '--outdir', salida, ruta], { timeout: TIEMPO_MS, maxBuffer: 1 << 22 });
        const hecho = path.join(salida, `${path.parse(ruta).name}.pdf`);
        const paginas = await paginasPdf(hecho);
        if (!paginas) return { ok: false, motivo: 'LibreOffice no produjo un PDF legible' };
        await fs.copyFile(hecho, destino);
        return { ok: true, pdf: destino, paginas };
    } catch (e) {
        return { ok: false, motivo: e.killed ? `LibreOffice no terminó en ${Math.round(TIEMPO_MS / 60000)} min` : String(e.stderr || e.message).trim().slice(-200) };
    } finally {
        await fs.rm(perfil, { recursive: true, force: true }).catch(() => {});
        await fs.rm(salida, { recursive: true, force: true }).catch(() => {});
    }
}
