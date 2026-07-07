// ── BUSCAR documentos SIN AUTOR (solo lectura) ───────────────────────────────────────────────────────
// Lista los documentos que no tienen NINGÚN autor ni contribuyente (p. ej. tras quitar un autor-artefacto
// como «Creator:» de todos sus libros). Ningún documento se borra al quedarse sin autor: siguen aquí.
// Filtro opcional por texto en el título/nombre de archivo. NO escribe nada.
//   docker exec gestor-biblioteca node scripts/buscar-sin-autor.js               (todos)
//   docker exec gestor-biblioteca node scripts/buscar-sin-autor.js visualization (filtra por título/archivo)
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';

const filtro = process.argv.slice(2).join(' ').trim();

async function main() {
    const db = await conectarDB();
    const bib = db.collection('biblioteca');
    const sinAutor = {
        $and: [
            { $or: [{ autores: { $exists: false } }, { autores: { $size: 0 } }] },
            { $or: [{ contribuciones: { $exists: false } }, { contribuciones: { $size: 0 } }] },
        ],
    };
    const q = { ...sinAutor };
    if (filtro) {
        const rx = new RegExp(filtro.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
        q.$and.push({ $or: [{ titulo: rx }, { nombre_archivo: rx }, { subtitulo: rx }] });
    }
    const docs = await bib.find(q, { projection: { titulo: 1, subtitulo: 1, isbn: 1, nombre_archivo: 1, ruta_base: 1, formatos: 1 } })
        .sort({ titulo: 1 }).limit(500).toArray();

    console.log(`\nDocumentos SIN autor${filtro ? ` que casan «${filtro}»` : ''}: ${docs.length}${docs.length === 500 ? ' (tope 500)' : ''}\n`);
    for (const d of docs) {
        console.log(`  ${d._id}  «${String(d.titulo || '—').slice(0, 55)}»`);
        console.log(`        ${d.isbn ? 'ISBN ' + d.isbn + ' · ' : ''}${(d.formatos || []).join(',')} · ${d.nombre_archivo || ''}`);
        if (d.ruta_base) console.log(`        ${d.ruta_base}`);
    }
    if (!filtro) console.log('\nSugerencia: pásale un texto para acotar (p. ej. «visualization»). Para re-poner autores por ISBN:\n  docker exec gestor-biblioteca node scripts/re-enriquecer-degradados.js --sin-autor --ejecutar');
    process.exit(0);
}

main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
