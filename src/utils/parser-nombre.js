// src/utils/parser-nombre.js
import path from 'path';

/**
 * Analiza un nombre de archivo basándose en el patrón determinista:
 * "Apellidos, Nombre - Título del Libro [ID_Numérico] (revisión)"
 * @param {string} nombreArchivo - Nombre completo con extensión.
 * @returns {Object} Estructura limpia de metadatos.
 */
export function extraerMetadatosNombre(nombreArchivo) {
    // 1. Aislar la extensión del archivo
    const nombreSinExtension = path.parse(nombreArchivo).name;

    // 2. Separación atómica de Autor y Contenido usando el delimitador " - "
    // El cuantificador perezoso (.+?) evita colisiones si el nombre del autor tuviera guiones lógicos.
    const regexEstructuraCentral = /^(.+?)\s+-\s+(.+)$/;
    const coincidenciaEstructura = nombreSinExtension.match(regexEstructuraCentral);

    if (!coincidenciaEstructura) {
        // Fallback: Si el nombre no cumple la estructura bimodal, preservamos el string como título
        return {
            titulo: nombreSinExtension.trim(),
            autores: [],
            id_control: null
        };
    }

    let autorRaw = coincidenciaEstructura[1].trim();
    let contenidoRaw = coincidenciaEstructura[2].trim();

    // 3. Extracción y depuración del bloque de Control (IDs)
    // Buscamos cualquier patrón numérico encerrado en corchetes
    const regexId = /\[(\d+)\]/;
    const coincidenciaId = contenidoRaw.match(regexId);
    const idControl = coincidenciaId ? coincidenciaId[1] : null;

    // 4. Limpieza del Título mediante sustitución recursiva de patrones
    let tituloLimpio = contenidoRaw
        .replace(/\[\d+\]/g, '') // Elimina los corchetes de ID
        .replace(/\(r\d+(\.\d+)*\)/gi, '') // Elimina revisiones tipo (r1.2), (R1), (r2.0.1)
        .replace(/\s+/g, ' ') // Colapsa espacios dobles o múltiples generados por las eliminaciones
        .trim();

    // 5. Normalización del bloque de autores
    // Si en un futuro introduces múltiples autores separados por caracteres específicos (ej: ";" o " y ")
    const autores = autorRaw.split(';').map(autor => autor.trim()).filter(Boolean);

    return {
        titulo: tituloLimpio,
        autores: autores,
        id_control: idControl
    };
}