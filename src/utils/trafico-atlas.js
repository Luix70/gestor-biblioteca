/**
 * CONTADOR DE TRÁFICO CON ATLAS (15-oct).
 *
 * El clúster gratuito de Atlas tiene un tope de transferencia: 10 GB de entrada y 10 GB de salida en una ventana
 * MÓVIL de 7 días; al pasarlo, Atlas frena la red (medido el 14-oct: 94 KB/s, frente a 6 MB/s de la misma red con
 * internet) y el panel de Atlas no avisa: solo hay una gráfica de medias diarias. Se pasó por las pasadas completas
 * de la base de esos días (integridad, auditorías, afinar/refinar CDU…).
 *
 * Este contador mide lo que CADA proceso (la aplicación y cualquier script, en el NAS o en el PC: todos conectan por
 * database.js·conectarDB) envía a Atlas y recibe de él, a partir de los eventos del driver (`monitorCommands`): el
 * tamaño BSON de cada comando y de cada respuesta. Lo acumula en memoria y lo vuelca cada minuto en la colección
 * `trafico_atlas` —un documento por día, con el desglose por origen (app, integridad, afinar-cdu…)—. Es una
 * ESTIMACIÓN: Atlas cuenta los bytes por la red, tras la compresión del protocolo; aquí son los del BSON (algo más).
 *
 * Al salir (process.exit corta en seco: no da tiempo a escribir en Atlas), lo pendiente se apunta en
 * logs/trafico-pendiente.jsonl y lo sube el siguiente volcado de cualquier proceso en esa máquina.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BSON } from 'mongodb';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PENDIENTE = path.join(RAIZ, 'logs', 'trafico-pendiente.jsonl');
const VOLCAR_CADA_MS = 60_000;
export const LIMITE_GB = Number(process.env.ATLAS_LIMITE_GB) || 10;

// Quién gasta: el script que se está ejecutando («afinar-cdu») o la aplicación.
const ORIGEN = (() => {
  const s = path.basename(process.argv[1] || '').replace(/\.(m?js|cjs)$/, '');
  return !s || s === 'app' || s === 'index' ? 'app' : s.replace(/[.$]/g, '_');
})();

let pendiente = { entrada: 0, salida: 0 };
let clienteVigilado = null;
let temporizador = null;

const dia = (fecha = new Date()) => fecha.toISOString().slice(0, 10);
const tamano = (doc) => { try { return BSON.calculateObjectSize(doc); } catch { return 0; } };

/** Empieza a medir el tráfico de un cliente (MongoClient abierto con `monitorCommands: true`). */
export function vigilarTrafico(client, db) {
  clienteVigilado = client;
  client.on('commandStarted', (e) => { pendiente.entrada += tamano(e.command); });
  client.on('commandSucceeded', (e) => { pendiente.salida += tamano(e.reply); });
  if (!temporizador) {
    temporizador = setInterval(() => volcarTrafico(db).catch(() => {}), VOLCAR_CADA_MS);
    temporizador.unref();   // no mantiene vivo un script que ya ha terminado
  }
}

/** Sube lo acumulado (y lo que quedó apuntado en el fichero local al salir algún proceso). Nunca lanza. */
export async function volcarTrafico(db) {
  const lotes = [];
  if (pendiente.entrada || pendiente.salida) {
    lotes.push({ dia: dia(), origen: ORIGEN, ...pendiente });
    pendiente = { entrada: 0, salida: 0 };
  }
  try {
    if (fs.existsSync(PENDIENTE)) {
      const lineas = fs.readFileSync(PENDIENTE, 'utf8').split('\n').filter(Boolean);
      fs.unlinkSync(PENDIENTE);
      for (const l of lineas) { try { lotes.push(JSON.parse(l)); } catch { /* línea rota: se ignora */ } }
    }
  } catch { /* sin acceso al fichero: se reintentará */ }
  for (const l of lotes) {
    await db.collection('trafico_atlas').updateOne({ _id: l.dia }, {
      $inc: { entrada: l.entrada, salida: l.salida, [`origen.${l.origen}.entrada`]: l.entrada, [`origen.${l.origen}.salida`]: l.salida },
    }, { upsert: true }).catch(() => {
      // Sin conexión: de vuelta al pendiente, para el próximo volcado.
      if (l.origen === ORIGEN && l.dia === dia()) { pendiente.entrada += l.entrada; pendiente.salida += l.salida; }
    });
  }
}

// Al salir: lo pendiente, al fichero local (síncrono: es lo único que da tiempo a hacer).
process.on('exit', () => {
  if (!clienteVigilado || (!pendiente.entrada && !pendiente.salida)) return;
  try {
    fs.mkdirSync(path.dirname(PENDIENTE), { recursive: true });
    fs.appendFileSync(PENDIENTE, JSON.stringify({ dia: dia(), origen: ORIGEN, ...pendiente }) + '\n');
  } catch { /* nada que hacer */ }
});

/**
 * Los últimos 7 días (la ventana de Atlas): total de salida y de entrada, el % del límite, el detalle por día y
 * los orígenes que más han gastado.
 */
export async function resumenTrafico(db) {
  await volcarTrafico(db).catch(() => {});
  const desde = dia(new Date(Date.now() - 6 * 86400_000));
  const dias = await db.collection('trafico_atlas').find({ _id: { $gte: desde } }).sort({ _id: 1 }).toArray();
  const GB = 1024 ** 3;
  const salida = dias.reduce((s, d) => s + (d.salida || 0), 0);
  const entrada = dias.reduce((s, d) => s + (d.entrada || 0), 0);
  const porOrigen = {};
  for (const d of dias) {
    for (const [o, v] of Object.entries(d.origen || {})) porOrigen[o] = (porOrigen[o] || 0) + (v.salida || 0);
  }
  return {
    limite_gb: LIMITE_GB,
    salida_gb: salida / GB,
    entrada_gb: entrada / GB,
    pct: Math.round((Math.max(salida, entrada) / (LIMITE_GB * GB)) * 100),
    desde,
    dias: dias.map((d) => ({ dia: d._id, salida_gb: (d.salida || 0) / GB, entrada_gb: (d.entrada || 0) / GB })),
    origenes: Object.entries(porOrigen).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([origen, b]) => ({ origen, salida_gb: b / GB })),
  };
}
