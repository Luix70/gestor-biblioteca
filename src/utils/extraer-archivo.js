/**
 * Extrae un archivo COMPRIMIDO de cómic (.cbr=RAR, .cb7=7z, .cbz=ZIP) a un directorio.
 *
 * Usa `bsdtar` (libarchive) como extractor PRINCIPAL porque, a diferencia de `unar` (The Unarchiver),
 * SÍ lee **RAR5** — el formato por defecto del RAR moderno (un .cbr de WinRAR reciente es RAR5 y unar
 * no lo abría). bsdtar maneja además RAR4/7z/ZIP. Si bsdtar falla, se intenta `unar` como respaldo
 * (algún RAR4/7z residual). Ambos son C nativo (aptos para el Atom) y vuelcan a disco (poca RAM).
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const OPTS = { timeout: 300000, maxBuffer: 16 * 1024 * 1024 };

/** Extrae `ruta` dentro de `dir`. Devuelve el extractor usado ('bsdtar'|'unar') o lanza si ninguno pudo. */
export async function extraerArchivoComic(ruta, dir) {
    try {
        await execFileP('bsdtar', ['-x', '-f', ruta, '-C', dir], OPTS);
        return 'bsdtar';
    } catch (e1) {
        try {
            await execFileP('unar', ['-quiet', '-force-overwrite', '-no-directory', '-output-directory', dir, ruta], OPTS);
            return 'unar';
        } catch (e2) {
            throw new Error(`bsdtar: ${e1.message} · unar: ${e2.message}`);
        }
    }
}
