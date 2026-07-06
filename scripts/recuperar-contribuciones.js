// ── RECUPERAR CONTRIBUCIONES ROTAS ───────────────────────────────────────────────────────────────────
// Repara los documentos cuyas `contribuciones[].persona` (traductor/ilustrador/editor…) apuntan a un autor
// que ya NO existe (p. ej. borrado por error). Reconstruye el NOMBRE desde el FICHERO (offline, por ISBN) y
// lo re-resuelve con la MISMA función de la ingesta (resolverPersona → find-or-create), de modo que el autor
// recuperado es idéntico al que crearía una reingesta. QUIRÚRGICO: solo toca las refs rotas; conserva las
// válidas y el orden. Las refs sin nombre recuperable se DEJAN intactas (no se pierde dato) y se listan.
// DRY-RUN por defecto; `--ejecutar` escribe.
//   node scripts/recuperar-contribuciones.js            (diagnostica)
//   node scripts/recuperar-contribuciones.js --ejecutar (repara)
import 'dotenv/config';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { buscarMetadatosExternos } from '../src/utils/proveedor-metadatos.js';
import { resolverPersona } from '../src/utils/resolver-persona.js';

const EJECUTAR = process.argv.includes('--ejecutar');
const S = (x) => String(x);

async function main() {
    const db = await conectarDB();
    const bib = db.collection('biblioteca');
    const docs = await bib.find({ contribuciones: { $exists: true, $ne: [] } })
        .project({ contribuciones: 1, isbn: 1, isbn_candidatos: 1, titulo: 1 }).toArray();

    // Autores que SÍ existen (para saber qué personas están rotas).
    const todas = new Set();
    for (const d of docs) for (const c of (d.contribuciones || [])) if (c?.persona) todas.add(S(c.persona));
    const existe = new Set((await db.collection('autores')
        .find({ _id: { $in: [...todas].filter(ObjectId.isValid).map(x => new ObjectId(x)) } })
        .project({ _id: 1 }).toArray()).map(a => S(a._id)));

    let tocados = 0, recuperadas = 0, sinRecuperar = 0, sinFichero = 0;
    const pendientes = [];
    for (const d of docs) {
        const rotas = (d.contribuciones || []).filter(c => c?.persona && !existe.has(S(c.persona)));
        if (!rotas.length) continue;

        const isbns = [d.isbn, ...(d.isbn_candidatos || [])].filter(Boolean);
        // Proveedor completo (Fichero → OpenLibrary online → by_statement), SIN IA (sin CDU/sinopsis/visión).
        let dx = null;
        try { if (isbns.length) dx = await buscarMetadatosExternos(d.titulo || '', '', null, { isbnsArchivo: isbns, incluirSinopsis: false, incluirCdu: false }); } catch { /* sigue */ }
        const nombres = dx && Array.isArray(dx.contribuciones_nombres) ? dx.contribuciones_nombres : [];
        if (!nombres.length) { sinFichero++; sinRecuperar += rotas.length; pendientes.push({ t: d.titulo, isbn: d.isbn, n: rotas.length }); continue; }

        // Cola de nombres por rol (para casar cada ref rota con el nombre de su mismo rol, por orden).
        const cola = {};
        for (const nm of nombres) { const r = (nm.rol || '').toLowerCase(); (cola[r] ||= []).push(nm.nombre); }

        const nuevas = [];
        let cambiado = false;
        for (const c of (d.contribuciones || [])) {
            if (c?.persona && existe.has(S(c.persona))) { nuevas.push(c); continue; }  // válida → intacta
            const nombre = (cola[(c?.rol || '').toLowerCase()] || []).shift();
            if (!nombre) { nuevas.push(c); sinRecuperar++; continue; }                 // sin nombre → se deja rota
            if (EJECUTAR) {
                const r = await resolverPersona(db, nombre);
                if (r?._id) { nuevas.push({ persona: r._id, rol: c.rol }); existe.add(S(r._id)); recuperadas++; cambiado = true; continue; }
                nuevas.push(c); sinRecuperar++;
            } else { nuevas.push({ persona: `«${nombre}»`, rol: c.rol }); recuperadas++; cambiado = true; }
        }
        if (cambiado) { tocados++; if (EJECUTAR) await bib.updateOne({ _id: d._id }, { $set: { contribuciones: nuevas } }); }
    }

    console.log(`Documentos reparados: ${tocados} · refs recuperadas: ${recuperadas} · sin recuperar: ${sinRecuperar} · docs sin datos en el Fichero: ${sinFichero}`);
    if (pendientes.length) {
        console.log('\nSin nombre en el Fichero (revisar a mano / online):');
        for (const p of pendientes.slice(0, 25)) console.log('  ·', S(p.t).slice(0, 42), '· isbn', p.isbn || '—', '·', p.n, 'ref(s)');
    }
    if (!EJECUTAR) console.log('\n(dry-run) Relanza con --ejecutar para escribir.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
