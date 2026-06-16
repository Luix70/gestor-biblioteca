import 'dotenv/config'; // <-- ¡Esta es la clave! Carga las variables de entorno
import { extraerMetadatosEpub } from './src/utils/lector-epub.js';
import { enriquecerMetadatos } from './src/motor-enriquecimiento.js';
import { procesarCatalogo } from './src/motor-catalogo.js';

async function probarCadenaCompleta() {
    const rutaAbsoluta = 'D:\\gestor-biblioteca\\Inbox\\Adrian Escudero, Jesus - El lenguaje de Heidegger [24563] (r1.2).epub'; 

    console.log(`🧪 Iniciando Cadena de Ingesta Completa...`);
    
    try {
        console.log(`\n[Paso 1] Extrayendo metadatos del archivo...`);
        const datosCrudos = await extraerMetadatosEpub(rutaAbsoluta);
        
        console.log(`[Paso 2] Enriqueciendo datos...`);
        const datosEnriquecidos = await enriquecerMetadatos(datosCrudos);
        
        console.log(`[Paso 3] Guardando en Base de Datos...`);
        const resultadoBD = await procesarCatalogo(datosEnriquecidos);

        console.log(`\n✅ [ÉXITO TOTAL] Operación: ${resultadoBD.operacion.toUpperCase()}`);
        console.log(`ID asignado: ${resultadoBD._id}`);
        
        process.exit(0);

    } catch (error) {
        console.error("\n❌ [ERROR CRÍTICO] La cadena falló:\n", error.message);
        process.exit(1);
    }
}

probarCadenaCompleta();