import express from 'express';
import multer from 'multer';
import path from 'path';
import { procesarIngesta } from './controlador-ingesta.js'; // Nueva lógica modular

const app = express();
const upload = multer({ dest: 'temp/' });

// Servir la carpeta CDU como estática
app.use('/recursos', express.static(path.resolve(process.env.PATH_CDU)));

// Endpoint único de ingesta
app.post('/api/ingestar', upload.array('files'), async (req, res) => {
    try {
        // Delegamos toda la lógica al controlador
        const resultado = await procesarIngesta(req.body, req.files);
        res.status(200).json(resultado);
    } catch (err) {
        console.error("Error en API:", err);
        res.status(500).json({ status: "error", message: err.message });
    }
});

app.listen(3000, () => console.log('🚀 API REST activa en puerto 3000'));