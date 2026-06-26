#!/usr/bin/env node
/**
 * VERIFICAR CLAVES GEMINI — comprueba que cada clave del .env funciona contra el modelo que usa la app
 * (gemini-2.5-flash). No escribe nada; solo hace una llamada mínima por clave y reporta OK/fallo.
 * Enmascara las claves en la salida (no filtra secretos).
 *
 *   node scripts/verificar-gemini.js
 *   docker exec gestor-biblioteca node scripts/verificar-gemini.js
 */
import 'dotenv/config';
import '../src/config.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

const MODELO = 'gemini-2.5-flash';
const CLAVES = [
    ['GEMINI_API_FREE_KEY (free)', process.env.GEMINI_API_FREE_KEY],
    ['GEMINI_API_KEY (Tier 1)',    process.env.GEMINI_API_KEY],
];

const mask = (k) => k.length > 12 ? `${k.slice(0, 6)}…${k.slice(-4)}` : '***';

async function probar(nombre, key) {
    if (!key) { console.log(`  ⊘ ${nombre}: NO definida en .env`); return false; }
    try {
        const genAI = new GoogleGenerativeAI(key.trim());
        const model = genAI.getGenerativeModel({ model: MODELO });
        const t0 = Date.now();
        const r = await model.generateContent('Responde solo con la palabra: OK');
        const txt = (r.response.text() || '').trim().replace(/\s+/g, ' ').slice(0, 40);
        console.log(`  ✓ ${nombre} [${mask(key)}] → ${MODELO} respondió "${txt}" (${Date.now() - t0} ms)`);
        return true;
    } catch (e) {
        console.log(`  ✗ ${nombre} [${mask(key)}] → ${e.status ? `HTTP ${e.status} · ` : ''}${e.message}`);
        return false;
    }
}

async function main() {
    console.log(`🔑 Verificando claves Gemini contra el modelo ${MODELO}\n`);
    for (const [n, k] of CLAVES) await probar(n, k);
    process.exit(0);
}
main();
