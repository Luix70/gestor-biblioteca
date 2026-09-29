#!/usr/bin/env node
/**
 * REVERTIR UNA EJECUCIÓN DE reidentificar-sin-isbn A PARTIR DE SU LOG — incidente del 29-sep: revistas y títulos
 * genéricos sin autor recibieron el ISBN de libros homónimos, con su editorial, autores, CDU (moviendo la carpeta)
 * y datos. No había copia de la base; el log (logs/scripts/reidentificar-sin-isbn-<fecha>.log) dice, por documento,
 * qué ISBN se le asignó y qué campos se tocaron.
 *
 * Por cada línea «✅ <id> · <título> → isbn=… (autoridad/…) · campo="valor" · …» (SOLO las de «autoridad/…»: las
 * de «fichero» sacaron el ISBN del propio fichero y son buenas):
 *   · quita el ISBN y sus marcas (provisional, dudoso, ediciones candidatas);
 *   · editorial: «X (antes «Y»)» → vuelve Y; si solo «X» (se rellenó un hueco) → se quita;
 *   · autores / contribuciones / cdu_autoridad del log (se rellenaron huecos) → se quitan;
 *   · título cambiado → vuelve el original (el del log, si no salió recortado);
 *   · CDU «A → B (BNE)» → vuelve A, MOVIENDO la carpeta de vuelta;
 *   · los demás huecos rellenados (sinopsis, año, páginas, medidas, Dewey/LCC, idioma original, subtítulo, materias)
 *     no salen en el log: se quitan los que COINCIDEN con lo que aporta ese ISBN equivocado (se vuelve a consultar su
 *     autoridad). Un valor distinto se deja (ya lo tenía el documento).
 * El documento no vuelve a la cola de «Recuperar ISBN»: sigue marcado como revisado (y sin autor, el motor blindado
 * ya no lo identificaría).
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/revertir-reidentificacion.js --log /app/logs/scripts/reidentificar-sin-isbn-20260929-183548.log
 *   … --ejecutar
 *   … --revisar-hoy [AAAA-MM-DD]   además, crea la selección «Revisar ISBN provisional/dudoso <fecha>» con los
 *                                  identificados como provisional/dudoso ese día que NO están en el log (campaña o
 *                                  panel), para revisarlos a mano.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { reubicarPorCdu, carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { buscarMetadatosExternos } from '../src/utils/proveedor-metadatos.js';
import { variantesISBN } from '../src/utils/identificadores.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { crearSeleccion } from '../src/utils/selecciones.js';
import { progreso } from '../src/utils/progreso-cli.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const RUTA_LOG = arg('--log');
const EJECUTAR = args.includes('--ejecutar');
const iRev = args.indexOf('--revisar-hoy');
const REVISAR = iRev >= 0;
const DIA_REVISAR = REVISAR && args[iRev + 1] && /^\d{4}-\d{2}-\d{2}$/.test(args[iRev + 1]) ? args[iRev + 1] : null;
if (!RUTA_LOG) { console.error('Falta --log <ruta del log de reidentificar-sin-isbn>'); process.exit(1); }

// ── 1. Leer el log ────────────────────────────────────────────────────────────────────────────────────
const texto = await fs.readFile(RUTA_LOG, 'utf8');
const entradas = [];
for (const linea of texto.split('\n')) {
    const m = /\[\d+\/\d+\] ✅ ([0-9a-f]{24}) · (.*?) → isbn=(\S+) \(([^)]*)\)(.*)$/.exec(linea);
    if (!m) continue;
    const [, id, tituloLog, isbn, via, resto] = m;
    if (!via.startsWith('autoridad/')) continue;   // «fichero»: el ISBN salió del propio fichero → bueno
    const campos = {};
    for (const c of resto.matchAll(/ · (\w+)="(.*?)"(?= · |$)/g)) campos[c[1]] = c[2];
    const cdu = / · CDU (.+?) → (.+) \(BNE\)\s*$/.exec(resto);
    entradas.push({ id, tituloLog, isbn, via, campos, cduDe: cdu ? cdu[1].trim() : null, cduA: cdu ? cdu[2].trim() : null });
}
console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · ${entradas.length} documento(s) identificados por autoridad en el log\n`);

const db = await conectarDB();
const col = db.collection('biblioteca');
const nfc = (v) => String(v ?? '').normalize('NFC').trim();
const iguales = (a, b) => (Array.isArray(a) || Array.isArray(b)) ? JSON.stringify(a) === JSON.stringify(b) : nfc(a) === nfc(b);

// ── 2. Revertir ───────────────────────────────────────────────────────────────────────────────────────
const st = { revertidos: 0, saltados: 0, carpetas: 0, fallos: 0 };
const p = progreso(entradas.length, EJECUTAR ? 'Revirtiendo' : 'Revisando');
for (const e of entradas) {
    p.paso(e.tituloLog);
    try {
        const doc = await col.findOne({ _id: new ObjectId(e.id) });
        if (!doc) { st.saltados++; p.nota(`   · ${e.id}: ya no existe`); continue; }
        if (doc.isbn !== e.isbn) { st.saltados++; p.nota(`   · ${e.id} «${doc.titulo}»: su ISBN ya no es ${e.isbn} (cambiado después) — no se toca`); continue; }

        const set = {}, unset = { isbn: '', isbn_provisional: '', isbn_dudoso: '', ediciones_candidatas: '', ediciones_candidatas_fecha: '' };
        const hechos = [`isbn ${e.isbn} fuera`];
        // Editorial
        if (e.campos.editorial) {
            const antes = /\(antes «(.+)»\)$/.exec(e.campos.editorial);
            if (antes) {
                const ed = await db.collection('editoriales').findOne({ nombre: antes[1] }, { projection: { _id: 1 } });
                if (ed) { set.editorial = ed._id; hechos.push(`editorial → «${antes[1]}»`); }
                else hechos.push(`⚠ editorial anterior «${antes[1]}» no encontrada: se deja la actual`);
            } else { unset.editorial = ''; hechos.push('editorial fuera'); }
        }
        if (e.campos.autores) { unset.autores = ''; hechos.push('autores fuera'); }
        if (e.campos.contribuciones) { unset.contribuciones = ''; hechos.push('contribuciones fuera'); }
        if (e.campos.cdu_autoridad) { unset.cdu_autoridad = ''; hechos.push('cdu_autoridad fuera'); }
        if (e.campos.titulo) {
            if (e.tituloLog.length < 45) { set.titulo = e.tituloLog; hechos.push(`título → «${e.tituloLog}»`); }
            else hechos.push(`⚠ título original recortado en el log («${e.tituloLog}…»): se deja «${doc.titulo}»`);
        }
        // Huecos que no salen en el log: fuera los que COINCIDEN con lo que aporta ese ISBN equivocado.
        const datos = await buscarMetadatosExternos(doc.titulo, '', null, {
            incluirSinopsis: true, incluirCdu: false, isbnsArchivo: variantesISBN(e.isbn), idioma: doc.idioma || null, sinIA: true,
        }).catch(() => ({}));
        const pares = [['sinopsis', datos.sinopsis], ['año_edicion', datos.año_edicion], ['paginas', datos.paginas_bne ?? datos.paginas],
            ['dimensiones', datos.dimensiones_bne ?? datos.dimensiones], ['dewey', datos.dewey], ['lcc', datos.lcc],
            ['idioma_original', datos.idioma_original], ['subtitulo', datos.subtitulo]];
        for (const [k, v] of pares) {
            if (v != null && v !== '' && doc[k] != null && iguales(doc[k], v)) { unset[k] = ''; hechos.push(`${k} fuera`); }
        }
        if (Array.isArray(datos.categorias) && Array.isArray(doc.palabras_clave)) {
            const quedan = doc.palabras_clave.filter((x) => !datos.categorias.some((c) => nfc(c) === nfc(x)));
            if (quedan.length < doc.palabras_clave.length) {
                if (quedan.length) set.palabras_clave = quedan; else unset.palabras_clave = '';
                hechos.push(`${doc.palabras_clave.length - quedan.length} materia(s) fuera`);
            }
        }
        for (const k of Object.keys(set)) delete unset[k];
        p.nota(`   ${EJECUTAR ? '↩️ ' : '·'} ${e.id} «${String(doc.titulo).slice(0, 40)}»: ${hechos.join(' · ')}${e.cduDe ? ` · CDU ${e.cduA} → ${e.cduDe} (carpeta de vuelta)` : ''}`);
        if (!EJECUTAR) { st.revertidos++; continue; }

        await col.updateOne({ _id: doc._id }, {
            $set: { ...set, fecha_actualizacion: new Date() },
            $unset: unset,
            $push: { alertas_agente: `Revertida la identificación del 29-sep (ISBN ${e.isbn} asignado por error a un documento sin autor: ${hechos.join(', ')}).` },
        });
        // CDU de antes, moviendo la carpeta de vuelta.
        if (e.cduDe && doc.cdu === e.cduA) {
            const actual = await col.findOne({ _id: doc._id });
            const reub = await reubicarPorCdu(actual, e.cduDe).catch(() => null);
            if (reub?.set) {
                await col.updateOne({ _id: doc._id }, { $set: { ...reub.set, cdu: e.cduDe, cdu_fuente: 'clasificador', fecha_actualizacion: new Date() } });
                st.carpetas++;
            }
        }
        const fin = await col.findOne({ _id: doc._id });
        await regenerarSidecarsDoc(db, fin, carpetaDeDoc(fin)).catch(() => {});
        await indexarDoc(db, doc._id).catch(() => {});
        st.revertidos++;
    } catch (err) { st.fallos++; p.nota(`   ⛔ ${e.id}: ${err.message}`); }
}
const tiempo = p.fin();

// ── 3. Los de ese día que NO están en el log (campaña o panel): selección para revisar ──────────────────
if (REVISAR) {
    const dia = DIA_REVISAR || new Date().toISOString().slice(0, 10);
    const ini = new Date(`${dia}T00:00:00`), finDia = new Date(`${dia}T23:59:59`);
    const enLog = new Set(entradas.map((x) => x.id));
    const otros = (await col.find({
        fecha_actualizacion: { $gte: ini, $lte: finDia },
        $or: [{ isbn_provisional: true }, { isbn_dudoso: true }],
    }, { projection: { _id: 1 } }).toArray()).filter((d) => !enLog.has(String(d._id)));
    console.log(`\n${otros.length} documento(s) con ISBN provisional/dudoso del ${dia} que no están en el log (campaña o panel).`);
    if (otros.length && EJECUTAR) {
        await crearSeleccion(db, { nombre: `Revisar ISBN provisional/dudoso ${dia} (${otros.length})`,
            descripcion: 'Identificados como provisional o dudoso con el motor anterior al blindaje (podía aceptar un libro homónimo si el documento no tenía autor). Revisa que el ISBN sea el de este libro.',
            docs: otros.map((d) => d._id) });
        console.log('📋 Selección creada: revísala en el panel.');
    }
}

console.log(`\n=== RESUMEN (${EJECUTAR ? 'APLICADO' : 'dry-run'}) · ${tiempo} ===`);
console.log(`  ${EJECUTAR ? 'revertidos' : 'se revertirían'} : ${st.revertidos}${EJECUTAR ? ` (carpetas devueltas a su CDU: ${st.carpetas})` : ''}`);
if (st.saltados) console.log(`  saltados       : ${st.saltados}`);
if (st.fallos) console.log(`  fallos         : ${st.fallos}`);
if (!EJECUTAR) console.log('\n▶ Repite con --ejecutar para aplicarlo.');
process.exit(0);
