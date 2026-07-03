/**
 * Diagnóstico del Fichero local (fichero.db) para AFINAR las campañas de fondo, sin mover el .db de varios
 * GB: mide qué información de roles/idioma es realmente recuperable del volcado.
 *
 * Responde:
 *   1) ¿La columna `autores` de la BNE lleva la MENCIÓN de responsabilidad (con roles: traducción de…,
 *      ilustraciones de…) o solo nombres limpios? → decide si la campaña de roles rinde desde el Fichero.
 *   2) ¿Está `lengua_original` poblada? → rendimiento de la campaña de idioma_original.
 *   3) ¿Se conservó el registro CRUDO de la BNE en la columna `extra` (con `mencion_de_autores`)? → si sí,
 *      podríamos parsear roles desde ahí sin re-hacer el ETL de 58,7 M.
 *
 * Uso (en el NAS, donde vive el .db):
 *   docker exec gestor-biblioteca node scripts/muestra-fichero.js
 * Pega la salida y con eso ajusto las campañas. Solo LECTURA; no toca nada.
 */
import 'dotenv/config';
import '../src/config.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(__dirname, '..');

// Misma resolución de ruta que utils/buscador-local.js (PATH_FICHERO o <raíz>/Fichero/fichero.db).
function resolverDB() {
    const v = process.env.PATH_FICHERO;
    const base = v && path.isAbsolute(v) ? v : path.resolve(RAIZ, v || 'Fichero');
    return /\.db$/i.test(base) ? base : path.join(base, 'fichero.db');
}

const ruta = resolverDB();
if (!fs.existsSync(ruta)) {
    console.error(`❌ No encuentro fichero.db en: ${ruta}`);
    process.exit(1);
}
const { default: Database } = await import('better-sqlite3');
const db = new Database(ruta, { readonly: true, fileMustExist: true });
const uno = (sql, p = []) => db.prepare(sql).get(...p);
const varias = (sql, p = []) => db.prepare(sql).all(...p);

console.log(`\n═══ MUESTRA DEL FICHERO ═══\n  ${ruta}`);
console.log(`  Total filas: ${uno('SELECT COUNT(*) c FROM fichero').c.toLocaleString('es-ES')}`);
for (const f of varias('SELECT fuente, COUNT(*) c FROM fichero GROUP BY fuente'))
    console.log(`    ${f.fuente || '(null)'}: ${f.c.toLocaleString('es-ES')}`);

// 1) ¿La columna `autores` (BNE) parece llevar roles? (marcas /**/ o palabras de rol).
const ROL_LIKE =
    "(autores LIKE '%/**/%' OR autores LIKE '%traduc%' OR autores LIKE '%ilustr%' " +
    "OR autores LIKE '%prólog%' OR autores LIKE '%prolog%' OR autores LIKE '%edición de%')";
console.log(`\n── Roles en la columna «autores» (BNE) ──`);
console.log(`  Filas BNE cuyo «autores» parece llevar rol: ${uno(`SELECT COUNT(*) c FROM fichero WHERE fuente='bne' AND ${ROL_LIKE}`).c.toLocaleString('es-ES')}`);
console.log('  Muestras:');
for (const r of varias(`SELECT autores FROM fichero WHERE fuente='bne' AND ${ROL_LIKE} LIMIT 15`))
    console.log(`    · ${r.autores}`);
console.log('  Muestras «autores» BNE normales (para comparar formato):');
for (const r of varias(`SELECT autores FROM fichero WHERE fuente='bne' AND autores IS NOT NULL AND autores<>'' LIMIT 8`))
    console.log(`    · ${r.autores}`);

// 2) idioma_original (lengua_original).
console.log(`\n── idioma_original (lengua_original) ──`);
console.log(`  Filas con lengua_original: ${uno("SELECT COUNT(*) c FROM fichero WHERE lengua_original IS NOT NULL AND lengua_original<>''").c.toLocaleString('es-ES')}`);
console.log('  Valores de ejemplo:');
for (const r of varias("SELECT DISTINCT lengua_original FROM fichero WHERE lengua_original IS NOT NULL AND lengua_original<>'' LIMIT 12"))
    console.log(`    · ${r.lengua_original}`);

// 3) ¿Se conservó el registro crudo de la BNE en `extra` (con la mención)?
const conExtra = uno("SELECT COUNT(*) c FROM fichero WHERE fuente='bne' AND extra IS NOT NULL AND extra<>''").c;
console.log(`\n── Registro crudo BNE en «extra» ──`);
console.log(`  Filas BNE con «extra» (JSON crudo): ${conExtra.toLocaleString('es-ES')}`);
if (conExtra) {
    const conMencion = varias("SELECT extra FROM fichero WHERE fuente='bne' AND extra LIKE '%mencion%' LIMIT 3");
    console.log(`  ¿«extra» contiene «mencion»?: ${conMencion.length ? 'SÍ' : 'no'}`);
    for (const x of conMencion) console.log(`    · ${String(x.extra || '').slice(0, 320)}…`);
}

db.close();
console.log('\n✅ Fin de la muestra.\n');
