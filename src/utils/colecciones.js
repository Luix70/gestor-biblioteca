/**
 * 'colecciones' = colección PADRE abstracta (sin fichero propio) que agrupa documentos de 'biblioteca':
 *   · tipo:'revista' → CABECERA de un periódico (pivote ISSN). Sus miembros son los NÚMEROS, en un
 *     inventario CRONOLÓGICO `numeros[]`; cada número se identifica por (coleccion, clave_numero).
 *   · tipo:'libro' (o ausente = legado) → SERIE/colección editorial de libros (p. ej. «Graduate Texts
 *     in Physics», con ISSN de serie); cada libro conserva su PROPIO ISBN.
 * El ISSN es la AUTORIDAD del grupo (análogo a obras.isbn_obra para una obra multivolumen).
 */

/**
 * Resuelve una cabecera/serie a un documento de 'colecciones' (check-then-create), keyed por ISSN
 * (autoridad) y, en su defecto, por nombre. Completa huecos (issn, tipo, editorial, cdu, descripcion)
 * de una ya existente. Devuelve { _id, cdu, creada }. Análogo a resolverObra() para obras multivolumen.
 *
 * @param {import('mongodb').Db} db
 * @param {{nombre?:string|null, issn?:string|null, tipo?:'revista'|'libro'|null,
 *          editorialId?:import('mongodb').ObjectId|null, cdu?:string|null, descripcion?:string|null,
 *          naturaleza?:string|null}} datos
 */
export async function resolverCabecera(db, { nombre, issn = null, tipo = null, editorialId = null, cdu = null, descripcion = null, naturaleza = null }) {
    const col = db.collection('colecciones');
    // nombre es obligatorio y único; si solo tenemos ISSN, usamos el ISSN como nombre provisional
    // (el Conformador/autoridad lo renombra luego con el título real de la cabecera/serie). Se limpian las
    // colas de basura (« ; v», «, ISSN …») para no crear/guardar nombres feos; si el nombre ERA un ISSN
    // suelto, limpiarNombreColeccion lo deja intacto (no lleva esas colas).
    const bruto = (nombre && String(nombre).trim()) || issn || null;
    const n = bruto ? limpiarNombreColeccion(bruto) : null;

    const claveCan = claveCanonica(n);

    let existente = issn ? await col.findOne({ issn }) : null;
    // Nombre case- Y acento-insensitive (collation strength:1): reutiliza la colección existente y
    // evita crear duplicados por mayúsculas/minúsculas o acentos («Filosofia»/«Filosofía»,
    // «direction Italie»/«Direction Italie»). El índice único de nombre es sensible (no basta solo).
    if (!existente && n) existente = await col.findOne({ nombre: n }, { collation: { locale: 'es', strength: 1 } });
    // VARIANTE DE GRAFÍA (mismo grupo, distinto orden/puntuación/conectores): solo como último recurso,
    // solo si el entrante NO trae ISSN (un ISSN es autoridad: no se funde por parecido de nombre) y solo
    // contra colecciones que YA tengan la clave canónica guardada (el script de consolidación la rellena
    // en las existentes). Así una serie nueva se asigna a la que ya existe ligeramente distinta.
    if (!existente && !issn && claveCan) existente = await col.findOne({ clave_canonica: claveCan });

    if (existente) {
        const set = {};
        if (issn && !existente.issn) set.issn = issn;
        if (tipo && !existente.tipo) set.tipo = tipo;
        if (editorialId && !existente.editorial) set.editorial = editorialId;
        if (cdu && !existente.cdu) set.cdu = cdu;
        if (descripcion && !existente.descripcion) set.descripcion = descripcion;
        if (naturaleza && !existente.naturaleza) set.naturaleza = naturaleza;
        // Rellena la clave canónica si la existente aún no la tenía (para futuros emparejamientos).
        if (claveCan && !existente.clave_canonica) set.clave_canonica = claveCan;
        if (Object.keys(set).length) {
            set.fecha_actualizacion = new Date();
            await col.updateOne({ _id: existente._id }, { $set: set });
        }
        return { _id: existente._id, cdu: existente.cdu || cdu || null, creada: false };
    }

    const nueva = { nombre: n, fecha_creacion: new Date() };
    if (issn)        nueva.issn = issn;
    if (tipo)        nueva.tipo = tipo;
    if (editorialId) nueva.editorial = editorialId;
    if (cdu)         nueva.cdu = cdu;
    if (descripcion) nueva.descripcion = descripcion;
    if (naturaleza)  nueva.naturaleza = naturaleza;
    if (claveCan)    nueva.clave_canonica = claveCan;
    try {
        const r = await col.insertOne(nueva);
        return { _id: r.insertedId, cdu: cdu || null, creada: true };
    } catch {
        // Carrera con el índice único (issn o nombre): devolver el existente.
        const ya = issn ? await col.findOne({ issn })
            : (n ? await col.findOne({ nombre: n }, { collation: { locale: 'es', strength: 1 } }) : null);
        return ya ? { _id: ya._id, cdu: ya.cdu || cdu || null, creada: false } : { _id: null, cdu: null, creada: false };
    }
}

// Alias de colecciones: unifica variantes de grafía del MISMO nombre de serie que las fuentes (BNE/OL)
// escriben de formas distintas. Clave = nombre YA LIMPIO en minúsculas; valor = nombre canónico. Amplía la
// tabla cuando detectes otra serie que se duplica por cómo la escribe la fuente (p. ej. cifra ↔ palabra).
const ALIAS_COLECCION = new Map([
    ['alianza cien', 'Alianza Cien'],
    ['alianza 100', 'Alianza Cien'],
]);

// Marcas diacríticas combinantes (para quitar acentos), vía new RegExp desde ASCII (regla del proyecto).
const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');
// Conectores que NO distinguen una serie de otra: se ignoran al comparar («Cátedra, Letras Universales» ≡
// «Letras Universales de Cátedra»). ES + EN habituales.
const CONECTORES = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'o', 'u', 'en', 'a', 'al', 'the', 'of', 'and', 'or']);

// Colas de BASURA que las fuentes dejan en el nombre de serie al incrustar el volumen/ISSN («… ; v. 46»,
// «…, ISSN 0261-9814», «… ;»). Se construyen con new RegExp (regla del proyecto para clases de caracteres).
// Cola «ISSN …» con dígitos O YA sin ellos (separarNumeroColeccion puede haber quitado el número antes,
// dejando un «, ISSN» colgante): se limpia igualmente.
const RE_COLA_ISSN = new RegExp('[\\s,;:.·\\-–—]*issn\\b[\\s0-9xX-]*$', 'i');
const RE_COLA_VOL = new RegExp('[\\s,;:.·\\-–—]+(?:v|vol|volumen|tomo)\\.?\\s*$', 'i'); // marca de volumen SUELTA (sin número)
const RE_COLA_SEP = new RegExp('[\\s,;:.·\\-–—]+$');                                   // separador(es) colgante(s)

/**
 * Limpia las COLAS de basura del final del nombre de una colección (separadores sueltos, marca de volumen
 * sin número «; v», colas de «ISSN ####-####»). No toca el contenido real (solo el final) y NUNCA devuelve
 * vacío. Ej.: «Series on knots and everything ; v» → «Series on knots and everything»; «Arthurian studies,
 * ISSN 0261-9814» → «Arthurian studies».
 */
export function limpiarNombreColeccion(nombre) {
    const original = String(nombre || '').trim();
    let s = original, prev;
    do {
        prev = s;
        s = s.replace(RE_COLA_ISSN, '').replace(RE_COLA_VOL, '').replace(RE_COLA_SEP, '').trim();
    } while (s !== prev && s);
    return s || original;
}

/**
 * CLAVE CANÓNICA de un nombre de colección para detectar VARIANTES de grafía del mismo grupo
 * («Cátedra, Letras Universales» · «Cátedra Letras Universales» · «Cátedra-Letras Universales» ·
 * «Letras Universales Cátedra» → todas «catedra letras universales»): minúsculas, sin acentos ni
 * puntuación, sin conectores, y con los tokens significativos ORDENADOS (independiente del orden).
 * Devuelve null con menos de 2 tokens significativos (1 palabra colisiona demasiado → solo match exacto).
 */
export function claveCanonica(nombre) {
    const base = String(nombre || '').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '')
        .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    const tokens = base.split(' ').filter((t) => t.length >= 2 && !CONECTORES.has(t));
    if (tokens.length < 2) return null;
    return [...new Set(tokens)].sort().join(' ');
}

// Número de volumen al final del nombre de una serie, con separadores y/o una ETIQUETA reconocida delante
// (nº, n., no., núm., num., vol., volumen, tomo). La etiqueta NO puede ser una «n» suelta (si no, se comería
// la «n» final de palabras como «Cien»). Construida con new RegExp (regla del proyecto para char-classes).
const RE_NUM_COLECCION = new RegExp(
    "^(.*?)[\\s,;:.·\\-–—]*(?:(?:nº|n\\.|no\\.|núm\\.?|num\\.?|vol\\.?|volumen|tomo)\\s*)?\\(?\\s*(\\d{1,4})\\)?\\s*$",
    'i',
);

/**
 * Separa el NÚMERO de volumen final del nombre de una colección de LIBROS y aplica el alias canónico:
 *   «Alianza Cien 15» · «Alianza Cien, 15» · «Alianza Cien nº 15» · «Alianza Cien (15)» → { nombre:'Alianza Cien', numero:'15' }
 *   «Alianza 100 10» → { nombre:'Alianza Cien', numero:'10' }   (alias unifica la grafía tras separar el nº)
 *   «Alianza 100» → { nombre:'Alianza Cien', numero:null }       (alias sobre el nombre completo: «100» no es volumen)
 * Sin número final: { nombre:<limpio>, numero:null }. Nunca deja el nombre vacío. Idempotente.
 */
export function separarNumeroColeccion(raw) {
    const base = String(raw || '').trim();
    if (!base) return { nombre: '', numero: null };
    // 1) Alias sobre el nombre COMPLETO: capta variantes SIN número (p. ej. «Alianza 100», donde «100» es
    //    parte del nombre, no un volumen). Si casa, no se separa nada.
    const aliasCompleto = ALIAS_COLECCION.get(base.toLowerCase());
    if (aliasCompleto) return { nombre: aliasCompleto, numero: null };
    // 2) Separar el número final (solo si delante queda un nombre con letras) y aplicar alias al resultado.
    let nombre = base, numero = null;
    const m = base.match(RE_NUM_COLECCION);
    if (m && /[a-zà-ÿ]/i.test(m[1])) {
        nombre = m[1].replace(/[\s,;:.·\-–—]+$/, '').trim();
        numero = m[2];
    }
    const alias = ALIAS_COLECCION.get(nombre.toLowerCase());
    if (alias) nombre = alias;
    return { nombre, numero };
}

/**
 * Resuelve el nombre de una colección/serie editorial de LIBROS (patrón check-then-create, como
 * autores/editoriales). Atajo sobre resolverCabecera con tipo:'libro'. LIMPIA el nombre (separa el número
 * de volumen final y aplica el alias canónico) para no crear una colección por cada tomo. Enlaza la
 * editorial si se conoce. Devuelve { _id, creada } (compatibilidad con los llamantes previos).
 *
 * @param {import('mongodb').Db} db
 * @param {string} nombre
 * @param {import('mongodb').ObjectId|null} editorialId
 */
export async function resolverColeccion(db, nombre, editorialId = null) {
    const { nombre: limpio } = separarNumeroColeccion(nombre);
    const { _id, creada } = await resolverCabecera(db, { nombre: limpio || nombre, tipo: 'libro', editorialId });
    return { _id, creada };
}

/**
 * Registra (o actualiza) en la CABECERA (colección tipo:'revista') el número `docId`, manteniendo
 * `numeros` como una lista CRONOLÓGICA [{clave, año, mes, numero_issue, _id}] — adecuada para una
 * publicación periódica (no el array contiguo 1..N de las obras multivolumen). Un número sin clave
 * (sin fecha/nº) va a `numeros_sin_fecha` y marca la cabecera para revisión. Idempotente y
 * best-effort (nunca rompe la ingesta del número).
 */
export async function registrarNumeroEnColeccion(db, coleccionId, num, docId) {
    if (!coleccionId || !docId) return;
    try {
        const col = db.collection('colecciones');
        const cab = await col.findOne({ _id: coleccionId });
        if (!cab) return;

        const clave = num?.clave || null;
        // Quita cualquier entrada previa de ESTE doc (por _id) y, si trae clave, la de su misma clave.
        const numeros = (cab.numeros || [])
            .filter(x => x && String(x._id) !== String(docId) && (!clave || x.clave !== clave));
        let sinFecha = (cab.numeros_sin_fecha || []).filter(id => String(id) !== String(docId));

        if (clave) {
            numeros.push({ clave, 'año': num.año ?? null, mes: num.mes ?? null, numero_issue: num.numero_issue ?? null, _id: docId });
            numeros.sort((a, b) => String(a.clave).localeCompare(String(b.clave), undefined, { numeric: true }));
        } else {
            sinFecha = [...sinFecha, docId];
        }

        await col.updateOne({ _id: coleccionId }, { $set: {
            numeros,
            numeros_presentes: numeros.length,
            numeros_sin_fecha: sinFecha,
            revision_requerida: sinFecha.length > 0,
            fecha_actualizacion: new Date(),
        } });
    } catch { /* el inventario de la cabecera no debe romper la ingesta del número */ }
}
