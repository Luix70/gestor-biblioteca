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
    const CAMPOS = ['titulo', 'isbn', 'issn', 'idioma', 'cdu', 'sinopsis', 'editorial', 'año_edicion', 'portada', 'ubicacion', 'tipo_recurso', 'volumen_numero', 'numero_edicion'];

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

        // 3. Deduplicación: ISBN → ISSN → título.
        const filtro = docFinal.isbn ? { isbn: docFinal.isbn }
            : docFinal.issn ? { issn: docFinal.issn }
            : { titulo: docFinal.titulo };

        const existente = await coleccionBiblioteca.findOne(filtro);

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
