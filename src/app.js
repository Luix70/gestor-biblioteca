import express from 'express';
import multer from 'multer';
import axios from 'axios';
import fs from 'fs/promises';
import path from 'path';
import { analizarImagenesRecurso } from './agente.js';
import { optimizarImagenRecurso } from './procesador-imagenes.js';
import { conectarDB, guardarRecurso } from './database.js';

const app = express();
const upload = multer({ dest: 'temp/' }); // Carpeta temporal para procesar el POST
app.use(express.json());

// Exponer la carpeta CDU como estática para que el frontend pueda ver portadas
app.use('/recursos', express.static(path.resolve(process.env.PATH_CDU)));

/**
 * Servicio: Enriquecimiento determinista mediante API Pública
 */
async function obtenerMetadataPublica(isbn) {
    try {
        const url = `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;
        const res = await axios.get(url);
        if (res.data.totalItems > 0) {
            const info = res.data.items[0].volumeInfo;
            return {
                titulo: info.title,
                editorial: info.publisher,
                sinopsis: info.description,
                año_edicion: info.publishedDate ? parseInt(info.publishedDate.substring(0, 4)) : null
            };
        }
    } catch (e) {
        console.error(`[API Externa] Fallo consultando ISBN ${isbn}:`, e.message);
    }
    return null;
}

/**
 * Endpoint de Ingesta
 */
app.post('/api/ingestar', upload.array('files'), async (req, res) => {
    try {
        const files = req.files; // Array de archivos recibidos
        const esEpub = files.some(f => f.originalname.endsWith('.epub'));
        
        // 1. Proceso de Extracción (IA o EPUB Nativo)
        // ... (aquí llamaríamos a tus procesadores ya existentes) ...
        
        // 2. Enriquecimiento Determinista (Si tenemos ISBN)
        if (resultadoIA.isbn) {
            const extra = await obtenerMetadataPublica(resultadoIA.isbn);
            if (extra) Object.assign(resultadoIA, extra);
        }

        // 3. Persistencia y construcción de rutas públicas
        // ... (guardar en Atlas y devolver al front el array de rutas) ...
        
        res.status(200).json({ success: true, message: "Libro catalogado", rutas: [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(3000, () => console.log('🚀 API de Catalogación operativa en puerto 3000'));