/**
 * Tarea ÚNICA de integridad: diagnostica (y opcionalmente repara) el archivo en una sola pasada
 * — consolida auditoria-integridad + resolver-duplicados + dedup por hash.
 *
 *   node scripts/integridad.js                        → DIAGNÓSTICO (no toca nada)
 *   node scripts/integridad.js --reparar              → DIAGNÓSTICO + REPARACIÓN SEGURA (todo a la Papelera)
 *   node scripts/integridad.js --informe informe.txt  → además, escribe el informe DETALLADO (todos los casos,
 *                                                       con qué hacer con cada uno) en ese fichero
 *
 * En el NAS, dentro del contenedor:
 *   docker exec gestor-biblioteca node scripts/integridad.js [--reparar] [--informe /app/informe.txt]
 * Para programarlo (diario/semanal): Programador de tareas de DSM con ese mismo comando.
 *
 * Por consola sale solo el RESUMEN: en una tarea programada, volcar 120.000 líneas al log no ayuda a nadie.
 * El detalle va al fichero (o se descarga del panel). Las dos salidas las rinde el MISMO módulo
 * (utils/informe-integridad.js), así que no pueden contar cosas distintas.
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import fs from 'node:fs/promises';
import { verificarIntegridad } from '../src/integridad.js';
import { informeTexto, informeHtml } from '../src/utils/informe-integridad.js';

const REPARAR = process.argv.includes('--reparar');
const iFlag = process.argv.indexOf('--informe');
const RUTA_INFORME = iFlag >= 0 ? process.argv[iFlag + 1] : null;
if (iFlag >= 0 && !RUTA_INFORME) {
    console.error('Falta la ruta: --informe <fichero.txt>');
    process.exit(1);
}

// PROGRESO: una línea que avanza en su sitio (fase · i/total · tiempo restante de la fase). El motor ya emite su
// avance (el panel lo usa); el CLI no lo escuchaba y parecía colgado durante minutos.
const FASES = {
    cargando: 'Cargando documentos', 'docs-sin-carpeta': 'Comprobando carpetas', 'docs-sin-fichero': 'Comprobando ficheros',
    'audios-rotos': 'Comprobando pistas de audio', 'hash-desactualizado': 'Comprobando hashes',
    'recorrido-arbol': 'Recorriendo el árbol CDU', 'duplicados-hash': 'Duplicados por hash', cuarentena: 'Revisando Cuarentena',
    reparando: 'Reparando', hecho: 'Terminado',
};
const t0 = Date.now();
let faseActual = null, inicioFase = Date.now();
const seg = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
const onProgress = ({ fase, i, total, carpetas }) => {
    if (fase !== faseActual) { faseActual = fase; inicioFase = Date.now(); }
    let det = '';
    if (total) {
        const eta = i > 0 ? (Date.now() - inicioFase) / i * (total - i) : null;
        det = ` ${i}/${total}${eta != null ? ` · faltan ~${seg(eta)}` : ''}`;
    } else if (carpetas) det = ` ${carpetas} carpetas`;
    process.stdout.write(`\r\x1b[K   ⏳ ${FASES[fase] || fase}${det} · total ${seg(Date.now() - t0)}`);
};

const inf = await verificarIntegridad({ reparar: REPARAR, onProgress });
process.stdout.write('\r\x1b[K');
console.log(`   (${seg(Date.now() - t0)})`);

console.log(informeTexto(inf, { detalle: false }));

if (RUTA_INFORME) {
    // El formato lo manda la EXTENSIÓN, que es lo que uno espera al escribir «--informe algo.html». En HTML no
    // se pasa `base`: desde el CLI no hay petición de la que sacar la dirección del panel, así que los
    // documentos salen sin enlace a su ficha (el resto va igual). Para el informe enlazado, el botón del panel.
    const html = /\.html?$/i.test(RUTA_INFORME);
    await fs.writeFile(RUTA_INFORME, html ? informeHtml(inf) : informeTexto(inf), 'utf8');
    console.log(`  Informe detallado escrito en: ${RUTA_INFORME}`);
}
if (!REPARAR) console.log('  (diagnóstico) Re-ejecuta con --reparar para aplicar las correcciones seguras.\n');
process.exit(0);
