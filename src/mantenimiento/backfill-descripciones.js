import { conectarDB } from '../database.js';
import { conTexto, extraerJSON } from '../utils/vision.js';
import { describirCDU, sembrarDescripcionCDU } from '../utils/descripcion-cdu.js';
import { describirClasificacion, guardarDescripcionClasificacion } from '../utils/descripcion-clasificacion.js';
import { sanitizarCDU } from '../utils/cdu-arbol.js';

/**
 * Relleno de descripciones de clasificación (CDU/Dewey/LCC) minimizando el COSTE DE IA:
 *  - Busca los códigos que usan los libros y aún no tienen descripción.
 *  - Los pide POR LOTE a la IA (una sola llamada describe varios códigos): como se cobra por tokens y el
 *    prompt de instrucciones es fijo, agrupar amortiza ese coste y reduce el nº de llamadas (menos 429 en
 *    el tier gratis antes de caer al de pago). La IA de texto va por rotación multi-proveedor (conTexto).
 *  - Si el lote no se puede parsear o falta algún código, cae a la generación UNO-A-UNO (que también
 *    cachea). Best-effort: un fallo se reintenta en otra pasada (no inserta basura).
 * La misma función sirve para la campaña de fondo y para el script de relleno total.
 */
const PAUSA_MS = Number(process.env.DESC_PAUSA_MS || 400);         // ritmo entre códigos
const LOTE_IA = Math.max(1, Number(process.env.DESC_LOTE_IA) || 6); // códigos por llamada de IA

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

// Clave para casar la respuesta de la IA con el código pedido (CDU se normaliza con sanitizarCDU).
const clave = (sistema, codigo) => sistema === 'cdu'
    ? 'cdu|' + sanitizarCDU(codigo)
    : String(sistema).toLowerCase() + '|' + String(codigo).trim();

// Prompt para describir VARIOS códigos en una sola llamada (array JSON en el MISMO orden).
function promptLote(items) {
    const lista = items.map((o, i) => `${i + 1}. [${o.sistema}] ${o.codigo}`).join('\n');
    return `Eres un bibliotecario experto en clasificación bibliográfica (CDU/UDC, Dewey/DDC y Library of Congress/LCC).
Para CADA código de la lista redacta:
- "titulo_es": título BREVE en español (la materia que designa),
- "descripcion_es": explicación RIGUROSA y EXTENSA en español (uno o dos párrafos) desglosando la jerarquía
  del código (clase, división, secciones y auxiliares que apliquen).
Para los códigos [cdu] añade además "titulo_en" y "descripcion_en" (en inglés). Para [dewey] y [lcc] deja
"titulo_en" y "descripcion_en" como cadena vacía "".
Responde ÚNICAMENTE con un ARRAY JSON (sin markdown ni texto alrededor), un objeto por código y en el MISMO
orden, con el "codigo" EXACTO tal como se da:
[{"sistema":"cdu|dewey|lcc","codigo":"<código>","titulo_es":"...","descripcion_es":"...","titulo_en":"...","descripcion_en":"..."}]

Códigos:
${lista}`;
}

// Extrae un ARRAY JSON de la respuesta (tolera fences y texto alrededor).
function parsearArray(txt) {
    const j = extraerJSON(txt);
    if (Array.isArray(j)) return j;
    const s = String(txt || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const a = s.indexOf('['), b = s.lastIndexOf(']');
    if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* */ } }
    return null;
}

// Guarda en caché una descripción ya obtenida (sin IA). Devuelve true si quedó cacheada.
async function guardarUno(db, sistema, codigo, datos) {
    if (!datos || (!datos.descripcion_es && !datos.titulo_es)) return false;
    if (sistema === 'cdu') {
        const r = await sembrarDescripcionCDU(db, codigo, datos);
        return !!r || !!(await db.collection('cdu_descripciones').findOne({ codigo: sanitizarCDU(codigo) }));
    }
    const r = await guardarDescripcionClasificacion(db, sistema, codigo, datos);
    return !!r || !!(await db.collection('clasificacion_descripciones').findOne({ sistema, codigo: String(codigo).trim() }));
}

// Genera UNO-A-UNO (fallback): hace su propia llamada de IA y cachea.
async function generarUno(db, sistema, codigo) {
    try {
        const r = sistema === 'cdu' ? await describirCDU(db, codigo) : await describirClasificacion(db, sistema, codigo);
        return !!r;
    } catch { return false; }
}

/**
 * Genera (IA + caché) hasta `limite` descripciones que falten, en LOTES para abaratar. `onProgreso(hechos,
 * total)` se llama tras cada código (para la barra del panel).
 * @returns {Promise<{generadas:number, fallos:number, pendientes:number}>}
 */
export async function rellenarDescripcionesFaltantes({ limite = 5, db = null, onProgreso = null } = {}) {
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

    const total = objetivos.length;
    let generadas = 0, fallos = 0, hechos = 0;

    for (let i = 0; i < objetivos.length; i += LOTE_IA) {
        const grupo = objetivos.slice(i, i + LOTE_IA);

        // Una sola llamada de IA para todo el grupo (si es de 2+; uno suelto va directo al fallback).
        const mapa = new Map();
        if (grupo.length > 1) {
            try {
                const txt = await conTexto({ prompt: promptLote(grupo), json: true, maxTokens: 8000 });
                const arr = parsearArray(txt);
                if (Array.isArray(arr)) for (const o of arr) if (o && o.sistema && o.codigo) mapa.set(clave(o.sistema, o.codigo), o);
            } catch { /* el lote falló entero → cada código cae al fallback uno-a-uno */ }
        }

        for (const it of grupo) {
            const o = mapa.get(clave(it.sistema, it.codigo));
            let ok = o ? await guardarUno(db, it.sistema, it.codigo, o) : false;
            if (!ok) ok = await generarUno(db, it.sistema, it.codigo); // fallback individual
            if (ok) generadas++; else fallos++;
            hechos++;
            if (onProgreso) onProgreso(hechos, total);
            await new Promise(res => setTimeout(res, PAUSA_MS));
        }
    }
    return { generadas, fallos, pendientes: totalFaltan - generadas };
}
