import 'dotenv/config';
import axios from 'axios';
import { GoogleGenerativeAI } from '@google/generative-ai';

async function testGoogleBooks() {
    console.log("📚 Probando conexión con Google Books API...");
    const apiKey = process.env.GOOGLE_BOOKS_API_KEY;

    if (!apiKey) {
        console.error("❌ ERROR: No se encontró GOOGLE_BOOKS_API_KEY en el .env");
        return false;
    }

    try {
        // Buscamos un libro conocido para testear
        const query = encodeURIComponent("El lenguaje de Heidegger");
        const url = `https://www.googleapis.com/books/v1/volumes?q=${query}&key=${apiKey.trim()}`;
        
        const respuesta = await axios.get(url);
        
        if (respuesta.status === 200) {
            console.log("✅ [ÉXITO] Google Books API Key es VÁLIDA y está funcionando.");
            return true;
        }
    } catch (error) {
        console.error(`❌ [FALLO] Google Books devolvió un error: ${error.response?.status || error.message}`);
        if (error.response?.status === 400) {
            console.error("   ↳ Error 400: Tu clave API podría estar mal formada o tener espacios extra.");
        }
        return false;
    }
}

async function testGemini() {
    console.log("\n🤖 Probando conexión con Gemini API...");
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        console.error("❌ ERROR: No se encontró GEMINI_API_KEY en el .env");
        return false;
    }

    try {
        const genAI = new GoogleGenerativeAI(apiKey.trim());
        // Apuntamos a la versión 2.5 Flash que has sugerido
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        const prompt = "Responde únicamente con la palabra: 'Conectado'.";
        const result = await model.generateContent(prompt);
        const respuestaIA = result.response.text().trim();

        console.log(`✅ [ÉXITO] Gemini API Key es VÁLIDA. Respuesta de la IA: "${respuestaIA}"`);
        return true;
    } catch (error) {
        console.error(`❌ [FALLO] Gemini devolvió un error: ${error.message}`);
        return false;
    }
}

async function ejecutarTests() {
    console.log("🧪 INICIANDO TEST DE CREDENCIALES...\n");
    
    await testGoogleBooks();
    await testGemini();
    
    console.log("\n🏁 Tests finalizados.");
}

ejecutarTests();