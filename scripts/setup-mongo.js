/**
 * Configuración idempotente de MongoDB para el gestor:
 *   • Índices de consulta en 'biblioteca' (hash_contenido, coleccion).
 *   • Colección 'colecciones' con validador $jsonSchema + índices (nombre único, editorial).
 *
 * Es seguro ejecutarlo varias veces (createIndex/collMod no duplican).
 *   node scripts/setup-mongo.js
 *
 * En Windows, si Atlas rechaza el TLS, ejecutar con:
 *   NODE_TLS_REJECT_UNAUTHORIZED=0 node scripts/setup-mongo.js
 */

import 'dotenv/config';
import { conectarDB } from '../src/database.js';

async function asegurarIndice(col, spec, opciones) {
    try {
        const nombre = await col.createIndex(spec, opciones);
        console.log(`  ✅ índice ${col.collectionName}.${JSON.stringify(spec)} → ${nombre}`);
    } catch (e) {
        console.warn(`  ⚠️  índice ${col.collectionName}.${JSON.stringify(spec)}: ${e.codeName || e.message}`);
    }
}

const VALIDADOR_COLECCIONES = {
    $jsonSchema: {
        bsonType: 'object',
        required: ['nombre'],
        properties: {
            nombre:         { bsonType: 'string', description: 'Nombre de la colección/serie (obligatorio).' },
            editorial:      { bsonType: 'objectId', description: 'Referencia a editoriales (opcional).' },
            fecha_creacion: { bsonType: 'date' },
        },
    },
};

const VALIDADOR_CDU_DESC = {
    $jsonSchema: {
        bsonType: 'object',
        required: ['codigo'],
        properties: {
            codigo:         { bsonType: 'string', description: 'Código CDU limpio (clave única).' },
            clase:          { bsonType: 'string' },
            division:       { bsonType: 'string' },
            titulo_es:      { bsonType: ['string', 'null'] },
            descripcion_es: { bsonType: ['string', 'null'] },
            titulo_en:      { bsonType: ['string', 'null'] },
            descripcion_en: { bsonType: ['string', 'null'] },
            fuente:         { bsonType: 'string' },
            verificado:     { bsonType: 'bool' },
            fecha:          { bsonType: 'date' },
        },
    },
};

async function main() {
    const db = await conectarDB();
    console.log(`\nConfigurando MongoDB (db: ${db.databaseName})\n`);

    // ── biblioteca: índices de consulta ──────────────────────────────────────
    const biblioteca = db.collection('biblioteca');
    console.log('biblioteca:');
    // sparse: solo indexa los docs que ya tienen el campo (los antiguos se irán sumando al
    // rellenarse vía Conformador). NO unique todavía: pueden existir duplicados exactos previos.
    await asegurarIndice(biblioteca, { hash_contenido: 1 }, { sparse: true, name: 'idx_hash_contenido' });
    await asegurarIndice(biblioteca, { coleccion: 1 },      { sparse: true, name: 'idx_coleccion' });

    // ── colecciones: crear con validador (o aplicarlo si ya existe) ───────────
    console.log('\ncolecciones:');
    const existentes = await db.listCollections({ name: 'colecciones' }).toArray();
    if (existentes.length === 0) {
        await db.createCollection('colecciones', { validator: VALIDADOR_COLECCIONES, validationLevel: 'moderate' });
        console.log('  ✅ colección creada con validador.');
    } else {
        await db.command({ collMod: 'colecciones', validator: VALIDADOR_COLECCIONES, validationLevel: 'moderate' });
        console.log('  ✅ validador aplicado (collMod).');
    }
    const colecciones = db.collection('colecciones');
    await asegurarIndice(colecciones, { nombre: 1 },    { unique: true, name: 'idx_nombre_unico' });
    await asegurarIndice(colecciones, { editorial: 1 }, { sparse: true, name: 'idx_editorial' });

    // ── cdu_descripciones: descripciones bilingües ES/EN de cada código CDU ────
    console.log('\ncdu_descripciones:');
    const existeDesc = await db.listCollections({ name: 'cdu_descripciones' }).toArray();
    if (existeDesc.length === 0) {
        await db.createCollection('cdu_descripciones', { validator: VALIDADOR_CDU_DESC, validationLevel: 'moderate' });
        console.log('  ✅ colección creada con validador.');
    } else {
        await db.command({ collMod: 'cdu_descripciones', validator: VALIDADOR_CDU_DESC, validationLevel: 'moderate' });
        console.log('  ✅ validador aplicado (collMod).');
    }
    const cduDesc = db.collection('cdu_descripciones');
    await asegurarIndice(cduDesc, { codigo: 1 }, { unique: true, name: 'idx_codigo_unico' });
    await asegurarIndice(cduDesc, { clase: 1 },  { sparse: true, name: 'idx_clase' });

    console.log('\nListo.\n');
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
