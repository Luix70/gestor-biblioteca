import { ObjectId } from 'mongodb';
import { conectarDB } from './database.js';
import { ErrorInfraestructura, esErrorDeMongo } from './errores.js';
import { resolverColeccion, resolverCabecera, registrarNumeroEnColeccion, separarNumeroColeccion } from './utils/colecciones.js';
import { resolverObra, registrarVolumenEnObra } from './utils/obras.js';
import { claveNumero, tituloCabecera } from './utils/revistas.js';
import { resolverObraPorIsbn } from './utils/obra-autoridad.js';
import { variantesISBN } from './utils/identificadores.js';
import { resolverPersona } from './utils/resolver-persona.js';
import { separarAutores } from './utils/autor-normalizar.js';
import { ROLES_VALIDOS, esComicPorDatos, promoverIlustradorSiComic } from './utils/contribuciones.js';

const vacio = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const union = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));

/** Busca un documento ya catalogado por su hash de contenido (SHA-256). Para el atajo de ingesta:
 *  si el fichero entrante ya está archivado (hash idéntico) no hace falta extraer/enriquecer. */
export async function buscarDocPorHash(hash) {
    if (!hash) return null;
    const db = await conectarDB();
    return db.collection('biblioteca').findOne({ hash_contenido: hash });
}

/**
 * Calcula los cambios al re-procesar un libro ya catalogado (búsqueda futura con mejor info).
 * Reglas: (1) rellenar huecos siempre; (2) si el registro estaba 'pendiente' y la nueva
 * pasada lo identifica ('completado'), refrescar identificadores/clasificación con los nuevos;
 * (3) unir formatos, palabras_clave, imágenes y alertas. Nunca se degrada un dato bueno.
 */
function calcularActualizacion(existente, nuevo) {
    const set = {};
    const CAMPOS = ['titulo', 'subtitulo', 'isbn', 'issn', 'idioma', 'cdu', 'dewey', 'lcc', 'lccn', 'sinopsis', 'editorial', 'año_edicion', 'portada', 'ubicacion', 'tipo_recurso', 'volumen_numero', 'numero_edicion', 'nombre_archivo', 'hash_contenido', 'mes_publicacion', 'numero_issue', 'clave_numero', 'coleccion', 'coleccion_nombre', 'coleccion_numero', 'coleccion_numero_auto', 'obra', 'obra_titulo', 'volumen_titulo', 'isbn_obra', 'paginas', 'naturaleza'];

    // (1) Rellenar huecos (añadir información donde FALTA nunca borra).
    for (const c of CAMPOS) if (vacio(existente[c]) && !vacio(nuevo[c])) set[c] = nuevo[c];

    // (2) Upgrade pendiente -> completado: la nueva pasada REEMPLAZA los escalares… SALVO si el doc está
    // BLOQUEADO (locked = curado a mano ≈ no_override): entonces solo se RELLENAN huecos y se UNEN listas,
    // pero NUNCA se reemplaza lo que el usuario fijó. «Más información: bien. Borrar información: mal.»
    const mejora = existente.estado_verificacion === 'pendiente' && nuevo.estado_verificacion === 'completado';
    if (mejora) {
        if (!existente.locked) for (const c of CAMPOS) if (!vacio(nuevo[c])) set[c] = nuevo[c];
        set.estado_verificacion = 'completado';
    }

    // (3) Uniones.
    const formatos = union(existente.formatos, nuevo.formatos);
    if (formatos.length !== (existente.formatos || []).length) set.formatos = formatos;

    const palabras = union(existente.palabras_clave, nuevo.palabras_clave);
    if (palabras.length !== (existente.palabras_clave || []).length) set.palabras_clave = palabras;

    // Identificadores vistos (todos los ISBN/ISSN): ADITIVO (unir, nunca perder los ya guardados).
    const isbnC = union(existente.isbn_candidatos, nuevo.isbn_candidatos);
    if (isbnC.length !== (existente.isbn_candidatos || []).length) set.isbn_candidatos = isbnC;
    const issnC = union(existente.issn_candidatos, nuevo.issn_candidatos);
    if (issnC.length !== (existente.issn_candidatos || []).length) set.issn_candidatos = issnC;

    const imgs = [...(existente.imagenes || [])];
    for (const im of (nuevo.imagenes || [])) if (!imgs.some(x => x.ruta === im.ruta)) imgs.push(im);
    if (imgs.length !== (existente.imagenes || []).length) set.imagenes = imgs;

    const alertas = union(existente.alertas_agente, nuevo.alertas_agente);
    set.alertas_agente = [...alertas, 'Registro actualizado con nueva información.'];

    // ISBNs alternativos (otras ediciones): unir por isbn sin perder los ya registrados.
    const altsEx = Array.isArray(existente.isbns_alternativos) ? existente.isbns_alternativos : [];
    const altsNu = Array.isArray(nuevo.isbns_alternativos) ? nuevo.isbns_alternativos : [];
    if (altsNu.length) {
        const mapa = new Map(altsEx.map(a => [a.isbn, a]));
        for (const a of altsNu) if (a && a.isbn && !mapa.has(a.isbn)) mapa.set(a.isbn, a);
        if (mapa.size !== altsEx.length) set.isbns_alternativos = [...mapa.values()];
    }

    set.fecha_actualizacion = new Date();
    return set;
}

/**
 * Nivel 3: resuelve relaciones (autores/editorial → ObjectId) y persiste en 'biblioteca'.
 * Inserta si es nuevo; si ya existe (por ISBN, ISSN o título), fusiona la información.
 * Los fallos de conexión/operación de MongoDB se elevan como ErrorInfraestructura (→ Reintentos).
 */
export async function procesarCatalogo(documentoEnriquecido, opciones = {}) {
    let db;
    try {
        db = await conectarDB();
    } catch (e) {
        throw new ErrorInfraestructura('MongoDB inalcanzable', e);
    }

    const coleccionBiblioteca = db.collection('biblioteca');
    const coleccionEditoriales = db.collection('editoriales');

    let docFinal = { ...documentoEnriquecido };
    // El alta rápida por ISBN (sin enriquecer) no trae este array; sin él, cualquier `.push` de aviso
    // (nuevo autor/colección/…) revienta con "Cannot read properties of undefined (reading 'push')".
    if (!Array.isArray(docFinal.alertas_agente)) docFinal.alertas_agente = [];
    // Un tomo "?" (sin número determinable) lleva volumen_numero AUSENTE, nunca null (el $jsonSchema
    // lo tipa number|string). Si llegara null, se elimina para que el campo no exista.
    if (docFinal.volumen_numero == null) delete docFinal.volumen_numero;

    // Registra el tomo en el inventario de su obra (qué tomos hay y cuáles faltan). Declarada ANTES
    // del try para ser accesible también desde el manejador de E11000 (catch). Lee docFinal en el
    // momento de la llamada (ya tendrá .obra/.volumen_numero fijados por el paso 2c).
    const registrarTomo = async (idFinal) => {
        if (!idFinal) return;
        if (docFinal.tipo_recurso === 'revista') {
            // Número de revista → inventario cronológico de la CABECERA (colección tipo:'revista'),
            // no el array 1..N de las obras multivolumen.
            if (!docFinal.coleccion) return;
            await registrarNumeroEnColeccion(db, docFinal.coleccion, {
                clave: docFinal.clave_numero || null, 'año': docFinal.año_edicion ?? null,
                mes: docFinal.mes_publicacion ?? null, numero_issue: docFinal.numero_issue ?? null,
            }, idFinal);
        } else if (docFinal.obra) {
            // volumen_numero puede ser null ("tomo ?"): se registra igual (nunca se descarta un tomo).
            await registrarVolumenEnObra(db, docFinal.obra, docFinal.volumen_numero ?? null, idFinal, docFinal.obra_total);
        }
    };

    try {
        // 1. Autores (string → ObjectId; crea si no existe). La resolución (normaliza el marcador BNE «/**​/»,
        //    extrae fechas de vida, latiniza alfabetos no latinos + grafías alternativas, empareja/crea) vive
        //    en utils/resolver-persona.js, compartida con las contribuciones y los scripts de backfill.
        // CÓMIC: el dibujante es COAUTOR (al mismo nivel que el guionista). Antes de resolver, se pasan los
        // 'ilustrador' de la mención a AUTOR (el guionista ya viene como autor del parser). Anti-pérdida: solo
        // añade, no quita nada.
        if (Array.isArray(docFinal.contribuciones_nombres) && esComicPorDatos(docFinal)) {
            const { autoresExtra, contribuciones } = promoverIlustradorSiComic(docFinal.contribuciones_nombres, true);
            if (autoresExtra.length) {
                docFinal.autores = [...(docFinal.autores || []), ...autoresExtra];
                docFinal.contribuciones_nombres = contribuciones;
            }
        }

        if (docFinal.autores && docFinal.autores.length > 0) {
            const ids = [];
            const vistos = new Set();
            for (const autor of docFinal.autores) {
                if (typeof autor === 'string') {
                    // Una cadena puede traer VARIAS personas unidas por « & »/« ; »/« / » (p. ej. un epub con
                    // «Carroll, Lewis & Gardner, Martin») → se separan en personas distintas (normalización).
                    for (const nombre of separarAutores(autor)) {
                        const r = await resolverPersona(db, nombre);
                        if (!r || vistos.has(String(r._id))) continue;
                        vistos.add(String(r._id));
                        ids.push(r._id);
                        if (r.creada) docFinal.alertas_agente.push(`Nuevo autor registrado: ${r.nombre}`);
                    }
                } else if (!vistos.has(String(autor))) { vistos.add(String(autor)); ids.push(autor); }
            }
            docFinal.autores = ids;
        }

        // 1b. CONTRIBUCIONES con ROL (traductor/ilustrador/prologuista/anotador/editor/compilador), extraídas
        //     de la mención de responsabilidad. Llegan como `contribuciones_nombres:[{nombre,rol}]` (el autor
        //     principal ya se excluyó al parsear) → se resuelven a `contribuciones:[{persona,rol}]`, dedup por
        //     (persona,rol). Rol no reconocido → se ignora. El campo de trabajo crudo no se persiste.
        if (Array.isArray(docFinal.contribuciones_nombres) && docFinal.contribuciones_nombres.length) {
            const contribs = [];
            const vistos = new Set();
            for (const c of docFinal.contribuciones_nombres) {
                if (!c || !c.nombre || !ROLES_VALIDOS.includes(c.rol) || c.rol === 'autor') continue;
                const r = await resolverPersona(db, c.nombre);
                if (!r) continue;
                const clave = `${String(r._id)}|${c.rol}`;
                if (vistos.has(clave)) continue;
                vistos.add(clave);
                contribs.push({ persona: r._id, rol: c.rol });
                if (r.creada) docFinal.alertas_agente.push(`Nuevo contribuyente (${c.rol}): ${r.nombre}`);
            }
            if (contribs.length) docFinal.contribuciones = contribs;
        }
        delete docFinal.contribuciones_nombres;

        // 2. Editorial (string → ObjectId; crea si no existe).
        if (docFinal.editorial && typeof docFinal.editorial === 'string') {
            const existente = await coleccionEditoriales.findOne({ nombre: docFinal.editorial });
            if (existente) docFinal.editorial = existente._id;
            else {
                const nueva = await coleccionEditoriales.insertOne({ nombre: docFinal.editorial });
                docFinal.editorial = nueva.insertedId;
                docFinal.alertas_agente.push(`Nueva editorial registrada: ${documentoEnriquecido.editorial}`);
            }
        }

        // 2b. Colección/serie (nombre → ObjectId en 'colecciones'; crea si no existe, enlazando
        // la editorial ya resuelta). Se conserva coleccion_nombre denormalizado para MARC/registro.
        if (docFinal.coleccion_nombre && typeof docFinal.coleccion_nombre === 'string') {
            // Separar el número de volumen embebido en el nombre («Alianza Cien 15» → «Alianza Cien» + nº 15)
            // y unificar la grafía (alias), para NO crear una colección por cada tomo. El número, si aún no
            // estaba, pasa a coleccion_numero. Así todos los volúmenes enlazan a la MISMA colección.
            const { nombre: nomColeccion, numero: numColeccion } = separarNumeroColeccion(docFinal.coleccion_nombre);
            if (nomColeccion) docFinal.coleccion_nombre = nomColeccion;
            if (numColeccion && !docFinal.coleccion_numero) docFinal.coleccion_numero = String(numColeccion);
            const edId = (docFinal.editorial && typeof docFinal.editorial !== 'string') ? docFinal.editorial : null;
            const { _id, creada } = await resolverColeccion(db, docFinal.coleccion_nombre, edId);
            if (creada) docFinal.alertas_agente.push(`Nueva colección registrada: ${docFinal.coleccion_nombre}`);

            // NUMERACIÓN dentro de la colección (regla: el número EDITORIAL —leído del nombre/ISBN/datos—
            // PREVALECE; el asignado automáticamente cede). `coleccion_numero_auto:true` marca el AUTO, para
            // poder distinguirlo (y renumerarlo) después.
            if (opciones.serieAuto && !docFinal.coleccion_numero) {
                // Serie automática (drop por carpeta): sin número propio → el siguiente por encima del máximo.
                const miembros = await coleccionBiblioteca
                    .find({ coleccion: _id }, { projection: { coleccion_numero: 1 } }).toArray();
                const maxN = miembros.reduce((m, d) => {
                    const n = parseInt(d.coleccion_numero, 10);
                    return Number.isFinite(n) && n > m ? n : m;
                }, 0);
                docFinal.coleccion_numero = String(maxN + 1);
                docFinal.coleccion_numero_auto = true;
            } else if (docFinal.coleccion_numero != null && docFinal.coleccion_numero_auto !== true) {
                // Número EDITORIAL: si un miembro AUTO ya ocupa ese número, se le renumera a un hueco libre y
                // el entrante conserva el suyo → nunca hay conflicto de numeración.
                const nEnt = parseInt(docFinal.coleccion_numero, 10);
                if (Number.isFinite(nEnt)) {
                    const choca = await coleccionBiblioteca.findOne({ coleccion: _id, coleccion_numero: String(nEnt), coleccion_numero_auto: true });
                    if (choca) {
                        const miembros = await coleccionBiblioteca.find({ coleccion: _id }, { projection: { coleccion_numero: 1 } }).toArray();
                        const usados = new Set(miembros.map(d => parseInt(d.coleccion_numero, 10)).filter(Number.isFinite));
                        let libre = nEnt + 1; while (usados.has(libre)) libre++;
                        await coleccionBiblioteca.updateOne({ _id: choca._id }, { $set: { coleccion_numero: String(libre), coleccion_numero_auto: true } });
                        docFinal.alertas_agente.push(`Nº ${nEnt} de la colección liberado (editorial); el miembro auto pasa a ${libre}.`);
                    }
                }
            }
            docFinal.coleccion = _id;
        }

        // 2c. Obra multivolumen de LIBROS (tras editorial/colección, que se enlazan a la obra). Todos
        // los tomos comparten la CDU de la obra (un solo classmark → se archivan juntos). Las revistas
        // NO entran aquí: tienen su propio camino (2d), aunque traigan obra_titulo.
        if (docFinal.obra_titulo && typeof docFinal.obra_titulo === 'string' && docFinal.tipo_recurso !== 'revista') {
            const edId = (docFinal.editorial && typeof docFinal.editorial !== 'string') ? docFinal.editorial : null;
            const colId = (docFinal.coleccion && typeof docFinal.coleccion !== 'string') ? docFinal.coleccion : null;
            const { _id, cdu: cduObra, creada } = await resolverObra(db, {
                titulo: docFinal.obra_titulo, isbn_obra: docFinal.isbn_obra,
                editorialId: edId, coleccionId: colId, cdu: docFinal.cdu, total: docFinal.obra_total,
            });
            if (creada) docFinal.alertas_agente.push(`Nueva obra multivolumen registrada: ${docFinal.obra_titulo}`);
            if (_id) docFinal.obra = _id;
            if (cduObra) docFinal.cdu = cduObra; // todos los tomos comparten la CDU de la obra

            // Al CREAR la obra: resolver su título/sinopsis reales por el isbn_obra (autoridad), ya —
            // no esperar al Conformador. Fire-and-forget para NO añadir latencia a la ingesta del tomo
            // (la obra se renombra 1-2 s después); si la API falla, queda el nombre de carpeta y el
            // Conformador (completar-obra-por-isbn) lo reintenta.
            if (creada && _id && docFinal.isbn_obra) {
                resolverObraPorIsbn(db, _id)
                    .then(r => { if (r?.ok) console.log(`   📖 Obra resuelta por ISBN: "${r.titulo}".`); })
                    .catch(() => {});
            }
        }

        // 2d. CABECERA DE REVISTA (se modela como obra: tipo:'revista' + issn_obra). El ISSN es el
        // pivote: cada número se cuelga de su cabecera y su identidad es (cabecera, clave-de-número),
        // NO el ISSN suelto (eso fusionaba TODOS los números en un solo documento). Sin fecha/nº →
        // miembro "sin fecha" de la cabecera (nunca se fusiona, nunca se pierde).
        if (docFinal.tipo_recurso === 'revista') {
            const cn = claveNumero(docFinal);
            if (cn) docFinal.clave_numero = cn; else delete docFinal.clave_numero;
            const cabTitulo = tituloCabecera(docFinal.obra_titulo || docFinal.titulo);
            if (docFinal.issn || cabTitulo) {
                const edId = (docFinal.editorial && typeof docFinal.editorial !== 'string') ? docFinal.editorial : null;
                const { _id, cdu: cduCab, creada } = await resolverCabecera(db, {
                    nombre: cabTitulo, issn: docFinal.issn, tipo: 'revista', editorialId: edId, cdu: docFinal.cdu,
                    naturaleza: docFinal.naturaleza || null,   // cómics: la cabecera hereda naturaleza:'comic'
                });
                if (creada) docFinal.alertas_agente.push(`Nueva cabecera de revista registrada: ${cabTitulo || docFinal.issn}`);
                if (_id) { docFinal.coleccion = _id; if (cabTitulo) docFinal.coleccion_nombre = cabTitulo; }
                if (cduCab) docFinal.cdu = cduCab; // los números comparten la CDU de la cabecera
            }
        }

        // 2e. SERIE de LIBROS con ISSN de serie (p. ej. «Graduate Texts in Physics», ISSN 1868-4513): el
        // libro conserva su PROPIO ISBN; el ISSN es la AUTORIDAD de la SERIE, no del libro. Se modela como
        // colección tipo:'libro' (pivote ISSN) y el libro se cuelga de ella. El ISSN se RETIRA del
        // documento (su identidad es el ISBN; el ISSN vive en la colección) — así un ISSN de serie no
        // convierte el libro en revista ni fusiona libros distintos. Si 2b ya creó la colección por su
        // nombre, resolverCabecera la reencuentra por nombre y le añade el ISSN (no duplica).
        if (docFinal.tipo_recurso === 'libro' && docFinal.issn) {
            const edId = (docFinal.editorial && typeof docFinal.editorial !== 'string') ? docFinal.editorial : null;
            const nombreSerie = docFinal.coleccion_nombre || docFinal.obra_titulo || null;
            const { _id, creada } = await resolverCabecera(db, {
                nombre: nombreSerie, issn: docFinal.issn, tipo: 'libro', editorialId: edId, cdu: docFinal.cdu,
            });
            if (creada) docFinal.alertas_agente.push(`Nueva serie de libros registrada (ISSN ${docFinal.issn}): ${nombreSerie || docFinal.issn}`);
            if (_id) { docFinal.coleccion = _id; if (nombreSerie) docFinal.coleccion_nombre = nombreSerie; }
            delete docFinal.issn; // la autoridad ISSN vive en la colección, no en el libro
        }

        // NSFW HEREDADO: un nuevo miembro de una obra/colección marcada NSFW nace NSFW (así la marca
        // PROPAGA a los miembros FUTUROS; los actuales se propagan al marcar el padre desde el panel).
        if (!docFinal.nsfw && (docFinal.coleccion || docFinal.obra)) {
            const padres = await Promise.all([
                docFinal.coleccion ? db.collection('colecciones').findOne({ _id: docFinal.coleccion }, { projection: { nsfw: 1 } }) : null,
                docFinal.obra ? db.collection('obras').findOne({ _id: docFinal.obra }, { projection: { nsfw: 1 } }) : null,
            ]);
            if (padres.some(p => p?.nsfw)) docFinal.nsfw = true;
        }

        // SEGURIDAD MULTIVOLUMEN — un TOMO JAMÁS debe fusionarse con otro documento por su ISBN
        // (eso fusionaba/perdía tomos). Su identidad es (obra, volumen_numero), NO el ISBN. Por eso,
        // si el `isbn` del tomo (a) es el de la OBRA completa (set), o (b) ya pertenece a OTRO
        // documento (otro tomo, una variante de formato print/epub/tapa, o un código espurio), se
        // DESCARTA del tomo —que se guarda SIN isbn, identificado por obra+nº— y se marca anomalía.
        // Vale más un tomo sin ISBN que un tomo perdido.
        if (docFinal.obra && docFinal.isbn) {
            const variantesObra = docFinal.isbn_obra ? new Set(variantesISBN(docFinal.isbn_obra)) : new Set();
            const esDelSet = variantesISBN(docFinal.isbn).some(v => variantesObra.has(v));
            const choca = esDelSet ? null : await coleccionBiblioteca.findOne({ isbn: docFinal.isbn });
            const mismoTomo = choca && String(choca.obra) === String(docFinal.obra)
                && choca.volumen_numero != null && choca.volumen_numero === docFinal.volumen_numero;
            if (esDelSet) {
                delete docFinal.isbn; // el ISBN del set no es el del tomo
            } else if (choca && !mismoTomo) {
                docFinal.alertas_agente.push(`⚠ ISBN ${docFinal.isbn} ya pertenece a otro documento (${choca._id}); el tomo se guarda SIN isbn para NO fusionarlo.`);
                delete docFinal.isbn;
                docFinal.revision_requerida = true;
            }
        }

        // 3. Deduplicación en tres niveles:
        //
        // NIVEL A — Hash de contenido (SHA-256): detecta copias exactas del mismo archivo.
        //   • Mismo hash + mismo nombre_archivo → re-proceso del mismo fichero → ACTUALIZAR.
        //   • Mismo hash + nombre distinto → copia exacta con otro nombre → DUPLICADO_EXACTO.
        //
        // NIVEL B — Revistas: dedup por número de issue (ISSN + año + mes).
        //
        // NIVEL C — Libros con ISBN: solo actualiza si el nombre_archivo coincide (o el doc
        //   existente aún no tiene nombre_archivo — compatibilidad con docs pre-hash).
        //   Versiones distintas del mismo ISBN (ej. ePubLibre r2.7 vs r2.9) son docs distintos.

        // "CONSERVAR AMBOS" (opciones.forzarNuevo, override forzar_nuevo): se OMITE TODA la
        // deduplicación y se inserta como documento DISTINTO aunque comparta ISBN/título con otro
        // (biblioteca no tiene índice único de ISBN; servicio-ingesta desambigua la carpeta con un
        // sufijo del _id). Lo usa el panel para reingestar un duplicado que es otra edición/ejemplar.
        let filtro = null;
        if (!opciones.forzarNuevo) {
            // — Nivel A: hash
            if (docFinal.hash_contenido) {
                const hashDoc = await coleccionBiblioteca.findOne({ hash_contenido: docFinal.hash_contenido });
                if (hashDoc) {
                    if (hashDoc.nombre_archivo === docFinal.nombre_archivo) {
                        // Mismo fichero reprocesado (vuelta del Inbox, re-ingesta manual, etc.)
                        const cambios = calcularActualizacion(hashDoc, docFinal);
                        await coleccionBiblioteca.updateOne({ _id: hashDoc._id }, { $set: cambios });
                        const actualizado = await coleccionBiblioteca.findOne({ _id: hashDoc._id });
                        await registrarTomo(hashDoc._id);
                        return { ...actualizado, operacion: 'actualizacion' };
                    }
                    // Mismo contenido, nombre distinto → el llamante envía a Cuarentena
                    return { ...hashDoc, operacion: 'duplicado_exacto' };
                }
            }

            // — Nivel B0: tomo de obra multivolumen → (obra, volumen_numero) lo identifica.
            if (docFinal.obra && docFinal.volumen_numero != null) {
                filtro = { obra: docFinal.obra, volumen_numero: docFinal.volumen_numero };
            } else if (docFinal.tipo_recurso === 'revista') {
                // Identidad ROBUSTA de un número = (cabecera, clave-de-número). La cabecera es una
                // COLECCIÓN (tipo:'revista'). El ISSN suelto YA NO se usa como clave (fusionaba todos los
                // números). Con cabecera pero SIN clave (sin fecha/nº) → insertar (miembro "sin fecha").
                // Sin cabecera (sin ISSN) → caer a (título + año [+ mes]).
                if (docFinal.coleccion) {
                    if (docFinal.clave_numero) filtro = { coleccion: docFinal.coleccion, clave_numero: docFinal.clave_numero };
                } else if (docFinal.titulo && docFinal.año_edicion && docFinal.mes_publicacion) {
                    filtro = { titulo: docFinal.titulo, año_edicion: docFinal.año_edicion, mes_publicacion: docFinal.mes_publicacion };
                } else if (docFinal.titulo && docFinal.año_edicion) {
                    filtro = { titulo: docFinal.titulo, año_edicion: docFinal.año_edicion };
                }
            } else if (docFinal.isbn && !docFinal.obra) {
                // — Nivel C: libros con ISBN (NUNCA tomos de obra: jamás se fusionan por ISBN).
                //   Un mismo ISBN puede tener VARIOS documentos: UNO POR FORMATO (pdf, epub, mobi…),
                //   que es lo deseado (no se fusionan formatos en un solo registro; fundirlos más tarde
                //   es fácil, separarlos no). Solo deduplicamos contra el doc del MISMO formato:
                //     · mismo ISBN + mismo formato + mismo fichero  → ACTUALIZAR
                //     · mismo ISBN + mismo formato + OTRO fichero   → posible_duplicado (revisión)
                //     · mismo ISBN + formato NUEVO                  → documento DISTINTO (insertar)
                const candidatos = await coleccionBiblioteca.find({ isbn: docFinal.isbn }).toArray();
                if (candidatos.length) {
                    const miFormato = (docFinal.formatos || [])[0] || null;
                    const mismoFormato = miFormato
                        ? candidatos.find(c => (c.formatos || []).includes(miFormato))
                        : candidatos[0]; // sin formato conocido: compat con el comportamiento anterior
                    if (mismoFormato) {
                        const mismoArchivo = !mismoFormato.nombre_archivo
                            || mismoFormato.nombre_archivo === docFinal.nombre_archivo;
                        // POLÍTICA "nunca perder un documento": mismo ISBN+formato pero OTRO fichero (el
                        // hash idéntico ya se resolvió en el Nivel A) = OTRO documento → se INSERTA aparte
                        // (dedup posterior si procede). Antes iba a 'posible_duplicado' (riesgo de borrado).
                        if (mismoArchivo) filtro = { _id: mismoFormato._id };
                    }
                    // Ningún doc con este ISBN tiene este formato → otro formato del mismo libro: insertar.
                }
            }
            // (Se RETIRA el antiguo fallback `else if (issn) → {issn}`: fusionaba TODOS los números de
            //  una revista en un solo documento. Las revistas se deduplican ahora por (cabecera, clave).)
            // Sin filtro → siempre insertar
        }

        let existente = filtro ? await coleccionBiblioteca.findOne(filtro) : null;

        // POLÍTICA "nunca reemplazar un documento por otro": si el existente YA tiene un fichero con OTRO
        // nombre (y no es el mismo contenido — el hash idéntico ya se resolvió en el Nivel A), NO se
        // fusiona: el entrante es un documento DISTINTO y se inserta aparte (se deduplica luego si
        // procede). Solo se actualiza un existente SIN fichero (placeholder) o re-procesado con el MISMO
        // nombre. Así dos números/ediciones distintos jamás colapsan en uno (caso revista mismo año).
        if (existente && existente.nombre_archivo && docFinal.nombre_archivo
            && existente.nombre_archivo !== docFinal.nombre_archivo) {
            existente = null;
        }

        // 4. Actualización inteligente o inserción.
        if (existente) {
            const cambios = calcularActualizacion(existente, docFinal);
            await coleccionBiblioteca.updateOne({ _id: existente._id }, { $set: cambios });
            const actualizado = await coleccionBiblioteca.findOne({ _id: existente._id });
            await registrarTomo(existente._id);
            return { ...actualizado, operacion: 'actualizacion' };
        }

        // Nunca persistir campos VACÍOS (null/''/[]): el $jsonSchema rechaza en null muchos opcionales (error
        // 121). El enriquecimiento ya los limpia; el alta rápida por ISBN no, así que se limpia aquí para TODOS
        // los caminos. Los campos requeridos nunca son vacíos, así que no se tocan.
        for (const k of Object.keys(docFinal)) if (vacio(docFinal[k])) delete docFinal[k];

        // _id PRESERVADO (reprocesado): reusar el _id original para NO cambiar la identidad del documento
        // (la etiqueta NFC lleva grabado ?doc=<_id>, la obra referencia el tomo por _id, hay deep-links…).
        // El doc viejo ya se borró en el reprocesado, así que no hay colisión.
        const idPreservado = docFinal._id_preservado;
        delete docFinal._id_preservado;
        if (idPreservado && ObjectId.isValid(idPreservado)) docFinal._id = new ObjectId(idPreservado);

        docFinal.fecha_ingreso = new Date();
        const resultado = await coleccionBiblioteca.insertOne(docFinal);
        await registrarTomo(resultado.insertedId);
        return { ...docFinal, _id: resultado.insertedId, operacion: 'insercion' };

    } catch (error) {
        if (esErrorDeMongo(error)) throw new ErrorInfraestructura('Operación MongoDB fallida', error);
        if (error.code === 121) {
            console.error("\n❌ [MOTOR CATÁLOGO] RECHAZO POR ESQUEMA EN MONGODB:");
            console.error(JSON.stringify(error.errInfo?.details, null, 2));
            throw new Error("El documento no cumple con el $jsonSchema de 'biblioteca'.");
        }
        // Clave duplicada (E11000): un índice ÚNICO (p. ej. isbn_1 heredado) y ya hay un documento con
        // esa clave. POLÍTICA anti-pérdida (igual que en el dedup de arriba):
        //   · si el conflicto es con el MISMO fichero (re-proceso) → fusionar (actualizar).
        //   · si es con OTRO fichero (otro contenido — p. ej. un ISBN/ISSN COMPARTIDO por todos los
        //     números de una publicación seriada) → NO fusionar: se QUITA la(s) clave(s) en conflicto y
        //     se inserta como documento DISTINTO. Vale más un doc sin ese identificador que un número
        //     perdido. (Lo ideal es no tener ese índice único; ver scripts/setup-mongo.js.)
        if (error.code === 11000) {
            const clave = error.keyValue || {};
            const existente = Object.keys(clave).length ? await coleccionBiblioteca.findOne(clave) : null;
            const mismoFichero = existente && (!existente.nombre_archivo || !docFinal.nombre_archivo
                || existente.nombre_archivo === docFinal.nombre_archivo);
            if (existente && mismoFichero) {
                const cambios = calcularActualizacion(existente, docFinal);
                await coleccionBiblioteca.updateOne({ _id: existente._id }, { $set: cambios });
                const actualizado = await coleccionBiblioteca.findOne({ _id: existente._id });
                await registrarTomo(existente._id);
                console.warn(`   ↔ Identificador ya catalogado (${JSON.stringify(clave)}): re-proceso del mismo fichero → fusionado con ${existente._id}.`);
                return { ...actualizado, operacion: 'actualizacion' };
            }
            if (existente) {
                for (const k of Object.keys(clave)) {
                    docFinal.alertas_agente.push(`${k}=${clave[k]} ya pertenece a otro documento (${existente._id}); este se cataloga SIN ${k} para no fusionarlo.`);
                    delete docFinal[k];
                }
                docFinal.revision_requerida = true;
                if (!docFinal.fecha_ingreso) docFinal.fecha_ingreso = new Date();
                try {
                    const reins = await coleccionBiblioteca.insertOne(docFinal);
                    await registrarTomo(reins.insertedId);
                    console.warn(`   ↔ ${JSON.stringify(clave)} en conflicto con OTRO fichero → insertado como documento DISTINTO sin ese identificador (${reins.insertedId}).`);
                    return { ...docFinal, _id: reins.insertedId, operacion: 'insercion' };
                } catch (e2) {
                    throw new Error(`Error en base de datos (reinserción sin clave en conflicto): ${e2.message}`);
                }
            }
        }
        throw new Error(`Error en base de datos: ${error.message}`);
    }
}

/**
 * Actualiza campos de un documento ya insertado (p. ej. ruta_base / imagenes / portada
 * tras copiar los archivos a la estructura CDU). Best-effort: los fallos de Mongo se elevan
 * como ErrorInfraestructura para que el llamante decida.
 */
export async function actualizarDocumento(_id, campos) {
    let db;
    try {
        db = await conectarDB();
        await db.collection('biblioteca').updateOne({ _id }, { $set: campos });
    } catch (e) {
        if (esErrorDeMongo(e)) throw new ErrorInfraestructura('Operación MongoDB fallida', e);
        throw e;
    }
}
