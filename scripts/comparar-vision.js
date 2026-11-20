#!/usr/bin/env node
/**
 * comparar-vision.js — MIDE qué proveedor de visión cataloga mejor nuestras 5+1 páginas, con libros NUESTROS.
 *
 * Toma libros ya catalogados que tienen sus imágenes de catalogación en disco (portada + créditos + contraportada) y
 * un ISBN válido que NO es dudoso, provisional ni sospechoso; manda las MISMAS imágenes, con la MISMA instrucción que
 * usa la ingesta (agente·INSTRUCCIONES_SISTEMA), a cada proveedor, y compara lo que devuelve con la ficha:
 *   ISBN (cualquiera de sus formas, también entre los `isbns` que devuelva) · título (titulo-libro·mismoTituloLibro) ·
 *   autor (algún apellido en común) · editorial · año · idioma · CDU (misma clase principal; y si refina o coincide).
 * Al final, una tabla por proveedor: aciertos de cada campo, JSON inválidos, errores, tiempo medio y tokens/coste
 * (los tokens los anota el contador de uso de IA: Mantenimiento → Uso de IA, origen «comparar-vision»).
 *
 * OJO con lo que mide: la ficha es la referencia, y una ficha puede estar mal (ISBN por autoridad, título editado a
 * mano…). Sirve para COMPARAR proveedores entre sí, no como nota absoluta. Tampoco lee el código de barras con zxing:
 * mide solo la visión.
 *
 * Mide TODOS los proveedores de visión que tengan clave en .env, ESTÉN O NO ACTIVOS en el panel (para eso existe: medir
 * antes de activar). No escribe nada en la base de datos ni en disco, salvo el informe si se pide. Gasta IA: cada libro
 * es una llamada por proveedor (los de pago, unos céntimos por libro).
 *
 * Uso (en el NAS, donde están las imágenes; con docker exec, -t para ver el progreso):
 *   sudo docker exec -t gestor-biblioteca node scripts/comparar-vision.js                  (30 libros, todos los proveedores)
 *   … --muestra 50                     nº de libros (por defecto 30)
 *   … --proveedores GEMINI_API_FREE_KEY@lite,ZAI_API_KEY   solo esos (los ids que lista --listar)
 *   … --listar                         lista los proveedores con clave y sale
 *   … --soporte papel|digital          solo libros fotografiados en el panel (papel) o de ficheros (digital)
 *   … --informe logs/comparar-vision.txt   además, el detalle libro a libro en un .txt
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { INSTRUCCIONES_SISTEMA } from '../src/agente.js';
import { proveedoresDeVision, visionCon, extraerJSON } from '../src/utils/vision.js';
import { volcarUsoIA } from '../src/utils/uso-ia.js';
import { validarISBN, variantesISBN } from '../src/utils/identificadores.js';
import { mismoTituloLibro } from '../src/utils/titulo-libro.js';
import { progreso } from '../src/utils/progreso-cli.js';

const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const MUESTRA = Math.max(1, Number(arg('--muestra')) || 30);
const SOLO = (arg('--proveedores') || '').split(',').map((s) => s.trim()).filter(Boolean);
const SOPORTE = arg('--soporte');
const INFORME = arg('--informe');
const MAX_IMAGENES = 6;   // las 5+1 de catalogación

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR_CDU = (() => { const v = process.env.PATH_CDU || 'CDU'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();
const absDe = (web) => path.join(DIR_CDU, ...decodeURIComponent(String(web)).replace(/^\/?recursos\//, '').split('/'));
const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

// ── Comparaciones (tolerantes: medimos si el dato es el mismo, no si está escrito igual) ──
const plano = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const PALABRAS_VACIAS = new Set(['editorial', 'ediciones', 'edicions', 'editions', 'press', 'publishing', 'publishers', 'books',
    'verlag', 'sa', 'sl', 'ltd', 'inc', 'llc', 'the', 'de', 'la', 'el', 'and', 'y', 'co', 'grupo', 'group']);
const palabras = (s) => plano(s).split(' ').filter((w) => w.length > 2 && !PALABRAS_VACIAS.has(w));

/** ¿El ISBN de la ficha está entre lo que devolvió el modelo (isbn, isbns[], isbn_obra, código de barras)? */
function aciertaIsbn(r, isbnFicha) {
    const buenas = new Set(variantesISBN(isbnFicha));
    const leidos = [r.isbn, r.codigo_barras, r.isbn_obra, ...(Array.isArray(r.isbns) ? r.isbns.map((x) => x?.numero ?? x) : [])];
    return leidos.some((x) => { const v = validarISBN(x); return v && variantesISBN(v).some((y) => buenas.has(y)); });
}
/** ¿Algún apellido (palabra larga) de los autores de la ficha aparece en los del modelo? */
function aciertaAutor(r, autoresFicha) {
    if (!autoresFicha.length) return null;   // sin referencia: no cuenta
    const suyos = new Set((Array.isArray(r.autores) ? r.autores : []).flatMap(palabras));
    return autoresFicha.some((a) => palabras(a).some((w) => suyos.has(w)));
}
function aciertaEditorial(r, editorialFicha) {
    if (!editorialFicha) return null;
    const suyas = new Set(palabras(r.editorial));
    return palabras(editorialFicha).some((w) => suyas.has(w));
}
/** CDU: misma clase principal (primer dígito) = acierto; «exacta» si una empieza por la otra. */
function cduSegun(r, cduFicha) {
    const a = String(cduFicha || '').trim(), b = String(r.cdu || '').trim();
    if (!a || a.startsWith('000') || a === '0') return { clase: null, exacta: null };
    if (!b) return { clase: false, exacta: false };
    return { clase: a[0] === b[0], exacta: a.startsWith(b) || b.startsWith(a) };
}

// ── Muestra de libros con su referencia ──
async function muestra(db) {
    const filtro = {
        tipo_recurso: 'libro',
        isbn: { $exists: true, $ne: '' },
        isbn_dudoso: { $ne: true }, isbn_provisional: { $ne: true }, isbn_sospechoso: { $ne: true },
        'imagenes.2': { $exists: true },   // portada + al menos dos páginas más
    };
    if (SOPORTE) filtro.soporte = SOPORTE;
    // Al azar, pero más de los que hacen falta: algunos tendrán las imágenes fuera de disco.
    const docs = await db.collection('biblioteca').aggregate([{ $match: filtro }, { $sample: { size: MUESTRA * 3 } },
        { $project: { titulo: 1, isbn: 1, autores: 1, editorial: 1, año_edicion: 1, idioma: 1, cdu: 1, imagenes: 1, portada: 1 } }]).toArray();
    const out = [];
    for (const d of docs) {
        if (out.length >= MUESTRA) break;
        if (!validarISBN(d.isbn)) continue;
        // Las imágenes de catalogación: la portada primero y luego el resto, hasta 6 (las mismas que ve la ingesta).
        // `imagenes[]` son objetos {ruta, tipo, origen} (los antiguos, texto); `portada`, texto.
        const rutaDe = (x) => (typeof x === 'string' ? x : x?.ruta);
        const webs = [...new Set([d.portada, ...(d.imagenes || [])].map(rutaDe).filter(Boolean))].slice(0, MAX_IMAGENES);
        const imagenes = [];
        for (const w of webs) {
            const abs = absDe(w);
            const mime = MIME[path.extname(abs).toLowerCase()];
            if (!mime) continue;
            const buf = await fs.readFile(abs).catch(() => null);
            if (buf && buf.length > 2000) imagenes.push({ base64: buf.toString('base64'), mimeType: mime });
        }
        if (imagenes.length < 3) continue;
        const autores = d.autores?.length
            ? (await db.collection('autores').find({ _id: { $in: d.autores } }, { projection: { nombre: 1 } }).toArray()).map((a) => a.nombre).filter(Boolean)
            : [];
        const editorial = d.editorial ? (await db.collection('editoriales').findOne({ _id: d.editorial }, { projection: { nombre: 1 } }))?.nombre : null;
        out.push({ _id: d._id, titulo: d.titulo, isbn: d.isbn, autores, editorial, año: d.año_edicion || null,
            idioma: d.idioma || null, cdu: d.cdu || null, imagenes });
    }
    return out;
}

async function main() {
    const todos = await proveedoresDeVision();
    if (process.argv.includes('--listar')) {
        console.log('Proveedores de visión con clave en .env:');
        for (const p of todos) console.log(`  ${p.activo ? '●' : '○'} ${p.id.padEnd(34)} ${p.etiqueta} · ${p.tier} · ${p.modelo}`);
        console.log('\n  ● activo en la rotación   ○ apagado (se mide igual)');
        process.exit(0);
    }
    const provs = SOLO.length ? todos.filter((p) => SOLO.includes(p.id)) : todos;
    if (!provs.length) {
        console.error(SOLO.length ? `Ninguno de esos ids tiene clave: ${SOLO.join(', ')} (mira --listar).` : 'No hay proveedores de visión con clave en .env.');
        process.exit(1);
    }
    const db = await conectarDB();
    console.log(`📚 Buscando ${MUESTRA} libros con ISBN fiable y sus imágenes en disco${SOPORTE ? ` (soporte ${SOPORTE})` : ''}…`);
    const libros = await muestra(db);
    if (!libros.length) {
        console.error('No hay libros que sirvan (¿las imágenes están en este disco? Corre el script en el NAS).');
        process.exit(1);
    }
    console.log(`   ${libros.length} libro(s) · ${provs.length} proveedor(es): ${provs.map((p) => p.id).join(', ')}\n`);

    const CAMPOS = ['isbn', 'titulo', 'autor', 'editorial', 'año', 'idioma', 'cdu_clase', 'cdu_exacta'];
    const stats = Object.fromEntries(provs.map((p) => [p.id, { ok: 0, json: 0, error: 0, ms: 0, primerError: null,
        campos: Object.fromEntries(CAMPOS.map((c) => [c, { si: 0, de: 0 }])) }]));
    const detalle = [];
    const p = progreso(libros.length * provs.length, 'Comparando');

    for (const libro of libros) {
        const fila = [`«${libro.titulo}» · ISBN ${libro.isbn} · ${libro.imagenes.length} imágenes`];
        for (const prov of provs) {
            p.paso(`${prov.id} · ${String(libro.titulo).slice(0, 30)}`);
            const s = stats[prov.id];
            let r;
            try {
                const { texto, ms } = await visionCon(prov.id, { prompt: INSTRUCCIONES_SISTEMA, imagenes: libro.imagenes });
                s.ms += ms;
                r = extraerJSON(texto);
                if (!r) { s.json++; fila.push(`   ${prov.id}: JSON inválido`); continue; }
                s.ok++;
            } catch (e) {
                s.error++;
                const msg = `${String(e?.status || e?.response?.status || '')} ${String(e?.response?.data?.error?.message || e?.error?.message || e?.message || e).slice(0, 300)}`.trim();
                s.primerError ??= msg;   // para el resumen: sin él, la tabla solo decía «3 errores» sin el porqué
                fila.push(`   ${prov.id}: ERROR ${msg}`);
                continue;
            }
            const cdu = cduSegun(r, libro.cdu);
            const res = {
                isbn: aciertaIsbn(r, libro.isbn),
                titulo: mismoTituloLibro(r.titulo || '', libro.titulo || ''),
                autor: aciertaAutor(r, libro.autores),
                editorial: aciertaEditorial(r, libro.editorial),
                año: libro.año ? Number(r.año_edicion) === Number(libro.año) : null,
                idioma: libro.idioma ? String(r.idioma || '').toLowerCase().slice(0, 2) === String(libro.idioma).toLowerCase().slice(0, 2) : null,
                cdu_clase: cdu.clase,
                cdu_exacta: cdu.exacta,
            };
            for (const c of CAMPOS) if (res[c] !== null) { s.campos[c].de++; if (res[c]) s.campos[c].si++; }
            const fallos = CAMPOS.filter((c) => res[c] === false);
            fila.push(`   ${prov.id}: ${fallos.length ? `falla ${fallos.join(', ')}` : 'todo bien'} · leyó isbn=${r.isbn || '—'} título=«${String(r.titulo || '').slice(0, 50)}» cdu=${r.cdu || '—'}`);
        }
        detalle.push(fila.join('\n'));
    }
    const duracion = p.fin();
    await volcarUsoIA().catch(() => {});

    // ── Tabla final ──
    const pct = (x) => (x.de ? `${Math.round((100 * x.si) / x.de)}%`.padStart(4) + ` (${x.si}/${x.de})` : '   —').padEnd(13);
    const lineas = [
        `Comparación de visión · ${libros.length} libros · ${new Date().toLocaleString('es-ES')} · ${duracion}`,
        '',
        `${'proveedor'.padEnd(34)} ${CAMPOS.map((c) => c.padEnd(13)).join(' ')} ${'json✗'.padEnd(6)} ${'error'.padEnd(6)} ms/libro`,
        ...provs.map((pr) => {
            const s = stats[pr.id];
            return `${pr.id.padEnd(34)} ${CAMPOS.map((c) => pct(s.campos[c])).join(' ')} ${String(s.json).padEnd(6)} ${String(s.error).padEnd(6)} ${s.ok ? Math.round(s.ms / s.ok) : '—'}`;
        }),
        ...provs.filter((pr) => stats[pr.id].primerError).map((pr) => `⚠ ${pr.id} falló: ${stats[pr.id].primerError}`),
        '',
        'Referencia = la ficha catalogada (puede tener errores propios): sirve para comparar proveedores entre sí.',
        'Tokens y coste de esta pasada: panel → Mantenimiento → Uso de IA (origen «comparar-vision»).',
    ];
    console.log('\n' + lineas.join('\n'));
    if (INFORME) {
        await fs.mkdir(path.dirname(path.resolve(INFORME)), { recursive: true });
        await fs.writeFile(INFORME, [...lineas, '', '── Libro a libro ──', '', ...detalle].join('\n') + '\n');
        console.log(`\n📝 Detalle libro a libro en ${INFORME}`);
    }
    process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
