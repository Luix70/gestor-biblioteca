// src/database.js
import { MongoClient } from 'mongodb';
import dns from 'node:dns';

// Obligamos al motor interno de Node a usar Google DNS para las conexiones SRV
dns.setServers(['8.8.8.8', '8.8.4.4']);
// Definimos la variable arriba, pero NO la inicializamos todavía
let client;
export async function conectarDB() {
    const uri = process.env.MONGO_URI; 
    
    if (!uri) {
        throw new Error("❌ CRÍTICO: MONGO_URI no definida en el archivo .env");
    }

    if (!client) {
        // Añadimos también ipv4first por si Node 24 está intentando enrutar por IPv6
        client = new MongoClient(uri, {
            serverSelectionTimeoutMS: 5000,
            retryWrites: true,
            family: 4 
        });
        await client.connect();
        console.log("✅ Conexión establecida con MongoDB Atlas");
    }
    
    return client.db(process.env.MONGO_DB_NAME || 'Biblioteca');
}

// ... aquí el resto de tus funciones como guardarRecurso, que deberán llamar a conectarDB() internamente
export async function guardarRecurso(libro) {
    try {
        const db = await conectarDB();
        const coleccion = db.collection('biblioteca');
        
        const resultado = await coleccion.insertOne(libro);
        console.log(`💾 Libro guardado en BDD con ID: ${resultado.insertedId}`);
        return resultado;
    } catch (error) {
        // El código 121 es específico de fallos de validación de esquema
        if (error.code === 121) {
            console.error("❌ ERROR DE VALIDACIÓN DE ESQUEMA EN MONGODB:");
            // Imprimimos el detalle exacto de qué regla se rompió
            console.error(JSON.stringify(error.errInfo?.details, null, 2));
        } else {
            console.error("❌ Error al guardar en BDD:", error);
        }
        throw new Error("Document failed validation"); // Lanzamos algo limpio al frontend
    }
}