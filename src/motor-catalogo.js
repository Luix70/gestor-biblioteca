import { conectarDB } from './database.js';
import { ErrorInfraestructura, esErrorDeMongo } from './errores.js';

const vacio = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const union = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));

/**
 * Calcula los cambios al re-procesar un libro ya catalogado (búsqueda futura con mejor info).
 * Reglas: (1) rellenar huecos siempre; (2) si el registro estaba 'pendiente' y la nueva
 * pasada lo identifica ('completado'), refrescar identificadores/clasificación con los nuevos;
 * (3) unir formatos, palabras_clave, imágenes y alertas. Nunca se degrada un dato bueno.
 */
function calcularActualizacion(existente, nuevo) {
    const set = {};
    const CAMPOS = ['titulo', 'isbn', 'issn', 'idioma', 'cdu', 'sinopsis', 'editorial', 'año_edicion', 'portada', 'ubicacion', 'tipo_recurso', 'volumen_numero', 'numero_edicion', 'nombre_archivo', 'hash_contenido', 'mes_publicacion', 'numero_issue'];

    // (1) Rellenar huecos.
    for (const c of CAMPOS) if (vacio(existente[c]) && !vacio(nuevo[c])) set[c] = nuevo[c];

    // (2) Upgrade pendiente -> completado: la nueva pasada es más fiable.
    const mejora = existente.estado_verificacion === 'pendiente' && nuevo.estado_verificacion === 'completado';
    if (mejora) {
        for (const c of CAMPOS) if (!vacio(nuevo[c])) set[c] = nuevo[c];
        set.estado_verificacion = 'completado';
    }

    // (3) Uniones.
    const formatos = union(existente.formatos, nuevo.formatos);
    if (formatos.length !== (existente.formatos || []).length) set.formatos = formatos;

    const palabras = union(existente.palabras_clave, nuevo.palabras_clave);
    if (palabras.length !== (existente.palabras_clave || []).length) set.palabras_clave = palabras;

    const imgs = [...(existente.imagenes || [])];
    for (const im of (nuevo.imagenes || [])) if (!imgs.some(x => x.ruta === im.ruta)) imgs.push(im);
    if (imgs.length !== (existente.imagenes || []).length) set.imagenes = imgs;

    const alertas = union(existente.alertas_agente, nuevo.alertas_agente);
    set.alertas_agente = [...alertas, 'Registro actualizado con nueva información.'];

    set.fecha_actualizacion = new Date();
    return set;
}

/**
 * Nivel 3: resuelve relaciones (autores/editorial → ObjectId) y persiste en 'biblioteca'.
 * Inserta si es nuevo; si ya existe (por ISBN, ISSN o título), fusiona la información.
 * Los fallos de conexión/operación de MongoDB se elevan como ErrorInfraestructura (→ Reintentos).
 */
export async function procesarCatalogo(documentoEnriquecido) {
    let db;
    try {
        db = await conectarDB();
    } catch (e) {
        throw new ErrorInfraestructura('MongoDB inalcanzable', e);
    }

    const coleccionBiblioteca = db.collection('biblioteca');
    const coleccionAutores = db.collection('autores');
    const coleccionEditoriales = db.collection('editoriales');

    let docFinal = { ...documentoEnriquecido };

    try {
        // 1. Autores (string → ObjectId; crea si no existe).
        if (docFinal.autores && docFinal.autores.length > 0) {
            const ids = [];
            for (const autor of docFinal.autores) {
                if (typeof autor === 'string') {
                    const existente = await coleccionAutores.findOne({ nombre: autor });
                    if (existente) ids.push(existente._id);
                    else {
                        const nuevo = await coleccionAutores.insertOne({ nombre: autor });
                        ids.push(nuevo.insertedId);
                        docFinal.alertas_agente.push(`Nuevo autor registrado: ${autor}`);
                    }
                } else ids.push(autor);
            }
            docFinal.autores = ids;
        }

        // 2. Editorial (string → ObjectId; crea si no existe).
        if (docFinal.editorial && typeof docFinal.editorial === 'string') {
            const existente = await coleccionEditoriales.findOne({ nombre: docFinal.editorial });
            if (existente) docFinal.editorial = existente._id;
            else {
                const nueva = await coleccionEditoriales.insertOne({ nombre: docFinal.editorial });
                docFinal.editorial = nueva.insertedId;
                docFinal.alertas_agente.push(`Nueva editorial registrada: ${documentoEnriquecido.editorial}`);
            }
        }

        // 3. Deduplicación en tres niveles:
        //
        // NIVEL A — Hash de contenido (SHA-256): detecta copias exactas del mismo archivo.
        //   • Mismo hash + mismo nombre_archivo → re-proceso del mismo fichero → ACTUALIZAR.
        //   • Mismo hash + nombre distinto → copia exacta con otro nombre → DUPLICADO_EXACTO.
        //
        // NIVEL B — Revistas: dedup por número de issue (ISSN + año + mes).
        //
        // NIVEL C — Libros con ISBN: solo actualiza si el nombre_archivo coincide (o el doc
        //   existente aún no tiene nombre_archivo — compatibilidad con docs pre-hash).
        //   Versiones distintas del mismo ISBN (ej. ePubLibre r2.7 vs r2.9) son docs distintos.

        // — Nivel A: hash
        if (docFinal.hash_contenido) {
            const hashDoc = await coleccionBiblioteca.findOne({ hash_contenido: docFinal.hash_contenido });
            if (hashDoc) {
                if (hashDoc.nombre_archivo === docFinal.nombre_archivo) {
                    // Mismo fichero reprocesado (vuelta del Inbox, re-ingesta manual, etc.)
                    const cambios = calcularActualizacion(hashDoc, docFinal);
                    await coleccionBiblioteca.updateOne({ _id: hashDoc._id }, { $set: cambios });
                    const actualizado = await coleccionBiblioteca.findOne({ _id: hashDoc._id });
                    return { ...actualizado, operacion: 'actualizacion' };
                }
                // Mismo contenido, nombre distinto → el llamante envía a Cuarentena
                return { ...hashDoc, operacion: 'duplicado_exacto' };
            }
        }

        // — Nivel B: revistas por número de issue
        let filtro = null;
        if (docFinal.tipo_recurso === 'revista') {
            if (docFinal.issn && docFinal.año_edicion && docFinal.mes_publicacion) {
                filtro = { issn: docFinal.issn, año_edicion: docFinal.año_edicion, mes_publicacion: docFinal.mes_publicacion };
            } else if (docFinal.issn && docFinal.año_edicion) {
                filtro = { issn: docFinal.issn, año_edicion: docFinal.año_edicion };
            } else {
                filtro = { titulo: docFinal.titulo, año_edicion: docFinal.año_edicion };
            }
        } else if (docFinal.isbn) {
            // — Nivel C: libros con ISBN — solo actualizar si es el mismo fichero
            const candidato = await coleccionBiblioteca.findOne({ isbn: docFinal.isbn });
            if (candidato) {
                const mismoArchivo = !candidato.nombre_archivo
                    || candidato.nombre_archivo === docFinal.nombre_archivo;
                if (mismoArchivo) {
                    filtro = { _id: candidato._id };
                }
                // else: mismo ISBN pero distinto nombre_archivo → versión diferente → insertar
            }
        } else if (docFinal.issn) {
            filtro = { issn: docFinal.issn };
        }
        // Sin filtro → siempre insertar

        const existente = filtro ? await coleccionBiblioteca.findOne(filtro) : null;

        // 4. Actualización inteligente o inserción.
        if (existente) {
            const cambios = calcularActualizacion(existente, docFinal);
            await coleccionBiblioteca.updateOne({ _id: existente._id }, { $set: cambios });
            const actualizado = await coleccionBiblioteca.findOne({ _id: existente._id });
            return { ...actualizado, operacion: 'actualizacion' };
        }

        docFinal.fecha_ingreso = new Date();
        const resultado = await coleccionBiblioteca.insertOne(docFinal);
        return { ...docFinal, _id: resultado.insertedId, operacion: 'insercion' };

    } catch (error) {
        if (esErrorDeMongo(error)) throw new ErrorInfraestructura('Operación MongoDB fallida', error);
        if (error.code === 121) {
            console.error("\n❌ [MOTOR CATÁLOGO] RECHAZO POR ESQUEMA EN MONGODB:");
            console.error(JSON.stringify(error.errInfo?.details, null, 2));
            throw new Error("El documento no cumple con el $jsonSchema de 'biblioteca'.");
        }
        throw new Error(`Error en base de datos: ${error.message}`);
    }
}

/**
 * Actualiza campos de un documento ya insertado (p. ej. ruta_base / imagenes / portada
 * tras copiar los archivos a la estructura CDU). Best-effort: los fallos de Mongo se elevan
 * como ErrorInfraestructura para que el llamante decida.
 */
export async function actualizarDocumento(_id, campos) {
    let db;
    try {
        db = await conectarDB();
        await db.collection('biblioteca').updateOne({ _id }, { $set: campos });
    } catch (e) {
        if (esErrorDeMongo(e)) throw new ErrorInfraestructura('Operación MongoDB fallida', e);
        throw e;
    }
}
