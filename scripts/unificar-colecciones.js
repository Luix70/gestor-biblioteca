#!/usr/bin/env node
/**
 * UNIFICAR COLECCIONES — fusiona colecciones (cabeceras de revista / series de libros) que son la
 * MISMA pero están duplicadas por diferencias de mayúsculas/minúsculas/espacios/acentos en el nombre,
 * o que comparten el mismo ISSN. DRY-RUN por defecto; aplica con --ejecutar.
 *
 * Dos colecciones se consideran la misma si: comparten ISSN, O su nombre NORMALIZADO coincide
 * (minúsculas + espacios colapsados + sin acentos). Se agrupan por COMPONENTES CONEXOS (un grupo puede
 * unir A~B por nombre y B~C por ISSN). Por cada grupo de 2+:
 *   · elige CANÓNICA (con ISSN > más miembros > nombre con mayúsculas > más antigua),
 *   · repunta sus miembros (biblioteca.coleccion + coleccion_nombre) a la canónica,
 *   · rellena huecos de la canónica (issn/tipo/editorial/cdu/descripcion) desde las duplicadas,
 *   · reconstruye el inventario `numeros[]` de la canónica (si es revista),
 *   · borra las duplicadas.
 * SEGURIDAD: si un grupo contiene 2+ ISSN DISTINTOS, NO se fusiona (se avisa para revisión manual:
 * dos series distintas con el mismo nombre normalizado, p. ej.).
 *
 * Uso (NAS):
 *   docker exec gestor-biblioteca node scripts/unificar-colecciones.js              # DRY-RUN
 *   docker exec gestor-biblioteca node scripts/unificar-colecciones.js --ejecutar
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { registrarNumeroEnColeccion } from '../src/utils/colecciones.js';
import { claveNumero } from '../src/utils/revistas.js';

const EJECUTAR = process.argv.includes('--ejecutar');

// Nombre normalizado para detectar el "mismo" nombre: sin acentos, minúsculas, espacios colapsados.
const norm = (s) => String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();

// Union-Find (componentes conexos) para agrupar por ISSN y por nombre a la vez.
class UF {
    constructor() { this.p = new Map(); }
    find(x) {
        if (!this.p.has(x)) this.p.set(x, x);
        let r = x; while (this.p.get(r) !== r) r = this.p.get(r);
        while (this.p.get(x) !== r) { const n = this.p.get(x); this.p.set(x, r); x = n; }
        return r;
    }
    union(a, b) { this.p.set(this.find(a), this.find(b)); }
}

// Canónica del grupo: con ISSN > más miembros > nombre con mayúsculas > _id estable.
function elegirCanonica(grupo) {
    return [...grupo].sort((a, b) => {
        const ai = a.issn ? 1 : 0, bi = b.issn ? 1 : 0; if (ai !== bi) return bi - ai;
        if ((b._n || 0) !== (a._n || 0)) return (b._n || 0) - (a._n || 0);
        const au = /[A-ZÁÉÍÓÚÑÜ]/.test(a.nombre || '') ? 1 : 0, bu = /[A-ZÁÉÍÓÚÑÜ]/.test(b.nombre || '') ? 1 : 0;
        if (au !== bu) return bu - au;
        return String(a._id).localeCompare(String(b._id));
    })[0];
}

async function main() {
    console.log(`🧩 Unificar colecciones — ${EJECUTAR ? '⚠ EJECUTAR (aplica cambios)' : 'DRY-RUN (no cambia nada)'}`);
    const db = await conectarDB();
    const colCol = db.collection('colecciones'), bib = db.collection('biblioteca');
    const cols = await colCol.find({}).toArray();

    // Nº de miembros por colección (de un tirón).
    const conteos = await bib.aggregate([
        { $match: { coleccion: { $ne: null } } },
        { $group: { _id: '$coleccion', n: { $sum: 1 } } },
    ]).toArray();
    const mapaN = new Map(conteos.map(x => [String(x._id), x.n]));
    for (const c of cols) c._n = mapaN.get(String(c._id)) || 0;

    // Componentes: unir por ISSN y por nombre normalizado.
    const uf = new UF();
    const porISSN = new Map(), porNom = new Map();
    for (const c of cols) {
        const id = String(c._id); uf.find(id);
        if (c.issn) { const k = c.issn; porISSN.has(k) ? uf.union(id, porISSN.get(k)) : porISSN.set(k, id); }
        const nk = norm(c.nombre); if (nk) { porNom.has(nk) ? uf.union(id, porNom.get(nk)) : porNom.set(nk, id); }
    }
    const grupos = new Map();
    for (const c of cols) {
        const r = uf.find(String(c._id));
        let g = grupos.get(r); if (!g) grupos.set(r, g = []); g.push(c);
    }

    let fusionados = 0, miembrosMovidos = 0, conflictos = 0, unificables = 0;
    for (const grupo of grupos.values()) {
        if (grupo.length < 2) continue;
        const issns = new Set(grupo.filter(c => c.issn).map(c => c.issn));
        if (issns.size >= 2) {
            conflictos++;
            console.log(`  ⚠ CONFLICTO (ISSN distintos, NO se fusiona): ${grupo.map(c => `«${c.nombre}» [${c.issn || 's/issn'}]`).join('  ·  ')}`);
            continue;
        }
        const canon = elegirCanonica(grupo);
        const dups = grupo.filter(c => String(c._id) !== String(canon._id));
        unificables++;
        console.log(`  ${EJECUTAR ? '✔' : '·'} «${canon.nombre}» [${canon.issn || 's/issn'}]  ←  ${dups.map(d => `«${d.nombre}» (${d._n})`).join(', ')}`);
        if (!EJECUTAR) { fusionados += dups.length; miembrosMovidos += dups.reduce((s, d) => s + d._n, 0); continue; }

        // Rellenar huecos de la canónica desde las duplicadas.
        const set = {};
        for (const d of dups) {
            if (!canon.issn && d.issn) set.issn = canon.issn = d.issn;
            if (!canon.tipo && d.tipo) set.tipo = canon.tipo = d.tipo;
            if (!canon.editorial && d.editorial) set.editorial = canon.editorial = d.editorial;
            if (!canon.cdu && d.cdu) set.cdu = canon.cdu = d.cdu;
            if (!canon.descripcion && d.descripcion) set.descripcion = canon.descripcion = d.descripcion;
        }
        if (Object.keys(set).length) { set.fecha_actualizacion = new Date(); await colCol.updateOne({ _id: canon._id }, { $set: set }); }

        // Repuntar miembros a la canónica y borrar las duplicadas.
        for (const d of dups) {
            await bib.updateMany({ coleccion: d._id }, { $set: { coleccion: canon._id, coleccion_nombre: canon.nombre } });
            miembrosMovidos += d._n;
            await colCol.deleteOne({ _id: d._id });
            fusionados++;
        }

        // Reconstruir el inventario cronológico si la canónica es una cabecera de revista.
        if (canon.tipo === 'revista') {
            await colCol.updateOne({ _id: canon._id }, { $set: { numeros: [], numeros_sin_fecha: [], numeros_presentes: 0 } });
            const miembros = await bib.find({ coleccion: canon._id }).toArray();
            for (const m of miembros) await registrarNumeroEnColeccion(db, canon._id, {
                clave: m.clave_numero || claveNumero(m) || null,
                'año': m.año_edicion ?? null, mes: m.mes_publicacion ?? null, numero_issue: m.numero_issue ?? null,
            }, m._id);
        }
    }

    console.log(`\nGrupos unificables: ${unificables}  ·  conflictos (revisar a mano): ${conflictos}`);
    console.log(`Colecciones ${EJECUTAR ? 'fusionadas (borradas)' : 'a fusionar'}: ${fusionados}  ·  miembros ${EJECUTAR ? 'movidos' : 'a mover'}: ${miembrosMovidos}`);
    if (!EJECUTAR) console.log('\n(DRY-RUN; añade --ejecutar para aplicar)');
    process.exit(0);
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
