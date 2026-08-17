#!/usr/bin/env node
/**
 * limpiar-titulos.js — Corrige la PUNTUACIÓN ISBD que arrastran muchos títulos del volcado BNE (MARC 245):
 *
 *   · «::»  → delimitador TÍTULO :: SUBTÍTULO. Se divide: lo de antes es el título; lo de después pasa al
 *             SUBTÍTULO, pero SOLO si el documento no tenía ya uno (no se pisa un subtítulo existente).
 *   · «:» FINAL (uno o varios) → dos-puntos colgante ISBD: se quita del título (y del subtítulo).
 *
 * NO toca un «:» interior legítimo («Sapiens: de animales a dioses»). Es la MISMA limpieza que ahora aplica la
 * ingesta al leer del Fichero (src/utils/titulos.js · normalizarTituloBibliografico) — este script la propaga a
 * los documentos YA catalogados. Escribe con editarDocumento (mantiene sidecars + índice de búsqueda).
 *
 * DRY-RUN por defecto (no toca nada). --ejecutar aplica. --limite N para probar sobre una muestra.
 * Ejecutable desde el PANEL (Mantenimiento → «Ejecutar script»).
 *
 *   node scripts/limpiar-titulos.js [--limite N]      (vista previa)
 *   node scripts/limpiar-titulos.js --ejecutar        (aplica; COPIA DE SEGURIDAD antes)
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { editarDocumento } from '../src/utils/editar-doc.js';
import { normalizarTituloBibliografico } from '../src/utils/titulos.js';

const arg = (n) => process.argv.includes(n);
const EJECUTAR = arg('--ejecutar');
const LIMITE = (() => { const i = process.argv.indexOf('--limite'); return i >= 0 ? Number(process.argv[i + 1]) : 0; })();
const MUESTRA = 20;

const db = await conectarDB();
const bib = db.collection('biblioteca');

// Candidatos: título con «::» (en cualquier posición) O con «:» colgante al final (con espacios opcionales).
const FILTRO = { titulo: { $regex: '(::)|(:\\s*$)' } };

const total = await bib.countDocuments(FILTRO);
console.log(`\nLimpiar títulos (puntuación ISBD del Fichero) — ${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'} · candidatos: ${total}${LIMITE ? ` (ojeando ${LIMITE})` : ''}\n`);

const cur = bib.find(FILTRO, { projection: { titulo: 1, subtitulo: 1 } });
const t0 = Date.now();
let n = 0, cambT = 0, subNuevo = 0, aplicados = 0, sinCambio = 0;
const ej = [];
for await (const doc of cur) {
    if (LIMITE && n >= LIMITE) break;
    n++;
    if (n % 500 === 0) {
        const seg = (Date.now() - t0) / 1000, vel = n / (seg || 1), eta = Math.round(((LIMITE || total) - n) / (vel || 1));
        process.stdout.write(`  … ${n}/${LIMITE || total} · ${vel.toFixed(0)}/s · ETA ${eta}s   \r`);
    }
    const { titulo: nt, subtitulo: ns } = normalizarTituloBibliografico(doc.titulo, doc.subtitulo);
    const cambios = {};
    if (nt && nt !== doc.titulo) cambios.titulo = nt;
    // Subtítulo: solo cuando hay uno NUEVO no vacío que difiere (del «::» o al pulir el existente); nunca se
    // BORRA un subtítulo (ns falso → no se toca).
    if (ns && ns !== (doc.subtitulo || null)) { cambios.subtitulo = ns; if (!doc.subtitulo) subNuevo++; }
    if (!Object.keys(cambios).length) { sinCambio++; continue; }
    if (cambios.titulo) cambT++;
    if (ej.length < MUESTRA) ej.push(`  «${String(doc.titulo).slice(0, 56)}» → «${String(cambios.titulo || doc.titulo).slice(0, 56)}»${cambios.subtitulo ? `  ⟨sub: ${String(cambios.subtitulo).slice(0, 40)}⟩` : ''}`);
    if (EJECUTAR) { try { const r = await editarDocumento(db, String(doc._id), cambios); if (r && r.ok) aplicados++; } catch { /* omitir este doc */ } }
}

console.log(`\n${'─'.repeat(64)}`);
console.log(`Revisados: ${n} · títulos a limpiar: ${cambT} · subtítulos nuevos (del «::»): ${subNuevo} · sin cambio: ${sinCambio}`);
if (ej.length) { console.log(`\nMuestra:`); ej.forEach((l) => console.log(l)); }
if (EJECUTAR) console.log(`\nAPLICADOS: ${aplicados} documento(s).`);
else console.log(`\n▶ Repite con --ejecutar para aplicar (COPIA DE SEGURIDAD antes).`);
process.exit(0);
