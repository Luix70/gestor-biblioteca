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
 *   FASE B — RECICLA a la Papelera las carpetas de NÚMERO DE REVISTA que quedaron mal colocadas bajo
 *            obras/<cabecera>/vol-x (regresión de enrutado) y elimina esos registros-artefacto.
 *
 * IMPORTANTE — FASE B SOLO toca documentos cuyo `obra` es una CABECERA de revista (tipo:'revista').
 * Así NO toca los LIBROS MULTIVOLUMEN legítimos que viven en obras/<obra>/vol-N aunque estén mal
 * etiquetados como revista (su `obra` es una obra de libro normal, no una cabecera) — esos son cosa
 * de la Fix B (reclasificar revista→libro), aparte. Defensa extra: solo números sin volumen_numero.
 *
 * Lo que NO hace: no toca las revistas bien colocadas (en revistas/...), ni reclasifica los libros mal
 * clasificados (Fix B), ni puede recuperar los ~10 ficheros ya borrados (el usuario tiene backup).
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

async function main() {
    console.log(`🛠  Reparación de revistas — ${EJECUTAR ? '⚠ EJECUTAR (recicla-solo, reversible)' : 'DRY-RUN (no cambia nada)'}`);
    console.log(`    Árbol CDU: ${DIR_CDU}  ·  Papelera: ${process.env.PATH_RECICLAJE || 'Recycling'}`);
    const db = await conectarDB();
    const obras = db.collection('obras'), bib = db.collection('biblioteca');

    // ── Capturar TODO antes de mutar ──────────────────────────────────────────
    const cabeceras = await obras.find({ tipo: 'revista' }, { projection: { _id: 1 } }).toArray();
    const cabIds = cabeceras.map(c => c._id);
    let miembros = 0;
    for (const id of cabIds) miembros += await bib.countDocuments({ obra: id });

    // Números de revista mal colocados en obras/: SOLO los que cuelgan de una CABECERA (obra ∈ cabIds)
    // y sin volumen_numero (vol-x). Los libros multivolumen en obras/<obra>/vol-N quedan FUERA.
    const strays = cabIds.length
        ? await bib.find({ tipo_recurso: 'revista', ruta_base: { $regex: '/obras/' }, obra: { $in: cabIds }, volumen_numero: null }).toArray()
        : [];
    // Para informar: revistas-en-obras que NO se tocan por apuntar a una obra de LIBRO (no cabecera).
    const enObrasTotal = await bib.countDocuments({ tipo_recurso: 'revista', ruta_base: { $regex: '/obras/' } });

    // ── FASE A ────────────────────────────────────────────────────────────────
    console.log(`\n══ FASE A — revertir cabeceras de revista ══`);
    console.log(`  Cabeceras (obras tipo:'revista') ${EJECUTAR ? 'borradas' : 'a borrar'}: ${cabIds.length}`);
    console.log(`  Documentos ${EJECUTAR ? 'desvinculados' : 'a desvincular'} (quitar obra/clave_numero): ${miembros}`);

    // ── FASE B ────────────────────────────────────────────────────────────────
    console.log(`\n══ FASE B — reciclar NÚMEROS de revista mal colocados en obras/ ══  ${strays.length} registro(s)`);
    if (!EJECUTAR) for (const doc of strays) console.log(`  [dry-run] reciclar carpeta + borrar registro · ${doc.ruta_base}/${doc.nombre_archivo || ''}`);
    const omitidosLibro = enObrasTotal - strays.length;
    if (omitidosLibro > 0) console.log(`  (se DEJAN ${omitidosLibro} registro(s) revista-en-obras que apuntan a una obra de LIBRO — son libros mal clasificados, Fix B)`);

    // ── Aplicar ───────────────────────────────────────────────────────────────
    if (EJECUTAR) {
        for (const id of cabIds) {
            await bib.updateMany({ obra: id }, { $unset: { obra: '', clave_numero: '' } });
            await obras.deleteOne({ _id: id });
        }
        let recicladas = 0, borrados = 0, ghosts = 0;
        const vistas = new Set();
        for (const doc of strays) {
            const folder = carpetaDeRutaBase(doc.ruta_base);
            if (folder && await existe(folder)) {
                if (!vistas.has(folder)) { if (await reciclarCarpeta(folder, 'reparar-revistas')) recicladas++; vistas.add(folder); }
            } else ghosts++;
            await bib.deleteOne({ _id: doc._id });
            borrados++;
        }
        console.log(`  Registros eliminados: ${borrados} · carpetas recicladas: ${recicladas} · ghosts (sin carpeta): ${ghosts}`);
    }

    const restoObras = await obras.countDocuments({ tipo: 'revista' });
    console.log(`\n── Estado final ──  obras tipo:'revista' restantes: ${restoObras}${EJECUTAR ? '' : ' (serán 0 tras --ejecutar)'}`);
    if (!EJECUTAR) console.log('\n(esto fue un DRY-RUN; añade --ejecutar para aplicar)');
    process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
