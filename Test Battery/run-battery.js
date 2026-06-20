import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { ingestarRecurso } from '../src/servicio-ingesta.js';
import { filtrarDuplicadosNombre } from '../src/utils/agrupador.js';
import { ErrorInfraestructura, ErrorIdentificacion } from '../src/errores.js';
import { enviarACuarentena, enviarAReintentos } from '../src/gestor-fallos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Enruta un fallo a Cuarentena (identificación) o Reintentos (infraestructura). */
async function manejarFallo(error, rutas, caso, item) {
    if (error instanceof ErrorInfraestructura) {
        const destino = await enviarAReintentos(rutas, {
            error: { tipo: error.tipo, mensaje: error.message },
            documento: error.documentoParcial || null,
            fase: error.documentoParcial ? 'persistencia' : 'enriquecimiento',
        });
        console.error(`    🔁 Infraestructura caída → Reintentos: ${destino}`);
        return { caso, item, ok: false, ruta: 'reintentos', error: error.message };
    }
    if (error instanceof ErrorIdentificacion) {
        const destino = await enviarACuarentena(rutas, {
            error: { tipo: error.tipo, mensaje: error.message },
            fase: 'extraccion',
        });
        console.error(`    🚫 Identificación imposible → Cuarentena: ${destino}`);
        return { caso, item, ok: false, ruta: 'cuarentena', error: error.message };
    }
    console.error(`    ❌ FALLO: ${error.message}`);
    return { caso, item, ok: false, error: error.message };
}

// Ubicación de prueba para libros físicos (en producción llega en el POST).
const UBICACION_FISICA = { ambito: 'Salón', estanteria: 'Estante A' };

const CASOS = [
    { id: 1,  dir: '1.Single Epub',                 modo: 'archivo' },
    { id: 2,  dir: '2.Single.Epub',                 modo: 'archivo' },
    { id: 3,  dir: '3.BatchOf10Epubs',              modo: 'archivo' },
    { id: 4,  dir: '4.ModernPDF',                   modo: 'archivo' },
    { id: 5,  dir: '5.ModernPDF.W.Images',          modo: 'archivo' },
    { id: 6,  dir: '6.OldPDF',                      modo: 'archivo' },
    { id: 7,  dir: '7.GroupOf10PDFS',               modo: 'archivo' },
    { id: 8,  dir: '8.SingleImageBook',             modo: 'imagenes-individual', ubicacion: UBICACION_FISICA },
    { id: 9,  dir: '9.A group of images',           modo: 'imagenes-grupo',      ubicacion: UBICACION_FISICA },
    { id: 10, dir: '10. A Group of Images with ISBN', modo: 'imagenes-grupo',    ubicacion: UBICACION_FISICA },
    { id: 11, dir: '11.Scanned Magazine',           modo: 'imagenes-grupo',      ubicacion: UBICACION_FISICA },
    { id: 12, dir: '12.PDF Magazine',               modo: 'archivo' },
    { id: 20, dir: '20. Magazines as books',        modo: 'revistas' },
];

const EXT_SOPORTADAS = ['.epub', '.pdf'];
const EXT_IMAGEN = ['.jpg', '.jpeg', '.png', '.webp', '.heic'];

function sanitizar(nombre) {
    return (nombre || 'sin-titulo').replace(/[<>:"/\\|?*'\n\r]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80);
}

async function listar(dir, exts) {
    const entradas = await fs.readdir(dir, { withFileTypes: true });
    return entradas
        .filter(e => e.isFile() && exts.includes(path.extname(e.name).toLowerCase()))
        .map(e => path.join(dir, e.name));
}

/** Procesa un recurso vía el servicio de ingesta (orquesta→cataloga→copia a CDU) y guarda un JSON. */
async function procesarUnidad(rutas, contexto, carpetaCaso) {
    const r = await ingestarRecurso({ rutas, contexto });

    const idLegible = sanitizar(r.isbn || r.issn || r.documento.titulo);
    const carpetaResultado = path.join(carpetaCaso, '_resultado');
    await fs.mkdir(carpetaResultado, { recursive: true });
    await fs.writeFile(
        path.join(carpetaResultado, `${idLegible}.json`),
        JSON.stringify(r.documento, null, 2), 'utf8'
    );

    return { titulo: r.documento.titulo, isbn: r.isbn, _id: String(r._id), operacion: r.operacion, estado: r.estado };
}

async function ejecutar() {
    const filtro = process.argv[2] ? process.argv[2].split(',').map(Number) : null;
    const casos = filtro ? CASOS.filter(c => filtro.includes(c.id)) : CASOS;

    const informe = [];

    for (const caso of casos) {
        const carpetaCaso = path.join(__dirname, caso.dir);
        console.log(`\n══════════════════════════════════════════`);
        console.log(`📁 CASO ${caso.id}: ${caso.dir}  [${caso.modo}]`);
        console.log(`══════════════════════════════════════════`);

        try {
            if (caso.modo === 'archivo' || caso.modo === 'imagenes-individual') {
                const exts = caso.modo === 'archivo' ? EXT_SOPORTADAS : EXT_IMAGEN;
                const ficheros = await listar(carpetaCaso, exts);
                // Procesado SERIALIZADO con manejo de error por ítem.
                for (const f of ficheros) {
                    const nombre = path.basename(f);
                    try {
                        console.log(`\n  ▶ ${nombre}`);
                        const r = await procesarUnidad([f], { ubicacion: caso.ubicacion }, carpetaCaso);
                        console.log(`    ✅ ${r.operacion} · id=${r._id} · isbn=${r.isbn} · estado=${r.estado}`);
                        informe.push({ caso: caso.id, item: nombre, ...r, ok: true });
                    } catch (e) {
                        informe.push(await manejarFallo(e, [f], caso.id, nombre));
                    }
                }
            } else if (caso.modo === 'revistas') {
                // Cada PDF = un número de revista independiente; filtramos duplicados de nombre
                // ("X (1).pdf" cuando "X.pdf" existe → mismo archivo, nombre distinto por el SO).
                const ficheros = filtrarDuplicadosNombre(await listar(carpetaCaso, EXT_SOPORTADAS));
                console.log(`  ${ficheros.length} número(s) únicos (tras filtrar duplicados de nombre)`);
                for (const f of ficheros) {
                    const nombre = path.basename(f);
                    try {
                        console.log(`\n  ▶ ${nombre}`);
                        const r = await procesarUnidad([f], { ubicacion: caso.ubicacion }, carpetaCaso);
                        console.log(`    ✅ ${r.operacion} · id=${r._id} · issn=${r.documento?.issn || '-'} · año=${r.documento?.año_edicion || '-'} · mes=${r.documento?.mes_publicacion || '-'} · estado=${r.estado}`);
                        informe.push({ caso: caso.id, item: nombre, ...r, ok: true });
                    } catch (e) {
                        informe.push(await manejarFallo(e, [f], caso.id, nombre));
                    }
                }
            } else if (caso.modo === 'imagenes-grupo') {
                // Todas las imágenes de la carpeta = UN solo libro.
                const imagenes = await listar(carpetaCaso, EXT_IMAGEN);
                const nombre = `${imagenes.length} imágenes`;
                try {
                    console.log(`\n  ▶ Grupo de ${imagenes.length} imágenes (un único libro)`);
                    const r = await procesarUnidad(imagenes, { ubicacion: caso.ubicacion }, carpetaCaso);
                    console.log(`    ✅ ${r.operacion} · id=${r._id} · isbn=${r.isbn} · estado=${r.estado}`);
                    informe.push({ caso: caso.id, item: nombre, ...r, ok: true });
                } catch (e) {
                    informe.push(await manejarFallo(e, imagenes, caso.id, nombre));
                }
            }
        } catch (e) {
            console.error(`  ❌ No se pudo leer la carpeta del caso: ${e.message}`);
            informe.push({ caso: caso.id, item: '(carpeta)', ok: false, error: e.message });
        }
    }

    console.log(`\n\n📊 RESUMEN`);
    console.log(`══════════════════════════════════════════`);
    const ok = informe.filter(r => r.ok).length;
    console.log(`Total: ${informe.length} · OK: ${ok} · Fallos: ${informe.length - ok}`);
    for (const r of informe) {
        console.log(`  ${r.ok ? '✅' : '❌'} [caso ${r.caso}] ${r.item}` + (r.ok ? ` → ${r.operacion} (${r.estado})` : ` → ${r.error}`));
    }
    process.exit(0);
}

ejecutar().catch(e => { console.error("ERROR FATAL:", e); process.exit(1); });
