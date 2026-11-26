/**
 * PDF ESCANEADOS CUYO ISBN NO ES EL DEL NOMBRE DEL FICHERO — detector (26-nov; gemelo en la ingesta:
 * orquestador·imponerIsbnDelNombre con utils/isbn-nombre.js).
 *
 * En la rama del PDF escaneado, lo que leía la visión SUSTITUÍA los datos del fichero, y el ISBN escrito en el
 * nombre («9780801469114.Cornell.On_the_Republic….pdf», «<ISBN> - Autor - Título.pdf») se perdía: la ficha se
 * quedaba con el de otra edición (el de papel del CIP en vez del del ebook) o con el de OTRO libro hallado por
 * título («Understanding and Teaching English Spelling» → «Understanding English Spelling»). Medido: 145 fichas.
 *
 * No escribe nada en las fichas. Las reúne en una SELECCIÓN («ISBN del nombre ≠ ficha (escaneados)») para que las
 * arregles desde el panel con ⚙️ Acciones → «🔎 Extraer ISBN» marcando «forzar»: el motor de reidentificar-doc lee
 * el ISBN del nombre (un escaneo no tiene capa de texto) y aplica las reglas de siempre (autoridad, título, carpeta).
 *
 * Uso:
 *   node scripts/detectar-isbn-nombre-escaneados.js                 → lista + crea la selección
 *   node scripts/detectar-isbn-nombre-escaneados.js --sin-seleccion → solo lista
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { validarISBN, variantesISBN } from '../src/utils/identificadores.js';
import { isbnDelNombreFichero, isbnEstaEnNombre } from '../src/utils/isbn-nombre.js';
import { crearSeleccion } from '../src/utils/selecciones.js';

const SIN_SELECCION = process.argv.includes('--sin-seleccion');

const db = await conectarDB();
const col = db.collection('biblioteca');

// Los identificados por visión u OCR sobre las páginas de un PDF escaneado (la rama que perdía el ISBN del nombre).
const filtro = { alertas_agente: { $regex: 'identificado por VISIÓN sobre las páginas|OCR de reserva' } };
const total = await col.countDocuments(filtro);
console.log(`\n🔍 PDF escaneados identificados por visión/OCR: ${total}\n`);

const p = progreso(total, 'Mirando');
const hallados = [];
let conIsbnEnNombre = 0;
for await (const d of col.find(filtro, { projection: { nombre_archivo: 1, isbn: 1, titulo: 1 } })) {
    p.paso(d.titulo);
    const delNombre = isbnDelNombreFichero(d.nombre_archivo || '', d.isbn);
    if (!delNombre) continue;
    conIsbnEnNombre++;
    // Bien si la ficha lleva uno de los ISBN del nombre (con varios en el nombre, cualquiera de ellos).
    if (d.isbn && isbnEstaEnNombre(d.nombre_archivo, d.isbn)) continue;
    const actual = d.isbn ? validarISBN(d.isbn) : null;
    if (actual && variantesISBN(delNombre).includes(actual)) continue;
    hallados.push(d);
    p.nota(`   · ${d._id} · ficha ${d.isbn || '—'} «${String(d.titulo).slice(0, 50)}» · nombre ${delNombre} «${String(d.nombre_archivo).slice(0, 60)}»`);
}
console.log(`   (${p.fin()}) Con ISBN en el nombre: ${conIsbnEnNombre} · con OTRO ISBN en la ficha (o ninguno): ${hallados.length}\n`);

if (hallados.length && !SIN_SELECCION) {
    const sel = await crearSeleccion(db, {
        nombre: `ISBN del nombre ≠ ficha (escaneados) (${hallados.length})`,
        descripcion: 'PDF escaneados cuya ficha no lleva el ISBN escrito en el nombre del fichero (la visión lo pisó). '
            + 'Arreglo: ⚙️ Acciones → «🔎 Extraer ISBN» con «forzar». scripts/detectar-isbn-nombre-escaneados.js, 26-nov.',
        docs: hallados.map((d) => d._id),
    });
    console.log(`   📋 Selección creada: «${sel?.nombre || 'ISBN del nombre ≠ ficha'}» → Búsqueda → Selecciones.\n`);
}
process.exit(0);
