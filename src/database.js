import { MongoClient } from 'mongodb';
import dns from 'node:dns';

// Puenteamos el DNS local inyectando los servidores de Google para resolver registros SRV
dns.setServers(['8.8.8.8', '8.8.4.4']);

// El cliente se CACHEA (abrir una conexión por operación arruinaría el pool), pero un cliente cacheado puede
// MORIR: si la topología se cierra —corte de red, failover de Atlas, un rato largo sin consultas— el objeto
// sigue existiendo y el viejo `if (!client)` lo daba por bueno. Caso real: tras 91 minutos empaquetando
// láminas sin tocar la BD, las 17 unidades siguientes fallaron TODAS con «Topology is closed», una tras otra,
// y habría seguido así hasta reiniciar el contenedor. Un cliente muerto hay que detectarlo y reponerlo.
let client = null;
let conectando = null;       // conexión en curso: varias llamadas simultáneas comparten UNA sola
let ultimoUso = 0;           // ms del último uso con éxito

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

/** Cierra y olvida el cliente actual para que la próxima llamada abra uno nuevo. Nunca lanza. */
async function descartarCliente() {
    const viejo = client;
    client = null;
    if (viejo) await viejo.close(true).catch(() => { /* ya estaba muerto: da igual */ });
}

async function abrirCliente(uri) {
    const nuevo = new MongoClient(uri, {
        serverSelectionTimeoutMS: 10000, // Damos 10 segundos de margen a la conexión
        family: 4,                       // Forzamos IPv4 para evitar atascos en la red
    });
    // Si el driver anuncia que la topología se ha cerrado, se descarta el cliente EN EL ACTO: así la próxima
    // llamada abre uno nuevo en vez de devolver este cadáver. Es la señal que nos faltaba.
    nuevo.on('topologyClosed', () => { if (client === nuevo) client = null; });
    await nuevo.connect();
    return nuevo;
}

const nombreBD = () => process.env.MONGO_DB_NAME || 'Biblioteca';

export async function conectarDB() {
    const uri = process.env.MONGO_URI;

    if (!uri) {
        throw new Error("❌ CRÍTICO: MONGO_URI no definida en el archivo .env");
    }

    // Cliente vivo y usado hace poco: se devuelve sin más ceremonia (el caso normal durante una ingesta).
    if (client && Date.now() - ultimoUso < PING_TRAS_MS) return client.db(nombreBD());

    // Cacheado pero parado un rato: se comprueba que respira ANTES de dárselo a nadie.
    if (client) {
        try {
            await client.db('admin').command({ ping: 1 });
            ultimoUso = Date.now();
            return client.db(nombreBD());
        } catch (e) {
            console.warn(`⚠️  La conexión con MongoDB no responde (${e.message}) → se reconecta.`);
            await descartarCliente();
        }
    }

    // Varias ingestas en paralelo no deben abrir tres clientes: comparten la misma promesa de conexión.
    if (!conectando) {
        conectando = abrirCliente(uri)
            .then((c) => {
                client = c;
                ultimoUso = Date.now();
                console.log("✅ Conexión establecida con MongoDB Atlas");
                return c;
            })
            .finally(() => { conectando = null; });
    }
    await conectando;
    return client.db(nombreBD());
}
