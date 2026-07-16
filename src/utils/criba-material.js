/**
 * CRIBA DE MATERIAL NOTABLE — decide qué ficheros NO leíbles por los visores (ni PDF, ni audio, ni vídeo, ni
 * imagen) merecen FICHA propia en el catálogo, y cuáles solo se preservan en disco.
 *
 * El porqué: el invariante del proyecto es que todo lo que entra y NO es un duplicado exacto debe acabar con un
 * REGISTRO en la BD que apunte a él — preservarlo en disco no basta, porque sin registro es invisible (y eso
 * equivale a perderlo). Pero catalogar TODO lo no leíble sería peor: una carpeta con código fuente o un
 * `node_modules` metería MILES de .cpp/.h/.js —y de README/LICENSE, que también son .txt— como documentos. Eso
 * es basura, no biblioteca.
 *
 * Por eso la criba tiene TRES capas (una sola no basta):
 *   1. FORMATO documental: solo extensiones que son un documento por derecho propio (un .docx, un .lit, una
 *      imagen de disco .nrg/.iso). El código fuente y las librerías no entran nunca.
 *   2. RUIDO ESTRUCTURAL: nada bajo node_modules/.git/dist/__MACOSX/… (ahí un .txt jamás es un documento).
 *   3. NOMBRE de acompañamiento: README/LICENSE/CHANGELOG… son metadatos del paquete, no obras. Y un .txt
 *      diminuto es una nota, no un documento → tamaño mínimo (solo para los formatos de texto plano).
 *
 * Lo que NO pasa la criba se conserva verbatim y se lista en el manifiesto `_contenido.txt` de la colección.
 */
import path from 'node:path';

// VÍDEO — FUENTE ÚNICA (la usan transmedia y colección-de-audiolibros). Un vídeo se cataloga SIEMPRE
// (naturaleza:'video'): sin visor para los códecs que el navegador no decodifica, pero VISIBLE y descargable
// → nunca se queda solo en disco.
export const EXT_VIDEO = ['.avi', '.mp4', '.mkv', '.mov', '.webm', '.wmv', '.flv', '.m4v', '.mpg', '.mpeg', '.ogv', '.m2ts', '.ts', '.vob', '.divx', '.3gp'];
export const esVideo = (n) => EXT_VIDEO.includes(path.extname(String(n || '')).toLowerCase());

// IMAGEN — para excluirlas del reparto (son portadas/ilustraciones, no documentos sueltos).
export const esImagenArchivo = (n) => /\.(jpe?g|png|webp|gif|bmp|tiff?|heic)$/i.test(String(n || ''));

// 1) FORMATOS que son un documento por derecho propio (y que los visores no abren → sin visor, pero con ficha,
//    buscables y descargables; mismo criterio que ya se aplicó a los vídeos: «sin visor, pero VISIBLES»).
export const EXT_MATERIAL = new Set([
    // Documentos de texto / ofimática. OJO: .doc/.docx NO están aquí — son DOCUMENTOS DE PLENO DERECHO con
    // lector propio (utils/lector-word.js) y su propia rama en el orquestador; no «material sin visor».
    '.txt', '.rtf', '.odt', '.wpd', '.pages', '.tex',
    '.ppt', '.pptx', '.odp', '.xls', '.xlsx', '.ods',
    // Ebooks que ningún lector propio abre (los que sí se abren van por FORMATO_TEXTO, no por aquí)
    '.lit', '.fb2', '.pdb', '.prc', '.lrf', '.lrx', '.snb', '.tcr', '.rb',
    // Imágenes de disco y paquetes: en una biblioteca son la OBRA (un CD-ROM, un curso), no un accesorio. Se
    // catalogan como UNA ficha, INTACTOS: abrir un .ipa/.dmg/.nrg metería cientos de recursos como fichas
    // sueltas. (El .iso suelto en la raíz del Inbox SÍ se expande por defecto —bsdtar lo lee—, salvo que en el
    // Inspector se marque «software»; aquí entra el .iso que aparece DENTRO de una colección.)
    '.iso', '.nrg', '.mdf', '.mds', '.bin', '.cue', '.img', '.ccd', '.cdi', '.dmg', '.ipa',
]);

// Texto plano: por debajo de este tamaño casi siempre es una nota/apunte del ripeo, no un documento.
const EXT_TEXTO_PLANO = new Set(['.txt', '.tex']);
const MIN_BYTES_TEXTO = Number(process.env.CRIBA_MIN_BYTES_TXT) || 4096;

// 2) Carpetas de RUIDO: bajo ellas, ni un .txt ni un .docx son una obra (son parte de un paquete de software).
const DIRS_RUIDO = new Set([
    'node_modules', '.git', '.svn', '.hg', '__macosx', '__pycache__', 'site-packages', 'vendor',
    'dist', 'build', 'obj', 'release', 'debug', 'target', '.vs', '.idea', '.vscode', 'venv', '.venv',
]);

// 3) NOMBRES de acompañamiento (sin extensión, en minúsculas): metadatos del paquete, no obras.
const NOMBRES_RUIDO = new Set([
    'readme', 'read me', 'leeme', 'léeme', 'license', 'licence', 'licencia', 'copying', 'copyright',
    'changelog', 'changes', 'install', 'authors', 'contributors', 'news', 'todo', 'manifest',
    'requirements', 'package', 'package-lock', 'yarn', 'makefile', 'thumbs', 'desktop', 'version',
    'notes', 'notice', 'credits', 'faq', 'index', 'file_id.diz', 'descript',
]);

/**
 * ¿Este fichero merece FICHA propia como material?
 * @param rel    ruta RELATIVA (POSIX) dentro de la colección — se inspeccionan también sus carpetas.
 * @param bytes  tamaño (opcional; solo se usa para el mínimo de los textos planos).
 */
export function esMaterialNotable(rel, bytes = null) {
    const partes = String(rel || '').split('/').filter(Boolean);
    if (!partes.length) return false;
    const nombre = partes[partes.length - 1];
    const ext = path.extname(nombre).toLowerCase();

    if (!EXT_MATERIAL.has(ext)) return false;                                   // 1) formato no documental
    if (partes.slice(0, -1).some((d) => DIRS_RUIDO.has(d.toLowerCase()))) return false;  // 2) ruido estructural
    const base = path.basename(nombre, ext).trim().toLowerCase();
    if (NOMBRES_RUIDO.has(base)) return false;                                  // 3) nombre de acompañamiento
    if (EXT_TEXTO_PLANO.has(ext) && bytes != null && bytes < MIN_BYTES_TEXTO) return false; // .txt diminuto

    return true;
}

/** Formato (enum de `formatos` del $jsonSchema) de un material notable. Genérico: 'material'. */
export const FORMATO_MATERIAL = 'material';
