import { conTexto, extraerJSON } from './vision.js';
import { buscarEquivalenciaExterna } from '../clasificador-cdu.js';
import { sanitizarCDU } from './cdu-arbol.js';

/**
 * Descripciones (ES) de códigos Dewey (DDC) y Library of Congress (LCC), análogo a `descripcion-cdu.js`
 * pero para esos dos sistemas. Cacheado en la colección `clasificacion_descripciones` (clave
 * {sistema, codigo}); en un fallo (IA/JSON) devuelve null y se reintenta luego (no inserta basura).
 * El CDU NO pasa por aquí: tiene su propia tabla `cdu_descripciones` (ver `describirCDU`).
 *
 * (13-oct) REFERENCIAS OFICIALES (colección `clasificacion_oficial`, scripts/importar-referencias-clasificacion.js):
 *   · LCC: el LC Classification Outline (dominio público). Con él la descripción de un LCC se COMPONE SIN IA y es la
 *     que se enseña por defecto: «B753 → Philosophy (General) › Medieval (430-1450)». Antes la IA recibía la signatura
 *     COMPLETA, con la marca de autor y el año («B753.G34 G75 2009»), y describía el LIBRO («Al-Ghazali: obra
 *     específica»).
 *   · Dewey: los DDC 23 Summaries (© OCLC: SOLO como referencia interna para la IA, nunca se enseñan) y la CDU que da
 *     la tabla determinista. Antes la IA inventaba («181.5 = Filosofía japonesa»; 181 es filosofía oriental).
 */
const NOMBRES = {
    dewey: 'Clasificación Decimal Dewey (DDC)',
    lcc: 'Library of Congress Classification (LCC)',
};

/** La UNIDAD de un código: el LCC sin marca de autor ni año («B753.G34 G75 2009» → «B753»); el Dewey sin «/» ni «'». */
export function unidadClasificacion(sistema, codigo) {
    const c = String(codigo || '').trim();
    if (sistema === 'lcc') {
        const m = c.toUpperCase().match(/^([A-Z]{1,3})[\s-]*0*(\d+(?:\.\d+)?)/);
        return m ? `${m[1]}${m[2]}` : c.toUpperCase();
    }
    return (c.replace(/['/]/g, '').match(/\d{3}(?:\.\d+)?/) || [c])[0];
}

/** Los rangos OFICIALES del LC Outline que contienen el código, del más amplio al más concreto. */
async function rangosLcc(db, codigo) {
    const m = String(codigo || '').toUpperCase().match(/^([A-Z]{1,3})[\s-]*0*(\d+(?:\.\d+)?)/);
    if (!m) return [];
    const [, clase, numero] = m;
    const n = Number(numero);
    const filas = await db.collection('clasificacion_oficial').find({ sistema: 'lcc', clase, desde: { $ne: null, $lte: n }, hasta: { $gte: n } })
        .project({ notacion: 1, titulo: 1, titulo_es: 1, desde: 1, hasta: 1 }).toArray().catch(() => []);
    return filas.sort((a, b) => (b.hasta - b.desde) - (a.hasta - a.desde) || a.desde - b.desde);
}

/** Las referencias oficiales de un código, como líneas para la IA. */
export async function referenciasOficialesClasificacion(db, sistema, codigo) {
    const lineas = [];
    if (sistema === 'lcc') {
        for (const r of await rangosLcc(db, codigo)) lineas.push(`LCC ${r.notacion} = ${r.titulo} [LC Classification Outline]`);
    } else if (sistema === 'dewey') {
        const d = (String(codigo).match(/\d{3}/) || [])[0];
        if (d) {
            for (const k of [...new Set([`${d[0]}00`, `${d.slice(0, 2)}0`, d])]) {
                const o = await db.collection('clasificacion_oficial').findOne({ _id: `dewey|${k}` }).catch(() => null);
                if (o) lineas.push(`Dewey ${k} = ${o.titulo} [DDC 23 Summaries]`);
            }
        }
    }
    // La CDU que da la tabla determinista, con su significado oficial si está en el UDC Summary.
    const cdu = await buscarEquivalenciaExterna(sistema, codigo).catch(() => null);
    if (cdu) {
        const u = await db.collection('udc_summary').findOne({ _id: cdu }).catch(() => null)
            || await db.collection('cdu_descripciones').findOne({ codigo: sanitizarCDU(cdu), fuente: 'udcs' }).catch(() => null);
        const titulo = u?.es?.titulo || u?.titulo_es;
        lineas.push(`Equivale en la CDU a ${cdu}${titulo ? ` (${titulo})` : ''}`);
    }
    return lineas;
}

/** La descripción de un LCC COMPUESTA con el LC Outline, sin IA. null si no hay rangos para ese código. */
export async function descripcionLccOficial(db, codigo) {
    const rangos = await rangosLcc(db, codigo);
    if (!rangos.length) return null;
    const concreto = rangos[rangos.length - 1];
    const titulo = (r) => r.titulo_es || r.titulo;
    return {
        titulo_es: titulo(concreto),
        descripcion_es: `Según el LC Classification Outline de la Library of Congress, ${unidadClasificacion('lcc', codigo)} está en:\n`
            + rangos.map((r) => `· ${r.notacion} — ${titulo(r)}`).join('\n'),
        fuente: 'lcco',
    };
}

const prompt = (sistema, codigo, refs = []) => `Eres un bibliotecario experto en la ${NOMBRES[sistema] || sistema}.
Para el código "${codigo}" de la ${NOMBRES[sistema] || sistema}, redacta:
- un título BREVE en español (la materia que designa, pocas palabras),
- una explicación RIGUROSA y EXTENSA en español (uno o dos párrafos) desglosando la jerarquía del
  código (clase, división, sección y subdivisiones que apliquen).
Describe la CLASIFICACIÓN (la materia de ese número), NUNCA un libro, un autor o una obra concreta.
${refs.length ? `REFERENCIAS OFICIALES (no las contradigas; tradúcelas, no las copies):\n${refs.map((r) => `  · ${r}`).join('\n')}\nSi no sabes con certeza qué significa una subdivisión más fina que las referencias, quédate en el nivel de la referencia más concreta.\n` : ''}Responde ÚNICAMENTE con JSON válido (sin markdown, sin texto fuera del JSON):
{"titulo_es":"<título breve>","descripcion_es":"<explicación extensa>"}`;

async function generarIA(db, sistema, codigo, { soloGratis = false } = {}) {
    const unidad = unidadClasificacion(sistema, codigo);
    const refs = await referenciasOficialesClasificacion(db, sistema, unidad);
    const txt = await conTexto({ prompt: prompt(sistema, unidad, refs), json: true, maxTokens: 3000, soloGratis });
    const j = extraerJSON(txt);
    if (!j || !j.titulo_es || !j.descripcion_es) throw new Error('respuesta de IA no parseable o incompleta');
    return j;
}

/**
 * La descripción que se ENSEÑA de un código Dewey/LCC (sin generar nada):
 *   1. una rehecha a mano (↻) o verificada;
 *   2. para el LCC, la compuesta con el LC Outline (oficial, sin IA);
 *   3. la guardada (de IA).
 */
export async function descripcionVigente(db, sistema, codigo) {
    sistema = String(sistema || '').toLowerCase();
    codigo = String(codigo || '').trim();
    const guardada = await db.collection('clasificacion_descripciones').findOne({ sistema, codigo });
    if (guardada && (guardada.verificado || guardada.revisada)) return guardada;
    if (sistema === 'lcc') {
        const oficial = await descripcionLccOficial(db, codigo);
        if (oficial) return oficial;
    }
    return guardada || null;
}

/**
 * Guarda en caché la descripción Dewey/LCC a partir de datos YA obtenidos (p. ej. una llamada por LOTE),
 * sin gastar IA. Idempotente: si ya existe, no la pisa. Devuelve el doc guardado/existente o null.
 */
export async function guardarDescripcionClasificacion(db, sistema, codigo, datos = {}) {
    sistema = String(sistema || '').toLowerCase();
    codigo = String(codigo || '').trim();
    if (!['dewey', 'lcc'].includes(sistema) || !codigo) return null;
    if (!datos || (!datos.titulo_es && !datos.descripcion_es)) return null;
    const col = db.collection('clasificacion_descripciones');
    if (await col.findOne({ sistema, codigo })) return null; // ya cacheada
    const doc = {
        sistema, codigo,
        titulo_es: datos.titulo_es || null,
        descripcion_es: datos.descripcion_es || null,
        fuente: 'ia', verificado: false, fecha: new Date(),
    };
    try { await col.insertOne(doc); return doc; }
    catch { return await col.findOne({ sistema, codigo }); }
}

/**
 * Asegura que un código Dewey/LCC tenga descripción en `clasificacion_descripciones`. Cacheado: si ya
 * existe la devuelve sin llamar a la IA. Best-effort: ante fallo devuelve null.
 * Un LCC con rangos en el LC Outline no necesita IA: devuelve la oficial compuesta (sin guardarla).
 * @returns el documento de descripción (existente o nuevo) o null.
 */
export async function describirClasificacion(db, sistema, codigo) {
    sistema = String(sistema || '').toLowerCase();
    codigo = String(codigo || '').trim();
    if (!['dewey', 'lcc'].includes(sistema) || !codigo) return null;

    const col = db.collection('clasificacion_descripciones');
    const ya = await col.findOne({ sistema, codigo });
    if (ya) return ya;
    if (sistema === 'lcc') {
        // Con el LC Outline no hace falta IA: se guarda la oficial (si no, Mantenimiento la vería «faltante» siempre).
        const oficial = await descripcionLccOficial(db, codigo);
        if (oficial) {
            const doc = { sistema, codigo, ...oficial, verificado: true, fecha: new Date() };
            try { await col.insertOne(doc); return doc; } catch { return await col.findOne({ sistema, codigo }); }
        }
    }

    let datos;
    try { datos = await generarIA(db, sistema, codigo); } catch { return null; }

    const doc = {
        sistema, codigo,
        titulo_es: datos.titulo_es || null,
        descripcion_es: datos.descripcion_es || null,
        fuente: 'ia', verificado: false, fecha: new Date(),
    };
    try { await col.insertOne(doc); return doc; }
    catch { return await col.findOne({ sistema, codigo }); } // carrera: lo insertó otro
}

/**
 * REHACER la descripción de un código Dewey/LCC a petición (botón «↻» de la ficha), con o sin IA.
 *   · sin IA: LCC → la compuesta con el LC Outline; Dewey → su equivalencia en la CDU (los títulos del Dewey son
 *     © OCLC y no se enseñan). Si no hay nada oficial, lanza («usa la opción con IA»).
 *   · con IA: con las referencias oficiales.
 * La que hubiera se copia en clasificacion_descripciones_retiradas. Devuelve la nueva.
 */
export async function regenerarDescripcionClasificacion(db, sistema, codigo, { conIA = false, soloGratis = false } = {}) {
    sistema = String(sistema || '').toLowerCase();
    codigo = String(codigo || '').trim();
    if (!['dewey', 'lcc'].includes(sistema) || !codigo) throw new Error('sistema o código no válidos');
    let datos;
    let fuente;
    if (conIA) {
        datos = await generarIA(db, sistema, codigo, { soloGratis });
        fuente = 'ia';
    } else if (sistema === 'lcc') {
        datos = await descripcionLccOficial(db, codigo);
        if (!datos) throw new Error('este LCC no está en el LC Classification Outline: usa la opción con IA');
        fuente = 'lcco';
    } else {
        const cdu = await buscarEquivalenciaExterna('dewey', codigo).catch(() => null);
        if (!cdu) throw new Error('este Dewey no tiene equivalencia segura en la CDU: usa la opción con IA');
        const u = await db.collection('cdu_descripciones').findOne({ codigo: sanitizarCDU(cdu) });
        datos = {
            titulo_es: u?.titulo_es ? `${u.titulo_es} (CDU ${cdu})` : `Equivale a la CDU ${cdu}`,
            descripcion_es: `Descripción sin IA: este número Dewey equivale en la CDU a ${cdu}${u?.titulo_es ? `, «${u.titulo_es}»` : ''}.${u?.descripcion_es ? `\n\n${u.descripcion_es}` : ''}`,
        };
        fuente = 'cdu-equivalente';
    }
    const col = db.collection('clasificacion_descripciones');
    const vieja = await col.findOne({ sistema, codigo });
    if (vieja) {
        const { _id, ...copia } = vieja;
        await db.collection('clasificacion_descripciones_retiradas').insertOne({ ...copia, _id_original: _id, retirada: { fecha: new Date(), motivo: `regenerada (${conIA ? 'con IA' : 'sin IA'})` } });
    }
    const doc = {
        sistema, codigo, titulo_es: datos.titulo_es || null, descripcion_es: datos.descripcion_es || null,
        fuente, verificado: fuente !== 'ia', fecha: new Date(), revisada: { fecha: new Date(), motivo: 'regenerada' },
    };
    await col.updateOne({ sistema, codigo }, { $set: doc }, { upsert: true });
    return doc;
}
