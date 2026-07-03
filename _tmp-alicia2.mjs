import 'dotenv/config'; import './src/config.js';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const w=(s)=>process.stdout.write(s+'\n');
const ruta = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'Fichero','fichero.db');
const { default: Database } = await import('better-sqlite3');
const db = new Database(ruta,{readonly:true,fileMustExist:true});
const rows = db.prepare("SELECT fuente, isbn, autores FROM fichero WHERE fuente='bne' AND titulo LIKE 'Alicia anotada%' LIMIT 20").all();
w('registros BNE con título «Alicia anotada%»: '+rows.length);
for (const r of rows) w('  ['+r.isbn+'] '+r.autores);
// ¿Aparecen Torres Oliver o Tenniel en CUALQUIER registro del dump?
for (const nombre of ['Torres Oliver','Tenniel']) {
  const n = db.prepare("SELECT COUNT(*) c FROM fichero WHERE autores LIKE ?").get('%'+nombre+'%').c;
  w(`\n«${nombre}» aparece en ${n} registros del dump (en cualquier libro).`);
  const ej = db.prepare("SELECT isbn, titulo, autores FROM fichero WHERE autores LIKE ? LIMIT 2").all('%'+nombre+'%');
  for (const e of ej) w(`   ej: [${e.isbn}] ${e.titulo} → ${e.autores.slice(0,110)}`);
}
db.close(); process.exit(0);
