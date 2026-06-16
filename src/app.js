// src/app.js
import 'dotenv/config'; // <--- ESTO DEBE IR AQUÍ, ARRIBA DEL TODO
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.PATH_CDU = path.resolve(__dirname, '..', process.env.PATH_CDU);
process.env.PATH_INBOX = path.resolve(__dirname, '..', process.env.PATH_INBOX);

import express from 'express';
import multer from 'multer';
import { procesarIngesta } from './controlador-ingesta.js';


const app = express();
const upload = multer({ dest: 'temp/' });

// Servir la carpeta CDU como estática
app.use('/recursos', express.static(process.env.PATH_CDU));

// Endpoint API
app.post('/api/ingestar', upload.array('files'), async (req, res) => {
    try {
        const resultado = await procesarIngesta(req.body, req.files);
        res.status(200).json({ status: "success", data: resultado });
    } catch (err) {
        console.error("❌ ERROR CRÍTICO 500:", err); // <-- Añade esta línea
        res.status(500).json({ status: "error", message: err.message });
    }
});

// Iniciamos ambos sistemas
app.listen(3000, () => {
    console.log('🚀 API REST activa en puerto 3000');

});