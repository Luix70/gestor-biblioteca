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

const VALIDADOR_OBRAS = {
    $jsonSchema: {
        bsonType: 'object',
        required: ['titulo'],
        properties: {
            titulo:          { bsonType: 'string', description: 'Título de la obra multivolumen.' },
            isbn_obra:       { bsonType: ['string', 'null'], description: 'ISBN de la obra completa.' },
            editorial:       { bsonType: ['objectId', 'null'] },
            coleccion:       { bsonType: ['objectId', 'null'], description: 'Serie a la que pertenece la obra (opcional).' },
            cdu:             { bsonType: ['string', 'null'], description: 'CDU común a todos los tomos.' },
            descripcion:     { bsonType: ['string', 'null'], description: 'Descripción/sinopsis general de la obra.' },
            total_volumenes: { bsonType: ['int', 'null'], description: 'Nº total de tomos, si se conoce.' },
            volumenes_presentes: { bsonType: ['int', 'null'], description: 'Nº de tomos ya catalogados.' },
            completa:        { bsonType: ['bool', 'null'], description: 'true si están todos los tomos.' },
            // Inventario 1..total: el _id del tomo presente o null si falta.
            volumenes: {
                bsonType: ['array', 'null'],
                items: {
                    bsonType: 'object',
                    properties: { numero: { bsonType: 'int' }, _id: { bsonType: ['objectId', 'null'] } },
                },
            },
            fecha_creacion:     { bsonType: 'date' },
            fecha_actualizacion:{ bsonType: ['date', 'null'] },
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

    // ── obras: obras multivolumen (padre abstracto; los tomos son docs de biblioteca) ──
    console.log('\nobras:');
    const existeObras = await db.listCollections({ name: 'obras' }).toArray();
    if (existeObras.length === 0) {
        await db.createCollection('obras', { validator: VALIDADOR_OBRAS, validationLevel: 'moderate' });
        console.log('  ✅ colección creada con validador.');
    } else {
        await db.command({ collMod: 'obras', validator: VALIDADOR_OBRAS, validationLevel: 'moderate' });
        console.log('  ✅ validador aplicado (collMod).');
    }
    const obras = db.collection('obras');
    await asegurarIndice(obras, { isbn_obra: 1 }, { unique: true, sparse: true, name: 'idx_isbn_obra_unico' });
    await asegurarIndice(obras, { titulo: 1 },    { name: 'idx_titulo' });
    await asegurarIndice(obras, { coleccion: 1 }, { sparse: true, name: 'idx_coleccion' });

    // biblioteca: índice para localizar tomos por obra (y detectar obras incompletas).
    await asegurarIndice(biblioteca, { obra: 1, volumen_numero: 1 }, { sparse: true, name: 'idx_obra_volumen' });

    console.log('\nListo.\n');
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
