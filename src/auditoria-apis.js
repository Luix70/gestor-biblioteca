import dotenv from 'dotenv';
dotenv.config();

async function auditarModelos() {
    console.log("🔎 Interrogando a Google sobre los modelos autorizados...\n");
    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${process.env.GEMINI_API_KEY}`);
        const data = await response.json();
        
        if (data.error) {
            console.error("❌ Error de la API:", data.error.message);
            return;
        }

        const modelosDeTexto = data.models.filter(m => m.supportedGenerationMethods.includes("generateContent"));
        console.log("✅ Modelos disponibles para tu API Key:");
        modelosDeTexto.forEach(m => console.log(`  - ${m.name.replace('models/', '')}`));
        
    } catch (error) {
        console.error("Error de red:", error.message);
    }
}

auditarModelos();