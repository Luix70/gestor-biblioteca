import fs from 'fs/promises';
import path from 'path';
import { procesarCatalogo } from './motor-catalogo.js';
import { procesarImagenSiEsNecesario } from './utils/procesador-archivos.js';

export async function procesarIngesta(body, files) {
    const data = JSON.parse(body.datos);
    
    // 1. Determinar el destino final (Estructura de directorios)
    const subEntorno = data.formatos.includes('digital') ? 'digital' : 'fisico';
    const carpetaDestino = path.join(process.env.PATH_CDU, data.cdu, 'libros', data.isbn, subEntorno);
    await fs.mkdir(carpetaDestino, { recursive: true });
    const rutasGuardadas = [];
    for (const file of files) {
        const destinoFinal = path.join(carpetaDestino, file.originalname);
        
        // El seguro de vida ya gestiona el destino y la limpieza del temporal
        await procesarImagenSiEsNecesario(file.path, destinoFinal);
        
         rutasGuardadas.push(`/recursos/${data.cdu}/libros/${data.isbn}/${subEntorno}/${file.originalname}`);
        }
       

    // 3. Persistir en BDD a través del motor
    data.rutas_imagenes = rutasGuardadas;
    return await procesarCatalogo(data, data.ubicacion);
}