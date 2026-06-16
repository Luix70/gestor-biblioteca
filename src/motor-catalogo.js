import { conectarDB } from './database.js';

/**
 * Nivel 3: Valida, sanea e inserta el documento en MongoDB.
 * Resuelve las relaciones (Autores y Editoriales) antes de la inserción en 'biblioteca'.
 */
export async function procesarCatalogo(documentoEnriquecido) {
    const db = await conectarDB();
    const coleccionBiblioteca = db.collection('biblioteca');
    const coleccionAutores = db.collection('autores');
    const coleccionEditoriales = db.collection('editoriales');

    let docFinal = { ...documentoEnriquecido };
    let arrayObjectIdsAutores = [];

    // 1. Resolución Relacional: Autores (De String a ObjectId)
    if (docFinal.autores && docFinal.autores.length > 0) {
        for (const autor of docFinal.autores) {
            if (typeof autor === 'string') {
                let autorExistente = await coleccionAutores.findOne({ nombre: autor });

                if (autorExistente) {
                    arrayObjectIdsAutores.push(autorExistente._id);
                } else {
                    const nuevoAutor = await coleccionAutores.insertOne({ nombre: autor });
                    arrayObjectIdsAutores.push(nuevoAutor.insertedId);
                    docFinal.alertas_agente.push(`Nuevo autor registrado: ${autor}`);
                }
            } else {
                arrayObjectIdsAutores.push(autor);
            }
        }
    }
    docFinal.autores = arrayObjectIdsAutores;

    // 2. Resolución Relacional: Editoriales (De String a ObjectId)
    if (docFinal.editorial && typeof docFinal.editorial === 'string') {
        let editorialExistente = await coleccionEditoriales.findOne({ nombre: docFinal.editorial });

        if (editorialExistente) {
            docFinal.editorial = editorialExistente._id;
        } else {
            const nuevaEditorial = await coleccionEditoriales.insertOne({ nombre: docFinal.editorial });
            docFinal.editorial = nuevaEditorial.insertedId;
            docFinal.alertas_agente.push(`Nueva editorial registrada: ${documentoEnriquecido.editorial}`);
        }
    }

    // 3. Comprobación de duplicados en la colección 'biblioteca'
    const filtroDuplicado = docFinal.isbn 
        ? { isbn: docFinal.isbn } 
        : { titulo: docFinal.titulo };

    const libroExistente = await coleccionBiblioteca.findOne(filtroDuplicado);

    if (libroExistente) {
        docFinal.alertas_agente.push('El documento ya existía en el catálogo. Se ha actualizado.');
        await coleccionBiblioteca.updateOne(
            { _id: libroExistente._id }, 
            { $addToSet: { formatos: { $each: docFinal.formatos } } }
        );
        return { ...libroExistente, operacion: 'actualizacion' };
    }

    // 4. Inserción Final Definitiva
    docFinal.fecha_ingreso = new Date();
    try {
        
        const resultado = await coleccionBiblioteca.insertOne(docFinal);
        return { ...docFinal, _id: resultado.insertedId, operacion: 'insercion' };
    } catch (error) {
        // Capturamos específicamente el error 121 de esquema estricto
        if (error.code === 121) {
            console.error("\n❌ [MOTOR CATÁLOGO] RECHAZO POR VIOLACIÓN DE ESQUEMA EN MONGODB:");
            console.error(JSON.stringify(error.errInfo?.details, null, 2));
            throw new Error("El documento no cumple con el $jsonSchema de la colección 'biblioteca'. Revisa los logs.");
        }
        throw new Error(`Error en base de datos: ${error.message}`);
    }
}