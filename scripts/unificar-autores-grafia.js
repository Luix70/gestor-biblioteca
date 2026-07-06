// ── UNIFICAR AUTORES POR VARIANTE DE GRAFÍA (solo MAYÚSCULAS/ACENTOS) ─────────────────────────────────
// Funde los registros de `autores` que son la MISMA persona escrita distinto SOLO por mayúsculas o acentos
// («JEAN TOUCHARD» = «Jean Touchard»; «José» = «Jose»). ESTRICTO: agrupa por nombre NORMALIZADO (minúsculas
// + sin diacríticos + espacios colapsados) — nunca por parecido, así NO funde personas distintas («Touchard,
// Jean» ≠ «Touchard, Michel-Claude»). Destino = la mejor grafía (no TODO-MAYÚSCULAS, con acentos, más libros);
// las demás grafías quedan como nombres_alternativos. Reusa fusionarAutores (reasigna referencias + borra).
// DRY-RUN por defecto; --ejecutar funde (BORRA los redundantes → haz BACKUP antes).
//   node scripts/unificar-autores-grafia.js            (lista los grupos)
//   node scripts/unificar-autores-grafia.js --ejecutar (funde)
import 'dotenv/config';
import { conectarDB } from '../src/database.js';
import { fusionarAutores } from '../src/utils/gestion-autores.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '').replace(/\s+/g, ' ').trim();
const acentos = (s) => (String(s || '').normalize('NFD').match(RE_DIACRITICOS) || []).length;
const esMayus = (s) => s === s.toUpperCase() && s !== s.toLowerCase();

async function main() {
    const db = await conectarDB();
    const bib = db.collection('biblioteca');
    const autores = await db.collection('autores').find({}).project({ nombre: 1 }).toArray();

    // Nº de libros por autor (autores[] + contribuciones.persona) para desempatar el destino.
    const cuenta = new Map();
    for (const id of await bib.distinct('autores')) cuenta.set(String(id), (cuenta.get(String(id)) || 0) + 1);
    for (const d of await bib.find({ contribuciones: { $exists: true, $ne: [] } }).project({ contribuciones: 1 }).toArray())
        for (const c of (d.contribuciones || [])) if (c?.persona) cuenta.set(String(c.persona), (cuenta.get(String(c.persona)) || 0) + 1);
    const nlibros = (a) => cuenta.get(String(a._id)) || 0;

    // Agrupar por nombre normalizado (misma persona salvo mayúsculas/acentos).
    const grupos = new Map();
    for (const a of autores) { const k = norm(a.nombre); if (!k) continue; if (!grupos.has(k)) grupos.set(k, []); grupos.get(k).push(a); }

    // Elige la MEJOR grafía: no TODO-MAYÚSCULAS > con más acentos > con más libros.
    const mejor = (a, b) => {
        if (esMayus(a.nombre) !== esMayus(b.nombre)) return esMayus(a.nombre) ? b : a;
        if (acentos(a.nombre) !== acentos(b.nombre)) return acentos(a.nombre) > acentos(b.nombre) ? a : b;
        return nlibros(a) >= nlibros(b) ? a : b;
    };

    let nGrupos = 0, nFundidos = 0;
    for (const [, arr] of grupos) {
        if (arr.length < 2) continue;
        nGrupos++;
        let destino = arr[0];
        for (const a of arr.slice(1)) destino = mejor(destino, a);
        const absorber = arr.filter(a => String(a._id) !== String(destino._id));
        console.log(`  ${arr.map(a => `«${a.nombre}»(${nlibros(a)})`).join(' = ')}  →  «${destino.nombre}»`);
        if (EJECUTAR) { await fusionarAutores(db, destino._id, absorber.map(a => a._id)); nFundidos += absorber.length; }
    }
    console.log(`\nGrupos con variante de grafía: ${nGrupos} · autores redundantes: ${grupos.size ? [...grupos.values()].reduce((n, a) => n + Math.max(0, a.length - 1), 0) : 0}${EJECUTAR ? ` · FUNDIDOS: ${nFundidos}` : ''}`);
    if (!EJECUTAR) console.log('(dry-run) Relanza con --ejecutar para fundir. ⚠ BORRA los redundantes → BACKUP antes.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
