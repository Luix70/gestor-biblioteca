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
            nombre:         { bsonType: 'string', description: 'Nombre de la colección/serie/cabecera (obligatorio).' },
            // Discriminador: 'revista' = cabecera de periódico (pivote ISSN, inventario numeros[]);
            // 'libro' (o ausente) = serie/colección editorial de libros (cada libro con su propio ISBN).
            tipo:           { bsonType: ['string', 'null'], description: "Naturaleza: 'revista' (cabecera) | 'libro' (serie editorial) | null (legado ⇒ libro)." },
            naturaleza:     { bsonType: ['string', 'null'], description: "Clase del contenido: 'comic' | 'novela-grafica' | 'fanzine' | 'academico' | null." },
            // ISSN de la cabecera/serie: AUTORIDAD del grupo (análogo a isbn_obra para obras). Una serie
            // de monografías (p. ej. «Graduate Texts in Physics») tiene ISSN de serie aunque sea de libros.
            issn:           { bsonType: ['string', 'null'], description: 'ISSN de la cabecera/serie (autoridad del grupo).' },
            editorial:      { bsonType: ['objectId', 'null'], description: 'Referencia a editoriales (opcional).' },
            cdu:            { bsonType: ['string', 'null'], description: 'CDU común a los miembros (mismo classmark → se archivan juntos).' },
            descripcion:    { bsonType: ['string', 'null'], description: 'Descripción general de la cabecera/serie.' },
            fecha_creacion: { bsonType: 'date' },
            fecha_actualizacion: { bsonType: ['date', 'null'] },
            // ── Revistas (tipo:'revista'): inventario CRONOLÓGICO de números (no el array 1..N de obras) ──
            numeros: {
                bsonType: ['array', 'null'],
                description: 'Inventario cronológico de los números de la revista.',
                items: {
                    bsonType: 'object',
                    properties: {
                        clave:        { bsonType: 'string', description: 'Clave estable del número (AAAA-MM / n<nº> / AAAA).' },
                        'año':        { bsonType: ['int', 'null'] },
                        mes:          { bsonType: ['int', 'null'] },
                        numero_issue: { bsonType: ['string', 'int', 'null'] },
                        _id:          { bsonType: ['objectId', 'null'] },
                    },
                },
            },
            numeros_sin_fecha:  { bsonType: ['array', 'null'], items: { bsonType: 'objectId' }, description: 'Números con ISSN pero sin fecha/nº detectables.' },
            numeros_presentes:  { bsonType: ['int', 'null'], description: 'Nº de números ya catalogados en la cabecera.' },
            revision_requerida: { bsonType: ['bool', 'null'], description: 'Algo se guardó desordenado (número sin fecha): revisar.' },
            nsfw:           { bsonType: ['bool', 'null'], description: 'No apto para invitados: oculto a guest (solo admin).' },
            locked:         { bsonType: ['bool', 'null'], description: 'Fijado por intervención humana: el Conformador no lo altera.' },
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
            resuelta_isbn:   { bsonType: ['bool', 'null'], description: 'true si ya se resolvió título/descripción por el ISBN de obra.' },
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
            // Tomos sin número determinable ("?"): se guardan igual (nunca se descartan) y marcan revisión.
            volumenes_sin_numero: { bsonType: ['array', 'null'], items: { bsonType: 'objectId' } },
            // ── Revistas: una obra con tipo:'revista' es una CABECERA (p. ej. ISSN 1699-7913); sus
            //    "tomos" son los NÚMEROS, en un inventario cronológico propio (no el array 1..N) ──
            tipo:        { bsonType: ['string', 'null'], description: "Naturaleza de la obra: 'libro' (ausente) o 'revista' (cabecera)." },
            issn_obra:   { bsonType: ['string', 'null'], description: 'ISSN de la cabecera de revista (autoridad, análogo a isbn_obra).' },
            numeros: {
                bsonType: ['array', 'null'],
                description: 'Inventario cronológico de los números de la revista.',
                items: {
                    bsonType: 'object',
                    properties: {
                        clave:        { bsonType: 'string', description: 'Clave estable del número (AAAA-MM / n<nº> / AAAA).' },
                        'año':        { bsonType: ['int', 'null'] },
                        mes:          { bsonType: ['int', 'null'] },
                        numero_issue: { bsonType: ['string', 'int', 'null'] },
                        _id:          { bsonType: ['objectId', 'null'] },
                    },
                },
            },
            numeros_sin_fecha: { bsonType: ['array', 'null'], items: { bsonType: 'objectId' }, description: 'Números con ISSN pero sin fecha/nº detectables.' },
            numeros_presentes: { bsonType: ['int', 'null'], description: 'Nº de números ya catalogados en la cabecera.' },
            revision_requerida:   { bsonType: ['bool', 'null'], description: 'Algo se guardó desordenado (tomo sin nº / número sin fecha / ISBN en conflicto): revisar.' },
            fecha_creacion:     { bsonType: 'date' },
            fecha_actualizacion:{ bsonType: ['date', 'null'] },
            nsfw:               { bsonType: ['bool', 'null'], description: 'No apto para invitados: oculta la obra Y sus tomos a guest (solo admin).' },
            locked:             { bsonType: ['bool', 'null'], description: 'Fijado por intervención humana: el Conformador no lo altera.' },
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

    // Quitar índices ÚNICOS heredados de UN solo campo en isbn/issn: contradicen el modelo y FUSIONAN
    // documentos distintos (E11000). Un mismo ISBN puede tener varios docs (uno por formato; y hay
    // seriados que reimprimen el mismo ISBN en cada número); un ISSN lo COMPARTEN todos los números de
    // una revista → un único en biblioteca.issn fusionaría toda la cabecera. Se sustituyen por NO únicos.
    try {
        for (const ix of await biblioteca.indexes()) {
            const ks = ix.key ? Object.keys(ix.key) : [];
            if (ix.unique && ks.length === 1 && (ks[0] === 'isbn' || ks[0] === 'issn')) {
                await biblioteca.dropIndex(ix.name);
                console.log(`  🗑️  índice ÚNICO heredado ${ix.name} (${ks[0]}) eliminado (fusionaba documentos distintos).`);
            }
        }
    } catch (e) { console.warn(`  ⚠️  revisión de índices únicos isbn/issn: ${e.codeName || e.message}`); }
    await asegurarIndice(biblioteca, { isbn: 1 }, { sparse: true, name: 'idx_isbn' });
    await asegurarIndice(biblioteca, { issn: 1 }, { sparse: true, name: 'idx_issn' });

    // Ampliar (sin quitar) el enum de `formatos` del validador de biblioteca para admitir cómics/ebooks
    // (cbz/cbr/cb7/djvu/mobi). El validador de biblioteca vive en Atlas, así que se LEE y se re-aplica
    // añadiendo solo lo que falte (defensivo: si la estructura no encaja, no se toca).
    try {
        const info = (await db.listCollections({ name: 'biblioteca' }).toArray())[0];
        const js = info?.options?.validator?.$jsonSchema;
        const fmt = js?.properties?.formatos;
        const ref = fmt?.items?.enum ? fmt.items : (Array.isArray(fmt?.enum) ? fmt : null);
        if (ref) {
            const faltan = ['cbr', 'cbz', 'cb7', 'djvu', 'mobi'].filter(v => !ref.enum.includes(v));
            if (faltan.length) {
                ref.enum = [...ref.enum, ...faltan];
                await db.command({
                    collMod: 'biblioteca', validator: { $jsonSchema: js },
                    validationLevel: info.options.validationLevel || 'moderate',
                    validationAction: info.options.validationAction || 'error',
                });
                console.log(`  ✅ formatos: enum ampliado (+${faltan.join(', ')}).`);
            } else {
                console.log('  ✓ formatos: el enum ya admite cómics/ebooks.');
            }
        } else {
            console.log('  ⓘ biblioteca sin enum de formatos (o estructura distinta): no se modifica.');
        }
    } catch (e) {
        console.warn(`  ⚠️  no se pudo ampliar el enum de formatos: ${e.codeName || e.message}`);
    }

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
    // ISSN de la cabecera/serie: AUTORIDAD del grupo (análogo a obras.issn_obra). Sparse: solo las que lo tienen.
    await asegurarIndice(colecciones, { issn: 1 },      { unique: true, sparse: true, name: 'idx_issn_unico' });

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
    await asegurarIndice(obras, { issn_obra: 1 }, { unique: true, sparse: true, name: 'idx_issn_obra_unico' });
    await asegurarIndice(obras, { titulo: 1 },    { name: 'idx_titulo' });
    await asegurarIndice(obras, { coleccion: 1 }, { sparse: true, name: 'idx_coleccion' });

    // biblioteca: índice para localizar tomos por obra (y detectar obras incompletas).
    await asegurarIndice(biblioteca, { obra: 1, volumen_numero: 1 }, { sparse: true, name: 'idx_obra_volumen' });
    // biblioteca: número de revista por (cabecera, clave). La cabecera ahora es una COLECCIÓN
    // (tipo:'revista'), así que la identidad de un número es (coleccion, clave_numero). El índice
    // antiguo obra+clave_numero se conserva por compatibilidad con datos sin migrar.
    await asegurarIndice(biblioteca, { coleccion: 1, clave_numero: 1 }, { sparse: true, name: 'idx_coleccion_clave_numero' });
    await asegurarIndice(biblioteca, { obra: 1, clave_numero: 1 }, { sparse: true, name: 'idx_obra_clave_numero' });

    // autores: la ingesta busca por `nombre` (check-then-create) y la página «Autores» busca por nombre y
    // por grafías alternativas. Índices no únicos (puede haber homónimos reales; la fusión es manual).
    console.log('\nautores:');
    const autores = db.collection('autores');
    await asegurarIndice(autores, { nombre: 1 }, { name: 'idx_nombre' });
    await asegurarIndice(autores, { nombres_alternativos: 1 }, { sparse: true, name: 'idx_nombres_alternativos' });

    console.log('\nListo.\n');
    process.exit(0);
}

main().catch(e => { console.error('ERROR FATAL:', e); process.exit(1); });
