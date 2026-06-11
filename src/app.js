import dns from 'node:dns';
dns.setServers(['8.8.8.8', '8.8.4.4']); // Blindaje DNS para redes privadas

import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { analizarImagenesRecurso } from './agente.js'; 
import { optimizarImagenRecurso } from './procesador-imagenes.js';
import { conectarDB, guardarRecurso } from './database.js';
import { extraerDatosEpub } from './procesador-epub.js'; // Importación del nuevo pipeline

dotenv.config();

const INBOX = path.resolve(process.env.PATH_INBOX);
const CDU = path.resolve(process.env.PATH_CDU);
const CUARENTENA = path.resolve(process.env.PATH_CUARENTENA);
const REINTENTOS = path.resolve(process.env.PATH_REINTENTOS);

const TIEMPO_ESPERA_AGRUPACION_MS = 5000; 
const INTERVALO_DAEMON_MS = 60000; 
const INTERVALOS_REINTENTO_MIN = [5, 10, 20, 60, 360, 1440];

let colaDeArchivosActual = new Set();
let temporizadorDeBatching = null;

async function asegurarDirectorios() {
    for (const dir of [INBOX, CDU, CUARENTENA, REINTENTOS]) {
        await fs.mkdir(dir, { recursive: true });
    }
}

async function buscarDuplicado(recurso) {
    const base = await conectarDB();
    if (recurso.isbn) {
        return await base.collection('biblioteca').findOne({ isbn: resource => recurso.isbn, formatos: { $in: recurso.formatos } });
    }
    return await base.collection('biblioteca').findOne({
        titulo: { $regex: `^${recurso.titulo}$`, $options: 'i' },
        formatos: { $in: recurso.formatos }
    });
}

function sanitizarParaMongoDB(obj) {
    const limpio = { ...obj };
    Object.keys(limpio).forEach(key => {
        if (limpio[key] === null || limpio[key] === undefined) delete limpio[key];
    });
    return limpio;
}

/**
 * PIPELINE DE ENRUTAMIENTO LOGÍSTICO (Polimorfismo estructural)
 */
async function procesarTrabajo(rutasArchivos, metadataExistente = null) {
    let metadata = metadataExistente || {
        jobId: `job_${Date.now()}`,
        intentos: 0,
        proximo_intento_ms: Date.now(),
        datos_extraidos: null,
        archivos: rutasArchivos.map(r => path.basename(r))
    };

    // Evaluamos si el lote corresponde a un documento digital unitario
    const esEpub = rutasArchivos.length === 1 && rutasArchivos[0].toLowerCase().endsWith('.epub');

    try {
        let buffersOptimizados = [];

        if (!metadata.datos_extraidos) {
            if (esEpub) {
                // FLUJO DIGITAL DIRECTO
                const { info, bufferPortada } = await extraerDatosEpub(rutasArchivos[0]);
                
                if (bufferPortada) {
                    const bufferOpt = await optimizarImagenRecurso(bufferPortada);
                    buffersOptimizados.push(bufferOpt);
                }
                
                // Ejecución cruzada: Metadatos nativos + Imagen de portada enviada a Gemini
                const rawRecurso = await analizarImagenesRecurso(buffersOptimizados, info);
                
                // Forzado de reglas e inyección del índice de capítulos nativo
                rawRecurso.formatos = ["digital"];
                if (info.tabla_contenidos) rawRecurso.tabla_contenidos = info.tabla_contenidos;
                
                metadata.datos_extraidos = sanitizarParaMongoDB(rawRecurso);
            } else {
                // FLUJO FÍSICO TRADICIONAL (Imágenes analizadas por visión)
                for (const ruta of rutasArchivos) {
                    const bufferInicial = await fs.readFile(ruta);
                    buffersOptimizados.push(await optimizarImagenRecurso(bufferInicial));
                }
                const rawRecurso = await analizarImagenesRecurso(buffersOptimizados);
                metadata.datos_extraidos = sanitizarParaMongoDB(rawRecurso);
            }
            console.log(`\n📋 FICHA EXTRAÍDA CON ÉXITO: "${metadata.datos_extraidos.titulo}"`);
        } else {
            console.log(`   🧠 [Caché] Reutilizando ficha técnica guardada. Reconstruyendo recursos físicos...`);
            if (esEpub) {
                const { bufferPortada } = await extraerDatosEpub(rutasArchivos[0]);
                if (bufferPortada) buffersOptimizados.push(await optimizarImagenRecurso(bufferPortada));
            }
        }

        const recursoDB = metadata.datos_extraidos;
        recursoDB.fecha_ingreso = new Date(recursoDB.fecha_ingreso || Date.now());

        // Verificación de existencia previa en base de datos
        const duplicado = await buscarDuplicado(recursoDB);
        if (duplicado) {
            console.log(`🛑 Recurso duplicado detectado en Atlas. Cancelando inserción.`);
            const carpetaJob = path.join(CUARENTENA, `DUPLICADO_${metadata.jobId}`);
            await fs.mkdir(carpetaJob, { recursive: true });
            for (const ruta of rutasArchivos) await fs.rename(ruta, path.join(carpetaJob, path.basename(ruta)));
            return true;
        }

        const resultadoDB = await guardarRecurso(recursoDB);
        
        // Construcción de la arquitectura definitiva en el árbol CDU
        const subEntorno = esEpub ? "digital" : "fisico";
        const carpetaDestinoCDU = path.join(CDU, recursoDB.cdu || "000", "libros", recursoDB.isbn || resultadoDB.insertedId.toString(), subEntorno);
        await fs.mkdir(carpetaDestinoCDU, { recursive: true });

        if (esEpub) {
            // Archivamos la portada optimizada si se logró extraer del libro
            if (buffersOptimizados.length > 0) {
                await fs.writeFile(path.join(carpetaDestinoCDU, "portada.jpg"), buffersOptimizados[0]);
            }
            // Salvaguardamos el archivo ejecutable EPUB original moviéndolo a la biblioteca permanente
            await fs.rename(rutasArchivos[0], path.join(carpetaDestinoCDU, "libro.epub"));
            console.log(`📂 Almacenamiento completado. Libro electrónico y portada ubicados en árbol CDU.`);
        } else {
            // Conservación tradicional de fotografías optimizadas
            for (let i = 0; i < rutasArchivos.length; i++) {
                const bufferOpt = await optimizarImagenRecurso(await fs.readFile(rutasArchivos[i]));
                await fs.writeFile(path.join(carpetaDestinoCDU, `portada_${i}.jpg`), bufferOpt);
                await fs.unlink(rutasArchivos[i]);
            }
        }
        
        console.log(`🚀 PROCESO DE CATALOGACIÓN CONCLUIDO SANO Y SALVO.`);
        return true;
    } catch (error) {
        console.error(`\n⚠️  Interrupción en el pipeline: ${error.message}`);
        metadata.ultimo_error = error.message;
        return metadata;
    }
}

/**
 * GESTIÓN DE ENTRADA (Bandeja de entrada Inbox)
 */
async function encolarNuevoLote() {
    temporizadorDeBatching = null;
    const archivosAProcesar = Array.from(colaDeArchivosActual);
    colaDeArchivosActual.clear();

    if (archivosAProcesar.length === 0) return;
    
    const resultado = await procesarTrabajo(archivosAProcesar);

    if (resultado !== true) {
        const metadata = resultado;
        const carpetaJob = path.join(REINTENTOS, metadata.jobId);
        await fs.mkdir(carpetaJob, { recursive: true });
        
        for (const ruta of archivosAProcesar) {
            await fs.rename(ruta, path.join(carpetaJob, path.basename(ruta)));
        }
        
        metadata.archivos = archivosAProcesar.map(r => path.basename(r));
        metadata.proximo_intento_ms = Date.now() + (INTERVALOS_REINTENTO_MIN[0] * 60000);
        await fs.writeFile(path.join(carpetaJob, 'metadata.json'), JSON.stringify(metadata, null, 2));
        console.log(`📦 Fallo de red detectado. Trabajo persistido de forma segura en cola: ${metadata.jobId}`);
    }
}

/**
 * DEMONIO ASÍNCRONO DE REINTENTOS
 */
async function daemonReintentos() {
    try {
        const elementos = await fs.readdir(REINTENTOS, { withFileTypes: true });
        for (const carpeta of elementos.filter(el => el.isDirectory() && el.name.startsWith('job_'))) {
            const rutaJob = path.join(REINTENTOS, carpeta.name);
            const rutaMetadata = path.join(rutaJob, 'metadata.json');
            
            let metadata;
            try {
                metadata = JSON.parse(await fs.readFile(rutaMetadata, 'utf-8'));
            } catch (e) { continue; }

            if (Date.now() < metadata.proximo_intento_ms) continue; 

            console.log(`\n🔄 [Daemon] Despertando proceso postergado: ${metadata.jobId}...`);
            const rutasAbsolutas = metadata.archivos.map(n => path.join(rutaJob, n));
            
            const resultado = await procesarTrabajo(rutasAbsolutas, metadata);
            
            if (resultado === true) {
                await fs.rm(rutaJob, { recursive: true, force: true });
                console.log(`   ✨ [Daemon] Trabajo resuelto con éxito. Cola liberada.`);
            } else {
                resultado.intentos += 1;
                if (resultado.intentos >= INTERVALOS_REINTENTO_MIN.length) {
                    console.log(`   🚨 [Daemon] Agotados intentos máximos. Moviendo bloque íntegro a Cuarentena.`);
                    await fs.rename(rutaJob, path.join(CUARENTENA, resultado.jobId));
                } else {
                    const minEspera = INTERVALOS_REINTENTO_MIN[resultado.intentos];
                    resultado.proximo_intento_ms = Date.now() + (minEspera * 60000);
                    await fs.writeFile(rutaMetadata, JSON.stringify(resultado, null, 2));
                    console.log(`   ⏳ [Daemon] Error persistente. Postergado de nuevo por ${minEspera} min.`);
                }
            }
        }
    } catch (err) { console.error('[Daemon Error]:', err.message); }
}

async function loopDaemon() {
    await daemonReintentos();
    setTimeout(loopDaemon, INTERVALO_DAEMON_MS);
}

async function iniciarSistema() {
    await asegurarDirectorios();
    console.log(`\n=================================================`);
    console.log(`👁️  SISTEMA INTEGRAL DE CATALOGACIÓN MULTIMODAL`);
    console.log(`📍 Vigilando ruta activa: ${INBOX}`);
    console.log(`=================================================\n`);
    
    setTimeout(loopDaemon, INTERVALO_DAEMON_MS);

    const watcher = chokidar.watch(INBOX, {
        ignored: /(^|[\/\\])\../,
        persistent: true,
        usePolling: process.platform === 'win32',
        awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 }
    });

    watcher.on('add', (ruta) => {
        colaDeArchivosActual.add(ruta);
        if (temporizadorDeBatching) clearTimeout(temporizadorDeBatching);
        temporizadorDeBatching = setTimeout(encolarNuevoLote, TIEMPO_ESPERA_AGRUPACION_MS);
    });
}

iniciarSistema();