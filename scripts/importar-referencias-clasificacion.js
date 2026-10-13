/**
 * IMPORTAR LAS REFERENCIAS OFICIALES DE DEWEY Y LCC (13-oct), como se hizo con el UDC Summary para la CDU.
 *
 * Las descripciones de los códigos Dewey y LCC (el título con ⓘ de la ficha) las escribía la IA con el código A SECAS,
 * sin ninguna referencia, y se inventaba: «Dewey 181.5 = Filosofía japonesa» (181 es filosofía oriental; Japón es
 * 181.12), «LCC B753.G34 = Al-Ghazali: obra específica» (describía el LIBRO, no la clasificación). Con este script la IA
 * recibe el significado oficial de los niveles del código:
 *   · LCC: el «LC Classification Outline» de la Library of Congress (PDF gratuitos por clase, loc.gov/aba/publications/
 *     FreeLCC): rangos y sus títulos — «B720-765 Medieval (430-1450)», «BD143-237 Epistemology».
 *   · Dewey: los «DDC 23 Summaries» de OCLC (las 1.000 secciones: «181 Eastern philosophy»). OJO, LICENCIA: el Dewey es
 *     © OCLC. Aquí se usa SOLO como REFERENCIA INTERNA (para la IA y para revisar), nunca como texto que enseñe el panel.
 *
 * Los PDF se descargan a logs/clasificaciones/ (caché: no se vuelven a bajar) y se leen con pdftotext (poppler, ya en
 * la imagen). Guarda en la colección `clasificacion_oficial`. En seco no escribe nada.
 *
 *   node scripts/importar-referencias-clasificacion.js               (descarga, lee y enseña el resumen)
 *   node scripts/importar-referencias-clasificacion.js --ejecutar    (además lo guarda en la base)
 *   node scripts/importar-referencias-clasificacion.js --traducir    (después: títulos del LCC en español, con IA)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';

const ejecutar = promisify(execFile);
const EJECUTAR = process.argv.includes('--ejecutar');
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(RAIZ, 'logs', 'clasificaciones');

const URL_DDC = 'https://www.oclc.org/content/dam/oclc/dewey/ddc23-summaries.pdf';
const URL_LCC = 'https://www.loc.gov/aba/publications/FreeLCC/';
const LCC_PDF = [
  'A', 'B-BJ', 'BL-BQ', 'BR-BX', 'C', 'D-DR', 'DS-DX', 'E-F', 'G', 'H', 'J', 'K', 'KB', 'KD', 'KDZ_KG-KH', 'KE', 'KF',
  'KJ-KKZ', 'KJV-KJW', 'KK-KKC', 'KL-KWX', 'KZ', 'L', 'M', 'N', 'P-PA', 'PB-PH', 'PJ-PK', 'PL-PM', 'PN', 'PQ',
  'PR-PS-PZ', 'PT', 'Q', 'R', 'S', 'T', 'U-V', 'Z',
].map((c) => `LCC_${c}2024OUT.pdf`);

/** Descarga (si no está ya en la caché) y devuelve el texto del PDF con pdftotext. */
async function textoDePdf(url, nombre, modo) {
  const ruta = path.join(DIR, nombre);
  try { await fs.access(ruta); } catch {
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (gestor-biblioteca)' }, signal: AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
    await fs.writeFile(ruta, Buffer.from(await r.arrayBuffer()));
  }
  const { stdout } = await ejecutar('pdftotext', [modo, ruta, '-'], { maxBuffer: 32 << 20 });
  return stdout;
}

// ─── LCC: una línea por rango, «B720-765 Medieval (430-1450)» (modo -raw) ─────────────────────────────────────────
const RE_LCC = /^([A-Z]{1,3})(\d+(?:\.\d+)?)?(?:-(?:[A-Z]{1,3})?(\d+(?:\.\d+)?))?\s+(\S.*)$/;
function leerLcc(texto, fichero) {
  const filas = [];
  for (const bruta of texto.split('\n')) {
    const linea = bruta.trim();
    if (!linea || /^(OUTLINE|[ivx]+|Subclass .*|CLASS .*)$/i.test(linea)) continue;
    const m = linea.match(RE_LCC);
    if (!m) {
      // Continuación del título de la línea anterior (los títulos largos se parten).
      if (filas.length && /^[a-z(,]/.test(linea)) filas[filas.length - 1].titulo += ` ${linea}`;
      continue;
    }
    const [, clase, desde, hasta, titulo] = m;
    filas.push({
      sistema: 'lcc', clase, notacion: linea.slice(0, linea.length - titulo.length).trim(),
      desde: desde ? Number(desde) : null, hasta: hasta ? Number(hasta) : desde ? Number(desde) : null,
      titulo: titulo.trim(), fichero,
    });
  }
  return filas;
}

// ─── Dewey: las 1.000 secciones (modo -raw) ─────────────────────────────────────────────────────────────────────
// OJO: en el modo -layout la capa de texto del PDF DESCUADRA la columna derecha (los títulos 550-599 van dos filas
// por detrás de sus números: «551 Economic geology», que es el 553) — así entró la primera importación (13-oct) y el
// juez dio por malas descripciones buenas («551 = Meteorología»). En -raw cada columna sale como un bloque de
// números seguido de sus títulos EN EL MISMO ORDEN, así que se emparejan por orden con una cola: un número suelto
// espera; un título se lleva el número más antiguo en espera; una línea «822 English drama» se asigna sola.
// Los tres sumarios (clases, divisiones, secciones) van en orden: el tercero, el de las secciones, prevalece.
function leerDewey(texto) {
  const secciones = new Map();
  let cola = [];
  let anterior = null;
  for (const bruta of texto.split('\n')) {
    const linea = bruta.trim();
    if (!linea) continue;
    if (/^Consult schedules/i.test(linea)) { cola = []; continue; }   // pie de página: la cola no cruza páginas
    if (/^\d{3}$/.test(linea)) {
      if (linea !== anterior) cola.push(linea);   // el «000» de cabecera sale repetido
      anterior = linea;
      continue;
    }
    anterior = null;
    const m = linea.match(/^(\d{3})\s+(\S.*)$/);
    if (m) secciones.set(m[1], m[2].trim());
    else if (cola.length) secciones.set(cola.shift(), linea);
  }
  return [...secciones]
    .filter(([, titulo]) => !/^\[Unassigned\]$|^\(Optional number\)$/i.test(titulo))
    .map(([codigo, titulo]) => ({ sistema: 'dewey', codigo, titulo }));
}

/**
 * --traducir: pone `titulo_es` a los rangos del LCC que aún no lo tienen, con la IA (los proveedores activos en el
 * panel), por tandas de 60. Reanudable: solo pide los que faltan. El LC Outline es de dominio público; el Dewey no se
 * traduce (no se enseña).
 */
async function traducirLcc() {
  const { conTexto, extraerJSON } = await import('../src/utils/vision.js');
  const db = await conectarDB();
  const col = db.collection('clasificacion_oficial');
  const pendientes = await col.find({ sistema: 'lcc', titulo_es: { $exists: false } }, { projection: { titulo: 1 } }).toArray();
  // Un mismo título sale en muchos rangos («General works», «History»): se traduce una vez.
  const unicos = [...new Set(pendientes.map((p) => p.titulo))];
  console.log(`\n   Títulos del LCC sin traducir: ${pendientes.length} (${unicos.length} distintos)`);
  const TANDA = 60;
  const p = progreso(Math.ceil(unicos.length / TANDA), 'Traduciendo');
  let hechos = 0;
  for (let i = 0; i < unicos.length; i += TANDA) {
    const tanda = unicos.slice(i, i + TANDA);
    p.paso(`tanda ${i / TANDA + 1}`);
    const promptT = `Traduce al español estos títulos de la Library of Congress Classification (son materias de una
clasificación bibliotecaria: tradúcelos como lo haría un bibliotecario, breves, sin añadir nada). Responde SOLO con JSON:
{"t":[{"n":<número>,"es":"<traducción>"}]}
${tanda.map((t, k) => `${k + 1}. ${t}`).join('\n')}`;
    try {
      const j = extraerJSON(await conTexto({ prompt: promptT, json: true, maxTokens: 6000 }));
      for (const x of j?.t || []) {
        const original = tanda[Number(x.n) - 1];
        if (!original || !x.es) continue;
        await col.updateMany({ sistema: 'lcc', titulo: original, titulo_es: { $exists: false } }, { $set: { titulo_es: String(x.es).trim() } });
        hechos++;
      }
    } catch (e) {
      p.nota(`   ⚠ tanda ${i / TANDA + 1}: ${e.message} (se reintentará al relanzar)`);
    }
  }
  p.fin();
  console.log(`\n   ✔ Traducidos ${hechos} títulos distintos. Relanza --traducir si quedaron tandas sin hacer.\n`);
}

async function main() {
  await fs.mkdir(DIR, { recursive: true });
  console.log(`\n📚 Referencias oficiales Dewey + LCC — ${EJECUTAR ? '⚙️  EJECUTAR' : 'DRY-RUN (no escribe)'}\n`);

  const dewey = leerDewey(await textoDePdf(URL_DDC, 'ddc23-summaries.pdf', '-raw'));
  console.log(`   Dewey (DDC 23 Summaries): ${dewey.length} secciones`);

  const lcc = [];
  const p = progreso(LCC_PDF.length, 'LCC Outline');
  for (const f of LCC_PDF) {
    p.paso(f);
    try { lcc.push(...leerLcc(await textoDePdf(URL_LCC + f, f, '-raw'), f)); }
    catch (e) { p.nota(`   ⚠ ${f}: ${e.message}`); }
  }
  p.fin();
  console.log(`   LCC (LC Classification Outline): ${lcc.length} rangos`);

  for (const c of ['000', '181', '184', '300', '485', '551', '553', '595', '616', '791', '830', '973']) console.log(`     dewey ${c}  ${dewey.find((x) => x.codigo === c)?.titulo || '—'}`);
  for (const [cl, n] of [['B', 753], ['BD', 161], ['QA', 303], ['PN', 1995], ['TK', 5105.8]]) {
    const deEsta = lcc.filter((x) => x.clase === cl && x.desde !== null && n >= x.desde && n <= x.hasta).sort((a, b) => (b.hasta - b.desde) - (a.hasta - a.desde));
    console.log(`     lcc ${cl}${n}  ${deEsta.map((x) => `${x.notacion} ${x.titulo}`).join(' › ') || '—'}`);
  }

  if (process.argv.includes('--traducir')) {
    await traducirLcc();
    process.exit(0);
  }
  if (!EJECUTAR) {
    console.log('\n   ▶ Repite con --ejecutar para guardarlo (no descarga otra vez: usa la caché de logs/clasificaciones/).');
    console.log('   ▶ Y después, si quieres los títulos del LCC en español: --traducir (IA, por tandas, reanudable).\n');
    process.exit(0);
  }
  const db = await conectarDB();
  const col = db.collection('clasificacion_oficial');
  // Se rehace entera (es derivada de los PDF), pero conservando las traducciones del LCC ya hechas con --traducir.
  const traducidos = new Map((await col.find({ sistema: 'lcc', titulo_es: { $exists: true } }, { projection: { titulo: 1, titulo_es: 1 } }).toArray()).map((x) => [x.titulo, x.titulo_es]));
  for (const l of lcc) if (traducidos.has(l.titulo)) l.titulo_es = traducidos.get(l.titulo);
  await col.deleteMany({});
  const fecha = new Date();
  const docs = [
    ...dewey.map((d) => ({ ...d, _id: `dewey|${d.codigo}`, fuente: 'DDC 23 Summaries (OCLC)', uso: 'solo referencia interna: © OCLC, no se muestra', fecha })),
    ...lcc.map((l, i) => ({ ...l, _id: `lcc|${l.notacion}|${i}`, fuente: 'LC Classification Outline (Library of Congress)', fecha })),
  ];
  for (let i = 0; i < docs.length; i += 500) await col.insertMany(docs.slice(i, i + 500));
  await col.createIndex({ sistema: 1, clase: 1, desde: 1 }).catch(() => {});
  await col.createIndex({ sistema: 1, codigo: 1 }).catch(() => {});
  console.log(`\n   ✔ Guardadas ${docs.length} referencias en clasificacion_oficial.\n`);
  process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
