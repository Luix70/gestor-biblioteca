#!/usr/bin/env node
/**
 * cotejar-por-isbn.js — Vista previa (y aplicación manual opcional) de la campaña «cotejo»: para libros CON
 * ISBN, si el título del Fichero local (OL+BNE) DIFIERE del actual y el ISBN se CORROBORA por el nombre de
 * archivo, el título del Fichero PRIMA (escaneos descuidados: título = nombre de serie, artefacto…). SIN IA,
 * offline (solo Fichero). Si difiere pero el ISBN no se corrobora → «a revisar» (posible ISBN equivocado),
 * NO se toca el título.
 *
 * DRY-RUN por defecto (no toca nada): informa cuántos se aplicarían y REPORTA los sospechosos (difieren pero el
 * ISBN no se corrobora → posible ISBN equivocado/compartido), con muestras. `--ejecutar` aplica SOLO el caso
 * corroborado (los sospechosos solo se reportan, no se toca nada). `--limite N` para ojear solo N. Reutiliza la
 * MISMA lógica que la campaña (cotejarPorISBN), así que la vista previa es fiel a lo que hará al reposo.
 *
 *   node scripts/cotejar-por-isbn.js [--limite N]        (vista previa; COPIA DE SEGURIDAD recomendada antes de --ejecutar)
 *   node scripts/cotejar-por-isbn.js --ejecutar          (aplica SOLO el caso corroborado; reporta los sospechosos)
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { cotejarPorISBN } from '../src/mantenimiento/campanas.js';
import { buscarEnFicheroLocal } from '../src/utils/buscador-local.js';
import { resolverCDU } from '../src/clasificador-cdu.js';
import { variantesISBN } from '../src/utils/identificadores.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const CLASIFICACION = process.argv.includes('--clasificacion');
const LIMITE = (() => { const i = process.argv.indexOf('--limite'); return i >= 0 ? Number(process.argv[i + 1]) : 0; })();
const MUESTRA = 15;

const db = await conectarDB();
const bib = db.collection('biblioteca');

// ── Modo INFORME de clasificación (--clasificacion): compara la CDU catalogada con la del Fichero por ISBN.
// Solo lectura (las divergencias son para revisión manual; el relleno de CDU 000 lo hace la campaña 'cotejo-cdu').
if (CLASIFICACION) {
    const normCdu = (c) => String(c || '').trim().replace(/[^0-9.].*$/, '').replace(/\.+$/, '').trim();
    const cduFichero = async (f) => {
        if (!f) return null;
        if (f.cdu) return String(f.cdu).trim();
        if (f.dewey || f.lcc) { try { const r = await resolverCDU({ dewey: f.dewey, lcc: f.lcc, permitirIA: false }); const c = typeof r === 'string' ? r : (r && r.cdu); if (c && c !== '000') return String(c).trim(); } catch { /**/ } }
        return null;
    };
    const filtro = { isbn: { $exists: true, $nin: [null, ''] } };
    const total = await bib.countDocuments(filtro);
    console.log(`\nClasificación por ISBN — INFORME (solo lectura) · libros con ISBN: ${total}${LIMITE ? ` (ojeando ${LIMITE})` : ''}\n`);
    const cur = bib.find(filtro, { projection: { cdu: 1, isbn: 1 } });
    let n = 0, sinFich = 0, aporta = 0, exacto = 0, area = 0, difiere = 0; const ejDif = [];
    for await (const d of cur) {
        if (LIMITE && n >= LIMITE) break;
        n++;
        if (n % 500 === 0) process.stdout.write(`  … ${n}/${LIMITE || total}\r`);
        const f = await buscarEnFicheroLocal({ isbns: variantesISBN(d.isbn) }).catch(() => null);
        const fic = await cduFichero(f);
        if (!fic) { sinFich++; continue; }
        const cat = normCdu(d.cdu);
        if (!cat || d.cdu === '000') { aporta++; continue; }
        if (cat === normCdu(fic)) exacto++;
        else if (cat[0] === normCdu(fic)[0]) area++;
        else { difiere++; if (ejDif.length < MUESTRA) ejDif.push(`  cat ${cat.padEnd(12)} vs fichero ${normCdu(fic).padEnd(12)} (ISBN ${d.isbn})`); }
    }
    console.log(`\nrevisados ${n} · sin dato en Fichero ${sinFich} · Fichero APORTA (CDU 000/vacía) ${aporta}`);
    console.log(`con CDU en ambos → EXACTA ${exacto} · misma ÁREA ${area} · DIFIERE ${difiere}`);
    if (ejDif.length) { console.log(`\nMuestra de DIVERGENCIAS (área distinta — revisión manual):`); ejDif.forEach((l) => console.log(l)); }
    console.log(`\nℹ Rellenar las «${aporta}» sin clasificar: activa la campaña «Clasificación por ISBN» en el panel. Las divergencias NO se tocan (la CDU catalogada suele ser mejor que el crosswalk).`);
    process.exit(0);
}
const filtro = { isbn: { $exists: true, $nin: [null, ''] } };
const total = await bib.countDocuments(filtro);
console.log(`\nCotejar título por ISBN — ${EJECUTAR ? 'EJECUTAR' : 'DRY-RUN'} · libros con ISBN: ${total}${LIMITE ? ` (ojeando ${LIMITE})` : ''}\n`);

const cursor = bib.find(filtro, { projection: { titulo: 1, subtitulo: 1, isbn: 1, nombre_archivo: 1 } });
let revisados = 0, aplicar = 0, revisar = 0, aplicados = 0;
const ejAplicar = [], ejRevisar = [];
for await (const doc of cursor) {
    if (LIMITE && revisados >= LIMITE) break;
    revisados++;
    if (revisados % 500 === 0) process.stdout.write(`  … ${revisados}/${LIMITE || total}\r`);
    let r;
    try { r = await cotejarPorISBN(doc); } catch { continue; }
    if (!r) continue;
    if (r.accion === 'aplicar') {
        aplicar++;
        if (ejAplicar.length < MUESTRA) ejAplicar.push(`  «${String(doc.titulo).slice(0, 32)}» → «${r.titulo.slice(0, 50)}»`);
        if (EJECUTAR) {
            const set = { titulo: r.titulo, fecha_actualizacion: new Date() };
            if (r.subtitulo && !doc.subtitulo) set.subtitulo = r.subtitulo;
            await bib.updateOne({ _id: doc._id }, {
                $set: set, $unset: { cotejo_revisar: '' },
                $push: { alertas_agente: `Título sustituido por el del Fichero por ISBN (corroborado): "${r.titulo.slice(0, 45)}" (cotejar-por-isbn CLI, sin IA).` },
            });
            aplicados++;
        }
    } else { // 'revisar' — solo se REPORTA (posible ISBN equivocado/compartido); nunca se toca ni se marca.
        revisar++;
        if (ejRevisar.length < MUESTRA) ejRevisar.push(`  «${String(doc.titulo).slice(0, 32)}»  vs Fichero «${r.tituloFichero.slice(0, 40)}»  (ISBN ${doc.isbn})`);
    }
}

console.log(`\n${'─'.repeat(64)}`);
console.log(`Revisados: ${revisados} · A APLICAR (corroborados): ${aplicar} · A REVISAR (no corroboran): ${revisar}`);
if (ejAplicar.length) { console.log(`\nMuestra a aplicar (título de serie/artefacto → título real del Fichero):`); ejAplicar.forEach((l) => console.log(l)); }
if (ejRevisar.length) { console.log(`\nMuestra a revisar (difiere pero el ISBN NO se corrobora → posible ISBN equivocado):`); ejRevisar.forEach((l) => console.log(l)); }
if (EJECUTAR) console.log(`\nAPLICADOS: ${aplicados} títulos sustituidos (solo los corroborados). Los "a revisar" NO se han tocado.`);
else console.log(`\n▶ Repite con --ejecutar para aplicar SOLO los corroborados (COPIA DE SEGURIDAD antes). O deja que la campaña «cotejo» lo haga sola al reposo.`);
process.exit(0);
