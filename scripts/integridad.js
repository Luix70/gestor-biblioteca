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
import '../src/config.js';
import fs from 'node:fs/promises';
import { verificarIntegridad } from '../src/integridad.js';
import { informeTexto } from '../src/utils/informe-integridad.js';

const REPARAR = process.argv.includes('--reparar');
const iFlag = process.argv.indexOf('--informe');
const RUTA_INFORME = iFlag >= 0 ? process.argv[iFlag + 1] : null;
if (iFlag >= 0 && !RUTA_INFORME) {
    console.error('Falta la ruta: --informe <fichero.txt>');
    process.exit(1);
}

const inf = await verificarIntegridad({ reparar: REPARAR });

console.log(informeTexto(inf, { detalle: false }));

if (RUTA_INFORME) {
    await fs.writeFile(RUTA_INFORME, informeTexto(inf), 'utf8');
    console.log(`  Informe detallado escrito en: ${RUTA_INFORME}`);
}
if (!REPARAR) console.log('  (diagnóstico) Re-ejecuta con --reparar para aplicar las correcciones seguras.\n');
process.exit(0);
