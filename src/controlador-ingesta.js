import fs from 'fs/promises';
import path from 'path';
import { procesarCatalogo } from './motor-catalogo.js';

export async function procesarIngesta(body, files) {
    const data = JSON.parse(body.datos);
    
    // 1. Determinar el destino final (Estructura de directorios)
    const subEntorno = data.formatos.includes('digital') ? 'digital' : 'fisico';
    const carpetaDestino = path.join(process.env.PATH_CDU, data.cdu, 'libros', data.isbn, subEntorno);
    await fs.mkdir(carpetaDestino, { recursive: true });

    // 2. Mover archivos de la carpeta temp/ al destino final
    const rutasGuardadas = [];
    for (const file of files) {
        const destinoFinal = path.join(carpetaDestino, file.originalname);
        await fs.rename(file.path, destinoFinal); // Movemos desde temp/
        rutasGuardadas.push(`/recursos/${data.cdu}/libros/${data.isbn}/${subEntorno}/${file.originalname}`);
    }

    // 3. Persistir en BDD a través del motor
    data.rutas_imagenes = rutasGuardadas;
    return await procesarCatalogo(data, data.ubicacion);
}