import { MongoClient } from 'mongodb';
import dns from 'node:dns';
import { vigilarTrafico } from './utils/trafico-atlas.js';

// Puenteamos el DNS local inyectando los servidores de Google para resolver registros SRV
dns.setServers(['8.8.8.8', '8.8.4.4']);

// ─── Dos bases: la PRINCIPAL y la AUXILIAR ──────────────────────────────────────────────────────────────
// El Atlas gratuito (M0) da 512 MB de tamaño LÓGICO por clúster, y uno solo por proyecto. El 26-nov la base
// llegó a 461 MB. Las cachés y los archivos —regenerables o de consulta, nunca cruzados con el catálogo en un
// $lookup— pueden vivir en un SEGUNDO clúster gratuito (otro proyecto Atlas): `MONGO_URI_AUX`.
//
// Sin `MONGO_URI_AUX` todo sigue en la principal, como siempre. Con ella, `conectarDB()` devuelve la misma
// base de siempre pero con `collection(nombre)` (y createCollection / listCollections por nombre / los
// comandos collMod, collStats, create, drop con nombre) ENRUTADOS: las colecciones de COLECCIONES_AUXILIARES
// se sirven del clúster auxiliar. Así ningún módulo tiene que saber dónde vive cada colección (155 lo usan).
// Traslado de los datos: scripts/mover-a-bd-auxiliar.js.
//
// ⚠ Nunca meter aquí una colección que algún $lookup / $unionWith cruce con otra de la principal (un
// $lookup entre dos clústeres es imposible): biblioteca, autores, editoriales, colecciones, obras… se quedan.
export const COLECCIONES_AUXILIARES = new Set([
    'cdu_descripciones',                      // descripciones de CDU (caché; generadas por IA o UDC Summary)
    'clasificacion_descripciones',            // descripciones de Dewey/LCC (caché)
    'cdu_descripciones_retiradas',            // archivo
    'clasificacion_descripciones_retiradas',  // archivo
    'udc_summary',                            // tabla oficial importada (importar-udc-summary)
    'clasificacion_oficial',                  // tablas oficiales importadas
    'equivalencias_cdu',                      // caché Dewey/LCC → CDU aprendida
    'autores_retirados',                      // archivo de fusiones/borrados
    'editoriales_retiradas',
    'colecciones_retiradas',
    'registro_actividad',                     // registro de actividad del panel (con TTL)
]);

const hayAuxiliar = () => !!(process.env.MONGO_URI_AUX || '').trim();
const nombreBD = () => process.env.MONGO_DB_NAME || 'Biblioteca';
const nombreBDAux = () => process.env.MONGO_DB_NAME_AUX || nombreBD();

/** ¿En qué base vive esta colección ahora mismo? ('auxiliar' solo si hay MONGO_URI_AUX). */
export function baseDeColeccion(nombre) {
    return hayAuxiliar() && COLECCIONES_AUXILIARES.has(nombre) ? 'auxiliar' : 'principal';
}

// Tras este tiempo de INACTIVIDAD se comprueba con un ping que el cliente sigue vivo antes de devolverlo.
// No en cada llamada: durante una ingesta se pide la BD constantemente y sería un viaje a Atlas por
// documento. Tras un rato parado, en cambio, es justo cuando la conexión puede haberse caído.
// (El ping no necesita timeout propio: `serverSelectionTimeoutMS` ya lo acota, y sobre una topología
// cerrada falla en el acto.)
const PING_TRAS_MS = Number(process.env.MONGO_PING_TRAS_MS) || 60000;

/**
 * ¿Este error es de CONEXIÓN con Mongo (y no un problema del documento)?
 *
 * Importa para el enrutado de fallos: un error de infraestructura va a REINTENTOS (se copia y se reprocesa),
 * mientras que uno de catalogación va a Cuarentena. Sin esta distinción, una caída de la BD marcaba los
 * ficheros como «sin identificar» —un veredicto sobre su contenido— cuando ni siquiera se habían podido
 * consultar. Se mira el NOMBRE de la clase del driver además del mensaje: los mensajes cambian entre versiones.
 */
export function esFalloDeConexionMongo(e) {
    if (!e) return false;
    const nombre = e.name || e.constructor?.name || '';
    if (/^Mongo(NetworkError|NotConnectedError|TopologyClosedError|ServerSelectionError|NetworkTimeoutError)$/.test(nombre)) return true;
    const m = String(e.message || '');
    return /topology is closed|topology was destroyed|client must be connected|pool was (force )?destroyed|server selection|ECONNRESET|ENOTFOUND|ETIMEDOUT/i.test(m);
}

/**
 * Una conexión CACHEADA y autorreparable a un clúster.
 *
 * El cliente se CACHEA (abrir una conexión por operación arruinaría el pool), pero un cliente cacheado puede
 * MORIR: si la topología se cierra —corte de red, failover de Atlas, un rato largo sin consultas— el objeto
 * sigue existiendo y el viejo `if (!client)` lo daba por bueno. Caso real: tras 91 minutos empaquetando
 * láminas sin tocar la BD, las 17 unidades siguientes fallaron TODAS con «Topology is closed», una tras otra,
 * y habría seguido así hasta reiniciar el contenedor. Un cliente muerto hay que detectarlo y reponerlo.
 */
function crearConexion({ etiqueta, uri, base, medirTrafico }) {
    let client = null;
    let conectando = null;   // conexión en curso: varias llamadas simultáneas comparten UNA sola
    let ultimoUso = 0;       // ms del último uso con éxito

    /** Cierra y olvida el cliente actual para que la próxima llamada abra uno nuevo. Nunca lanza. */
    async function descartarCliente() {
        const viejo = client;
        client = null;
        if (viejo) await viejo.close(true).catch(() => { /* ya estaba muerto: da igual */ });
    }

    async function abrirCliente() {
        const nuevo = new MongoClient(uri(), {
            serverSelectionTimeoutMS: 10000, // Damos 10 segundos de margen a la conexión
            family: 4,                       // Forzamos IPv4 para evitar atascos en la red
            monitorCommands: medirTrafico,   // para el contador de tráfico con Atlas (utils/trafico-atlas.js)
        });
        // Si el driver anuncia que la topología se ha cerrado, se descarta el cliente EN EL ACTO: así la próxima
        // llamada abre uno nuevo en vez de devolver este cadáver. Es la señal que nos faltaba.
        nuevo.on('topologyClosed', () => { if (client === nuevo) client = null; });
        await nuevo.connect();
        // El clúster gratuito de Atlas frena la red al pasar de 10 GB en 7 días: se mide lo que gasta cada
        // proceso. Solo en la principal: la auxiliar es otro clúster con su propio cupo y su tráfico (cachés
        // pequeñas) no se sumaría bien al de la principal.
        if (medirTrafico) vigilarTrafico(nuevo, nuevo.db(base()));
        return nuevo;
    }

    /** El objeto Db de este clúster, conectando o reconectando si hace falta. */
    return async function obtenerDb() {
        // Cliente vivo y usado hace poco: se devuelve sin más ceremonia (el caso normal durante una ingesta).
        if (client && Date.now() - ultimoUso < PING_TRAS_MS) return client.db(base());

        // Cacheado pero parado un rato: se comprueba que respira ANTES de dárselo a nadie.
        if (client) {
            try {
                await client.db('admin').command({ ping: 1 });
                ultimoUso = Date.now();
                return client.db(base());
            } catch (e) {
                console.warn(`⚠️  La conexión con MongoDB${etiqueta} no responde (${e.message}) → se reconecta.`);
                await descartarCliente();
            }
        }

        // Varias ingestas en paralelo no deben abrir tres clientes: comparten la misma promesa de conexión.
        if (!conectando) {
            conectando = abrirCliente()
                .then((c) => {
                    client = c;
                    ultimoUso = Date.now();
                    console.log(`✅ Conexión establecida con MongoDB Atlas${etiqueta}`);
                    return c;
                })
                .finally(() => { conectando = null; });
        }
        await conectando;
        return client.db(base());
    };
}

const dbPrincipal = crearConexion({ etiqueta: '', uri: () => process.env.MONGO_URI, base: nombreBD, medirTrafico: true });
const dbAuxiliarCruda = crearConexion({ etiqueta: ' (auxiliar)', uri: () => process.env.MONGO_URI_AUX.trim(), base: nombreBDAux, medirTrafico: false });

/**
 * La base PRINCIPAL envuelta para que las colecciones auxiliares se sirvan del otro clúster.
 *
 * `collection()` es síncrono en el driver y así debe seguir: por eso la base auxiliar se conecta ANTES
 * (en conectarDB) y aquí ya se tiene el objeto. Todo lo demás (databaseName, command de otros tipos,
 * aggregate a nivel de base…) va a la principal, con `this` = la base real (el driver usa sus internos).
 */
function enrutada(principal, auxiliar) {
    const esAux = (nombre) => typeof nombre === 'string' && COLECCIONES_AUXILIARES.has(nombre);
    // Comandos que nombran una colección como valor de su primera clave: { collMod: 'x' }, { collStats: 'x' }…
    const COMANDOS_CON_COLECCION = ['collMod', 'collStats', 'create', 'drop', 'createIndexes', 'dropIndexes', 'listIndexes', 'count', 'distinct', 'aggregate', 'find'];
    return new Proxy(principal, {
        get(objetivo, prop) {
            if (prop === 'collection') {
                return (nombre, opciones) => (esAux(nombre) ? auxiliar : objetivo).collection(nombre, opciones);
            }
            if (prop === 'createCollection' || prop === 'dropCollection') {
                return (nombre, ...resto) => (esAux(nombre) ? auxiliar : objetivo)[prop](nombre, ...resto);
            }
            if (prop === 'listCollections') {
                // Por nombre concreto (setup-mongo: «¿existe ya?») se pregunta a la base donde vive. Un listado
                // general es de la principal: para TODAS, utilizar listarColecciones().
                return (filtro = {}, opciones) => (esAux(filtro?.name) ? auxiliar : objetivo).listCollections(filtro, opciones);
            }
            if (prop === 'command') {
                return (cmd, opciones) => {
                    const clave = cmd && COMANDOS_CON_COLECCION.find((k) => Object.keys(cmd)[0] === k);
                    return (clave && esAux(cmd[clave]) ? auxiliar : objetivo).command(cmd, opciones);
                };
            }
            const valor = Reflect.get(objetivo, prop, objetivo);
            return typeof valor === 'function' ? valor.bind(objetivo) : valor;
        },
    });
}

export async function conectarDB() {
    if (!process.env.MONGO_URI) {
        throw new Error("❌ CRÍTICO: MONGO_URI no definida en el archivo .env");
    }
    const principal = await dbPrincipal();
    if (!hayAuxiliar()) return principal;
    return enrutada(principal, await dbAuxiliarCruda());
}

/**
 * La base AUXILIAR tal cual (sin enrutar), o null si no hay MONGO_URI_AUX. Para los scripts que trabajan
 * sobre los dos clústeres a la vez (mover-a-bd-auxiliar, copia-base, el tamaño en el panel).
 */
export async function conectarDBAuxiliar() {
    return hayAuxiliar() ? dbAuxiliarCruda() : null;
}

/**
 * La base PRINCIPAL tal cual (sin enrutar): para quien necesita ver lo que hay físicamente en ella (el
 * traslado comprueba y borra las copias viejas de las colecciones ya movidas).
 */
export async function conectarDBPrincipal() {
    if (!process.env.MONGO_URI) throw new Error("❌ CRÍTICO: MONGO_URI no definida en el archivo .env");
    return dbPrincipal();
}

/**
 * Nombres de TODAS las colecciones en uso, de las dos bases: las de la principal (menos las auxiliares, que
 * pueden quedar como copia vieja hasta borrarlas) y las auxiliares. Para la copia de seguridad.
 */
export async function listarColecciones() {
    const principal = await conectarDBPrincipal();
    const auxiliar = await conectarDBAuxiliar();
    const deLaPrincipal = (await principal.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    if (!auxiliar) return deLaPrincipal.filter((n) => !n.startsWith('system.')).sort();
    const deLaAuxiliar = (await auxiliar.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    return [...new Set([
        ...deLaPrincipal.filter((n) => !COLECCIONES_AUXILIARES.has(n)),
        ...deLaAuxiliar.filter((n) => COLECCIONES_AUXILIARES.has(n)),
    ])].filter((n) => !n.startsWith('system.')).sort();
}
