import AdmZip from 'adm-zip';
import * as cheerio from 'cheerio';
import fs from 'fs/promises';
import path from 'path';

/**
 * Módulo atómico: Extrae metadatos y cubiertas de un archivo EPUB.
 * Lee el EPUB como Buffer para máxima compatibilidad.
 */
export async function extraerMetadatosEpub(rutaArchivo) {
    // Añadir esta función auxiliar dentro de extraerMetadatosEpub
    function buscarPaginaCreditos(zip) {
        const archivos = zip.getEntries();
        // Buscamos patrones de nombres comunes para créditos
        const patronCreditos = /cred[i|y]ts|colophon|credits|info/i;
        
        for (const entry of archivos) {
            if (patronCreditos.test(entry.entryName)) {
                // Si es imagen, la extraemos como base64
                if (entry.entryName.match(/\.(jpg|jpeg|png)$/i)) {
                    return entry.getData().toString('base64');
                }
            }
        }
        return null;
    }

// Dentro del try, después de la sección 3 (cubierta), añadimos:
if (!metadatos.cubierta_base64) {
    metadatos.imagen_adicional = buscarPaginaCreditos(zip);
}

    return new Promise(async (resolve) => {
        try {
            const fileBuffer = await fs.readFile(rutaArchivo);
            const zip = new AdmZip(fileBuffer);

            // 1. Localizar contenedor y OPF
            const containerEntry = zip.getEntry("META-INF/container.xml");
            if (!containerEntry) throw new Error("Falta META-INF/container.xml");

            const $container = cheerio.load(containerEntry.getData().toString("utf8"), { xmlMode: true });
            const opfPath = $container("rootfile").attr("full-path");
            if (!opfPath) throw new Error("No se encontró la ruta del rootfile");

            const opfEntry = zip.getEntry(opfPath);
            if (!opfEntry) throw new Error(`Falta el archivo OPF en: ${opfPath}`);

            const opfXml = opfEntry.getData().toString("utf8");
            const $ = cheerio.load(opfXml, { xmlMode: true });
            const metadata = $('metadata');

            // 2. Extracción de metadatos básicos
            const metadatos = {
                titulo: metadata.find('dc\\:title').first().text().trim(),
                autores: metadata.find('dc\\:creator').map((i, el) => {
                    const normalizado = $(el).attr('opf:file-as');
                    return normalizado ? normalizado.trim() : $(el).text().trim();
                }).get(),
                isbn: metadata.find('dc\\:identifier[opf\\:scheme="ISBN"]').first().text().trim() || null,
                editorial: metadata.find('dc\\:publisher').first().text().trim() || null,
                idioma: metadata.find('dc\\:language').first().text().trim().substring(0, 2).toLowerCase() || 'es',
                sinopsis: metadata.find('dc\\:description').text().trim() || null,
                año_edicion: parseInt(metadata.find('dc\\:date').first().text().substring(0, 4)) || null,
                palabras_clave: metadata.find('dc\\:subject').map((i, el) => $(el).text().trim()).get(),
                cubierta_base64: null // Reservado para la imagen que enviaremos a Gemini
            };

            // 3. Extracción de la Cubierta (Si existe en el manifest)
            const coverId = $('meta[name="cover"]').attr('content');
            if (coverId) {
                const coverHref = $(`#${coverId}`).attr('href');
                if (coverHref) {
                    const opfDir = path.dirname(opfPath);
                    // Normalizamos el path para adm-zip (usando posix para evitar problemas de '\')
                    const fullCoverPath = path.posix.join(opfDir, coverHref);
                    const imageEntry = zip.getEntry(fullCoverPath);
                    
                    if (imageEntry) {
                        metadatos.cubierta_base64 = imageEntry.getData().toString('base64');
                    }
                }
            }

            // 4. Limpieza para evitar violaciones de esquema en MongoDB
            Object.keys(metadatos).forEach(key => {
                const val = metadatos[key];
                if (val === null || val === '' || Number.isNaN(val) ||
                   (Array.isArray(val) && val.length === 0)) {
                    delete metadatos[key];
                }
            });

            // Fallback obligatorio para el título
            if (!metadatos.titulo) {
                metadatos.titulo = path.basename(rutaArchivo, '.epub');
            }

            resolve(metadatos);

        } catch (error) {
            console.warn(`⚠️ [Lector EPUB] Estructura ilegible en ${path.basename(rutaArchivo)}: ${error.message}`);
            resolve({
                titulo: path.basename(rutaArchivo, '.epub'),
                autores: [],
                idioma: 'es'
            });
        }
    });
}