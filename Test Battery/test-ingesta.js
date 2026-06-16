import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function probarIngesta() {
    const form = new FormData();
    
    // El JSON con los datos (cumpliendo tu esquema de BDD)
    const datosLibro = {
        titulo: "Test de Ingesta Automatizada",
        tipo_recurso: "libro",
        cdu: "000",
        idioma: "es",
        formatos: ["papel"],
        isbn: "1234567890",
        ubicacion: { ambito: "Biblioteca", estanteria: "E1" }
    };

    form.append('datos', JSON.stringify(datosLibro));
    // Adjuntamos un archivo de prueba (asegúrate de tener uno en la raíz)
    form.append('files', fs.createReadStream(path.join(__dirname, 'test-archivo.jpg')));

    try {
        const res = await axios.post('http://localhost:3000/api/ingestar', form, {
            headers: form.getHeaders()
        });
        console.log("✅ Éxito:", res.data);
} catch (err) {
        console.error("❌ Fallo:", err.response ? err.response.data : err.message);
    }
}

probarIngesta();