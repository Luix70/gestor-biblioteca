/**
 * INSPECCIONAR LA ESTRUCTURA DE UN ÁRBOL DE CARPETAS (agente de estructura, FASE 1: solo propuesta).
 *
 * Recorre el árbol, calcula en local las señales gratuitas (tomos «Vol. N», ISBN en los nombres, editorial y
 * serie dominantes según el Fichero) y pide a la IA, en UNA llamada, qué es cada carpeta: colección, serie,
 * editorial, materia (con su CDU), obra o cajón. NO ESCRIBE NADA: enseña la propuesta para juzgarla.
 * Ver src/utils/agente-estructura.js.
 *
 *   node scripts/inspeccionar-estructura.js "<ruta del árbol>"            (señales + propuesta de la IA)
 *   node scripts/inspeccionar-estructura.js "<ruta>" --sin-ia             (solo el esqueleto: coste cero)
 *   node scripts/inspeccionar-estructura.js "<ruta>" --json               (salida en JSON)
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import { esqueletoArbol, interpretarEstructura } from '../src/utils/agente-estructura.js';

const args = process.argv.slice(2);
const RUTA = args.find((a) => !a.startsWith('--'));
const SIN_IA = args.includes('--sin-ia');
const JSON_OUT = args.includes('--json');

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
    console.log('\n   (FASE 1: solo propuesta — no se ha escrito nada)\n');
    process.exit(0);
}

main().catch((e) => { console.error('❌', e.message); process.exit(1); });
