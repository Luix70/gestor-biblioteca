// src/motor-catalogo.js
import axios from 'axios';
import { guardarRecurso } from './database.js';

// src/motor-catalogo.js

async function obtenerMetadataPublica(isbn) {
    if (!isbn) return null;
    try {
        const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;
        const res = await axios.get(url);
        // ... (tu lógica de extracción)
    } catch (e) {
        if (e.response?.status === 429) {
            console.warn("⚠️ Límite de Google alcanzado. Saltando enriquecimiento.");
        } else {
            console.error(`[API Externa] Error con ISBN ${isbn}:`, e.message);
        }
    }
    return null; // Retorna null para que el motor siga trabajando sin datos externos
}

export async function procesarCatalogo(datos, ubicacion = null) {
    const ubicacionFinal = ubicacion || { ambito: "Sin Ubicación", estanteria: "E0" };

    // 1. Enriquecimiento Determinista (API Pública)
    const datosPublicos = await obtenerMetadataPublica(datos.isbn);
    
    // 2. Fusionamos datos: La API pública sobrescribe lo que ya sabíamos
    const recursoEnriquecido = { ...datos, ...datosPublicos };

    // 3. Construcción del objeto final

    const nuevoLibro = {
        tipo_recurso: recursoEnriquecido.tipo_recurso || 'libro',
        titulo: recursoEnriquecido.titulo || 'Sin título',
        cdu: recursoEnriquecido.cdu || '000',
        idioma: recursoEnriquecido.idioma || 'es',
        formatos: recursoEnriquecido.formatos || ['papel'],
        ubicacion: ubicacionFinal,
        sinopsis: recursoEnriquecido.sinopsis || "",
        editorial: recursoEnriquecido.editorial || "",
        estado_verificacion: 'pendiente',
        fecha_ingreso: new Date(),
        isbn: recursoEnriquecido.isbn || datos.isbn,
        rutas_imagenes: recursoEnriquecido.rutas_imagenes || []
    };

    // MAGIA AQUÍ: Solo añadimos el año si es un número válido
    if (recursoEnriquecido.año_edicion) {
        nuevoLibro.año_edicion = recursoEnriquecido.año_edicion;
    }

    console.log("📦 Documento final a insertar:", JSON.stringify(nuevoLibro, null, 2));
    return await guardarRecurso(nuevoLibro);
}