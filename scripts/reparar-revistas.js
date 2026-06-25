#!/usr/bin/env node
/**
 * DESHACER el daño de la migración de revistas — vuelve al estado PREVIO. DRY-RUN por defecto.
 *
 * Modelo mental: NINGÚN fichero se destruye. Esta utilidad es RECICLA-SOLO (mueve a la Papelera, de
 * donde todo es recuperable) y revierte en BD lo que la migración añadió. Los números "absorbidos"
 * siguen en revistas/<issn>/<año>/ (donde estaban); por eso borrar los registros-artefacto NO pierde
 * datos: el contenido sigue en disco y la recuperación correcta (Fix C re-hecho) los volverá a catalogar.
 *
 *   FASE A — revierte las CABECERAS: desvincula cada documento de su cabecera (quita obra y
 *            clave_numero) y borra las obras tipo:'revista'. Las revistas vuelven a ser planas.
 *   FASE B — RECICLA a la Papelera las carpetas de revista que quedaron mal colocadas bajo
 *            obras/<cabecera>/vol-x (regresión de enrutado) y elimina esos registros-artefacto.
 *            (El fichero original del número sigue en revistas/...; aquí solo se retira la copia mal
 *            colocada y su registro roto.)
 *
 * Lo que NO hace: no toca las revistas bien colocadas (en revistas/...), ni reclasifica los libros mal
 * clasificados (eso es la Fix B, aparte), ni puede recuperar los ~10 ficheros ya borrados.
 *
 * Uso (en el contenedor del NAS):
 *   docker exec gestor-biblioteca node scripts/reparar-revistas.js              # DRY-RUN (no cambia nada)
 *   docker exec gestor-biblioteca node scripts/reparar-revistas.js --ejecutar   # aplica (recicla-solo)
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { reciclarCarpeta } from '../src/utils/papelera.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const DIR_CDU = resolver(process.env.PATH_CDU, 'CDU');
const EJECUTAR = process.argv.includes('--ejecutar');

const carpetaDeRutaBase = (rb) => rb ? path.join(DIR_CDU, String(rb).replace(/^\/recursos\//, '')) : null;
const existe = async (p) => { try { await fs.access(p); return true; } catch { return false; } };

async function faseA(db) {
    const obras = db.collection('obras'), bib = db.collection('biblioteca');
    const cabeceras = await obras.find({ tipo: 'revista' }).toArray();
    let miembros = 0;
    for (const cab of cabeceras) miembros += await bib.countDocuments({ obra: cab._id });

    console.log(`\n══ FASE A — revertir cabeceras de revista ══`);
    console.log(`  Cabeceras (obras tipo:'revista') ${EJECUTAR ? 'borradas' : 'a borrar'}: ${cabeceras.length}`);
    console.log(`  Documentos ${EJECUTAR ? 'desvinculados' : 'a desvincular'} (quitar obra/clave_numero): ${miembros}`);

    if (EJECUTAR) {
        for (const cab of cabeceras) {
            await bib.updateMany({ obra: cab._id }, { $unset: { obra: '', clave_numero: '' } });
            await obras.deleteOne({ _id: cab._id });
        }
    }
}

async function faseB(db) {
    const bib = db.collection('biblioteca');
    // Revistas con ruta_base bajo /obras/ = artefactos del enrutado erróneo (una revista NUNCA va ahí).
    const strays = await bib.find({ tipo_recurso: 'revista', ruta_base: { $regex: '/obras/' } }).toArray();
    console.log(`\n══ FASE B — reciclar revistas mal colocadas en obras/ ══  ${strays.length} registro(s)`);

    let recicladas = 0, ghosts = 0, borrados = 0;
    const carpetasTratadas = new Set();
    for (const doc of strays) {
        const folder = carpetaDeRutaBase(doc.ruta_base);
        const hayFichero = folder && await existe(folder);
        if (!hayFichero) ghosts++;

        if (!EJECUTAR) {
            console.log(`  [dry-run] ${hayFichero ? 'reciclar carpeta + borrar registro' : 'borrar registro (ghost, sin carpeta)'} · ${doc.ruta_base}/${doc.nombre_archivo || ''}`);
            if (folder) carpetasTratadas.add(folder);
            continue;
        }
        if (hayFichero && !carpetasTratadas.has(folder)) {
            const dest = await reciclarCarpeta(folder, 'reparar-revistas');
            if (dest) recicladas++;
        }
        if (folder) carpetasTratadas.add(folder);
        await bib.deleteOne({ _id: doc._id });
        borrados++;
    }
    console.log(`  Registros ${EJECUTAR ? 'eliminados' : 'a eliminar'}: ${EJECUTAR ? borrados : strays.length}`);
    console.log(`  Carpetas ${EJECUTAR ? 'recicladas a Papelera' : 'distintas a reciclar'}: ${EJECUTAR ? recicladas : carpetasTratadas.size}`);
    console.log(`  Registros sin carpeta en disco (ghosts): ${ghosts}`);
}

async function main() {
    console.log(`🛠  Reparación de revistas — ${EJECUTAR ? '⚠ EJECUTAR (recicla-solo, reversible)' : 'DRY-RUN (no cambia nada)'}`);
    console.log(`    Árbol CDU: ${DIR_CDU}  ·  Papelera: ${process.env.PATH_RECICLAJE || 'Recycling'}`);
    const db = await conectarDB();
    await faseA(db);
    await faseB(db);

    const restoObras = await db.collection('obras').countDocuments({ tipo: 'revista' });
    const restoStray = await db.collection('biblioteca').countDocuments({ tipo_recurso: 'revista', ruta_base: { $regex: '/obras/' } });
    console.log(`\n── Estado final ──  obras tipo:'revista' restantes: ${restoObras}  ·  revistas en obras/: ${restoStray}  ${(!EJECUTAR) ? '(serán 0 tras --ejecutar)' : ''}`);
    if (!EJECUTAR) console.log('\n(esto fue un DRY-RUN; añade --ejecutar para aplicar)');
    process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
