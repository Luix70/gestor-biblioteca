import 'dotenv/config';
import fs from 'fs/promises';
import { buscarMetadatosExternos } from './src/utils/proveedor-metadatos.js';

async function testIntegracion() {
    console.log("🚀 Iniciando Test de Integración: Visión + API...");

    try {
        // 1. Cargamos tu imagen de prueba
        const imageBuffer = await fs.readFile('./content.jfif');
        const base64Image = imageBuffer.toString('base64');

        // 2. Simulamos los datos que extraeríamos del EPUB (título/autor)
        const titulo = "El lenguaje de Heidegger";
        const autor = "Adrián Escudero, Jesús";

        console.log("🔎 Analizando imagen y consultando fuentes...");

        // 3. Ejecutamos el nuevo flujo inteligente
        const resultado = await buscarMetadatosExternos(titulo, autor, base64Image);

        console.log("\n✅ [ÉXITO] Resultado final del enriquecimiento:");
        console.log(JSON.stringify(resultado, null, 2));

    } catch (error) {
        console.error("\n❌ [ERROR] La integración falló:", error.message);
    }
}

testIntegracion();
