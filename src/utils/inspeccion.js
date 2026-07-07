import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { conectarDB } from '../database.js';
import { reciclar, reciclarCarpeta } from './papelera.js';

/**
 * Utilidades de INSPECCIÓN para el panel de control: tamaño/contenido de la Papelera, listado y
 * reingesta de la Cuarentena, e ingesta por día. Solo lectura + acciones explícitas del usuario.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..', '..');
const resolver = (p, def) => {
    const v = p || def;
    return path.isAbsolute(v) ? v : path.resolve(RAIZ, v);
};
const DIR_RECICLAJE = resolver(process.env.PATH_RECICLAJE, 'Recycling');
const DIR_CUARENTENA = resolver(process.env.PATH_CUARENTENA, 'Cuarentena');
const DIR_INBOX = resolver(process.env.PATH_INBOX, 'Inbox');

async function tamanoDir(dir) {
    let bytes = 0, ficheros = 0;
    async function walk(d) {
        let ents; try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            const p = path.join(d, e.name);
            if (e.isDirectory()) await walk(p);
            else { try { bytes += (await fs.stat(p)).size; ficheros++; } catch { /* ignora */ } }
        }
    }
    await walk(dir);
    return { bytes, ficheros };
}

// ── Papelera (Recycling) ─────────────────────────────────────────────────────
export async function infoPapelera() {
    const subcarpetas = [];
    let ents; try { ents = await fs.readdir(DIR_RECICLAJE, { withFileTypes: true }); } catch { ents = []; }
    for (const e of ents) {
        if (!e.isDirectory()) continue;
        const { bytes, ficheros } = await tamanoDir(path.join(DIR_RECICLAJE, e.name));
        // ¿Tiene manifiesto de origen? → se puede restaurar a su sitio (Papelera de Windows).
        const restaurable = await fs.access(path.join(DIR_RECICLAJE, e.name, '.papelera.json')).then(() => true).catch(() => false);
        subcarpetas.push({ nombre: e.name, ficheros, bytes, restaurable });
    }
    subcarpetas.sort((a, b) => b.nombre.localeCompare(a.nombre)); // serial desc → más reciente primero
    const bytes = subcarpetas.reduce((s, x) => s + x.bytes, 0);
    const ficheros = subcarpetas.reduce((s, x) => s + x.ficheros, 0);
    return { bytes, ficheros, subcarpetas };
}

export async function contenidoPapelera(sub) {
    const dir = path.join(DIR_RECICLAJE, path.basename(String(sub || '')));
    const out = [];
    let ents; try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of ents) {
        if (!e.isFile() || e.name === '.papelera.json') continue; // el manifiesto es metadato, no contenido
        let size = 0; try { size = (await fs.stat(path.join(dir, e.name))).size; } catch { /* ignora */ }
        out.push({ nombre: e.name, bytes: size });
    }
    return out;
}

/** Vacía la Papelera entera o una subcarpeta. Es la PAPELERA (último destino): borrar aquí es la
 *  acción explícita de "vaciar la basura" del usuario — fs.rm es correcto. */
export async function vaciarPapelera(sub = null) {
    if (sub) {
        await fs.rm(path.join(DIR_RECICLAJE, path.basename(String(sub))), { recursive: true, force: true }).catch(() => {});
        return { ok: true, vaciado: path.basename(String(sub)) };
    }
    let ents; try { ents = await fs.readdir(DIR_RECICLAJE, { withFileTypes: true }); } catch { ents = []; }
    for (const e of ents) await fs.rm(path.join(DIR_RECICLAJE, e.name), { recursive: true, force: true }).catch(() => {});
    return { ok: true, vaciado: 'todo' };
}

// ── Cuarentena ───────────────────────────────────────────────────────────────
export async function listarCuarentena() {
    const categorias = {};
    let cats; try { cats = await fs.readdir(DIR_CUARENTENA, { withFileTypes: true }); } catch { return categorias; }
    for (const c of cats) {
        if (!c.isDirectory() || c.name.startsWith('@') || c.name.startsWith('.')) continue;
        const catDir = path.join(DIR_CUARENTENA, c.name);
        const depositos = [];
        let deps; try { deps = await fs.readdir(catDir, { withFileTypes: true }); } catch { deps = []; }
        for (const d of deps) {
            if (!d.isDirectory()) continue;
            const depDir = path.join(catDir, d.name);
            let estado = null;
            try { estado = JSON.parse(await fs.readFile(path.join(depDir, 'estado.json'), 'utf8')); } catch { /* sin estado */ }
            const archivos = (await fs.readdir(depDir).catch(() => []))
                .filter(n => n !== 'estado.json' && n !== '.reemplazo');
            depositos.push({
                id: `${c.name}/${d.name}`, nombre: d.name, archivos,
                titulo: estado?.titulo || null,
                error: estado?.error?.mensaje || estado?.error?.tipo || null,
                fecha: estado?.fecha || null,
                // Saneamiento: copia sana ya PREPARADA (lista para procesar por lotes) + posible fallo.
                listo: !!estado?.listo,
                reemplazo: estado?.reemplazo || null,
                error_proceso: estado?.error_proceso || null,
            });
        }
        if (depositos.length) categorias[c.name] = depositos;
    }
    return categorias;
}

/** Devuelve los ficheros reales de un depósito al Inbox para re-catalogarlos, y retira el depósito. */
export async function reingestarCuarentena(idRel) {
    const partes = String(idRel || '').split('/').map(s => path.basename(s)).filter(Boolean);
    if (partes.length < 2) return { ok: false, motivo: 'identificador de depósito inválido' };
    const depDir = path.join(DIR_CUARENTENA, ...partes);
    let ents; try { ents = await fs.readdir(depDir, { withFileTypes: true }); } catch { return { ok: false, motivo: 'depósito no encontrado' }; }
    // Solo ficheros NO vacíos: reingestar un fantasma de 0 bytes lo devolvería tal cual a
    // Cuarentena/ilegibles (trabajo de Sísifo). Un fichero ilegible se arregla con «Reemplazar».
    const candidatos = ents.filter(e => e.isFile() && e.name !== 'estado.json');
    const archivos = [];
    for (const a of candidatos) {
        try { if ((await fs.stat(path.join(depDir, a.name))).size > 0) archivos.push(a); } catch { /* ignora */ }
    }
    if (!archivos.length) return { ok: false, motivo: 'el depósito solo tiene ficheros vacíos (0 bytes): usa «Reemplazar» con una copia sana' };
    await fs.mkdir(DIR_INBOX, { recursive: true });
    let movidos = 0;
    for (const a of archivos) {
        try { await fs.copyFile(path.join(depDir, a.name), path.join(DIR_INBOX, a.name)); movidos++; } catch { /* sigue */ }
    }
    if (movidos === archivos.length) await fs.rm(depDir, { recursive: true, force: true }).catch(() => {});
    return { ok: movidos > 0, movidos, total: archivos.length };
}

/** DESCARTA un depósito: mueve su CARPETA ENTERA (intacta, con `.reemplazo/` y sidecar) a la Papelera,
 *  bajo su categoría, y lo retira de la Cuarentena. Conservar la carpeta tal cual facilita restaurarla
 *  (basta moverla de vuelta). Para cuando ya no interesa el documento o no hay copia sana. */
export async function descartarCuarentena(idRel) {
    const partes = String(idRel || '').split('/').map(s => path.basename(s)).filter(Boolean);
    if (partes.length < 2) return { ok: false, motivo: 'identificador de depósito inválido' };
    const depDir = path.join(DIR_CUARENTENA, ...partes);
    try { await fs.access(depDir); } catch { return { ok: false, motivo: 'depósito no encontrado' }; }
    const dest = await reciclarCarpeta(depDir, 'cuarentena-descartada', partes[0]);
    if (!dest) return { ok: false, motivo: 'no se pudo mover el depósito a la Papelera' };
    return { ok: true, descartado: partes.join('/') };
}

/** DESCARTA una CATEGORÍA entera: mueve cada depósito (carpeta intacta) a la Papelera. Destructivo →
 *  el endpoint exige re-confirmar la contraseña de administrador. */
export async function descartarCategoria(cat) {
    const c = path.basename(String(cat || ''));
    if (!c) return { ok: false, motivo: 'categoría inválida' };
    const catDir = path.join(DIR_CUARENTENA, c);
    let deps; try { deps = (await fs.readdir(catDir, { withFileTypes: true })).filter(e => e.isDirectory()); }
    catch { return { ok: false, motivo: 'categoría no encontrada' }; }
    let movidos = 0;
    for (const d of deps) {
        if (await reciclarCarpeta(path.join(catDir, d.name), `cuarentena-categoria-${c}`, c)) movidos++;
    }
    await fs.rm(catDir, { recursive: true, force: true }).catch(() => {}); // la carpeta de categoría ya vacía
    return { ok: true, categoria: c, movidos, total: deps.length };
}

/** Reingesta TODOS los depósitos de Cuarentena/duplicados (vuelven al Inbox para re-evaluarse con la
 *  lógica actual: los de mismo hash se BORRAN, los de otro formato se SEPARAN en su propio documento,
 *  y solo los conflictos reales (mismo formato, contenido distinto) vuelven a Cuarentena). */
export async function reingestarTodosDuplicados() {
    const catDir = path.join(DIR_CUARENTENA, 'duplicados');
    let deps; try { deps = await fs.readdir(catDir, { withFileTypes: true }); } catch { return { ok: true, depositos: 0, movidos: 0 }; }
    let depositos = 0, movidos = 0;
    for (const d of deps) {
        if (!d.isDirectory()) continue;
        const r = await reingestarCuarentena(`duplicados/${d.name}`);
        depositos++; if (r.ok) movidos += r.movidos || 0;
    }
    return { ok: true, depositos, movidos };
}

// ── Ingesta por día (para la gráfica del panel) ──────────────────────────────
export async function ingestaPorDia(dias = 30) {
    const db = await conectarDB();
    const desde = new Date(Date.now() - dias * 86400000);
    const agg = await db.collection('biblioteca').aggregate([
        { $match: { fecha_ingreso: { $gte: desde } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$fecha_ingreso' } }, n: { $sum: 1 } } },
        { $sort: { _id: 1 } },
    ]).toArray();
    return { dias, total: agg.reduce((s, g) => s + g.n, 0), serie: agg.map(g => ({ dia: g._id, n: g.n })) };
}
