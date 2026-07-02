/**
 * Autocompletar datos de un autor (foto · biografía · seudónimos/heterónimos · fechas) desde APIs PÚBLICAS
 * y GRATUITAS, SIN clave y SIN IA (cumple la regla de minimizar IA):
 *   1) OpenLibrary Authors — biografía, `alternate_names` (incluye heterónimos, p. ej. Pessoa→«Alberto
 *      Caeiro»), foto por OLID.
 *   2) Wikidata — `aliases` (seudónimos), foto P18 (Wikimedia Commons), fechas P569/P570. Exige P31=Q5
 *      (humano) para no casar con una banda/empresa.
 *   3) Wikipedia REST summary — biografía en prosa + miniatura (fallback de foto).
 * Todo degradado: si una fuente falla o no casa el nombre, se ignora. La aplicación es CONSERVADORA por
 * defecto (solo rellena huecos; no pisa lo que ya haya) salvo que se pida `sobrescribir`.
 */
import { ObjectId } from 'mongodb';
import { guardarFotoAutor } from './gestion-autores.js';

const oid = (id) => (ObjectId.isValid(id) ? new ObjectId(id) : null);
const UA = 'gestor-biblioteca/1.0 (biblioteca personal; enriquecimiento de autores)';
const MAX_FOTO_BYTES = 12 * 1024 * 1024;

// GET JSON con timeout y User-Agent (Wikimedia lo exige). Devuelve null ante cualquier fallo.
async function jget(url) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 12000);
    try {
        const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
        if (!r.ok) return null;
        return await r.json();
    } catch {
        return null;
    } finally {
        clearTimeout(to);
    }
}

// Año (número) a partir de una fecha suelta ("1888", "13 June 1888", ISO Wikidata "+1888-06-13T…").
const anio = (s) => {
    const m = String(s || '').match(/([12]?\d{3})/);
    return m ? Number(m[1]) : null;
};

// Normaliza un nombre para comparar (minúsculas, sin acentos ni puntuación). El rango de marcas
// diacríticas combinantes se construye con new RegExp desde una cadena ASCII (evita literales frágiles).
const RE_DIACRITICOS = new RegExp('[\\u0300-\\u036f]', 'g');
const norm = (s) =>
    String(s || '').toLowerCase().normalize('NFD').replace(RE_DIACRITICOS, '')
        .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

// ¿El nombre encontrado casa con el buscado? Exige compartir ≥1 token significativo (≥3 letras). Evita
// enriquecer con el autor equivocado y descarta basura ("AA. VV.", "Creator: PScript5.dll" → sin tokens).
function coincideNombre(buscado, encontrado) {
    const a = new Set(norm(buscado).split(' ').filter((w) => w.length >= 3));
    const b = norm(encontrado).split(' ').filter((w) => w.length >= 3);
    if (!a.size || !b.length) return false;
    return b.some((w) => a.has(w));
}

// ── Fuente 1 · OpenLibrary Authors ─────────────────────────────────────────────────────────────────
async function deOpenLibrary(nombre) {
    const s = await jget('https://openlibrary.org/search/authors.json?q=' + encodeURIComponent(nombre) + '&limit=1');
    const d = (s && s.docs) ? s.docs[0] : null;
    if (!d || !d.key || !coincideNombre(nombre, d.name || '')) return null;
    const a = await jget('https://openlibrary.org/authors/' + d.key + '.json');
    if (!a) return null;
    const bio = a.bio ? (typeof a.bio === 'string' ? a.bio : a.bio.value) : null;
    const tieneFoto = Array.isArray(a.photos) && a.photos.some((p) => p > 0);
    return {
        fuente: 'OpenLibrary',
        biografia: bio || null,
        nombres_alternativos: Array.isArray(a.alternate_names) ? a.alternate_names : [],
        nacimiento: anio(a.birth_date),
        fallecimiento: anio(a.death_date),
        foto_url: tieneFoto ? `https://covers.openlibrary.org/a/olid/${d.key}-L.jpg` : null,
    };
}

// ── Fuente 2 · Wikidata ────────────────────────────────────────────────────────────────────────────
async function deWikidata(nombre) {
    const w = await jget('https://www.wikidata.org/w/api.php?action=wbsearchentities&search=' +
        encodeURIComponent(nombre) + '&language=es&format=json&type=item&limit=1');
    const hit = (w && w.search) ? w.search[0] : null;
    if (!hit || !hit.id || !coincideNombre(nombre, hit.label || '')) return null;
    const e = await jget('https://www.wikidata.org/wiki/Special:EntityData/' + hit.id + '.json');
    const ent = e && e.entities ? e.entities[hit.id] : null;
    if (!ent) return null;
    // Debe ser una PERSONA (P31 = Q5): evita casar con obras, bandas, empresas homónimas.
    const p31 = (ent.claims?.P31 || []).map((c) => c?.mainsnak?.datavalue?.value?.id);
    if (p31.length && !p31.includes('Q5')) return null;
    const aliases = [...(ent.aliases?.es || []), ...(ent.aliases?.en || [])].map((x) => x.value);
    const archivoP18 = ent.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    const foto = archivoP18
        ? 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(archivoP18) + '?width=600'
        : null;
    return {
        fuente: 'Wikidata',
        biografia: null,
        nombres_alternativos: aliases,
        nacimiento: anio(ent.claims?.P569?.[0]?.mainsnak?.datavalue?.value?.time),
        fallecimiento: anio(ent.claims?.P570?.[0]?.mainsnak?.datavalue?.value?.time),
        foto_url: foto,
    };
}

// ── Fuente 3 · Wikipedia REST summary (biografía en prosa + miniatura) ───────────────────────────────
async function deWikipedia(nombre) {
    for (const lang of ['es', 'en']) {
        const r = await jget(`https://${lang}.wikipedia.org/api/rest_v1/page/summary/` +
            encodeURIComponent(nombre.replace(/ /g, '_')));
        // 'standard' = artículo real (no desambiguación); descarta títulos ambiguos.
        if (r && r.type === 'standard' && r.extract) {
            return { fuente: 'Wikipedia', biografia: r.extract, foto_url: r.thumbnail?.source || null };
        }
    }
    return null;
}

/**
 * Reúne los datos de las 3 fuentes para un nombre. Devuelve la PROPUESTA (no escribe nada):
 *   { biografia, nombres_alternativos[], nacimiento, fallecimiento, foto_url, fuentes[] } o null.
 * Preferencias: biografía Wikipedia (prosa concisa) → OpenLibrary; foto Wikidata → OpenLibrary → Wikipedia.
 */
export async function buscarDatosAutorWeb(nombre) {
    const n = String(nombre || '').trim();
    if (n.length < 3) return null;
    // Los nombres se guardan a menudo INVERTIDos ("Apellido, Nombre"): las APIs buscan mejor con la forma
    // natural "Nombre Apellido". Si hay una coma, se consulta con la forma des-invertida.
    const coma = n.indexOf(',');
    const consulta = coma > 0 ? (n.slice(coma + 1).trim() + ' ' + n.slice(0, coma).trim()).trim() : n;
    const [ol, wd, wp] = await Promise.all([deOpenLibrary(consulta), deWikidata(consulta), deWikipedia(consulta)]);
    const fuentes = [ol, wd, wp].filter(Boolean).map((x) => x.fuente);
    if (!fuentes.length) return null;

    const alt = new Set();
    for (const src of [ol, wd]) if (src) (src.nombres_alternativos || []).forEach((x) => alt.add(String(x).trim()));
    alt.delete('');
    alt.delete(n);

    const bio = (wp && wp.biografia) || (ol && ol.biografia) || null;
    return {
        biografia: bio ? bio.slice(0, 1500) : null,
        nombres_alternativos: [...alt].slice(0, 15),
        nacimiento: (ol && ol.nacimiento) || (wd && wd.nacimiento) || null,
        fallecimiento: (ol && ol.fallecimiento) || (wd && wd.fallecimiento) || null,
        foto_url: (wd && wd.foto_url) || (ol && ol.foto_url) || (wp && wp.foto_url) || null,
        fuentes,
    };
}

// Descarga una imagen remota y la guarda como foto del autor (reutiliza guardarFotoAutor). null si falla.
async function guardarFotoDesdeURL(db, id, url) {
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), 15000);
    let resp;
    try {
        resp = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA } });
    } catch {
        return null;
    } finally {
        clearTimeout(to);
    }
    if (!resp || !resp.ok) return null;
    const ct = (resp.headers.get('content-type') || '').toLowerCase();
    const ext = ct.includes('png') ? 'png' : ct.includes('webp') ? 'webp' : (ct.includes('jpeg') || ct.includes('jpg')) ? 'jpeg' : null;
    if (!ext) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length || buf.length > MAX_FOTO_BYTES) return null;
    return guardarFotoAutor(db, String(id), `data:image/${ext};base64,` + buf.toString('base64'));
}

/**
 * Enriquece UN autor desde la web y APLICA los datos (conservador: solo rellena huecos, salvo `sobrescribir`).
 * @returns {Promise<{ok, cambios:string[], fuentes:string[], foto?:string, motivo?}>}
 */
export async function enriquecerAutor(db, id, { sobrescribir = false } = {}) {
    const _id = oid(id);
    if (!_id) return { ok: false, motivo: 'id inválido' };
    const autor = await db.collection('autores').findOne({ _id });
    if (!autor) return { ok: false, motivo: 'autor no encontrado' };

    const datos = await buscarDatosAutorWeb(autor.nombre);
    if (!datos) return { ok: true, cambios: [], fuentes: [], motivo: 'sin datos en la web para este nombre' };

    const set = {};
    const cambios = [];
    if (datos.biografia && (sobrescribir || !autor.biografia)) { set.biografia = datos.biografia; cambios.push('biografía'); }
    if (datos.nacimiento && (sobrescribir || !autor.nacimiento)) { set.nacimiento = datos.nacimiento; cambios.push('nacimiento'); }
    if (datos.fallecimiento && (sobrescribir || !autor.fallecimiento)) { set.fallecimiento = datos.fallecimiento; cambios.push('fallecimiento'); }
    if (datos.nombres_alternativos.length) {
        const union = [...new Set([...(autor.nombres_alternativos || []), ...datos.nombres_alternativos])]
            .filter((x) => x && x !== autor.nombre);
        if (union.length !== (autor.nombres_alternativos || []).length) { set.nombres_alternativos = union; cambios.push('alternativos'); }
    }
    if (Object.keys(set).length) {
        set.fecha_actualizacion = new Date();
        await db.collection('autores').updateOne({ _id }, { $set: set });
    }

    let foto = null;
    if (datos.foto_url && (sobrescribir || !autor.foto)) {
        const g = await guardarFotoDesdeURL(db, _id, datos.foto_url).catch(() => null);
        if (g && g.ok) { foto = g.foto; cambios.push('foto'); }
    }

    return { ok: true, cambios, fuentes: datos.fuentes, foto };
}

/**
 * Autores CANDIDATOS a enriquecer: los que TIENEN libros y les falta biografía o foto (lo caro de rellenar
 * a mano). Devuelve documentos { _id, nombre } (proyección mínima).
 */
export async function autoresEnriquecibles(db) {
    const usados = await db.collection('biblioteca')
        .aggregate([{ $unwind: '$autores' }, { $group: { _id: '$autores' } }]).toArray();
    const ids = usados.map((u) => u._id).filter(Boolean);
    if (!ids.length) return [];
    const faltaTexto = { $or: [{ biografia: { $exists: false } }, { biografia: null }, { biografia: '' }] };
    const faltaFoto = { $or: [{ foto: { $exists: false } }, { foto: null }, { foto: '' }] };
    return db.collection('autores')
        .find({ _id: { $in: ids }, $or: [faltaTexto, faltaFoto] }, { projection: { nombre: 1 } })
        .toArray();
}
