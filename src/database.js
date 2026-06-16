import { MongoClient } from 'mongodb';
import dns from 'node:dns';

// Puenteamos el DNS local inyectando los servidores de Google para resolver registros SRV
dns.setServers(['8.8.8.8', '8.8.4.4']);

let client;

export async function conectarDB() {
    const uri = process.env.MONGO_URI; 
    
    if (!uri) {
        throw new Error("❌ CRÍTICO: MONGO_URI no definida en el archivo .env");
    }

    if (!client) {
        client = new MongoClient(uri, {
            serverSelectionTimeoutMS: 10000, // Damos 10 segundos de margen a la conexión
            family: 4 // Forzamos IPv4 para evitar atascos en la red
        });
        
        await client.connect();
        console.log("✅ Conexión establecida con MongoDB Atlas");
    }
    
    return client.db(process.env.MONGO_DB_NAME || 'Biblioteca');
}