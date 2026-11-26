/**
 * APARTAR LAS PORTADAS SIN LIBRO QUE YA ENTRARON — reparación del 26-nov (gemelo en la ingesta:
 * utils/portada-sin-libro.js, usado por vigilante·clasificarDirectorio).
 *
 * Una exportación de Calibre («Science & Technology Studies/Computer») traía en cada carpeta la portada
 * «<ISBN> - Autor - Título.jpg» + su .opf, y casi nunca el libro. El Vigilante tomó cada portada por un escaneo:
 *   A) 367 a Cuarentena/ilegibles («página descomunal (500")»: el JPG declara 1 ppp; las imágenes están sanas);
 *   B) 28 fichas falsas de «artículo» de 1 página (el JPG y su .opf, a la Papelera).
 * Decisión del usuario (26-nov): se APARTAN a PreProceso/_Portadas sin libro/<ruta que tenían en el Inbox>/.
 *
 * Qué hace con cada una:
 *   · Si su carpeta original del Inbox (o una superior) tiene ahora el LIBRO → la portada vuelve a su carpeta del Inbox
 *     (la ingesta la usa como portada del libro / espera a que se catalogue).
 *   · Si no → la portada (y su .opf, esté en el Inbox o en la Papelera) va a PreProceso/_Portadas sin libro/.
 *   · B además: la ficha falsa se BORRA (reproceso·eliminarDocumento: su carpeta CDU, con el PDF de 1 página que
 *     fabricó la ingesta, va a la Papelera). Solo si se encuentra el JPG original en la Papelera junto a su .opf
 *     —prueba de que era una portada de catálogo y no un escaneo de verdad—; si no, se deja y se lista.
 *   · El depósito de Cuarentena vacío (queda su estado.json) va a la Papelera.
 *
 * Uso (en el NAS; antes, copia de la base: node scripts/copia-base.js):
 *   node scripts/apartar-portadas-sin-libro.js                 → en seco: qué haría con cada una
 *   node scripts/apartar-portadas-sin-libro.js --ejecutar      → lo hace
 *   --desde AAAA-MM-DD   fichas ingresadas y papelera desde ese día (por defecto 2026-11-26)
 *   --solo-cuarentena | --solo-fichas
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { esDocumentoLeible, esImagenArchivo } from '../src/utils/criba-material.js';
import { libroEnCarpetaSuperior, apartarFicheros, CARPETA_PORTADAS_SIN_LIBRO } from '../src/utils/portada-sin-libro.js';
import { moverArbol, destinoLibre } from '../src/utils/mover-arbol.js';
import { reciclarCarpeta, MANIFIESTO_PAPELERA } from '../src/utils/papelera.js';
import { eliminarDocumento } from '../src/utils/reproceso.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const valor = (k, def) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : def; };
const DESDE = valor('--desde', '2026-11-26');
const HACER_CUARENTENA = !args.includes('--solo-fichas');
const HACER_FICHAS = !args.includes('--solo-cuarentena');

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const resolver = (p, def) => { const v = p || def; return path.isAbsolute(v) ? v : path.resolve(RAIZ, v); };
const INBOX = resolver(process.env.PATH_INBOX, 'Inbox');
const PREPROCESO = resolver(process.env.PATH_PREPROCESO, 'PreProceso');
const CUARENTENA = resolver(process.env.PATH_CUARENTENA, 'Cuarentena');
const PAPELERA = resolver(process.env.PATH_RECICLAJE, 'Recycling');
const DIR_ILEGIBLES = path.join(CUARENTENA, 'ilegibles');
const RUTAS = { inbox: INBOX, preproceso: PREPROCESO };

const existe = (p) => fs.access(p).then(() => true).catch(() => false);
const rel = (p) => path.relative(INBOX, p);

/** Una ruta guardada por la ingesta («/app/Inbox/…») como ruta de ESTA máquina (el mismo montaje en el NAS). */
function rutaDelInbox(guardada) {
    const p = String(guardada || '').replace(/\\/g, '/');
    const i = p.indexOf('/Inbox/');
    return i >= 0 ? path.join(INBOX, ...p.slice(i + '/Inbox/'.length).split('/')) : null;
}

/** Ficheros (primer nivel) de una carpeta; [] si no existe. */
async function ficherosDe(dir) {
    const ents = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    return ents.filter((e) => e.isFile() && !/^[.@#]/.test(e.name)).map((e) => path.join(dir, e.name));
}

/**
 * Qué hacer con una portada que salió de `dirOriginal`: 'devolver' (su libro está ahí o más arriba) o 'apartar'.
 * `nombres` = nombres base de la portada y su .opf (para casar con el libro).
 */
async function decidir(dirOriginal, nombres) {
    const aqui = (await ficherosDe(dirOriginal)).find((f) => esDocumentoLeible(f));
    if (aqui) return { accion: 'devolver', libro: aqui };
    const arriba = await libroEnCarpetaSuperior(path.join(dirOriginal, '_'), INBOX, { nombres, isbn: null, titulo: null });
    if (arriba) return { accion: 'devolver', libro: arriba };
    return { accion: 'apartar' };
}

/** Lleva ficheros a `dir` sin pisar nada (copia verificada entre montajes). */
async function devolverA(rutas, dir) {
    await fs.mkdir(dir, { recursive: true });
    for (const r of rutas) await moverArbol(r, await destinoLibre(path.join(dir, path.basename(r))));
}

/** Aparta las imágenes y, con ellas, lo que quede en su carpeta del Inbox si es solo .opf/acompañantes. */
async function apartar(imagenes, dirOriginal) {
    const restos = (await ficherosDe(dirOriginal)).filter((f) => !esImagenArchivo(f) && !esDocumentoLeible(f));
    await apartarFicheros([...imagenes, ...restos], dirOriginal, RUTAS);
}

const cuenta = { dep: 0, depApartar: 0, depDevolver: 0, depSaltar: 0, fichas: 0, fichasRetirar: 0, fichasSaltar: 0, errores: 0 };

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · portadas sin libro → PreProceso/${CARPETA_PORTADAS_SIN_LIBRO}/ (desde ${DESDE})\n`);

// ─── A) Depósitos de Cuarentena/ilegibles que son solo una portada ────────────────────────────────────────
if (HACER_CUARENTENA) {
    const depositos = (await fs.readdir(DIR_ILEGIBLES, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory());
    const p = progreso(depositos.length, 'Cuarentena/ilegibles');
    for (const e of depositos) {
        const dep = path.join(DIR_ILEGIBLES, e.name);
        p.paso(e.name);
        let estado;
        try { estado = JSON.parse(await fs.readFile(path.join(dep, 'estado.json'), 'utf8')); } catch { continue; }
        const archivos = (estado.archivos || []).map((a) => path.join(dep, a));
        const originales = (estado.rutas_originales || []).map(rutaDelInbox).filter(Boolean);
        // Solo portadas: 1-2 imágenes que salieron del Inbox, y la causa es la de la página descomunal (1 ppp).
        if (!archivos.length || archivos.length > 2 || !archivos.every(esImagenArchivo) || !originales.length) continue;
        if (!/descomunal/i.test(estado.error?.mensaje || '')) continue;
        if (!(await Promise.all(archivos.map(existe))).every(Boolean)) continue;
        const dirOriginal = path.dirname(originales[0]);
        // Sin .opf al lado (ni nombre de cubierta) podría ser un escaneo de verdad de 1-2 páginas: no se toca.
        const conOpf = (await ficherosDe(dirOriginal)).some((f) => /\.opf$/i.test(f));
        if (!conOpf) { cuenta.depSaltar++; p.nota(`   · sin .opf en su carpeta (¿escaneo de verdad?), no se toca: ${e.name}`); continue; }
        cuenta.dep++;
        const nombres = [...archivos, ...(await ficherosDe(dirOriginal)).filter((f) => /\.opf$/i.test(f))].map((f) => path.parse(f).name);
        const d = await decidir(dirOriginal, nombres);
        if (d.accion === 'devolver') cuenta.depDevolver++; else cuenta.depApartar++;
        p.nota(`   ${d.accion === 'devolver' ? '↩ al Inbox (su libro: ' + path.basename(d.libro) + ')' : '📦 apartar'} · ${rel(dirOriginal)}`);
        if (!EJECUTAR) continue;
        try {
            if (d.accion === 'devolver') await devolverA(archivos, dirOriginal);
            else await apartar(archivos, dirOriginal);
            await reciclarCarpeta(dep, 'deposito portada sin libro', 'ilegibles');   // queda solo su estado.json
        } catch (err) {
            cuenta.errores++;
            p.nota(`   ⚠️  ${e.name}: ${err.message} (se queda donde estaba)`);
        }
    }
    console.log(`   Cuarentena/ilegibles (${p.fin()}): ${cuenta.dep} portadas · 📦 ${cuenta.depApartar} a apartar · ↩ ${cuenta.depDevolver} con su libro · ${cuenta.depSaltar} sin .opf (no se tocan)\n`);
}

// ─── B) Fichas falsas de «artículo» de 1 página fabricadas con una portada ─────────────────────────────────
if (HACER_FICHAS) {
    // Índice de la Papelera desde DESDE: nombre del fichero → [{ ruta en la papelera, origen }].
    const indice = new Map();
    const subs = (await fs.readdir(PAPELERA, { withFileTypes: true }).catch(() => []))
        .filter((e) => e.isDirectory() && (e.name.match(/^\d+_(\d{4}-\d{2}-\d{2})/)?.[1] || '') >= DESDE);
    const pp = progreso(subs.length, 'Leyendo la Papelera');
    for (const s of subs) {
        pp.paso(s.name);
        let man;
        try { man = JSON.parse(await fs.readFile(path.join(PAPELERA, s.name, MANIFIESTO_PAPELERA), 'utf8')); } catch { continue; }
        for (const it of man.items || []) {
            if (it.tipo !== 'file' || !it.origen) continue;
            const clave = path.basename(it.origen);
            if (!indice.has(clave)) indice.set(clave, []);
            indice.get(clave).push({ ruta: path.join(PAPELERA, s.name, it.rel), origen: it.origen, sub: path.join(PAPELERA, s.name) });
        }
    }
    pp.fin();

    const db = await conectarDB();
    const filtro = {
        tipo_recurso: 'articulo', paginas: 1, formatos: ['pdf'],
        fecha_ingreso: { $gte: new Date(`${DESDE}T00:00:00Z`) },
        alertas_agente: { $regex: '^Escaneo de 1 páginas' },
    };
    const docs = await db.collection('biblioteca').find(filtro).toArray();
    const p = progreso(docs.length, 'Fichas de 1 página');
    for (const doc of docs) {
        p.paso(doc.titulo);
        const base = path.parse(doc.nombre_archivo || '').name;
        // El JPG original en la Papelera, con un .opf de la MISMA carpeta reciclado en el mismo momento.
        const imagen = ['.jpg', '.jpeg', '.png'].flatMap((x) => indice.get(base + x) || []).find(Boolean);
        const opf = imagen && [...indice.values()].flat().find((x) => x.sub === imagen.sub && /\.opf$/i.test(x.ruta));
        if (!imagen || !opf || !(await existe(imagen.ruta))) {
            cuenta.fichasSaltar++;
            p.nota(`   · sin su portada + .opf en la Papelera, no se toca: «${doc.titulo}» (${doc._id})`);
            continue;
        }
        cuenta.fichas++;
        const dirOriginal = path.dirname(rutaDelInbox(imagen.origen));
        const d = await decidir(dirOriginal, [base, path.parse(opf.ruta).name]);
        cuenta.fichasRetirar++;
        p.nota(`   🗑 ficha «${doc.titulo}» (${doc._id}) · portada ${d.accion === 'devolver' ? '↩ al Inbox (su libro: ' + path.basename(d.libro) + ')' : '📦 apartada'} · ${rel(dirOriginal)}`);
        if (!EJECUTAR) continue;
        try {
            const ficheros = [imagen.ruta, opf.ruta];
            if (d.accion === 'devolver') await devolverA(ficheros, dirOriginal);
            else await apartarFicheros(ficheros, dirOriginal, RUTAS);
            await eliminarDocumento(db, doc);   // borra la ficha; su carpeta CDU (el PDF fabricado) va a la Papelera
        } catch (err) {
            cuenta.errores++;
            p.nota(`   ⚠️  «${doc.titulo}»: ${err.message} (la ficha se queda)`);
        }
    }
    console.log(`   Fichas (${p.fin()}): ${cuenta.fichas} hechas con una portada → 🗑 ${cuenta.fichasRetirar} a retirar · ${cuenta.fichasSaltar} sin pruebas (no se tocan)\n`);
}

if (cuenta.errores) console.log(`   ⚠️  ${cuenta.errores} con error (ver arriba): se quedaron donde estaban.`);
console.log(EJECUTAR
    ? `   ✅ Hecho. Las apartadas están en PreProceso/${CARPETA_PORTADAS_SIN_LIBRO}/ con la ruta que tenían en el Inbox.`
    : '   Nada escrito. Para aplicarlo: node scripts/apartar-portadas-sin-libro.js --ejecutar   (antes: node scripts/copia-base.js)');
console.log('');
process.exit(0);
