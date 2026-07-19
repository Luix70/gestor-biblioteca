/**
 * PLANES DE INGESTA GUARDADOS.
 *
 * El plan se calcula MIRANDO EL INBOX, así que después de ingerir ya no se puede reconstruir: el Inbox está
 * vacío y no queda contra qué comparar. Y entre planificar y comprobar pueden pasar horas, irse la luz o
 * reiniciarse la máquina. Por eso el plan se PERSISTE en disco al generarlo, y se puede recargar después para
 * cotejarlo contra el catálogo — que es lo único que responde «¿entró todo?».
 *
 * Se guarda en `PATH_PLANES` (por defecto `Planes/` bajo la raíz de la app, que en el NAS es un bind mount y
 * sobrevive a reinicios y a rebuilds del contenedor).
 * ⚠ El despliegue hace `rsync --delete`: esta carpeta va EXCLUIDA en actualizar-GestorBiblioteca.sh, igual que
 * Inbox/CDU/Cuarentena. Sin esa exclusión, cada despliegue se llevaría el historial por delante.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const dirPlanes = () => {
    const v = process.env.PATH_PLANES || 'Planes';
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};

/** Cuántos planes se conservan. Son ficheros pequeños, pero no tiene sentido guardar historia infinita. */
const MAX_PLANES = Number(process.env.PLANES_MAX) || 40;

const ID_RE = /^plan-[0-9TZ:.\-]+$/;   // el id ES el nombre del fichero: se valida antes de tocar el disco

/**
 * Guarda un plan y devuelve su id. Nunca lanza: no poder guardar el historial no debe romper el informe (que
 * es lo que el usuario está pidiendo en ese momento).
 * @returns {Promise<string|null>} id del plan guardado, o null si no se pudo.
 */
export async function guardarPlan(plan) {
    try {
        const dir = dirPlanes();
        await fs.mkdir(dir, { recursive: true });
        const id = 'plan-' + new Date(plan?.ts || Date.now()).toISOString().replace(/[:.]/g, '-');
        await fs.writeFile(path.join(dir, id + '.json'), JSON.stringify(plan), 'utf8');
        await podar(dir);
        return id;
    } catch { return null; }
}

/** Los planes guardados, del más reciente al más antiguo: {id, ts, unidades, documentos}. */
export async function listarPlanes() {
    const dir = dirPlanes();
    let nombres;
    try { nombres = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')); } catch { return []; }
    const out = [];
    for (const n of nombres) {
        const id = n.slice(0, -5);
        try {
            const p = JSON.parse(await fs.readFile(path.join(dir, n), 'utf8'));
            out.push({ id, ts: p.ts || null, unidades: p.resumen?.unidades ?? (p.unidades || []).length, documentos: p.resumen?.documentos ?? null });
        } catch { /* un plan ilegible no debe tumbar el listado */ }
    }
    return out.sort((a, b) => String(b.ts || b.id).localeCompare(String(a.ts || a.id)));
}

/** Lee un plan guardado por su id. Devuelve null si no existe o el id es inválido. */
export async function leerPlan(id) {
    if (!ID_RE.test(String(id || ''))) return null;   // el id se usa como nombre de fichero: nada de «..»
    try { return JSON.parse(await fs.readFile(path.join(dirPlanes(), id + '.json'), 'utf8')); }
    catch { return null; }
}

/** Deja solo los MAX_PLANES más recientes. Best-effort. */
async function podar(dir) {
    try {
        const nombres = (await fs.readdir(dir)).filter((n) => n.endsWith('.json')).sort();
        for (const n of nombres.slice(0, Math.max(0, nombres.length - MAX_PLANES)))
            await fs.rm(path.join(dir, n), { force: true }).catch(() => {});
    } catch { /* */ }
}
