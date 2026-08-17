#!/usr/bin/env node
/**
 * listar-modelos-groq.js — Lista los MODELOS que Groq ofrece HOY para tu clave (GET /models) y marca los de
 * VISIÓN. Sirve para arreglar el «404 model_not_found»: cuando Groq JUBILA un modelo, la visión deja de
 * funcionar. Mira la lista, elige uno de visión y ponlo en .env como GROQ_MODELO=<id> (o QUITA el GROQ_MODELO
 * viejo para usar el default vigente del código) y reinicia. SOLO LECTURA — no escribe nada ni imprime la clave.
 *   node scripts/listar-modelos-groq.js
 */
import 'dotenv/config';
import '../src/config.js';
import axios from 'axios';

// Primera GROQ_API_KEY del .env (GROQ_API_KEY / GROQ_API_KEY_1 / _2 …), sin exponerla.
const key = Object.entries(process.env)
    .filter(([k, v]) => /^GROQ_API_KEY(_\d+)?$/.test(k) && v && String(v).trim())
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([, v]) => String(v).trim())[0];
if (!key) { console.error('❌ No hay ninguna GROQ_API_KEY en .env (GROQ_API_KEY / GROQ_API_KEY_1 …).'); process.exit(1); }

const base = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const DEFAULT_CODIGO = 'meta-llama/llama-4-scout-17b-16e-instruct';       // el default del código (src/utils/vision.js)
const configId = process.env.GROQ_MODELO || DEFAULT_CODIGO;
// Heurística por nombre para señalar los multimodales (Groq no siempre marca la capacidad en /models).
const RE_VIS = /vision|scout|maverick|llama-4|pixtral|-vl\b|qwen.*vl/i;

try {
    const { data } = await axios.get(base + '/models', { headers: { Authorization: 'Bearer ' + key }, timeout: 20000 });
    const ids = (data?.data || []).map((m) => m.id).filter(Boolean).sort();
    if (!ids.length) { console.log('La API respondió pero sin modelos.'); process.exit(0); }
    const vis = ids.filter((id) => RE_VIS.test(id));

    console.log(`\n✅ Groq respondió: ${ids.length} modelos disponibles para tu clave.\n`);
    console.log('👁  Candidatos de VISIÓN (multimodales) — pon UNO de estos en GROQ_MODELO:');
    (vis.length ? vis : ['(ninguno detectado por el nombre; mira la lista completa abajo)']).forEach((id) => console.log('   • ' + id));
    console.log('\n— Lista completa —');
    ids.forEach((id) => console.log('   ' + id));

    const enLista = ids.includes(configId);
    console.log(`\nModelo configurado ahora: ${configId}${process.env.GROQ_MODELO ? '' : '  (default del código, no hay GROQ_MODELO en .env)'}`);
    console.log(enLista
        ? '   → SÍ está en la lista (si «Probar» da 404, revisa GROQ_BASE_URL).'
        : '   → ⚠️  NO está en la lista → ESTE es el 404. Cámbialo por uno de visión de arriba.');
    console.log('\nCómo aplicarlo:');
    console.log('   1) En .env:  GROQ_MODELO=<id de visión elegido>   (o borra el GROQ_MODELO viejo para usar el default)');
    console.log('   2) Reinicia: sudo docker-compose restart gestor-biblioteca');
    console.log('   3) Vuelve al panel y pulsa «Probar» en la fila de Groq.\n');
} catch (e) {
    const s = e?.response?.status;
    if (s === 401) console.error('❌ 401: la GROQ_API_KEY no es válida/está revocada → renuévala en console.groq.com y ponla en .env.');
    else console.error('❌ No se pudo consultar Groq:', s || '', String(e?.message || '').slice(0, 160));
    process.exit(1);
}
