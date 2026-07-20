#!/usr/bin/env node
/**
 * UNIFICA UNA SERIE (colección de números) QUE SE CATALOGÓ A TROZOS: un tipo, una CDU, una carpeta.
 *
 * Para qué: una serie larga que entra número a número, sin ISBN y con poco texto, hace que el clasificador
 * adivine en cada ejemplar. El caso real (Don Miki, 692 números con ISSN 0212-5285): 57 CDU distintas —214 en
 * el comodín `000`, y una cola con «arquitectura religiosa» o «cine»—, el tipo_recurso partido en 451 «libro»
 * y 233 «revista», y `serie_numero` a null en los 692 aunque el título dijera «Don Miki 001». La colección ya
 * existía y era correcta: lo que estaba disperso eran sus miembros.
 *
 * Deja cada número donde le corresponde según el modelo: <cdu>/revistas/<issn>/<clave>, siendo la clave
 * AAAA-MM → n<nº> → AAAA (utils/revistas.js · claveNumero), que es la IDENTIDAD del número.
 *
 *   node scripts/unificar-serie-revista.js --coleccion <id> --cdu <cdu> [--esperados <n>] [--ejecutar]
 *
 * Por DEFECTO es dry-run. ⚠ Copia de seguridad de la BD antes de `--ejecutar`: toca cientos de documentos.
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';
import { conectarDB } from '../src/database.js';
import { rutaCatalogo } from '../src/utils/rutas.js';
import { claveNumero } from '../src/utils/revistas.js';
import { registrarNumeroEnColeccion } from '../src/utils/colecciones.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');
const DIR_CDU = (() => { const v = process.env.PATH_CDU || 'CDU'; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); })();
const escribir = (s = '') => process.stdout.write(s + '\n');

const args = process.argv.slice(2);
const valor = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const EJECUTAR = args.includes('--ejecutar');
const idCol = valor('--coleccion');
const cduNueva = valor('--cdu');
const esperados = valor('--esperados') ? Number(valor('--esperados')) : null;

if (!idCol || !cduNueva) {
    escribir('\n  node scripts/unificar-serie-revista.js --coleccion <id> --cdu <cdu> [--esperados n] [--ejecutar]\n');
    process.exit(1);
}

const aDisco = (web) => path.join(DIR_CDU, String(web || '').replace(/^\/recursos\/?/, ''));

/**
 * Número del ejemplar. EL TÍTULO MANDA sobre el campo `numero_issue` guardado.
 *
 * Parece al revés, pero el dry-run lo dejó claro: los números guardados vienen de la ingesta y están MAL en
 * bastantes casos («Don Miki 054» tenía numero_issue=84; «141»→147; «330»→33). El título, en cambio, es
 * inequívoco. Así que se lee del título y el campo solo se usa como respaldo.
 *
 * Se quita antes el nombre de la cabecera: si no, cualquier cifra del propio nombre podría colarse.
 * Los ESPECIALES («Extra Navidad 1986», «Especial Patomas») no llevan número de serie: coger su primera
 * cifra daría el AÑO, y los 19 acabarían amontonados. Para ellos la clave es un resumen del título, que los
 * distingue y además se lee.
 */
function numeroDelTitulo(titulo, nombreCabecera) {
    // Sin barras invertidas a proposito: se normaliza y se compara con texto llano, en vez de construir un
    // regex a partir del nombre de la cabecera (que habria que escapar).
    const norm = (x) => String(x || '').toLowerCase().replace(/[ _]+/g, ' ').trim();
    let limpio = norm(titulo);
    const cab = norm(nombreCabecera);
    if (cab && limpio.startsWith(cab)) limpio = limpio.slice(cab.length).trim();

    // Los ESPECIALES («Extra Navidad 1986») no llevan numero de serie: su primera cifra es el AÑO, y cogerla
    // amontonaria los 19 bajo la misma clave. Se resuelven por titulo, igual que los albumes sueltos.
    const porTitulo = () => limpio.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || null;
    if (limpio.includes('extra') || limpio.includes('especial')) return porTitulo();

    const m = limpio.match(/[0-9]{1,4}/);
    if (m) return String(parseInt(m[0], 10));
    // Sin cifra alguna: son los albumes de la serie («Manual de Tarconi», «Don Miki Superdetective»). Sin esto
    // se quedaban SIN clave y caian todos en la carpeta de la cabecera, distinguidos solo por un sufijo opaco.
    return porTitulo();
}

const db = await conectarDB();
let _idCol; try { _idCol = new ObjectId(idCol); } catch { escribir('\n⛔ id de colección no válido\n'); process.exit(1); }

const col = await db.collection('colecciones').findOne({ _id: _idCol });
if (!col) { escribir('\n⛔ colección no encontrada\n'); process.exit(1); }

const docs = await db.collection('biblioteca').find({ coleccion: _idCol }).toArray();
escribir(`\n${EJECUTAR ? '⚙️  EJECUTAR' : '🔍 DRY-RUN'} · «${col.nombre || col.titulo}» (issn ${col.issn || '—'})`);
escribir(`   ${docs.length} número(s) · CDU → ${cduNueva} · tipo_recurso → revista\n`);

if (esperados != null && docs.length !== esperados) {
    escribir(`⛔ Se esperaban ${esperados} y hay ${docs.length}. No se toca nada.\n`);
    process.exit(1);
}

// 1) PLANIFICAR entero antes de mover un solo fichero: así se detectan las claves repetidas (dos ejemplares
//    que caerían en la misma carpeta) y se les da discriminador, en vez de descubrirlo a mitad del proceso.
const plan = [];
const porRuta = new Map();
for (const d of docs) {
    const numero = numeroDelTitulo(d.titulo, col.nombre || col.titulo) ?? d.numero_issue ?? null;
    const clave = claveNumero({ año_edicion: d.año_edicion, mes_publicacion: d.mes_publicacion, numero_issue: numero });
    const destino = rutaCatalogo({
        cdu: cduNueva, tipo_recurso: 'revista', issn: col.issn, titulo: col.nombre || col.titulo,
        id: d._id, clave_numero: clave, año_edicion: d.año_edicion, mes_publicacion: d.mes_publicacion,
    });
    plan.push({ d, numero, clave, web: destino.web });
    porRuta.set(destino.web, (porRuta.get(destino.web) || 0) + 1);
}
// Repetidas → cada documento conserva SU carpeta (1 doc ↔ 1 carpeta), como hace la ingesta.
for (const p of plan) {
    if (porRuta.get(p.web) > 1) {
        p.web = rutaCatalogo({
            cdu: cduNueva, tipo_recurso: 'revista', issn: col.issn, titulo: col.nombre || col.titulo,
            id: p.d._id, clave_numero: p.clave, año_edicion: p.d.año_edicion, mes_publicacion: p.d.mes_publicacion,
            discriminador: String(p.d._id).slice(-6),
        }).web;
        p.repetida = true;
    }
}

const resumen = { cdu: 0, tipo: 0, clave: 0, movidos: 0, saltados: 0, repetidas: plan.filter((p) => p.repetida).length };
for (const p of plan) {
    if (p.d.cdu !== cduNueva) resumen.cdu++;
    if (p.d.tipo_recurso !== 'revista') resumen.tipo++;
    if (p.d.clave_numero !== p.clave) resumen.clave++;
}
escribir('  Cambios previstos:');
escribir(`     CDU distinta ................ ${resumen.cdu}`);
escribir(`     tipo_recurso → revista ...... ${resumen.tipo}`);
escribir(`     clave de número nueva ....... ${resumen.clave}`);
escribir(`     claves repetidas (con sufijo) ${resumen.repetidas}`);
escribir('\n  Muestra:');
for (const p of plan.slice(0, 6)) {
    escribir(`     «${p.d.titulo}»  nº=${p.numero ?? '—'}  clave=${p.clave ?? '—'}`);
    escribir(`        ${p.d.ruta_base}`);
    escribir(`        → ${p.web}`);
}
const sinClave = plan.filter((p) => !p.clave);
if (sinClave.length) {
    escribir(`\n  ⚠ ${sinClave.length} sin clave deducible (irán a la carpeta de la cabecera, con sufijo propio):`);
    for (const p of sinClave.slice(0, 5)) escribir(`     · ${p.d.titulo}`);
}

if (!EJECUTAR) {
    escribir(`\n${'─'.repeat(70)}`);
    escribir('  (DRY-RUN) No se ha tocado nada.');
    escribir('  ⚠ Haz COPIA DE SEGURIDAD de la base de datos antes de repetir con --ejecutar.\n');
    process.exit(0);
}

// 2) EJECUTAR.
for (const p of plan) {
    const { d } = p;
    const origenDisco = aDisco(d.ruta_base);
    const destinoDisco = aDisco(p.web);
    if (origenDisco !== destinoDisco) {
        if (await fs.stat(destinoDisco).then(() => true).catch(() => false)) {
            escribir(`  ⚠ «${d.titulo}»: el destino ya existe → se salta`);
            resumen.saltados++;
            continue;
        }
        try {
            await fs.mkdir(path.dirname(destinoDisco), { recursive: true });
            await fs.rename(origenDisco, destinoDisco);
        } catch (e) {
            escribir(`  ✖ «${d.titulo}»: no se pudo mover (${e.message}) → se salta`);
            resumen.saltados++;
            continue;
        }
    }
    const rebase = (x) => (typeof x === 'string' && x.startsWith(d.ruta_base) ? p.web + x.slice(d.ruta_base.length) : x);
    await db.collection('biblioteca').updateOne({ _id: d._id }, {
        $set: {
            cdu: cduNueva,
            tipo_recurso: 'revista',
            ruta_base: p.web,
            ...(p.numero != null ? { numero_issue: p.numero } : {}),
            ...(p.clave ? { clave_numero: p.clave } : {}),
            ...(d.portada ? { portada: rebase(d.portada) } : {}),
            ...(Array.isArray(d.imagenes) ? { imagenes: d.imagenes.map(rebase) } : {}),
        },
    });
    await registrarNumeroEnColeccion(db, _idCol, { clave: p.clave, numero: p.numero }, d._id);
    resumen.movidos++;
}

// La cabecera: con ISSN y números, es una colección de tipo revista.
await db.collection('colecciones').updateOne({ _id: _idCol }, {
    $set: { tipo: 'revista', cdu: cduNueva, fecha_actualizacion: new Date() },
});

// Carpetas que hayan quedado vacías. Solo si lo están de verdad.
for (const d of docs) {
    let dir = path.dirname(aDisco(d.ruta_base));
    for (let n = 0; n < 3; n++) {
        const dentro = await fs.readdir(dir).catch(() => null);
        if (!dentro || dentro.length) break;
        await fs.rmdir(dir).catch(() => {});
        dir = path.dirname(dir);
    }
}

escribir(`\n${'─'.repeat(70)}`);
escribir(`  Unificados: ${resumen.movidos}` + (resumen.saltados ? ` · saltados: ${resumen.saltados}` : ''));
escribir('  Reindexa la búsqueda: node scripts/reindexar-busqueda.js\n');
process.exit(0);
