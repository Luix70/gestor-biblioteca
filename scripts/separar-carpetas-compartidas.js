/**
 * SEPARAR CARPETAS COMPARTIDAS — «1 documento ↔ 1 carpeta».
 *
 * Por qué: varios documentos apuntaban a la MISMA carpeta. Casi siempre el mismo libro en dos ficheros (epub r1.2
 * y r1.3), a veces libros distintos con el mismo ISBN. Pasaba sobre todo por un fallo ya corregido de
 * `reubicarPorCdu`: al cambiar la CDU con la carpeta destino ocupada, apuntaba el documento a la carpeta del OTRO.
 * Consecuencias: un solo `registro.json` por carpeta (la copia en disco de un documento PISA la del otro: si hubiera
 * que reconstruir la base desde los sidecars, se perdería uno), una sola `portada-1.jpg` (uno enseña la del otro)
 * y, a menudo, el documento apunta a una carpeta donde NI SIQUIERA está su fichero.
 *
 * Qué hace, carpeta por carpeta (los miembros de colecciones de árbol fijo comparten carpeta A PROPÓSITO: no se tocan):
 *   · Se queda en la carpeta su DUEÑO: el del registro.json, o si no el que tiene su fichero allí, o el más antiguo.
 *   · Cada uno de los demás pasa a SU carpeta (la misma ruta con el sufijo de su _id, como hace la ingesta):
 *       1. si su fichero está en la carpeta compartida → se MUEVE (copia verificada por tamaño, luego se borra el
 *          original de la compartida);
 *       2. si está en otra carpeta del árbol (una con su registro.json, o por nombre) — medido: los 75 casos, en
 *          su carpeta ANTIGUA (casi siempre 0/000/000/libros/<isbn>, de antes de clasificarse) — esa carpeta se
 *          MUEVE ENTERA a su sitio correcto (su CDU + sufijo), con su propia portada; si otro documento la usara,
 *          solo se copia su fichero;
 *       3. si está en la Papelera / Cuarentena → se COPIA de vuelta a su carpeta (lo de la Papelera no se toca);
 *       4. si no está en ninguna parte → no se borra nada: el documento pasa a su carpeta con su ficha en disco y
 *          queda marcado para revisar («fichero original no encontrado»).
 *     Su portada: la de la carpeta compartida se COPIA (es la única que hay); si los títulos difieren, se marca para
 *     re-extraerla de su propio fichero.
 *   · Se regeneran los sidecars (registro.json + MARC) de TODOS, cada uno en su carpeta.
 *
 * Solo en el NAS. Una pasada por el árbol (CDU, Papelera, Cuarentena) para localizar los ficheros.
 *   sudo docker exec -t gestor-biblioteca node scripts/separar-carpetas-compartidas.js              (DRY-RUN)
 *   sudo docker exec -t gestor-biblioteca node scripts/separar-carpetas-compartidas.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { conectarDB } from '../src/database.js';
import { DIR_CDU, carpetaDeDoc, moverCarpetaConVerificacion } from '../src/mantenimiento/util-mantenimiento.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const RAIZ_APP = path.resolve(DIR_CDU, '..');
const OTRAS_RAICES = ['Papelera', 'Cuarentena', 'Reintentos'].map((d) => path.join(RAIZ_APP, d));

const db = await conectarDB();
const col = db.collection('biblioteca');
const existe = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
const webAAbs = (web) => path.join(DIR_CDU, ...String(web).replace(/^\/recursos\//, '').split('/'));
const absAWeb = (abs) => '/recursos/' + path.relative(DIR_CDU, abs).split(path.sep).join('/');
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '').slice(0, 30);

// ── 1. Carpetas compartidas (sin las de colecciones de árbol fijo) ─────────────────────────────────────────
const todos = await col.find({ ruta_base: { $exists: true } }, {
    projection: { ruta_base: 1, titulo: 1, nombre_archivo: 1, portada: 1, imagenes: 1, fecha_ingreso: 1, ruta_fija: 1, coleccion: 1, naturaleza: 1 },
}).toArray();
const porRuta = new Map();
for (const d of todos) porRuta.set(d.ruta_base, [...(porRuta.get(d.ruta_base) || []), d]);
const deColeccion = (d) => d.ruta_fija && (d.coleccion || d.naturaleza === 'audiolibro' || d.naturaleza === 'software');
const compartidas = [...porRuta.entries()].filter(([, ds]) => ds.length > 1 && !ds.some(deColeccion));
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · ${compartidas.length} carpeta(s) compartida(s) · ${compartidas.reduce((s, [, ds]) => s + ds.length, 0)} documento(s)\n`);
if (!compartidas.length) process.exit(0);

// ── 2. Localizar ficheros: una pasada por el árbol ─────────────────────────────────────────────────────────
// Solo interesan los nombres de fichero de estos documentos y las carpetas cuyo nombre empieza como la hoja de
// alguna carpeta compartida (ahí puede estar la carpeta propia con sufijo, con su registro.json).
const buscados = new Set(compartidas.flatMap(([, ds]) => ds.map((d) => d.nombre_archivo).filter(Boolean)));
const hojas = new Set(compartidas.map(([r]) => path.posix.basename(r)));
const porNombre = new Map();      // nombre de fichero → [rutas absolutas]
const porRegistro = new Map();    // _id del registro.json → carpeta absoluta
let vistas = 0;
async function recorrer(dir) {
    let ents;
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    if (++vistas % 5000 === 0) process.stdout.write(`\r   …${vistas} carpetas recorridas`);
    const base = path.basename(dir);
    if ([...hojas].some((h) => base.startsWith(h)) && ents.some((e) => e.isFile() && e.name === 'registro.json')) {
        try { const id = JSON.parse(await fs.readFile(path.join(dir, 'registro.json'), 'utf8'))._id; if (id) porRegistro.set(String(id), dir); } catch { /* ilegible */ }
    }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) await recorrer(p);
        else if (buscados.has(e.name)) porNombre.set(e.name, [...(porNombre.get(e.name) || []), p]);
    }
}
process.stdout.write('   Localizando ficheros en el NAS…');
for (const r of [DIR_CDU, ...OTRAS_RAICES]) await recorrer(r);
process.stdout.write(`\r   ${vistas} carpetas recorridas.                    \n\n`);

// Copia verificada por tamaño (y, si se pide, borra el original tras verificar).
async function copiarVerificado(origen, destino, { mover = false } = {}) {
    await fs.mkdir(path.dirname(destino), { recursive: true });
    await fs.copyFile(origen, destino);
    const [a, b] = await Promise.all([fs.stat(origen), fs.stat(destino)]);
    if (a.size !== b.size) throw new Error(`copia incompleta de ${path.basename(origen)}`);
    if (mover) await fs.unlink(origen);
}

const cuenta = { movidos: 0, reapuntados: 0, recuperados: 0, sinFichero: 0, fallos: 0 };
let i = 0;
for (const [ruta, ds] of compartidas) {
    i++;
    const carpeta = webAAbs(ruta);
    let regId = null;
    try { regId = JSON.parse(await fs.readFile(path.join(carpeta, 'registro.json'), 'utf8'))._id || null; } catch { /* */ }
    const presentes = [];
    for (const d of ds) if (d.nombre_archivo && await existe(path.join(carpeta, d.nombre_archivo))) presentes.push(d);
    const porAntiguedad = [...ds].sort((a, b) => (a.fecha_ingreso || 0) - (b.fecha_ingreso || 0));
    const dueno = ds.find((d) => String(d._id) === String(regId) && presentes.includes(d)) || presentes[0] || porAntiguedad[0];
    console.log(`[${i}/${compartidas.length}] ${ruta}\n   se queda: «${String(dueno.titulo).slice(0, 45)}» (${dueno.nombre_archivo || '—'})`);

    for (const d of ds) {
        if (d === dueno) continue;
        const hoja = path.basename(carpeta);
        const propia = path.join(path.dirname(carpeta), `${hoja}-${String(d._id).slice(-6)}`);
        const enCompartida = presentes.includes(d);
        // Su carpeta por registro.json, salvo que sea la propia compartida (entonces no es «otra» carpeta suya).
        const carpetaReg0 = porRegistro.get(String(d._id));
        const carpetaReg = carpetaReg0 && carpetaReg0 !== carpeta ? carpetaReg0 : null;
        const enArbol = (porNombre.get(d.nombre_archivo) || []).filter((p) => p.startsWith(DIR_CDU) && path.dirname(p) !== carpeta);
        const enOtras = (porNombre.get(d.nombre_archivo) || []).filter((p) => !p.startsWith(DIR_CDU));
        const otroTitulo = norm(d.titulo) !== norm(dueno.titulo);

        let accion, destino;
        if (enCompartida) { accion = 'mover su fichero a su carpeta'; destino = propia; }
        // Su carpeta antigua (donde está su fichero): ¿la usa algún otro documento? Si no, se mueve entera a su sitio.
        // La que CONTIENE su fichero manda; la de su registro.json, solo si el fichero no aparece por nombre.
        const vieja = (enArbol.length ? path.dirname(enArbol[0]) : null) || carpetaReg;
        const viejaEnUso = vieja ? (porRuta.get(absAWeb(vieja)) || []).length > 0 : false;
        if (vieja) { accion = viejaEnUso ? `copiar su fichero desde ${absAWeb(vieja)} (esa carpeta la usa otro)` : `mover su carpeta ${absAWeb(vieja)} a su sitio`; destino = propia; }
        else if (enOtras.length) { accion = `recuperar su fichero de ${path.relative(RAIZ_APP, enOtras[0])}`; destino = propia; }
        else { accion = 'FICHERO NO ENCONTRADO en el NAS → carpeta propia con su ficha, marcado para revisar'; destino = propia; }
        console.log(`   · «${String(d.titulo).slice(0, 45)}» (${d.nombre_archivo || '—'})\n       → ${accion}: ${absAWeb(destino)}`);
        if (!EJECUTAR) continue;

        try {
            const alertas = [];
            if (enCompartida) await copiarVerificado(path.join(carpeta, d.nombre_archivo), path.join(destino, d.nombre_archivo), { mover: true });
            else if (vieja && !viejaEnUso && !(await existe(destino))) {
                // La carpeta antigua es SOLO suya: entera (fichero, su portada, sus imágenes, material) a su sitio.
                const suyos = [d.nombre_archivo, d.portada && path.posix.basename(d.portada), ...(d.imagenes || []).map((im) => path.posix.basename(im.ruta))].filter(Boolean);
                await moverCarpetaConVerificacion(vieja, destino, suyos);
            } else if (vieja) await copiarVerificado(path.join(vieja, d.nombre_archivo), path.join(destino, d.nombre_archivo));
            else if (enOtras.length) await copiarVerificado(enOtras[0], path.join(destino, d.nombre_archivo));
            await fs.mkdir(destino, { recursive: true });

            // Portada: la de su carpeta de destino si ya tiene una; si no, copia de la compartida (la única que hay).
            const set = { ruta_base: absAWeb(destino), fecha_actualizacion: new Date() };
            const nombrePortada = d.portada ? path.posix.basename(d.portada) : null;
            if (nombrePortada) {
                const enDestino = path.join(destino, nombrePortada);
                if (!(await existe(enDestino)) && await existe(path.join(carpeta, nombrePortada))) await copiarVerificado(path.join(carpeta, nombrePortada), enDestino);
                set.portada = `${set.ruta_base}/${nombrePortada}`;
            }
            if (Array.isArray(d.imagenes) && d.imagenes.length) {
                const imagenes = [];
                for (const im of d.imagenes) {
                    const n = path.posix.basename(im.ruta);
                    const enDestino = path.join(destino, n);
                    if (!(await existe(enDestino)) && await existe(path.join(carpeta, n))) await copiarVerificado(path.join(carpeta, n), enDestino).catch(() => {});
                    if (await existe(enDestino)) imagenes.push({ ...im, ruta: `${set.ruta_base}/${n}` });
                }
                set.imagenes = imagenes;
            }
            if (otroTitulo) { set.revision_requerida = true; alertas.push('Portada heredada de una carpeta compartida con OTRO libro: re-extráela de su fichero («Re-extraer imágenes»).'); }
            if (enCompartida) { cuenta.movidos++; alertas.push(`Carpeta separada: compartía «${ruta}» con otro documento; ahora tiene la suya.`); }
            else if (vieja) { cuenta.reapuntados++; alertas.push(`Apuntaba a la carpeta de otro documento (${ruta}) y sus ficheros se habían quedado en ${absAWeb(vieja)}: ${viejaEnUso ? 'copiado su fichero' : 'movida su carpeta'} a su sitio.`); }
            else if (enOtras.length) { cuenta.recuperados++; alertas.push(`Fichero recuperado de ${path.relative(RAIZ_APP, enOtras[0])} (copia; el original sigue allí).`); }
            else { cuenta.sinFichero++; set.revision_requerida = true; set.fichero_perdido = true; alertas.push(`Fichero original «${d.nombre_archivo}» NO encontrado en el NAS (CDU, Papelera, Cuarentena): el documento apuntaba a la carpeta de otro (${ruta}). Se conserva la ficha; recupera el fichero o elimina el documento si es un duplicado.`); }

            await col.updateOne({ _id: d._id }, { $set: set, $push: { alertas_agente: { $each: alertas } } });
            const actualizado = await col.findOne({ _id: d._id });
            await regenerarSidecarsDoc(db, actualizado, carpetaDeDoc(actualizado)).catch(() => {});
            await indexarDoc(db, d._id).catch(() => {});
        } catch (e) {
            cuenta.fallos++;
            console.log(`       ⛔ ${e.message}`);
        }
    }
    // El dueño: su registro.json vuelve a ser SUYO (podía ser el del otro).
    if (EJECUTAR) {
        const actualizado = await col.findOne({ _id: dueno._id });
        if (actualizado) await regenerarSidecarsDoc(db, { ...actualizado, fecha_actualizacion: new Date() }, carpeta).catch(() => {});
    }
}
console.log(EJECUTAR
    ? `\nSeparados (fichero movido): ${cuenta.movidos} · devueltos a su sitio desde su carpeta antigua: ${cuenta.reapuntados} · recuperados de Papelera/Cuarentena: ${cuenta.recuperados} · sin fichero (marcados): ${cuenta.sinFichero} · fallos: ${cuenta.fallos}\n`
    : '\nDRY-RUN: no se ha tocado nada. Repite con --ejecutar.\n');
process.exit(cuenta.fallos ? 1 : 0);
