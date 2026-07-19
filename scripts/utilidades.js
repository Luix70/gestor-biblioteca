#!/usr/bin/env node
/**
 * UTILIDADES DEL INBOX por consola — lo mismo que la barra del Inspector, pero sin depender del navegador.
 *
 * Existe porque la vía del panel puede fallar por algo tan tonto como un app.js cacheado, y entonces el botón
 * «no hace nada» sin decir por qué. Por aquí la salida es completa y se puede pegar en una conversación.
 *
 *   node scripts/utilidades.js <operacion> <ruta-en-el-inbox> [más rutas…] [opciones]
 *
 * Operaciones:  expandir · expandir-aqui · aplanar · limpiar · comprimir · renombrar
 * Opciones:
 *   --ejecutar        aplica de verdad (por DEFECTO solo informa: dry-run)
 *   --propagar        aplicar también dentro de las subcarpetas
 *   --solo-unicas     (aplanar) disolver SOLO las carpetas con UN único fichero — deja intactas las que son
 *                     un conjunto aparte, como «jpg/» con las versiones de baja resolución
 *   --de "…" --a "…"  (renombrar) sustituir un texto en el nombre; --a vacío = quitarlo
 *   --nuevo "…"       (renombrar) nombre nuevo, para una sola ruta
 *
 * Las rutas son RELATIVAS al Inbox. Ejemplo del caso de los grabados:
 *   node scripts/utilidades.js aplanar "Grabados de la Encyclopedie/Grabados de la Encyclopedie.01" --solo-unicas
 *   …y con --ejecutar cuando el informe cuadre.
 *
 * Con comodín para no escribir 15 veces lo mismo:
 *   node scripts/utilidades.js aplanar "Grabados de la Encyclopedie/*" --solo-unicas
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { utilidadInbox, OPERACIONES } from '../src/utils/utilidades-inbox.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const INBOX = (() => { const v = process.env.PATH_INBOX || 'Inbox'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();
const escribir = (s = '') => process.stdout.write(s + '\n');   // NO console.log: consola-timestamp lo silenciaría

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const operacion = args[0];
if (!OPERACIONES.includes(operacion)) {
    escribir(`\nOperación no válida: «${operacion || ''}»`);
    escribir(`Válidas: ${OPERACIONES.join(' · ')}\n`);
    escribir('Ejemplo:  node scripts/utilidades.js aplanar "Grabados de la Encyclopedie/*" --solo-unicas\n');
    process.exit(1);
}

// Rutas: las que no empiezan por «--» y no son el valor de una opción.
const conValor = ['--de', '--a', '--nuevo'];
const rutas = args.slice(1).filter((a, i, arr) => !a.startsWith('--') && !conValor.includes(arr[i - 1]));
if (!rutas.length) { escribir('\nFalta la ruta (relativa al Inbox).\n'); process.exit(1); }

// Resolución + comodín «carpeta/*» (evita escribir 15 rutas a mano) + blindaje: nada fuera del Inbox.
const absolutas = [];
for (const r of rutas) {
    if (r.endsWith('/*') || r.endsWith(String.fromCharCode(92) + '*')) {
        const padre = path.resolve(INBOX, r.slice(0, -2));
        const dentro = path.relative(INBOX, padre);
        if (dentro.startsWith('..') || path.isAbsolute(dentro)) { escribir(`Ruta fuera del Inbox: ${r}`); process.exit(1); }
        for (const e of await fs.readdir(padre, { withFileTypes: true }).catch(() => [])) {
            if (!e.name.startsWith('.') && !e.name.startsWith('@')) absolutas.push(path.join(padre, e.name));
        }
        continue;
    }
    const abs = path.resolve(INBOX, r);
    const dentro = path.relative(INBOX, abs);
    if (dentro.startsWith('..') || path.isAbsolute(dentro)) { escribir(`Ruta fuera del Inbox: ${r}`); process.exit(1); }
    absolutas.push(abs);
}

const extra = {};
if (flag('--solo-unicas')) extra.soloUnicas = true;
if (valor('--de') !== undefined) { extra.de = valor('--de'); extra.a = valor('--a') ?? ''; }
if (valor('--nuevo') !== undefined) extra.nuevo = valor('--nuevo');

const EJECUTAR = flag('--ejecutar');
escribir(`\n${EJECUTAR ? '⚙️  EJECUTAR' : '🔍 DRY-RUN'} · ${operacion}${extra.soloUnicas ? ' (solo carpetas de 1 fichero)' : ''}${flag('--propagar') ? ' (propagando)' : ''}`);
escribir(`   ${absolutas.length} ruta(s) · Inbox: ${INBOX}\n`);

const r = await utilidadInbox({ operacion, absolutas, propagar: flag('--propagar'), ejecutar: EJECUTAR, extra });
if (!r.ok) { escribir(`⛔ ${r.motivo}\n`); process.exit(1); }

for (const a of r.acciones) {
    escribir(`  ${a.hecho ? '✔' : '·'} ${path.relative(INBOX, a.ruta)}`);
    escribir(`      ${a.detalle}${a.error ? ` — ${a.error}` : ''}`);
}
escribir(`\n${'─'.repeat(70)}`);
escribir(`  ${EJECUTAR ? 'Hechas' : 'Se harían'}: ${r.resumen.hechas} · sin efecto: ${r.resumen.fallidas} · total: ${r.resumen.total}`);
if (!EJECUTAR) escribir('\n  (DRY-RUN) Nada tocado. Repite con --ejecutar para aplicar.\n');
else escribir('\n  Lo retirado está en la Papelera.\n');
process.exit(0);
