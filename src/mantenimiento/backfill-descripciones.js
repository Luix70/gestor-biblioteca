import { conectarDB } from '../database.js';
import { describirCDU } from '../utils/descripcion-cdu.js';
import { describirClasificacion } from '../utils/descripcion-clasificacion.js';
import { sanitizarCDU } from '../utils/cdu-arbol.js';

/**
 * Relleno PEREZOSO de descripciones de clasificación (CDU/Dewey/LCC) en tandas pequeñas: busca los
 * códigos que usan los libros y aún no tienen descripción y genera unos pocos por llamada (IA + caché).
 * Pensado para correr en CADA pasada de mantenimiento con un tope bajo (acota el coste de IA) y, cuando
 * todo está descrito, no hace ninguna llamada. La misma función sirve para el script de relleno total.
 */
const PAUSA_MS = Number(process.env.DESC_PAUSA_MS || 800); // ritmo entre llamadas a la IA

/** Códigos CDU (limpios, con dígitos) que usan los libros y NO están en cdu_descripciones. */
async function cduFaltantes(db) {
    const crudos = await db.collection('biblioteca').distinct('cdu', { cdu: { $exists: true, $ne: null } });
    const codigos = new Set();
    for (const c of crudos) { const k = sanitizarCDU(c); if (k && /[0-9]/.test(k)) codigos.add(k); }
    const ya = new Set(await db.collection('cdu_descripciones').distinct('codigo'));
    return [...codigos].filter(k => !ya.has(k));
}

/** Códigos Dewey/LCC que usan los libros y NO están en clasificacion_descripciones. */
async function clasFaltantes(db, sistema) {
    const crudos = await db.collection('biblioteca').distinct(sistema, { [sistema]: { $exists: true, $ne: null } });
    const codigos = new Set(crudos.map(c => String(c).trim()).filter(Boolean));
    const ya = new Set(await db.collection('clasificacion_descripciones').distinct('codigo', { sistema }));
    return [...codigos].filter(c => !ya.has(c));
}

/** Cuenta cuántas descripciones faltan por sistema (sin generar nada) — para el dry-run del script. */
export async function contarFaltantes(db = null) {
    if (!db) db = await conectarDB();
    const cdu = await cduFaltantes(db), dewey = await clasFaltantes(db, 'dewey'), lcc = await clasFaltantes(db, 'lcc');
    return { cdu: cdu.length, dewey: dewey.length, lcc: lcc.length, total: cdu.length + dewey.length + lcc.length };
}

/**
 * Genera (IA + caché) hasta `limite` descripciones que falten, primero CDU y luego Dewey/LCC con el
 * cupo restante. Best-effort: un fallo de IA se reintenta en otra tanda (no inserta basura).
 * @returns {Promise<{generadas:number, fallos:number, pendientes:number}>}
 */
export async function rellenarDescripcionesFaltantes({ limite = 5, db = null } = {}) {
    if (!limite || limite <= 0) return { generadas: 0, fallos: 0, pendientes: 0 };
    if (!db) db = await conectarDB();

    const cdu = await cduFaltantes(db);
    const dewey = await clasFaltantes(db, 'dewey');
    const lcc = await clasFaltantes(db, 'lcc');
    const totalFaltan = cdu.length + dewey.length + lcc.length;
    if (!totalFaltan) return { generadas: 0, fallos: 0, pendientes: 0 };

    const objetivos = [
        ...cdu.map(c => ({ sistema: 'cdu', codigo: c })),
        ...dewey.map(c => ({ sistema: 'dewey', codigo: c })),
        ...lcc.map(c => ({ sistema: 'lcc', codigo: c })),
    ].slice(0, limite);

    let generadas = 0, fallos = 0;
    for (const o of objetivos) {
        const r = o.sistema === 'cdu'
            ? await describirCDU(db, o.codigo)
            : await describirClasificacion(db, o.sistema, o.codigo);
        if (r) generadas++; else fallos++;
        await new Promise(res => setTimeout(res, PAUSA_MS));
    }
    return { generadas, fallos, pendientes: totalFaltan - generadas };
}
