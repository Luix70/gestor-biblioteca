import 'dotenv/config';
import { buscarMetadatosExternos } from './src/utils/proveedor-metadatos.js';

async function probarMotorAPIs() {
    console.log("🧪 Iniciando prueba aislada del proveedor de metadatos...\n");

    // Datos crudos extraídos de nuestro EPUB simulado
    const datosCrudosEPUB = {
        titulo: "El lenguaje de Heidegger",
        autores: ["Adrián Escudero, Jesús"],
        idioma: "es",
        sinopsis: "El lenguaje de Heidegger ha sido foco de muchas críticas por su carácter críptico y en ocasiones esotérico... El presente diccionario filosófico analiza la especificidad del vocabulario filosófico del joven Heidegger...",
        año_edicion: 2009
    };

    console.log("📦 Datos iniciales:");
    console.log(`- Título: ${datosCrudosEPUB.titulo}`);
    console.log(`- Autor: ${datosCrudosEPUB.autores[0]}`);

    console.log("\n🌐 Lanzando red de captura (Google -> OpenLibrary -> IA)...\n");

    try {
        const datosEnriquecidos = await buscarMetadatosExternos(
            datosCrudosEPUB.titulo, 
            datosCrudosEPUB.autores[0]
        );

        console.log("✅ [ÉXITO] Datos obtenidos de fuentes externas:");
        console.log(JSON.stringify(datosEnriquecidos, null, 2));

        // Fusionamos mentalmente para ver cómo quedaría el documento
        const documentoFinalSimulado = {
            ...datosCrudosEPUB,
            ...datosEnriquecidos, // Sobrescribe o añade los campos encontrados
            // Si el EPUB ya traía sinopsis (como este caso), priorizamos la original
            sinopsis: datosCrudosEPUB.sinopsis || datosEnriquecidos.sinopsis
        };

        console.log("\n📚 CDU Asignada para el enrutador del NAS:", documentoFinalSimulado.cdu);

    } catch (error) {
        console.error("❌ Error en la prueba:", error);
    }
}

probarMotorAPIs();