/**
 * REPARAR TRAS LA PASADA DE REIDENTIFICACIÓN (29/30-sep) — todas las reparaciones, en orden, en un solo comando.
 *
 * La pasada `reidentificar-sin-isbn --todos --edicion-por-elegir --ejecutar` corrió con el código de antes de los
 * arreglos del 30-sep. Este script aplica esos arreglos a lo que ya hizo. En seco por defecto; `--ejecutar` aplica.
 *
 *   Fase 1 · COLABORADORES de ediciones sin confirmar: la pasada dio el traductor/ilustrador… de la autoridad a
 *            ediciones PROVISIONALES o DUDOSAS. Son de la edición y no valen hasta confirmarla (regla del usuario):
 *            se quitan los que añadió la pasada (según su diario `deshacer[]`), nunca los que el libro ya tenía.
 *   Fase 2 · EDITORIALES FALSAS impuestas: donde la pasada puso un distribuidor («Distribooks Inc» en lugar de
 *            «Hodder Children's Books») o un marcador («Unknown»), se devuelve la editorial anterior.
 *   Fase 3 · EDITORIALES CON PUNTUACIÓN («Valdemar,», «Ultramar.», «Alianza, etc»): se fusionan con la de nombre
 *            limpio (el nombre sucio queda como grafía alternativa: nada se pierde) o, si no existe, se renombran.
 *            No se fusiona una que tenga datos propios (logo, web…): se lista para hacerlo a mano.
 *   Fase 4 · scripts/modernizar-cdu.js         (CDU en notación antigua → moderna + carpetas; juveniles 087.5)
 *   Fase 5 · scripts/editoriales-por-prefijo.js (editorial por el prefijo del ISBN: solo huecos y basura)
 *   Fase 6 · scripts/reidentificar-sin-isbn.js --edicion-por-elegir  (falsos «❓ otro título», ISBN probable y
 *            datos de la obra en las que sigan sin decidir). Larga (horas): en seco se salta, salvo
 *            `--con-reidentificar`.
 *   Fase 7 · COLECCIONES con « /**\/ » en el nombre (el volcado de la BNE junta así varias series:
 *            «Punto de lectura /**\/  Biblioteca de bolsillo», «Bestseller 185/4 /**\/»): se quedan con la PRIMERA
 *            serie, sin el número pegado (que pasa a coleccion_numero si el libro no tenía); si ya existe una
 *            colección con ese nombre, se fusionan. 25 colecciones el 30-sep. Se ejecuta tras la fase 3.
 *
 *   LO QUE ENSEÑÓ EL LOG COMPLETO (30-sep: 6.795 libros, 2.587 ISBN recuperados):
 *   Fase 10 · EDITORIALES LEÍDAS POR LA VISIÓN en la cubierta de ePubLibre: «se», «Se», «ge», «9e»… (su logotipo) y
 *            «Seix Barral» en libros que no son suyos. Se quita la editorial (queda vacía: la fase 5 la rellena por
 *            el prefijo del ISBN donde pueda). «Seix Barral» se respeta si el ISBN es de Seix Barral (978-84-322).
 *            Los demás libros SIN ISBN cuya editorial sustituyó a la de un maquetador van a una selección.
 *   Fase 8 · DESHACER Y REHACER las identificaciones que el motor corregido haría de otra manera:
 *            · el ISBN lo comparte con otro documento de OTRO título (el del conjunto: tomos de enciclopedias,
 *              «Routledge Library Editions»…);
 *            · recibió la edición de un lote con audio («… MP3 PACK», «… CD Pack»);
 *            · es material derivado («— glosario») y recibió el ISBN del libro;
 *            · el ISBN que declara el contenido es de otra editorial que el del nombre del fichero.
 *            Cada uno vuelve a como estaba (según su diario, incluida la CDU y la carpeta) y se reidentifica.
 *   Fase 9 · TÍTULOS: (a) los que la pasada cambió por el mismo título con una coletilla de catálogo («Recycling» →
 *            «Recycling, Level 3») recuperan el suyo; (b) los títulos-artefacto de TODA la base que ya tienen ISBN
 *            («9780226063812.UChicagoPress.Patient_Zero…», «Unknown», «CreationDate: …») se cotejan de nuevo con
 *            la autoridad (ahora también Crossref) y, si nadie responde, toman el título del nombre del fichero.
 *   Fase 12 · scripts/reparar-cdu-contaminada.js (CDU heredadas de una equivalencia aprendida para toda una clase
 *            LCC: «lcc:e → 972.5» y otras 29). Antes de la fase 4.
 *   Fase 11 · SELECCIONES PARA REVISAR A MANO (no cambian nada): «CDU de la BNE de otra lengua» (la BNE dice
 *            española y lo deducido decía inglesa, o el número no existe: «821.11(73)») e «ISBN de otra lengua».
 *
 *   Orden de ejecución: 1, 2, 3, 7, 10, 8, 9, 12, 4, 5, 11, 6.
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/reparar-tras-reidentificacion.js              (en seco)
 *   sudo docker exec -t gestor-biblioteca node scripts/reparar-tras-reidentificacion.js --ejecutar
 *   … --desde 2026-09-29   solo lo que hizo la pasada desde esa fecha (por defecto, el 29-sep)
 *   … --fases 1,2,3        solo esas fases
 *
 * Antes de --ejecutar: copia de la base (scripts/copia-base.js o CopiaBase.ps1). Conformador y campañas apagados.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { esEditorialFalsa, limpiarNombreEditorial } from '../src/utils/editoriales-falsas.js';
import { fusionarEditoriales } from '../src/utils/gestion-editoriales.js';
import { regenerarSidecarsDoc } from '../src/utils/registro.js';
import { carpetaDeDoc } from '../src/mantenimiento/util-mantenimiento.js';
import { indexarDoc } from '../src/utils/indice-busqueda.js';
import { separarSerie } from '../src/utils/series-texto.js';
import { claveCanonica } from '../src/utils/colecciones.js';
import { fusionarColecciones } from '../src/utils/gestion-grupos.js';
import { reubicarPorCdu, carpetaExiste } from '../src/mantenimiento/util-mantenimiento.js';
import { reidentificarDoc, anotarRevisionIsbn, soloAnadeColetilla, CAMPO_MARCA_RECUPERAR_ISBN } from '../src/utils/reidentificar-doc.js';
import { esMaterialDerivado, esTituloDeLoteAudio } from '../src/utils/identificar-edicion.js';
import { tituloComparable } from '../src/utils/titulo-libro.js';
import { esTituloArtefacto, tituloDeNombreDeLote } from '../src/utils/parsear-nombre.js';
import { esNombreRuido } from '../src/utils/editorial-por-prefijo.js';
import { modernizarCDU } from '../src/utils/cdu-moderna.js';
import { extraerISBNs } from '../src/utils/lector-pdf.js';
import { validarISBN, variantesISBN } from '../src/utils/identificadores.js';
import { crearSeleccion } from '../src/utils/selecciones.js';

const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const EJECUTAR = args.includes('--ejecutar');
const CON_REIDENTIFICAR = args.includes('--con-reidentificar');
const DESDE = new Date(arg('--desde') || '2026-09-29');
const FASES = arg('--fases') ? new Set(arg('--fases').split(',').map((x) => Number(x.trim()))) : null;
const toca = (n) => !FASES || FASES.has(n);

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = await conectarDB();
const col = db.collection('biblioteca');
const resumen = [];

console.log(`\n${EJECUTAR ? '⚙️  EJECUCIÓN' : '🔍 DRY-RUN'} · reparaciones tras la pasada de reidentificación (desde ${DESDE.toISOString().slice(0, 10)})\n`);

// Documentos que la pasada tocó: los que tienen una entrada «reidentificar» en su diario desde DESDE.
const filtroPasada = { deshacer: { $elemMatch: { origen: 'reidentificar', fecha: { $gte: DESDE } } } };
const entradasDe = (doc) => (doc.deshacer || []).filter((e) => e.origen === 'reidentificar' && new Date(e.fecha) >= DESDE && !e.deshecho);
const FECHA = new Date().toISOString().slice(0, 10);
const recorta = (texto, n = 50) => String(texto || '').slice(0, n);
/** Solo las cifras de un ISBN. */
const cifrasISBN = (isbn) => String(isbn || '').replace(/[^0-9Xx]/g, '').toUpperCase();
/** Crea una selección de revisión (solo al ejecutar) y lo anota en el resumen. */
async function seleccionDeRevision(nombre, descripcion, ids) {
    if (!ids.length) return;
    if (EJECUTAR) await crearSeleccion(db, { nombre: `${nombre} ${FECHA}`, descripcion, docs: ids });
    resumen.push(`         → selección «${nombre} ${FECHA}»: ${ids.length} documento(s)${EJECUTAR ? '' : ' (se creará al ejecutar)'}`);
}

/** Anota en el diario, regenera sidecars e índice. */
async function guardar(doc, update, antes, alerta) {
    const ahora = new Date();
    await col.updateOne({ _id: doc._id }, {
        ...update,
        $set: { ...(update.$set || {}), fecha_actualizacion: ahora },
        $push: { deshacer: { fecha: ahora, origen: 'reparar-tras-reidentificacion', antes }, alertas_agente: alerta },
    });
    const nuevo = await col.findOne({ _id: doc._id });
    await regenerarSidecarsDoc(db, nuevo, carpetaDeDoc(nuevo)).catch(() => {});
    await indexarDoc(db, doc._id).catch(() => {});
}

// ─── FASE 1: colaboradores de ediciones sin confirmar ─────────────────────────────────────────────────────────
if (toca(1)) {
    const filtro = { ...filtroPasada, $or: [{ isbn_provisional: true }, { isbn_dudoso: true }], 'contribuciones.0': { $exists: true } };
    let n = 0;
    const p = progreso(await col.countDocuments(filtro), 'Fase 1 · colaboradores');
    for await (const doc of col.find(filtro)) {
        p.paso(doc.titulo);
        // ¿Los añadió la pasada? Su diario guarda cómo estaban ANTES: si entonces no había ninguno, son de ella.
        const añadidos = entradasDe(doc).some((e) => e.antes && 'contribuciones' in e.antes && !(e.antes.contribuciones?.length));
        if (!añadidos) continue;
        n++;
        p.nota(`${doc._id} · quitar ${doc.contribuciones.length} colaborador(es) · «${String(doc.titulo || '').slice(0, 50)}»`);
        if (EJECUTAR) {
            await guardar(doc, { $unset: { contribuciones: '' } }, { contribuciones: doc.contribuciones },
                'Colaboradores quitados: los había dado la autoridad a una edición PROVISIONAL o DUDOSA (son de la edición; volverán al confirmarla).');
        }
    }
    p.fin();
    resumen.push(`Fase 1 · colaboradores quitados de ediciones sin confirmar: ${n}`);
}

// ─── FASE 2: editoriales falsas impuestas por la pasada ───────────────────────────────────────────────────────
if (toca(2)) {
    const nombrePorId = new Map();
    for await (const e of db.collection('editoriales').find({}, { projection: { nombre: 1 } })) nombrePorId.set(String(e._id), e.nombre);
    const filtro = { ...filtroPasada, editorial: { $exists: true } };
    let n = 0;
    const p = progreso(await col.countDocuments(filtro), 'Fase 2 · editoriales falsas');
    for await (const doc of col.find(filtro, { projection: { editorial: 1, deshacer: 1, titulo: 1, alertas_agente: 1, ruta_base: 1 } })) {
        p.paso(doc.titulo);
        const actual = nombrePorId.get(String(doc.editorial));
        if (!actual || !esEditorialFalsa(actual)) continue;
        // La editorial que tenía ANTES de la pasada (la entrada más antigua del periodo que la cambió).
        const entrada = entradasDe(doc).find((e) => e.antes && 'editorial' in e.antes);
        if (!entrada) continue;
        const anterior = entrada.antes.editorial;
        const nombreAnterior = anterior ? nombrePorId.get(String(anterior)) : null;
        if (nombreAnterior && esEditorialFalsa(nombreAnterior)) continue;   // antes también era falsa: nada que devolver
        n++;
        p.nota(`${doc._id} · «${actual}» → ${nombreAnterior ? `«${nombreAnterior}»` : '(sin editorial)'} · «${String(doc.titulo || '').slice(0, 45)}»`);
        if (EJECUTAR) {
            const update = anterior ? { $set: { editorial: anterior } } : { $unset: { editorial: '' } };
            await guardar(doc, update, { editorial: doc.editorial },
                `Editorial «${actual}» (un distribuidor o marcador, no una editorial) devuelta a ${nombreAnterior ? `«${nombreAnterior}»` : 'vacía'}.`);
        }
    }
    p.fin();
    resumen.push(`Fase 2 · editoriales falsas devueltas a la anterior: ${n}`);
}

// ─── FASE 3: editoriales con puntuación en el nombre ─────────────────────────────────────────────────────────
if (toca(3)) {
    const colEd = db.collection('editoriales');
    const todas = await colEd.find({}).toArray();
    const porNombre = new Map(todas.map((e) => [e.nombre, e]));
    const PROPIOS = new Set(['_id', 'nombre', 'nombres_alternativos', 'fecha_creacion', 'fecha_actualizacion']);
    let fusionadas = 0, renombradas = 0, aMano = 0;
    const sucias = todas.filter((e) => e.nombre && limpiarNombreEditorial(e.nombre) && limpiarNombreEditorial(e.nombre) !== e.nombre);
    const p = progreso(sucias.length, 'Fase 3 · nombres de editorial');
    for (const e of sucias) {
        p.paso(e.nombre);
        const limpio = limpiarNombreEditorial(e.nombre);
        const destino = porNombre.get(limpio);
        const conDatos = Object.keys(e).some((k) => !PROPIOS.has(k));
        if (destino && conDatos) { aMano++; p.nota(`✋ «${e.nombre}» tiene datos propios: fusiónala a mano con «${limpio}»`); continue; }
        if (destino) {
            fusionadas++;
            p.nota(`«${e.nombre}» → se fusiona con «${limpio}»`);
            if (EJECUTAR) await fusionarEditoriales(db, destino._id, [e._id]);
        } else {
            renombradas++;
            p.nota(`«${e.nombre}» → se renombra «${limpio}»`);
            if (EJECUTAR) {
                const alt = [...new Set([...(e.nombres_alternativos || []), e.nombre])];
                await colEd.updateOne({ _id: e._id }, { $set: { nombre: limpio, nombres_alternativos: alt, fecha_actualizacion: new Date() } });
                porNombre.set(limpio, { ...e, nombre: limpio });
            }
        }
    }
    p.fin();
    resumen.push(`Fase 3 · editoriales con puntuación: ${fusionadas} fusionadas, ${renombradas} renombradas, ${aMano} a mano`);
    if (EJECUTAR && fusionadas) resumen.push('         (los sidecars de sus libros los pone al día la campaña «sidecars»)');
}

// ─── FASE 7: colecciones con « /**/ » en el nombre ───────────────────────────────────────────────────────────
if (toca(7)) {
    const colCol = db.collection('colecciones');
    const RE_SEPARADOR = new RegExp(String.raw`/\*\*/`);
    const afectadas = await colCol.find({ nombre: RE_SEPARADOR }).toArray();
    let fusionadas = 0, renombradas = 0;
    const p = progreso(afectadas.length, 'Fase 7 · colecciones con /**/');
    for (const c of afectadas) {
        p.paso(c.nombre);
        const { nombre, numero } = separarSerie(c.nombre);
        if (!nombre) continue;
        // Por nombre (sin mayúsculas ni acentos) y, si el nombre da clave canónica, por ella. Un nombre de UNA palabra
        // no tiene clave (null): buscar por clave null casaría con cualquier colección sin clave («Millenium» →
        // «Legendarium» en el primer ensayo).
        const clave = claveCanonica(nombre);
        const destino = await colCol.findOne({ nombre, _id: { $ne: c._id } }, { collation: { locale: 'es', strength: 1 } })
            || (clave ? await colCol.findOne({ clave_canonica: clave, _id: { $ne: c._id } }) : null);
        p.nota(`«${c.nombre}» → ${destino ? `se fusiona con «${destino.nombre}»` : `«${nombre}»`}${numero ? ` (nº ${numero} a sus libros)` : ''}`);
        if (!EJECUTAR) { if (destino) fusionadas++; else renombradas++; continue; }
        // El número que iba pegado al nombre, a los libros que no tengan el suyo.
        if (numero) {
            await col.updateMany({ coleccion: c._id, $or: [{ coleccion_numero: { $exists: false } }, { coleccion_numero: null }, { coleccion_numero: '' }] },
                { $set: { coleccion_numero: String(numero) } });
        }
        if (destino) {
            await fusionarColecciones(db, [c._id], destino._id);
            fusionadas++;
        } else {
            await colCol.updateOne({ _id: c._id }, { $set: { nombre, clave_canonica: claveCanonica(nombre), fecha_actualizacion: new Date() } });
            await col.updateMany({ coleccion: c._id }, { $set: { coleccion_nombre: nombre, fecha_actualizacion: new Date() } });
            renombradas++;
        }
    }
    p.fin();
    // Libros con el separador en su coleccion_nombre (texto), estén o no en una colección.
    const sueltos = await col.countDocuments({ coleccion_nombre: RE_SEPARADOR });
    if (EJECUTAR && sueltos) {
        for await (const d of col.find({ coleccion_nombre: RE_SEPARADOR }, { projection: { coleccion_nombre: 1 } })) {
            const { nombre } = separarSerie(d.coleccion_nombre);
            if (nombre) await col.updateOne({ _id: d._id }, { $set: { coleccion_nombre: nombre } });
        }
    }
    resumen.push(`Fase 7 · colecciones con /**/: ${fusionadas} fusionadas, ${renombradas} renombradas · ${sueltos} libros con el separador en su serie`);
}

// ─── FASE 10: editoriales que la visión «leyó» en la cubierta de un maquetador ──────────────────────────────
// En los ficheros de ePubLibre la cubierta lleva SU logotipo. La visión lo leía como «se», «Se», «ge», «9e»… o
// lo tomaba por «Seix Barral», y esa «editorial» sustituía a «ePubLibre» como «la real» (medido: 225 y 219 libros).
if (toca(10)) {
    const colEd = db.collection('editoriales');
    const todas = await colEd.find({}, { projection: { nombre: 1 } }).toArray();
    const nombrePorId = new Map(todas.map((e) => [String(e._id), e.nombre]));
    const deRuido = todas.filter((e) => e.nombre && esNombreRuido(e.nombre));
    const seix = todas.find((e) => e.nombre === 'Seix Barral');
    const RE_SUSTITUIDA = new RegExp(String.raw`^Editorial "[^"]+" sustituida por la editorial real: "(.+)"\.$`);
    const alertaDeSustitucion = (doc) => (doc.alertas_agente || []).map((a) => String(a).match(RE_SUSTITUIDA)).find(Boolean);
    const proyeccion = { titulo: 1, editorial: 1, isbn: 1, alertas_agente: 1, ruta_base: 1 };

    let quitadasRuido = 0, quitadasSeix = 0;
    const sinConfirmar = [];

    // (a) Nombres de una o dos letras: no son una editorial, vengan de donde vengan.
    const filtroRuido = { editorial: { $in: deRuido.map((e) => e._id) } };
    const pa = progreso(await col.countDocuments(filtroRuido), 'Fase 10 · editoriales de una o dos letras');
    for await (const doc of col.find(filtroRuido, { projection: proyeccion })) {
        pa.paso(doc.titulo);
        quitadasRuido++;
        if (quitadasRuido <= 15) pa.nota(`${doc._id} · quitar «${nombrePorId.get(String(doc.editorial))}» · «${recorta(doc.titulo)}»`);
        if (EJECUTAR) {
            await guardar(doc, { $unset: { editorial: '' } }, { editorial: doc.editorial },
                `Editorial «${nombrePorId.get(String(doc.editorial))}» quitada: no es una editorial (la visión leyó así el logotipo de la cubierta).`);
        }
    }
    pa.fin();

    // (b) «Seix Barral» puesta en lugar de un maquetador, en libros cuyo ISBN no es de Seix Barral (o sin ISBN).
    if (seix) {
        const filtroSeix = { editorial: seix._id };
        const pb = progreso(await col.countDocuments(filtroSeix), 'Fase 10 · «Seix Barral» de la visión');
        for await (const doc of col.find(filtroSeix, { projection: proyeccion })) {
            pb.paso(doc.titulo);
            const sustitucion = alertaDeSustitucion(doc);
            if (!sustitucion || sustitucion[1] !== 'Seix Barral') continue;       // la trajo el fichero o la pusiste tú
            if (/^(97884322|84322)/.test(cifrasISBN(doc.isbn))) continue;        // ISBN de Seix Barral: es suya
            quitadasSeix++;
            if (quitadasSeix <= 15) pb.nota(`${doc._id} · quitar «Seix Barral» · isbn ${doc.isbn || '—'} · «${recorta(doc.titulo)}»`);
            if (EJECUTAR) {
                await guardar(doc, { $unset: { editorial: '' } }, { editorial: doc.editorial },
                    'Editorial «Seix Barral» quitada: la puso la visión al leer la cubierta de ePubLibre, y el ISBN del libro no es de Seix Barral.');
            }
        }
        pb.fin();
    }

    // (c) Los demás libros SIN ISBN cuya editorial sustituyó a la de un maquetador: nada la confirma. A revisar.
    const filtroResto = { editorial: { $exists: true }, $or: [{ isbn: { $exists: false } }, { isbn: null }, { isbn: '' }],
        alertas_agente: /sustituida por la editorial real/ };
    const pc = progreso(await col.countDocuments(filtroResto), 'Fase 10 · editoriales sin confirmar');
    for await (const doc of col.find(filtroResto, { projection: proyeccion })) {
        pc.paso(doc.titulo);
        const sustitucion = alertaDeSustitucion(doc);   // (las «deducidas de la colección» no casan: son fiables)
        const actual = nombrePorId.get(String(doc.editorial));
        if (!sustitucion || sustitucion[1] !== actual) continue;
        if (actual === 'Seix Barral' || esNombreRuido(actual)) continue;          // ya tratadas arriba
        sinConfirmar.push(doc._id);
    }
    pc.fin();

    resumen.push(`Fase 10 · editoriales de la visión: ${quitadasRuido} de una o dos letras y ${quitadasSeix} «Seix Barral» quitadas`);
    await seleccionDeRevision('Editorial sin confirmar (sin ISBN, en lugar del maquetador)',
        'Libros sin ISBN cuya editorial sustituyó a la de un maquetador (ePubLibre…) sin que la colección la avale: pudo leerla la visión en la cubierta. Revísala.',
        sinConfirmar);
}

// ─── FASE 8: deshacer y rehacer lo que el motor corregido haría de otra manera ──────────────────────────────
/**
 * Devuelve un documento a como estaba antes de UNA entrada de su diario: cada campo a su valor anterior (null = no
 * existía), la CDU y la carpeta incluidas. La entrada queda marcada como deshecha (no se borra: es historia).
 */
async function deshacerEntrada(doc, entrada, motivo) {
    const antes = entrada.antes || {};
    const set = {}, unset = {};
    for (const [campo, valor] of Object.entries(antes)) {
        if (['cdu', 'cdu_fuente', 'ruta_base'].includes(campo)) continue;        // la CDU y la carpeta, abajo
        if (valor === null || valor === undefined) unset[campo] = ''; else set[campo] = valor;
    }
    // La CDU que la pasada aplicó (de la BNE, por ese ISBN) movió la carpeta: vuelve a la anterior, moviéndola.
    if (antes.cdu && antes.cdu !== doc.cdu) {
        const reub = await reubicarPorCdu(doc, modernizarCDU(antes.cdu));
        if (reub) Object.assign(set, reub.set);
        if (antes.cdu_fuente) set.cdu_fuente = antes.cdu_fuente; else unset.cdu_fuente = '';
    }
    // Deja de estar «ya revisado»: se va a reidentificar.
    unset[CAMPO_MARCA_RECUPERAR_ISBN] = '';
    const ahora = new Date();
    await col.updateOne({ _id: doc._id }, {
        $set: { ...set, fecha_actualizacion: ahora, 'deshacer.$[entrada].deshecho': ahora },
        $unset: unset,
        $push: { alertas_agente: `Identificación del ${new Date(entrada.fecha).toISOString().slice(0, 10)} deshecha (${motivo}); se reidentifica con el motor corregido.` },
    }, { arrayFilters: [{ 'entrada.fecha': entrada.fecha, 'entrada.origen': 'reidentificar' }] });
}

if (toca(8)) {
    const tocados = await col.find(filtroPasada).toArray();

    // Quién tiene cada ISBN en TODA la base (para ver los compartidos con otro título).
    const porIsbn = new Map();
    const pIndice = progreso(await col.countDocuments({ isbn: { $type: 'string' } }), 'Fase 8 · índice de ISBN');
    for await (const d of col.find({ isbn: { $type: 'string' } }, { projection: { titulo: 1, isbn: 1, obra: 1, volumen_numero: 1 } })) {
        pIndice.paso();
        const clave = cifrasISBN(d.isbn);
        if (!porIsbn.has(clave)) porIsbn.set(clave, []);
        porIsbn.get(clave).push(d);
    }
    pIndice.fin();

    /** ¿Casi todas las palabras con cuerpo del título más corto están en el otro? (sin mirar números ni orden) */
    function compartenPalabras(a, b) {
        const palabras = (titulo) => new Set(tituloComparable(titulo).split(' ').filter((w) => w.length > 3 && !/^\d+$/.test(w)));
        const [corto, largo] = palabras(a).size <= palabras(b).size ? [palabras(a), palabras(b)] : [palabras(b), palabras(a)];
        if (!corto.size) return false;
        return [...corto].filter((w) => largo.has(w)).length / corto.size >= 0.8;
    }

    /** ¿Por qué habría que rehacer este documento? (null = está bien) */
    function motivoParaRehacer(doc) {
        const entrada = entradasDe(doc).filter((e) => e.isbn).pop();
        if (!entrada || !doc.isbn) return null;
        const via = String(entrada.via || '');
        const conEseIsbn = (porIsbn.get(cifrasISBN(doc.isbn)) || []).filter((o) => String(o._id) !== String(doc._id));
        // Otro TOMO de la misma obra con el mismo ISBN: es el del conjunto, no el de cada tomo.
        const otroTomo = doc.obra && conEseIsbn.find((o) => String(o.obra || '') === String(doc.obra)
            && (o.volumen_numero !== doc.volumen_numero || tituloComparable(o.titulo) !== tituloComparable(doc.titulo)));
        if (otroTomo) return `comparte el ISBN ${doc.isbn} con otro tomo de su obra («${recorta(otroTomo.titulo, 35)}»): es el del conjunto`;
        // Otro documento cuyo título no tiene nada que ver. (Dos copias del mismo libro con títulos desaliñados —
        // «HAGEL, S. (2010) Ancient Greek Music» / «Ancient Greek Music»— no cuentan: comparten casi todas las palabras.)
        const deOtroTitulo = conEseIsbn.find((o) => !compartenPalabras(o.titulo, doc.titulo));
        if (deOtroTitulo) return `comparte el ISBN ${doc.isbn} con «${recorta(deOtroTitulo.titulo, 35)}», otro título`;
        if (entrada.antes && 'titulo' in entrada.antes && esTituloDeLoteAudio(doc.titulo)) return 'recibió la edición de un lote con audio';
        if (via.startsWith('autoridad/') && esMaterialDerivado(entrada.antes?.titulo || doc.titulo)) return 'es material derivado y recibió el ISBN del libro';
        if (via === 'fichero' && doc.nombre_archivo) {
            // El ISBN del nombre del fichero y el asignado, ¿de editoriales distintas? (comienzo del ISBN-13)
            const prefijo = (isbn) => variantesISBN(isbn).map(cifrasISBN).find((v) => v.length === 13)?.slice(0, 7);
            const delNombre = extraerISBNs(doc.nombre_archivo).map((x) => validarISBN(x)).find(Boolean);
            if (delNombre && prefijo(delNombre) && prefijo(doc.isbn) && prefijo(delNombre) !== prefijo(doc.isbn)) {
                return `el ISBN del contenido (${doc.isbn}) es de otra editorial que el del nombre del fichero (${delNombre})`;
            }
        }
        return null;
    }

    const aRehacer = tocados.map((doc) => ({ doc, motivo: motivoParaRehacer(doc) })).filter((x) => x.motivo);
    const porMotivo = {};
    for (const x of aRehacer) { const k = x.motivo.replace(/ISBN \S+|«.*?»|\(.*?\)/g, '…'); porMotivo[k] = (porMotivo[k] || 0) + 1; }

    // Al ejecutar se mueven carpetas: hay que estar en la máquina que las tiene (el NAS).
    let enEstaMaquina = true;
    if (EJECUTAR && aRehacer.length) {
        const muestra = aRehacer.slice(0, 20);
        let vistas = 0;
        for (const x of muestra) if (await carpetaExiste(carpetaDeDoc(x.doc))) vistas++;
        enEstaMaquina = vistas >= Math.ceil(muestra.length / 2);
        if (!enEstaMaquina) console.error(`\n⛔ Fase 8: solo ${vistas} de ${muestra.length} carpetas de muestra están en esta máquina. Se salta (hay que ejecutarla en el NAS).`);
    }

    let rehechos = 0, conIsbnNuevo = 0, sinIsbn = 0, fallos = 0;
    const p = progreso(aRehacer.length, 'Fase 8 · deshacer y rehacer');
    for (const { doc, motivo } of (enEstaMaquina ? aRehacer : [])) {
        p.paso(doc.titulo);
        if (!EJECUTAR) {
            // En seco, con --con-reidentificar y el fichero a mano, se enseña qué haría el motor corregido.
            let previsto = '';
            if (CON_REIDENTIFICAR) {
                const comoEstaba = { ...doc };
                for (const entrada of entradasDe(doc).reverse()) {
                    for (const [campo, valor] of Object.entries(entrada.antes || {})) {
                        if (valor === null || valor === undefined) delete comoEstaba[campo]; else comoEstaba[campo] = valor;
                    }
                }
                const r = await reidentificarDoc(db, comoEstaba, { aplicar: false, usarApis: true }).catch((e) => ({ estado: 'error', motivo: e.message }));
                previsto = ` ⇒ ${r.estado}${r.isbn ? ` isbn=${r.isbn}` : ''}${r.isbn_obra ? ` obra=${r.isbn_obra}` : ''}${r.motivo ? ` (${recorta(r.motivo, 90)})` : ''}`;
            }
            p.nota(`${doc._id} · «${recorta(doc.titulo, 40)}» · ${motivo}${previsto}`);
            continue;
        }
        try {
            // Todas las entradas de la pasada, de la última a la primera.
            let actual = doc;
            for (const entrada of entradasDe(doc).reverse()) {
                await deshacerEntrada(actual, entrada, motivo);
                actual = await col.findOne({ _id: doc._id });
            }
            const r = await reidentificarDoc(db, actual, { aplicar: true, usarApis: true });
            await anotarRevisionIsbn(db, doc._id, r).catch(() => {});
            const final = await col.findOne({ _id: doc._id });
            await regenerarSidecarsDoc(db, final, carpetaDeDoc(final)).catch(() => {});
            await indexarDoc(db, doc._id).catch(() => {});
            rehechos++;
            if (final.isbn) conIsbnNuevo++; else sinIsbn++;
            p.nota(`${doc._id} · «${recorta(doc.titulo, 40)}» · ${motivo} ⇒ ${final.isbn ? `isbn=${final.isbn}` : 'sin ISBN'}${final.isbn_obra ? ` · obra=${final.isbn_obra}` : ''}`);
        } catch (e) {
            fallos++;
            p.nota(`⛔ ${doc._id}: ${e.message}`);
        }
    }
    p.fin();
    resumen.push(`Fase 8 · identificaciones a rehacer: ${aRehacer.length}${EJECUTAR ? ` → rehechas ${rehechos} (${conIsbnNuevo} con su ISBN, ${sinIsbn} sin ISBN propio${fallos ? `, ${fallos} fallos` : ''})` : ''}`);
    for (const [motivo, n] of Object.entries(porMotivo).sort((a, b) => b[1] - a[1])) resumen.push(`         ${String(n).padStart(4)} · ${motivo}`);
}

// ─── FASE 9: títulos ─────────────────────────────────────────────────────────────────────────────────────────
if (toca(9)) {
    // (a) El título que la pasada cambió por el mismo con una coletilla de catálogo: vuelve el suyo.
    let devueltos = 0;
    const filtroTitulo = { deshacer: { $elemMatch: { origen: 'reidentificar', fecha: { $gte: DESDE }, 'antes.titulo': { $exists: true } } } };
    const pa = progreso(await col.countDocuments(filtroTitulo), 'Fase 9 · títulos con coletilla');
    for await (const doc of col.find(filtroTitulo)) {
        pa.paso(doc.titulo);
        const entrada = entradasDe(doc).find((e) => e.antes && 'titulo' in e.antes);
        const anterior = entrada?.antes?.titulo;
        if (!anterior || !soloAnadeColetilla(anterior, doc.titulo)) continue;
        devueltos++;
        pa.nota(`${doc._id} · «${recorta(doc.titulo, 60)}» → «${recorta(anterior, 50)}»`);
        if (EJECUTAR) {
            await guardar(doc, { $set: { titulo: anterior } }, { titulo: doc.titulo },
                `Título devuelto a «${anterior}»: el de la autoridad solo le añadía una coletilla de catálogo («${recorta(doc.titulo, 80)}»).`);
        }
    }
    pa.fin();

    // (b) Títulos-artefacto de TODA la base que ya tienen ISBN: nuevo cotejo con la autoridad (y, si nadie
    //     responde, el título que lleva el nombre del fichero).
    const artefactos = [];
    const pb0 = progreso(await col.countDocuments({ isbn: { $type: 'string' } }), 'Fase 9 · buscando títulos-artefacto');
    for await (const doc of col.find({ isbn: { $type: 'string' }, tipo_recurso: 'libro' }, { projection: { titulo: 1, isbn: 1, nombre_archivo: 1 } })) {
        pb0.paso();
        if (esTituloArtefacto(doc.titulo)) artefactos.push(doc);
    }
    pb0.fin();
    let cotejados = 0, conTituloNuevo = 0, delNombre = 0;
    const pb = progreso(artefactos.length, 'Fase 9 · títulos-artefacto con ISBN');
    for (const resumenDoc of artefactos) {
        pb.paso(resumenDoc.titulo);
        const delFichero = tituloDeNombreDeLote(resumenDoc.nombre_archivo || resumenDoc.titulo);
        if (!EJECUTAR && !CON_REIDENTIFICAR) {
            if (delFichero) delNombre++;
            if (cotejados++ < 25) pb.nota(`${resumenDoc._id} · «${recorta(resumenDoc.titulo, 55)}»${delFichero ? ` (del nombre: «${recorta(delFichero, 45)}»)` : ''}`);
            continue;
        }
        const doc = await col.findOne({ _id: resumenDoc._id });
        const r = await reidentificarDoc(db, doc, { aplicar: EJECUTAR, usarApis: true, forzar: true }).catch((e) => ({ estado: 'error', motivo: e.message }));
        cotejados++;
        const nuevo = r.set?.titulo || (r.titulo !== doc.titulo ? r.titulo : null);
        if (nuevo) { conTituloNuevo++; pb.nota(`${doc._id} · «${recorta(doc.titulo, 45)}» → «${recorta(nuevo, 55)}»`); }
    }
    pb.fin();
    resumen.push(`Fase 9 · títulos: ${devueltos} devueltos al suyo (coletilla de catálogo) · ${artefactos.length} títulos-artefacto con ISBN`
        + (EJECUTAR || CON_REIDENTIFICAR ? ` → ${conTituloNuevo} con título nuevo` : ` (${delNombre} con título en el nombre del fichero; el resto depende de la autoridad: --con-reidentificar para verlo)`));
}

// ─── FASES con script propio ─────────────────────────────────────────────────────────────────────────────────
function lanzar(script, extra = []) {
    return new Promise((resolve) => {
        const argumentos = [path.join(RAIZ, 'scripts', script), ...extra, ...(EJECUTAR ? ['--ejecutar'] : [])];
        console.log(`\n▶▶ ${script} ${[...extra, ...(EJECUTAR ? ['--ejecutar'] : [])].join(' ')}\n`);
        const hijo = spawn(process.execPath, argumentos, { stdio: 'inherit', cwd: RAIZ });
        hijo.on('exit', (codigo) => resolve(codigo ?? 1));
    });
}
const comoFue = (codigo) => (codigo === 0 ? 'bien' : 'con fallos (mira su log)');
if (toca(12)) resumen.push(`Fase 12 · reparar-cdu-contaminada: ${comoFue(await lanzar('reparar-cdu-contaminada.js'))}`);
if (toca(4)) resumen.push(`Fase 4 · modernizar-cdu: ${comoFue(await lanzar('modernizar-cdu.js'))}`);
if (toca(5)) resumen.push(`Fase 5 · editoriales-por-prefijo: ${comoFue(await lanzar('editoriales-por-prefijo.js'))}`);

// ─── FASE 11: selecciones para revisar a mano ────────────────────────────────────────────────────────────────
if (toca(11)) {
    // Lengua de una CDU de literatura: «821.134.2-31"19"» → «134.2»; null si no es literatura de una lengua.
    const lenguaLiteraria = (cdu) => String(modernizarCDU(cdu) || '').match(/^(?:087(?:\.\d+)*:)?821\.([\d.']+?)\.?(?=[^\d.']|$)/)?.[1] || null;
    const LENGUAS_CONOCIDAS = new Set(['1', '11', '111', '112', '112.2', '112.5', '113', '113.4', '113.5', '113.6', '124', '13', '131.1', '133',
        '133.1', '134', '134.1', '134.2', '134.3', '134.4', '135.1', '14', "14'02", "14'06", '16', '161', '161.1', '161.2', '162', '162.1', '162.3',
        '162.4', '163', '163.2', '163.41', '163.42', '21', '214.21', '22', '222.1', '361', '41', '411.16', '411.21', '51', '511', '511.111',
        '511.113', '511.141', '512.161', '521', '531', '581']);
    const GRUPOS = [[/^2/, 'fr'], [/^3/, 'de'], [/^4/, 'ja'], [/^5/, 'ru'], [/^7/, 'zh'], [/^88/, 'it'], [/^(85|972|989)/, 'pt'], [/^(90|94)/, 'nl'], [/^[01]/, 'en']];
    const lenguaDelGrupo = (isbn) => {
        const c = cifrasISBN(isbn);
        const cuerpo = c.length === 13 ? (c.startsWith('978') ? c.slice(3) : '') : c;
        return cuerpo.length >= 9 ? (GRUPOS.find(([re]) => re.test(cuerpo))?.[1] || null) : null;
    };
    const pareceEspanol = (titulo) => /[áéíóúñ¿¡]|\b(el|la|los|las|del|una?|y|en|para|por|con|sobre|historia|vida|cuentos?)\b/i.test(String(titulo || ''));

    const cduOtraLengua = [], isbnOtraLengua = [];
    const p = progreso(await col.countDocuments(filtroPasada), 'Fase 11 · buscando qué revisar');
    for await (const doc of col.find(filtroPasada, { projection: { titulo: 1, cdu: 1, cdu_fuente: 1, isbn: 1, idioma: 1, deshacer: 1 } })) {
        p.paso(doc.titulo);
        const entradas = entradasDe(doc);
        if (!entradas.length) continue;

        // (a) CDU de la BNE cuya lengua contradice a la que había (deducida), o que no existe.
        const conCdu = entradas.find((e) => e.antes && 'cdu' in e.antes);
        const ahora = lenguaLiteraria(doc.cdu), antes = conCdu ? lenguaLiteraria(conCdu.antes.cdu) : null;
        if (ahora && doc.cdu_fuente === 'bne') {
            const distinta = antes && !(ahora.startsWith(antes) || antes.startsWith(ahora));
            if (distinta || !LENGUAS_CONOCIDAS.has(ahora)) {
                cduOtraLengua.push(doc._id);
                if (cduOtraLengua.length <= 20) p.nota(`CDU  ${doc._id} · ${conCdu?.antes?.cdu || '—'} → ${doc.cdu} · «${recorta(doc.titulo, 40)}»`);
            }
        }

        // (b) ISBN dado por autoridad cuyo grupo es de otra lengua que el documento.
        const conIsbn = entradas.filter((e) => e.isbn).pop();
        const idioma = String(doc.idioma || '').toLowerCase().slice(0, 2);
        if (conIsbn && doc.isbn && String(conIsbn.via || '').startsWith('autoridad/') && ['es', 'ca', 'gl', 'eu', 'fr', 'it', 'pt', 'de'].includes(idioma)) {
            const grupo = lenguaDelGrupo(doc.isbn);
            const deEspana = /^(97884|84)/.test(cifrasISBN(doc.isbn));
            // Un ISBN del grupo inglés en un libro en español solo es sospechoso si el título está en español y la
            // identificación no es segura (en EE. UU. se publica en español; y muchos «es» son libros en inglés).
            const sospechoso = grupo && !deEspana && grupo !== idioma
                && (grupo !== 'en' || (/PROVISIONAL|DUDOSO/.test(conIsbn.via) && pareceEspanol(doc.titulo)));
            if (sospechoso) {
                isbnOtraLengua.push(doc._id);
                if (isbnOtraLengua.length <= 20) p.nota(`ISBN ${doc._id} · ${idioma} ≠ grupo ${grupo} · ${doc.isbn} · «${recorta(doc.titulo, 40)}»`);
            }
        }
    }
    p.fin();
    resumen.push(`Fase 11 · para revisar a mano: ${cduOtraLengua.length} CDU de la BNE de otra lengua · ${isbnOtraLengua.length} ISBN de otra lengua`);
    await seleccionDeRevision('CDU de la BNE de otra lengua',
        'La CDU de la BNE clasifica el libro en una literatura distinta de la que se había deducido (Hemingway como española), o con un número que no existe («821.11(73)»). Comprueba la CDU.',
        cduOtraLengua);
    await seleccionDeRevision('ISBN de otra lengua',
        'El ISBN que dio la autoridad es de un grupo de otra lengua que la del libro («1984» en español con el ISBN de la edición alemana). Comprueba que es tu edición.',
        isbnOtraLengua);
}

// ─── FASE 6: reidentificar de nuevo (los que quedaron «con esperanza», los sin decidir y lo deshecho) ─────────
if (toca(6)) {
    const opciones = ['--todos', '--edicion-por-elegir'];
    if (!EJECUTAR && !CON_REIDENTIFICAR) {
        resumen.push('Fase 6 · reidentificar --todos --edicion-por-elegir: saltada en seco (tarda horas; --con-reidentificar para verla)');
    } else {
        resumen.push(`Fase 6 · reidentificar ${opciones.join(' ')}: ${comoFue(await lanzar('reidentificar-sin-isbn.js', opciones))}`);
    }
}

console.log(`\n=== ${EJECUTAR ? 'HECHO' : 'DRY-RUN'} ===`);
for (const l of resumen) console.log(`  ${l}`);
if (!EJECUTAR) console.log('\n▶ Repite con --ejecutar para aplicarlo (antes: copia de la base; Conformador y campañas apagados).');
process.exit(0);
