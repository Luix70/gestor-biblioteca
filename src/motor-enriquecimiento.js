import { buscarMetadatosExternos } from './utils/proveedor-metadatos.js';

/**
 * Nivel 2: Toma los datos crudos del lector y los enriquece
 * usando nuestro proveedor de metadatos externo (Google -> OpenLibrary -> Gemini).
 */
export async function enriquecerMetadatos(datosBase) {
    // 1. Clonamos el objeto con los campos estructurales básicos
    let documento = { 
        ...datosBase,
        tipo_recurso: 'libro',
        formatos: ['epub'],
        estado_verificacion: 'pendiente',
        alertas_agente: [],
        ubicacion: {
            ambito: "Biblioteca Digital",
            estanteria: "NAS"
        }
    };

    console.log(`[Enriquecedor] Buscando datos extra para: "${documento.titulo}"...`);

    // 2. Llamamos a nuestra nueva maquinaria pesada (APIs + IA)
    const autorPrincipal = documento.autores && documento.autores.length > 0 ? documento.autores[0] : '';
    const datosExtra = await buscarMetadatosExternos(documento.titulo, autorPrincipal);

    // 3. Fusionamos los datos descubiertos
    // Priorizamos lo que ya traía el EPUB, si no lo tiene, usamos lo de la API
   
    documento.sinopsis = documento.sinopsis || datosExtra.sinopsis;
    documento.editorial = documento.editorial || datosExtra.editorial;
    documento.cdu = datosExtra.cdu; // La CDU viene validada por la caché o la IA
    
    // Asignación segura del ISBN para no romper el esquema
    const isbnDescubierto = documento.isbn || datosExtra.isbn;
    if (isbnDescubierto) {
        documento.isbn = isbnDescubierto;
    } else {
        delete documento.isbn; // Eliminamos la clave para que MongoDB la ignore
    }

    // Traspasamos las alertas generadas por el proveedor
    if (datosExtra.alertas && datosExtra.alertas.length > 0) {
        documento.alertas_agente.push(...datosExtra.alertas);
    }

    if (datosBase.cubierta_base64 || datosBase.imagen_adicional) {
    const img = datosBase.cubierta_base64 || datosBase.imagen_adicional;
    const infoVisual = await analizarImagenConIA(img);
    
    if (infoVisual) {
        documento.isbn = infoVisual.isbn || documento.isbn;
        documento.editorial = infoVisual.editorial || documento.editorial;
        documento.año_edicion = infoVisual.año_edicion || documento.año_edicion;
        documento.alertas_agente.push("Datos extraídos mediante IA multimodal de imágenes internas.");
    }
    if (documento.isbn) {
        console.log("🔍 ISBN detectado. Consultando base de datos global...");
        const datosGlobales = await buscarPorISBN(documento.isbn);
        if (datosGlobales) {
            documento = { ...documento, ...datosGlobales };
            documento.alertas_agente.push("Datos validados vía ISBN en base de datos global.");
        }
}

}


    return documento;
}