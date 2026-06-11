import { MongoClient } from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const client = new MongoClient(process.env.MONGO_URI);
let db = null;

export async function conectarDB() {
    if (db) return db;
    try {
        await client.connect();
        console.log('──> [DB] Conectado con éxito a MongoDB Atlas');
        db = client.db(process.env.MONGO_DB_NAME);
        return db;
} catch (error) {
        console.error('CRÍTICO: Fallo al conectar a MongoDB:', error.message);
        throw error; // Eliminamos process.exit(1)
    }
}

export async function guardarRecurso(documento) {
    const base = await conectarDB();
    return await base.collection('biblioteca').insertOne(documento);
}