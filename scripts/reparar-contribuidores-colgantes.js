/**
 * REPARAR CONTRIBUIDORES COLGANTES — re-crea los autores que fueron BORRADOS pero que todavía están
 * referenciados como contribuidores (traductor/editor/prologuista/…) o como autor en algún documento. Ocurrió
 * porque la limpieza de autores huérfanos borró a personas cuya ÚNICA referencia estaba, en aquel momento,
 * guardada de forma corrupta (persona como objeto en vez de ObjectId) y por tanto invisible al recuento.
 *
 * El nombre se recupera del `registro.json` del propio documento (que guarda las contribuciones ya resueltas
 * como {nombre, rol}). Se re-crea el autor con SU MISMO _id, así la referencia del documento vuelve a resolver
 * sin tocar los documentos. Si algún nombre no se puede recuperar, se informa para añadirlo a mano.
 *
 * Uso:
 *   node scripts/reparar-contribuidores-colgantes.js            (DRY-RUN)
 *   node scripts/reparar-contribuidores-colgantes.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { DIR_CDU } from '../src/mantenimiento/util-mantenimiento.js';

const EJECUTAR = process.argv.includes('--ejecutar');

const rutaRegistro = (rutaBase) => rutaBase
    ? path.join(DIR_CDU, String(rutaBase).replace(/^\/?recursos\//, '').split('/').join(path.sep), 'registro.json')
    : null;

const db = await conectarDB();
const bib = db.collection('biblioteca');
const aut = db.collection('autores');

console.log(`\n=== Reparar contribuidores colgantes ${EJECUTAR ? '· EJECUCIÓN' : '· SIMULACIÓN'} ===\n`);

const existentes = new Set((await aut.find({}, { projection: { _id: 1 } }).toArray()).map((a) => String(a._id)));
const refAutor = (await bib.distinct('autores')).filter(Boolean).map(String);
const refContrib = (await bib.distinct('contribuciones.persona')).filter(Boolean).map(String);
const colgantes = [...new Set([...refAutor, ...refContrib])].filter((id) => !existentes.has(id));

console.log(`Referencias colgantes (autor inexistente): ${colgantes.length}\n`);
if (!colgantes.length) { console.log('Nada que reparar.'); process.exit(0); }

let recreados = 0, sinNombre = 0;
for (const id of colgantes) {
    const oid = new ObjectId(id);
    // Documentos que lo referencian (como autor o como contribuidor) + el rol.
    const docs = await bib.find({ $or: [{ autores: oid }, { 'contribuciones.persona': oid }] },
        { projection: { titulo: 1, ruta_base: 1, contribuciones: 1, autores: 1 } }).toArray();
    // Rol con el que aparece (para casar el nombre en el registro.json).
    let rol = 'autor';
    for (const d of docs) { const c = (d.contribuciones || []).find((x) => String(x.persona) === id); if (c) { rol = c.rol; break; } }

    // Recuperar el nombre del registro.json de alguno de sus documentos (casando por rol).
    let nombre = null, fuente = null;
    for (const d of docs) {
        const rj = rutaRegistro(d.ruta_base);
        if (!rj) continue;
        let reg; try { reg = JSON.parse(await fs.readFile(rj, 'utf8')); } catch { continue; }
        if (rol === 'autor' && Array.isArray(reg.autores) && reg.autores.length === (d.autores || []).length) {
            // Un solo autor en el doc → directo; si hay varios, no se puede desambiguar por nombre → se salta.
            if ((d.autores || []).length === 1) { nombre = reg.autores[0]; fuente = d.titulo; break; }
        }
        const cs = (reg.contribuciones || []).filter((c) => c.rol === rol);
        // Solo si hay UN contribuidor con ese rol en el doc (si no, ambiguo).
        const nEse = (d.contribuciones || []).filter((c) => c.rol === rol).length;
        if (cs.length === 1 && nEse === 1) { nombre = cs[0].nombre; fuente = d.titulo; break; }
    }

    if (!nombre) {
        sinNombre++;
        console.log(`  ⚠ ${id} · rol ${rol} · en ${docs.length} doc(s) — NO se pudo recuperar el nombre (añádelo a mano: «${(docs[0]?.titulo || '').slice(0, 40)}»)`);
        continue;
    }
    console.log(`  ✔ ${id} · rol ${rol} · «${nombre}» (de «${String(fuente).slice(0, 35)}»)`);
    if (EJECUTAR) {
        await aut.insertOne({ _id: oid, nombre, recreado_desde_registro: new Date() });
        recreados++;
    }
}

console.log(EJECUTAR
    ? `\n✅ ${recreados} autor(es) re-creados${sinNombre ? ` · ${sinNombre} sin nombre (a mano)` : ''}.`
    : `\n(simulación) Se re-crearían ${colgantes.length - sinNombre} autor(es)${sinNombre ? ` · ${sinNombre} sin nombre recuperable` : ''}. Re-ejecuta con --ejecutar.`);
process.exit(0);
