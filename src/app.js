import dns from 'node:dns';
dns.setServers(['8.8.8.8', '8.8.4.4']);

import chokidar from 'chokidar';
import path from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';
import { analizarImagenesRecurso } from './agente.js'; 
import { optimizarImagenRecurso } from './procesador-imagenes.js';
import { conectarDB, guardarRecurso } from './database.js';
import { extraerDatosEpub } from './procesador-epub.js'; 

dotenv.config();

// --- INTERCEPTOR DE CONSOLA (Marcas de tiempo de alta precisión) ---
const logOriginal = console.log;
const errorOriginal = console.error;

function obtenerMarcaTiempo() {
    const d = new Date();
    // Genera formato: [HH:MM:SS.mmm]
    return `[${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}]`;
}

console.log = (...args) => logOriginal(obtenerMarcaTiempo(), ...args);
console.error = (...args) => errorOriginal(obtenerMarcaTiempo(), ...args);
// -------------------------------------------------------------------


const INBOX = path.resolve(process.env.PATH_INBOX);
const CDU = path.resolve(process.env.PATH_CDU);
const CUARENTENA = path.resolve(process.env.PATH_CUARENTENA);
const REINTENTOS = path.resolve(process.env.PATH_REINTENTOS);

const TIEMPO_ESPERA_AGRUPACION_MS = 5000; 
const INTERVALO_DAEMON_MS = 60000; 
const INTERVALOS_REINTENTO_MIN = [5, 10, 20, 60, 360, 1440];

let colaDeArchivosActual = new Set();
let temporizadorDeBatching = null;
let procesandoLoteActualmente = false; // MUTEX: Cerrojo de concurrencia

async function asegurarDirectorios() {
    for (const dir of [INBOX, CDU, CUARENTENA, REINTENTOS]) await fs.mkdir(dir, { recursive: true });
}

async function buscarDuplicado(recurso) {
    const base = await conectarDB();
    if (recurso.isbn) {
        return await base.collection('biblioteca').findOne({ isbn: recurso.isbn, formatos: { $in: recurso.formatos } });
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
 * MOTOR PRINCIPAL: Pipeline polimórfico
 */
async function procesarTrabajo(rutasArchivos, metadataExistente = null) {
    let metadata = metadataExistente || {
        jobId: `job_${Date.now()}`,
        intentos: 0,
        proximo_intento_ms: Date.now(),
        datos_extraidos: null,
        archivos: rutasArchivos.map(r => path.basename(r))
    };

    const esEpub = rutasArchivos.length === 1 && rutasArchivos[0].toLowerCase().endsWith('.epub');

    try {
        let buffersOptimizados = [];

        if (!metadata.datos_extraidos) {
            if (esEpub) {
                const { info, bufferPortada } = await extraerDatosEpub(rutasArchivos[0]);
                info.formatos = ["digital"];
                
                // 🛡️ DEFENSA TEMPRANA: Consultamos Atlas antes de consumir API de Gemini
                if (info.isbn || info.titulo) {
                    const posibleDuplicado = await buscarDuplicado(info);
                    if (posibleDuplicado) {
                        console.log(`🛑 DUPLICADO ENCONTRADO EN ANÁLISIS LOCAL. Abortando llamadas a IA.`);
                        const carpetaJob = path.join(CUARENTENA, `DUPLICADO_${metadata.jobId}`);
                        await fs.mkdir(carpetaJob, { recursive: true });
                        await fs.rename(rutasArchivos[0], path.join(carpetaJob, path.basename(rutasArchivos[0])));
                        return true; 
                    }
                }

                if (bufferPortada) buffersOptimizados.push(await optimizarImagenRecurso(bufferPortada));
                const rawRecurso = await analizarImagenesRecurso(buffersOptimizados, info);
                
                rawRecurso.formatos = ["digital"];
                if (info.tabla_contenidos) rawRecurso.tabla_contenidos = info.tabla_contenidos;
                metadata.datos_extraidos = sanitizarParaMongoDB(rawRecurso);
                
            } else {
                for (const ruta of rutasArchivos) buffersOptimizados.push(await optimizarImagenRecurso(await fs.readFile(ruta)));
                const rawRecurso = await analizarImagenesRecurso(buffersOptimizados);
                metadata.datos_extraidos = sanitizarParaMongoDB(rawRecurso);
            }
            console.log(`\n📋 FICHA EXTRAÍDA: "${metadata.datos_extraidos.titulo}"`);
        } else {
            console.log(`   🧠 [Caché] Reutilizando ficha técnica guardada.`);
            if (esEpub) {
                const { bufferPortada } = await extraerDatosEpub(rutasArchivos[0]);
                if (bufferPortada) buffersOptimizados.push(await optimizarImagenRecurso(bufferPortada));
            }
        }

        const recursoDB = metadata.datos_extraidos;
        recursoDB.fecha_ingreso = new Date(recursoDB.fecha_ingreso || Date.now());

        const duplicado = await buscarDuplicado(recursoDB);
        if (duplicado) {
            console.log(`🛑 Recurso duplicado detectado en Atlas. Cancelando inserción.`);
            const carpetaJob = path.join(CUARENTENA, `DUPLICADO_${metadata.jobId}`);
            await fs.mkdir(carpetaJob, { recursive: true });
            for (const ruta of rutasArchivos) await fs.rename(ruta, path.join(carpetaJob, path.basename(ruta)));
            return true;
        }

        const resultadoDB = await guardarRecurso(recursoDB);
        const subEntorno = esEpub ? "digital" : "fisico";
        const carpetaDestinoCDU = path.join(CDU, recursoDB.cdu || "000", "libros", recursoDB.isbn || resultadoDB.insertedId.toString(), subEntorno);
        await fs.mkdir(carpetaDestinoCDU, { recursive: true });

        if (esEpub) {
            if (buffersOptimizados.length > 0) await fs.writeFile(path.join(carpetaDestinoCDU, "portada.jpg"), buffersOptimizados[0]);
            await fs.rename(rutasArchivos[0], path.join(carpetaDestinoCDU, "libro.epub"));
        } else {
            for (let i = 0; i < rutasArchivos.length; i++) {
                const bufferOpt = await optimizarImagenRecurso(await fs.readFile(rutasArchivos[i]));
                await fs.writeFile(path.join(carpetaDestinoCDU, `portada_${i}.jpg`), bufferOpt);
                await fs.unlink(rutasArchivos[i]);
            }
        }
        
        console.log(`🚀 CATALOGACIÓN COMPLETADA.`);
        return true;
    } catch (error) {
        console.error(`\n⚠️ Interrupción: ${error.message}`);
        metadata.ultimo_error = error.message;
        return metadata;
    }
}

/**
 * GESTIÓN DE ENTRADA CON MUTEX
 */
async function encolarNuevoLote() {
    // 🔒 Si ya estamos procesando un lote, postergamos la ejecución para no solapar hilos
    if (procesandoLoteActualmente) {
        if (!temporizadorDeBatching) temporizadorDeBatching = setTimeout(encolarNuevoLote, TIEMPO_ESPERA_AGRUPACION_MS);
        return;
    }

    if (colaDeArchivosActual.size === 0) return;

    temporizadorDeBatching = null;
    const archivosAProcesar = Array.from(colaDeArchivosActual);
    colaDeArchivosActual.clear();
    procesandoLoteActualmente = true; // Bloqueamos la entrada a nuevos hilos
    
    try {
        const resultado = await procesarTrabajo(archivosAProcesar);

        if (resultado !== true) {
            const metadata = resultado;
            const carpetaJob = path.join(REINTENTOS, metadata.jobId);
            await fs.mkdir(carpetaJob, { recursive: true });
            
            for (const ruta of archivosAProcesar) {
                try {
                    await fs.rename(ruta, path.join(carpetaJob, path.basename(ruta)));
                } catch(e) { console.error(`Error moviendo a Reintentos: ${e.message}`); }
            }
            
            metadata.archivos = archivosAProcesar.map(r => path.basename(r));
            metadata.proximo_intento_ms = Date.now() + (INTERVALOS_REINTENTO_MIN[0] * 60000);
            await fs.writeFile(path.join(carpetaJob, 'metadata.json'), JSON.stringify(metadata, null, 2));
            console.log(`📦 Fallo gestionado. Persistido en cola: ${metadata.jobId}`);
        }
    } finally {
        procesandoLoteActualmente = false; // Liberamos el cerrojo
        if (colaDeArchivosActual.size > 0 && !temporizadorDeBatching) {
            temporizadorDeBatching = setTimeout(encolarNuevoLote, TIEMPO_ESPERA_AGRUPACION_MS);
        }
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

            console.log(`\n🔄 [Daemon] Despertando proceso: ${metadata.jobId}...`);
            const rutasAbsolutas = metadata.archivos.map(n => path.join(rutaJob, n));
            
            const resultado = await procesarTrabajo(rutasAbsolutas, metadata);
            
            if (resultado === true) {
                await fs.rm(rutaJob, { recursive: true, force: true });
                console.log(`   ✨ [Daemon] Trabajo resuelto. Cola liberada.`);
            } else {
                resultado.intentos += 1;
                if (resultado.intentos >= INTERVALOS_REINTENTO_MIN.length) {
                    console.log(`   🚨 [Daemon] Agotados intentos. Moviendo a Cuarentena.`);
                    await fs.rename(rutaJob, path.join(CUARENTENA, resultado.jobId));
                } else {
                    const minEspera = INTERVALOS_REINTENTO_MIN[resultado.intentos];
                    resultado.proximo_intento_ms = Date.now() + (minEspera * 60000);
                    await fs.writeFile(rutaMetadata, JSON.stringify(resultado, null, 2));
                    console.log(`   ⏳ [Daemon] Postergado por ${minEspera} min.`);
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
    console.log(`👁️  SISTEMA ACTIVO CON CONTROL DE CONCURRENCIA`);
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