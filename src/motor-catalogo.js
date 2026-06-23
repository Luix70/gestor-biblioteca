import { conectarDB } from './database.js';
import { ErrorInfraestructura, esErrorDeMongo } from './errores.js';
import { resolverColeccion } from './utils/colecciones.js';
import { resolverObra, registrarVolumenEnObra } from './utils/obras.js';
import { resolverObraPorIsbn } from './utils/obra-autoridad.js';
import { variantesISBN } from './utils/identificadores.js';

const vacio = (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
const union = (a, b) => Array.from(new Set([...(a || []), ...(b || [])]));

/**
 * Calcula los cambios al re-procesar un libro ya catalogado (búsqueda futura con mejor info).
 * Reglas: (1) rellenar huecos siempre; (2) si el registro estaba 'pendiente' y la nueva
 * pasada lo identifica ('completado'), refrescar identificadores/clasificación con los nuevos;
 * (3) unir formatos, palabras_clave, imágenes y alertas. Nunca se degrada un dato bueno.
 */
function calcularActualizacion(existente, nuevo) {
    const set = {};
    const CAMPOS = ['titulo', 'subtitulo', 'isbn', 'issn', 'idioma', 'cdu', 'dewey', 'lcc', 'lccn', 'sinopsis', 'editorial', 'año_edicion', 'portada', 'ubicacion', 'tipo_recurso', 'volumen_numero', 'numero_edicion', 'nombre_archivo', 'hash_contenido', 'mes_publicacion', 'numero_issue', 'coleccion', 'coleccion_nombre', 'coleccion_numero', 'obra', 'obra_titulo', 'volumen_titulo', 'isbn_obra'];

    // (1) Rellenar huecos.
    for (const c of CAMPOS) if (vacio(existente[c]) && !vacio(nuevo[c])) set[c] = nuevo[c];

    // (2) Upgrade pendiente -> completado: la nueva pasada es más fiable.
    const mejora = existente.estado_verificacion === 'pendiente' && nuevo.estado_verificacion === 'completado';
    if (mejora) {
        for (const c of CAMPOS) if (!vacio(nuevo[c])) set[c] = nuevo[c];
        set.estado_verificacion = 'completado';
    }

    // (3) Uniones.
    const formatos = union(existente.formatos, nuevo.formatos);
    if (formatos.length !== (existente.formatos || []).length) set.formatos = formatos;

    const palabras = union(existente.palabras_clave, nuevo.palabras_clave);
    if (palabras.length !== (existente.palabras_clave || []).length) set.palabras_clave = palabras;

    const imgs = [...(existente.imagenes || [])];
    for (const im of (nuevo.imagenes || [])) if (!imgs.some(x => x.ruta === im.ruta)) imgs.push(im);
    if (imgs.length !== (existente.imagenes || []).length) set.imagenes = imgs;

    const alertas = union(existente.alertas_agente, nuevo.alertas_agente);
    set.alertas_agente = [...alertas, 'Registro actualizado con nueva información.'];

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
    const coleccionAutores = db.collection('autores');
    const coleccionEditoriales = db.collection('editoriales');

    let docFinal = { ...documentoEnriquecido };
    // Un tomo "?" (sin número determinable) lleva volumen_numero AUSENTE, nunca null (el $jsonSchema
    // lo tipa number|string). Si llegara null, se elimina para que el campo no exista.
    if (docFinal.volumen_numero == null) delete docFinal.volumen_numero;

    // Registra el tomo en el inventario de su obra (qué tomos hay y cuáles faltan). Declarada ANTES
    // del try para ser accesible también desde el manejador de E11000 (catch). Lee docFinal en el
    // momento de la llamada (ya tendrá .obra/.volumen_numero fijados por el paso 2c).
    const registrarTomo = async (idFinal) => {
        if (docFinal.obra && idFinal)
            // volumen_numero puede ser null ("tomo ?"): se registra igual (nunca se descarta un tomo).
            await registrarVolumenEnObra(db, docFinal.obra, docFinal.volumen_numero ?? null, idFinal, docFinal.obra_total);
    };

    try {
        // 1. Autores (string → ObjectId; crea si no existe).
        if (docFinal.autores && docFinal.autores.length > 0) {
            const ids = [];
            for (const autor of docFinal.autores) {
                if (typeof autor === 'string') {
                    const existente = await coleccionAutores.findOne({ nombre: autor });
                    if (existente) ids.push(existente._id);
                    else {
                        const nuevo = await coleccionAutores.insertOne({ nombre: autor });
                        ids.push(nuevo.insertedId);
                        docFinal.alertas_agente.push(`Nuevo autor registrado: ${autor}`);
                    }
                } else ids.push(autor);
            }
            docFinal.autores = ids;
        }

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
            const edId = (docFinal.editorial && typeof docFinal.editorial !== 'string') ? docFinal.editorial : null;
            const { _id, creada } = await resolverColeccion(db, docFinal.coleccion_nombre, edId);
            if (creada) docFinal.alertas_agente.push(`Nueva colección registrada: ${docFinal.coleccion_nombre}`);

            // Serie automática (drop por carpeta): si el documento no trae número de serie, se le
            // asigna el siguiente incremental dentro de la colección (max numérico existente + 1).
            if (opciones.serieAuto && !docFinal.coleccion_numero) {
                const miembros = await coleccionBiblioteca
                    .find({ coleccion: _id }, { projection: { coleccion_numero: 1 } }).toArray();
                const maxN = miembros.reduce((m, d) => {
                    const n = parseInt(d.coleccion_numero, 10);
                    return Number.isFinite(n) && n > m ? n : m;
                }, 0);
                docFinal.coleccion_numero = String(maxN + 1);
            }
            docFinal.coleccion = _id;
        }

        // 2c. Obra multivolumen (tras editorial/colección, que se enlazan a la obra). Todos los
        // tomos comparten la CDU de la obra (un solo classmark → se archivan juntos).
        if (docFinal.obra_titulo && typeof docFinal.obra_titulo === 'string') {
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
        let filtro = null;
        if (docFinal.obra && docFinal.volumen_numero != null) {
            filtro = { obra: docFinal.obra, volumen_numero: docFinal.volumen_numero };
        } else if (docFinal.tipo_recurso === 'revista') {
            if (docFinal.issn && docFinal.año_edicion && docFinal.mes_publicacion) {
                filtro = { issn: docFinal.issn, año_edicion: docFinal.año_edicion, mes_publicacion: docFinal.mes_publicacion };
            } else if (docFinal.issn && docFinal.año_edicion) {
                filtro = { issn: docFinal.issn, año_edicion: docFinal.año_edicion };
            } else {
                filtro = { titulo: docFinal.titulo, año_edicion: docFinal.año_edicion };
            }
        } else if (docFinal.isbn && !docFinal.obra) {
            // — Nivel C: libros con ISBN (NUNCA tomos de obra: jamás se fusionan por ISBN) — solo
            //   actualizar si es el mismo fichero
            const candidato = await coleccionBiblioteca.findOne({ isbn: docFinal.isbn });
            if (candidato) {
                const mismoArchivo = !candidato.nombre_archivo
                    || candidato.nombre_archivo === docFinal.nombre_archivo;
                if (mismoArchivo) {
                    filtro = { _id: candidato._id };
                } else {
                    // Mismo ISBN, fichero con OTRO nombre → POSIBLE duplicado. No se inserta a ciegas
                    // (evita versiones duplicadas silenciosas): el servicio lo confirma por HASH de
                    // contenido y recicla el idéntico, o lo manda a Cuarentena/duplicados si difiere.
                    return { ...candidato, operacion: 'posible_duplicado' };
                }
            }
        } else if (docFinal.issn) {
            filtro = { issn: docFinal.issn };
        }
        // Sin filtro → siempre insertar

        const existente = filtro ? await coleccionBiblioteca.findOne(filtro) : null;

        // 4. Actualización inteligente o inserción.
        if (existente) {
            const cambios = calcularActualizacion(existente, docFinal);
            await coleccionBiblioteca.updateOne({ _id: existente._id }, { $set: cambios });
            const actualizado = await coleccionBiblioteca.findOne({ _id: existente._id });
            await registrarTomo(existente._id);
            return { ...actualizado, operacion: 'actualizacion' };
        }

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
        // Clave duplicada (E11000): existe un índice ÚNICO (p. ej. isbn_1) y ya hay un documento
        // con esa clave. En vez de fallar a Cuarentena, FUSIONAMOS con el existente (la mayoría
        // son re-ingestas del mismo libro). El identificador conflictivo viene en error.keyValue.
        if (error.code === 11000) {
            const clave = error.keyValue || {};
            const existente = Object.keys(clave).length
                ? await coleccionBiblioteca.findOne(clave) : null;
            if (existente) {
                const cambios = calcularActualizacion(existente, docFinal);
                await coleccionBiblioteca.updateOne({ _id: existente._id }, { $set: cambios });
                const actualizado = await coleccionBiblioteca.findOne({ _id: existente._id });
                await registrarTomo(existente._id);
                console.warn(`   ↔ ISBN/ISSN ya catalogado (${JSON.stringify(clave)}): fusionado con ${existente._id}.`);
                return { ...actualizado, operacion: 'actualizacion' };
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
