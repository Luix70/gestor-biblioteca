/**
 * INSPECCIONAR LA ESTRUCTURA DE UN ÁRBOL DE CARPETAS (agente de estructura, FASE 1: solo propuesta).
 *
 * Recorre el árbol, calcula en local las señales gratuitas (tomos «Vol. N», ISBN en los nombres, editorial y
 * serie dominantes según el Fichero) y pide a la IA, en UNA llamada, qué es cada carpeta: colección, serie,
 * editorial, materia (con su CDU), obra o cajón. NO ESCRIBE NADA: enseña la propuesta para juzgarla.
 * Ver src/utils/agente-estructura.js.
 *
 *   node scripts/inspeccionar-estructura.js "<ruta del árbol>"            (señales + propuesta + PLAN de guías)
 *   node scripts/inspeccionar-estructura.js "<ruta>" --escribir           (escribe las guías del plan)
 *   node scripts/inspeccionar-estructura.js "<ruta>" --escribir --incluir-dudosas
 *   node scripts/inspeccionar-estructura.js "<ruta>" --sin-ia             (solo el esqueleto: coste cero)
 *   node scripts/inspeccionar-estructura.js "<ruta>" --json               (salida en JSON)
 *
 * FASE 2: sin --escribir enseña qué `_guia.json` escribiría en cada carpeta y NO escribe nada. Nunca pisa una
 * guía tuya (hecha en el Inspector); las carpetas dudosas solo se escriben con --incluir-dudosas.
 * Ver src/utils/guias-estructura.js.
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { esqueletoArbol, interpretarEstructura } from '../src/utils/agente-estructura.js';
import { planGuias, escribirGuias } from '../src/utils/guias-estructura.js';

const args = process.argv.slice(2);
const RUTA = args.find((a) => !a.startsWith('--'));
const SIN_IA = args.includes('--sin-ia');
const JSON_OUT = args.includes('--json');
const ESCRIBIR = args.includes('--escribir');
const INCLUIR_DUDOSAS = args.includes('--incluir-dudosas');

const ICONO = { coleccion: '📚', serie: '🔗', editorial: '🏢', materia: '🏷️', obra: '📖', cajon: '🗃️', mixta: '🧩', raiz: '🌳' };

async function main() {
    if (!RUTA) { console.error('Uso: node scripts/inspeccionar-estructura.js "<ruta>" [--sin-ia] [--json]'); process.exit(1); }
    try { await fs.access(RUTA); } catch { console.error(`❌ No existe: ${RUTA}`); process.exit(1); }

    const t0 = Date.now();
    const esq = await esqueletoArbol(RUTA);
    const sLocal = ((Date.now() - t0) / 1000).toFixed(1);

    if (!JSON_OUT) {
        console.log(`\n🔍 Estructura de «${esq.raiz}» — ${esq.carpetas.length} carpetas (${sLocal}s en local)${esq.recortado ? '  ⚠️ RECORTADO' : ''}\n`);
        console.log('   Señales locales (gratis):');
        for (const c of esq.carpetas) {
            const s = [];
            if (c.tomos_distintos >= 2) s.push(`${c.tomos_distintos} tomos`);
            if (c.editorial_dominante) s.push(`ed. «${c.editorial_dominante.valor}» ${c.editorial_dominante.veces}/${c.editorial_dominante.de}`);
            if (c.serie_dominante) s.push(`serie «${c.serie_dominante.valor}» ${c.serie_dominante.veces}/${c.serie_dominante.de}`);
            const sangria = '  '.repeat(c.nivel);
            console.log(`   ${sangria}${c.ruta === '.' ? esq.raiz : c.ruta.split('/').pop()}  (${c.documentos} docs)${s.length ? '  · ' + s.join(' · ') : ''}`);
        }
    }

    if (SIN_IA) {
        if (JSON_OUT) console.log(JSON.stringify(esq, null, 2));
        else console.log('\n   (--sin-ia: no se ha llamado a la IA)\n');
        process.exit(0);
    }

    const t1 = Date.now();
    const r = await interpretarEstructura(esq);
    const sIA = ((Date.now() - t1) / 1000).toFixed(1);

    if (JSON_OUT) { console.log(JSON.stringify({ esqueleto: esq, interpretacion: r }, null, 2)); process.exit(0); }

    console.log(`\n   Interpretación de la IA (${r.llamadas} llamada${r.llamadas > 1 ? 's' : ''}, ${sIA}s):\n`);
    if (r.aviso) console.log(`   ⚠️  ${r.aviso}\n`);
    // Las carpetas de una tanda FALLIDA se marcan distinto de las que la IA sí vio y dejó sin interpretar:
    // no es lo mismo «la IA no supo» que «la IA no llegó a verla».
    const noVistas = new Set();
    for (const f of r.fallidas || []) {
        const ini = (f.tanda - 1) * 50;
        esq.carpetas.slice(ini, ini + f.carpetas).forEach((c) => noVistas.add(c.ruta));
    }
    const porRuta = new Map(r.carpetas.map((c) => [c.ruta, c]));
    for (const c of esq.carpetas) {
        const i = porRuta.get(c.ruta);
        const sangria = '  '.repeat(c.nivel);
        const nombre = c.ruta === '.' ? esq.raiz : c.ruta.split('/').pop();
        if (!i) { console.log(`   ${sangria}${nombre}  — ${noVistas.has(c.ruta) ? '(tanda fallida: la IA no llegó a verla)' : '(sin interpretar)'}`); continue; }
        const extra = [i.cdu && `CDU ${i.cdu}`, i.editorial && `ed. ${i.editorial}`,
            i.nombre_canonico && i.nombre_canonico !== nombre && `«${i.nombre_canonico}»`].filter(Boolean).join(' · ');
        const conf = i.confianza < 0.6 ? `  ⚠️ confianza ${i.confianza.toFixed(2)}` : '';
        console.log(`   ${sangria}${ICONO[i.tipo] || '•'} ${nombre}  → ${i.tipo.toUpperCase()}${extra ? '  · ' + extra : ''}${conf}`);
        if (i.confianza < 0.6 && i.razon) console.log(`   ${sangria}     ↳ ${i.razon}`);
    }
    // Lo que la IA devolvió y NO casó con ninguna carpeta real: se enseña en vez de tragárselo, porque es la
    // única pista si el filtro está siendo demasiado estricto (o si la IA se ha inventado carpetas).
    if (r.descartadas?.length) {
        console.log(`\n   ⚠️  ${r.descartadas.length} respuesta(s) de la IA descartadas (ruta que no existe o tipo desconocido):`);
        for (const d of r.descartadas.slice(0, 8)) console.log(`      ${JSON.stringify(d.ruta)}  tipo=${d.tipo}`);
    }

    // ── FASE 2: plan de guías ──────────────────────────────────────────────────────────────────────────────
    const plan = await planGuias(path.resolve(RUTA), esq, r, { incluirDudosas: INCLUIR_DUDOSAS });
    const cuenta = (e) => plan.filter((p) => p.estado === e).length;
    console.log(`\n   Plan de guías (_guia.json):  ${cuenta('nueva')} nuevas · ${cuenta('actualizar')} a actualizar · `
        + `${cuenta('respetada')} tuyas respetadas · ${cuenta('dudosa')} dudosas · ${cuenta('omitida')} sin guía`);

    // Qué se escribiría, resumido: una línea por carpeta que recibe guía.
    const resumen = (g) => {
        if (!g) return '';
        const p = g.perfil || {};
        return [g.accion === 'obra' && `obra «${p.obra}»`, p.coleccion && `colección «${p.coleccion}»`,
            p.editorial_probable && `editorial «${p.editorial_probable}»`, p.materia_cdu && `CDU ${p.materia_cdu}`,
            p.sin_coleccion && 'sin colección'].filter(Boolean).join(' · ');
    };
    for (const p of plan) {
        if (!['nueva', 'actualizar', 'dudosa', 'respetada'].includes(p.estado)) continue;
        const marca = { nueva: '＋', actualizar: '↻', dudosa: '？', respetada: '🔒' }[p.estado];
        const nombre = p.ruta === '.' ? esq.raiz : p.ruta;
        console.log(`   ${marca} ${nombre}  → ${resumen(p.guia)}${p.motivo ? `   (${p.motivo})` : ''}`);
    }

    if (!ESCRIBIR) {
        console.log(`\n   (Sin --escribir no se ha escrito nada. Para aplicarlo: --escribir${cuenta('dudosa') ? '; las dudosas, con --incluir-dudosas' : ''})\n`);
        process.exit(0);
    }
    const n = await escribirGuias(plan);
    console.log(`\n   ✔ Escritas ${n} guías. El vigilante las obedecerá en la próxima ingesta de este árbol.\n`);
    process.exit(0);
    process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
