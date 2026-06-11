// src/motor-catalogo.js
import { guardarRecurso } from './database.js';

/**
 * Función centralizada para procesar cualquier recurso.
 * @param {Object} datos - Datos del libro (podrían venir de IA, API o usuario)
 * @param {Object} ubicacion - Objeto {ambito, estanteria}
 */
    export async function procesarCatalogo(datos, ubicacion = null) {
    // ... lógica previa ...
    
        const nuevoLibro = {
            // ... campos obligatorios ...
            ubicacion: ubicacionFinal,
            formatos: datos.formatos || ['papel'],
            // Si es digital, calculamos la ruta relativa
            ruta_acceso: datos.formatos?.includes('digital') 
                ? `/recursos/${datos.cdu}/libros/${datos.isbn}/digital/libro.${datos.extension}` 
                : null,
            fecha_ingreso: new Date(),
            ...datos
        };

        // 3. Persistencia
        console.log(`[Motor] Catalogando: ${nuevoLibro.titulo} en ${ubicacionFinal.ambito}/${ubicacionFinal.estanteria}`);
        return await guardarRecurso(nuevoLibro);
}