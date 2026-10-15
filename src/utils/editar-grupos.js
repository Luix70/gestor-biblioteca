/**
 * Edición MANUAL de COLECCIONES (series/cabeceras) y OBRAS (multivolumen) desde su ficha. Campos comunes:
 * descripción/presentación, editorial (por nombre → ObjectId, check-then-create), CDU y las fechas de
 * publicación (inicio/fin: p. ej. una revista de 1920 a 1960, o de 1980 a la actualidad → fin vacío).
 * Específicos: la colección lleva ISSN (autoridad de la cabecera/serie) y la obra su ISBN de obra + total
 * de tomos. Identificadores validados por checksum (los malformados se descartan con aviso, no rompen nada).
 * No mueve ficheros: un cambio de CDU de la colección/obra es de metadatos (cada miembro conserva el suyo).
 */
import { ObjectId } from 'mongodb';
import { validarISBN, validarISSN } from './identificadores.js';
import { limpiarNombreEditorial } from './editoriales-falsas.js';
import { resolverEditorial as resolverEditorialComun } from './resolver-editorial.js';

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);

async function resolverEditorial(db, nombre) {
    return resolverEditorialComun(db, nombre);   // por nombre o grafía (utils/resolver-editorial.js)
}

// Año de publicación (inicio/fin): entero 1000-2100, o null (vacío = «sin dato» / «hasta la actualidad»).
function anioValido(v) {
    if (v === '' || v == null) return null;
    const n = parseInt(v, 10);
    return (n >= 1000 && n <= 2100) ? n : NaN;
}

// Campos COMUNES a colección y obra: descripción, editorial, CDU, fecha_inicio, fecha_fin.
async function aplicarComunes(db, campos, set, unset, avisos) {
    if ('descripcion' in campos) {
        const v = String(campos.descripcion || '').trim();
        if (v) set.descripcion = v; else unset.descripcion = '';
    }
    if ('cdu' in campos) {
        const v = String(campos.cdu || '').trim();
        if (v) { set.cdu = v; set.cdu_manual = true; } else unset.cdu = '';
    }
    if ('editorial' in campos) {
        const e = await resolverEditorial(db, campos.editorial);
        if (e) set.editorial = e; else unset.editorial = '';
    }
    for (const k of ['fecha_inicio', 'fecha_fin']) {
        if (!(k in campos)) continue;
        const a = anioValido(campos[k]);
        if (a === null) unset[k] = '';
        else if (Number.isNaN(a)) avisos.push(`${k === 'fecha_inicio' ? 'Año de inicio' : 'Año de fin'} inválido (ignorado)`);
        else set[k] = a;
    }
}

async function persistir(db, coleccion, _id, set, unset, avisos) {
    if (!Object.keys(set).length && !Object.keys(unset).length) return { ok: true, sinCambios: true, avisos };
    set.fecha_actualizacion = new Date();
    const upd = {};
    if (Object.keys(set).length) upd.$set = set;
    if (Object.keys(unset).length) upd.$unset = unset;
    try {
        const r = await db.collection(coleccion).updateOne({ _id }, upd);
        if (!r.matchedCount) return { ok: false, motivo: `${coleccion === 'obras' ? 'obra' : 'colección'} no encontrada` };
    } catch (e) {
        if (/duplicate key/i.test(e.message)) return { ok: false, motivo: 'Ya existe otra con ese nombre o ISSN' };
        throw e;
    }
    return { ok: true, avisos };
}

// Tipos de colección conmutables a mano desde la ficha. `transmedia`/`audiolibros` NO están: son
// ESTRUCTURALES (su árbol en disco con `ruta_fija` y la naturaleza de sus miembros dependen del tipo).
const TIPOS_COLECCION = ['libro', 'revista'];
const TIPOS_ESTRUCTURALES = ['transmedia', 'audiolibros'];

export async function editarColeccion(db, id, campos = {}) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const set = {}, unset = {}, avisos = [];
    if ('nombre' in campos && String(campos.nombre).trim()) set.nombre = String(campos.nombre).trim(); // requerido: nunca se borra
    if ('issn' in campos) {
        const v = String(campos.issn || '').trim();
        if (!v) unset.issn = '';
        else { const ok = validarISSN(v); if (ok) set.issn = ok; else avisos.push(`ISSN inválido (ignorado): ${v}`); }
    }
    // TIPO: 'libro' (serie editorial) ↔ 'revista' (cabecera, pivote ISSN). Es SEGURO cambiarlo: `tipo` no
    // participa en el emparejado de resolverCabecera (que va por ISSN → nombre → clave canónica), así que no
    // funde ni duplica cabeceras. Solo cambia el MODELO del grupo; el tipo_recurso de cada MIEMBRO se cambia
    // aparte con «🔀 Cambiar tipo» (ficha o lote del Catálogo). `null`/ausente = legado ⇒ se trata como libro.
    if ('tipo' in campos) {
        const actual = (await db.collection('colecciones').findOne({ _id }, { projection: { tipo: 1 } }))?.tipo || null;
        const v = String(campos.tipo || '').trim().toLowerCase();
        if (TIPOS_ESTRUCTURALES.includes(actual)) avisos.push(`El tipo «${actual}» es estructural: no se cambia desde la ficha.`);
        else if (TIPOS_COLECCION.includes(v)) { if (v !== actual) set.tipo = v; }
        else if (v) avisos.push(`Tipo no admitido (ignorado): ${v}`);
    }
    await aplicarComunes(db, campos, set, unset, avisos);
    return persistir(db, 'colecciones', _id, set, unset, avisos);
}

/**
 * APLICAR LA CDU DE LA OBRA A TODOS SUS TOMOS (15-oct, petición del usuario: al cambiar la CDU de una obra, el panel
 * pregunta si se aplica también a los tomos). Los tomos viven juntos en <cdu>/obras/<obra>/<vol-N>/, así que no se
 * mueven uno a uno (reubicarPorCdu no toca los tomos de obra): se mueve la carpeta DE LA OBRA entera al árbol de la CDU
 * nueva —con verificación de la copia, como siempre—, y en cada tomo se actualizan la CDU (manual: la has decidido tú),
 * la ruta, la portada y las imágenes; se regeneran sus sidecars. Un tomo que no vive en esa carpeta (ingerido aparte)
 * recibe la CDU solo en la base, con aviso. Si la carpeta destino ya existe (otra obra), no se mueve nada.
 * @returns {Promise<{ tomos:number, movida:boolean, avisos:string[] }>}
 */
export async function aplicarCduAObra(db, obraId, cduNueva) {
    const { carpetaDeDoc, webDeDoc, carpetaExiste, moverCarpetaConVerificacion } = await import('../mantenimiento/util-mantenimiento.js');
    const { arbolCDU } = await import('./cdu-arbol.js');
    const { modernizarCDU } = await import('./cdu-moderna.js');
    const { regenerarSidecarsDoc } = await import('./registro.js');
    const { indexarDoc } = await import('./indice-busqueda.js');
    const cdu = modernizarCDU(String(cduNueva || '').trim());
    const avisos = [];
    const col = db.collection('biblioteca');
    const tomos = await col.find({ obra: obraId }).toArray();
    if (!cdu || !tomos.length) return { tomos: 0, movida: false, avisos };

    // La carpeta de la obra: lo que va hasta «…/obras/<obra>» en la ruta de sus tomos (la del primero que la tenga).
    const baseDe = (web) => { const m = String(web || '').match(/^(.*\/obras\/[^/]+)\//); return m ? m[1] : null; };
    const baseVieja = tomos.map((t) => baseDe(t.ruta_base)).find(Boolean) || null;
    let baseNueva = null;
    let movida = false;
    if (baseVieja) {
        const obraSeg = baseVieja.split('/').pop();
        baseNueva = '/recursos/' + [...arbolCDU(cdu).segmentos, 'obras', obraSeg].join('/');
        if (baseNueva !== baseVieja) {
            const dirViejo = carpetaDeDoc({ ruta_base: baseVieja });
            const dirNuevo = carpetaDeDoc({ ruta_base: baseNueva });
            if (!(await carpetaExiste(dirViejo))) {
                avisos.push('La carpeta de la obra no está en este disco: la CDU de los tomos se cambia solo en la base.');
                baseNueva = null;
            } else if (await carpetaExiste(dirNuevo)) {
                avisos.push(`Ya existe una carpeta «${baseNueva}» (¿otra obra con el mismo nombre?): no se mueve; la CDU se cambia solo en la base.`);
                baseNueva = null;
            } else {
                const ficheros = tomos.flatMap((t) => [t.portada, ...(t.imagenes || []).map((i) => i.ruta)]).filter(Boolean).map((p) => p.split('/').pop());
                await moverCarpetaConVerificacion(dirViejo, dirNuevo, ficheros);
                movida = true;
            }
        } else baseNueva = null;   // misma rama: no hay que mover nada
    }

    const remap = (p) => (p && baseNueva && p.startsWith(baseVieja + '/') ? baseNueva + p.slice(baseVieja.length) : p);
    for (const t of tomos) {
        const set = { cdu, cdu_manual: true, cdu_fuente: 'manual', fecha_actualizacion: new Date() };
        const dentro = baseNueva && String(t.ruta_base || '').startsWith(baseVieja + '/');
        if (dentro) {
            set.ruta_base = remap(t.ruta_base);
            if (t.portada) set.portada = remap(t.portada);
            if (t.imagenes?.length) set.imagenes = t.imagenes.map((i) => ({ ...i, ruta: remap(i.ruta) }));
        }
        await col.updateOne({ _id: t._id }, {
            $set: set,
            $push: { alertas_agente: `CDU «${t.cdu}» → «${cdu}», la de su obra (aplicada a todos los tomos desde la ficha de la obra)${dentro ? '; carpeta de la obra movida' : ''}.` },
        });
        const nuevo = { ...t, ...set };
        await regenerarSidecarsDoc(db, nuevo, carpetaDeDoc(nuevo)).catch(() => {});
        await indexarDoc(db, t._id).catch(() => {});
    }
    const fuera = tomos.filter((t) => !baseVieja || !String(t.ruta_base || '').startsWith(baseVieja + '/')).length;
    if (fuera && movida) avisos.push(`${fuera} tomo(s) no estaban en la carpeta de la obra: CDU cambiada solo en la base.`);
    return { tomos: tomos.length, movida, avisos };
}

export async function editarObra(db, id, campos = {}) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const set = {}, unset = {}, avisos = [];
    if ('titulo' in campos && String(campos.titulo).trim()) set.titulo = String(campos.titulo).trim(); // requerido
    if ('isbn_obra' in campos) {
        const v = String(campos.isbn_obra || '').trim();
        if (!v) unset.isbn_obra = '';
        else { const ok = validarISBN(v); if (ok) set.isbn_obra = ok; else avisos.push(`ISBN inválido (ignorado): ${v}`); }
    }
    if ('total_volumenes' in campos) {
        if (campos.total_volumenes === '' || campos.total_volumenes == null) unset.total_volumenes = '';
        else { const v = parseInt(campos.total_volumenes, 10); if (Number.isFinite(v) && v > 0) set.total_volumenes = v; else avisos.push('Total de tomos inválido (ignorado)'); }
    }
    await aplicarComunes(db, campos, set, unset, avisos);
    const r = await persistir(db, 'obras', _id, set, unset, avisos);
    // A LOS TOMOS, si se pidió (el panel pregunta al guardar): la CDU (mueve la carpeta de la obra) y la editorial.
    const aTomos = Array.isArray(campos.aplicarATomos) ? campos.aplicarATomos : [];
    if (r.ok && aTomos.includes('cdu') && set.cdu) {
        const t = await aplicarCduAObra(db, _id, set.cdu);
        r.tomos = t.tomos;
        r.avisos = [...(r.avisos || []), `CDU aplicada a ${t.tomos} tomo(s)${t.movida ? ' (carpeta de la obra movida)' : ''}`, ...t.avisos];
    }
    if (r.ok && aTomos.includes('editorial') && set.editorial) {
        const u = await db.collection('biblioteca').updateMany({ obra: _id }, {
            $set: { editorial: set.editorial, fecha_actualizacion: new Date() },
            $push: { alertas_agente: 'Editorial de su obra aplicada a todos los tomos desde la ficha de la obra.' },
        });
        r.avisos = [...(r.avisos || []), `Editorial aplicada a ${u.modifiedCount} tomo(s)`];
    }
    return r;
}
