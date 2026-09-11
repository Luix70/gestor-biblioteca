/**
 * AUDITORÍA DE LA CACHÉ DE EQUIVALENCIAS CDU (`equivalencias_cdu`).
 *
 * Busca equivalencias APRENDIDAS que CONTRADICEN a la tabla determinista Dewey/LCC → CDU, y cuenta cuántos
 * documentos las heredaron.
 *
 * POR QUÉ EXISTE (caso real): el 23-jun la IA clasificó un libro de LCC «QA» como inteligencia artificial y se
 * aprendió «lcc:qa → 004.8:004.832.2». La clase QA cubre TODA la matemática (y la informática, QA75-76). Estuvo
 * dormida hasta el 4-sep, cuando el LCC pasó a buscarse por CLASE: desde entonces cada libro de matemáticas
 * con LCC QA la heredaba, porque la caché se consultaba ANTES que la tabla (que dice QA → 51). 242 documentos
 * de álgebra, análisis numérico o geometría acabaron clasificados como IA.
 *
 * Desde el arreglo en `clasificador-cdu.js · resolverCDU`, la caché solo puede AFINAR la tabla (tabla «51» →
 * caché «512.64» vale), nunca contradecirla. Pero eso actúa al LEER: las entradas malas siguen en la base y los
 * documentos ya clasificados conservan su CDU equivocada. Esto las encuentra.
 *
 *   node scripts/auditar-equivalencias-cdu.js              (informa: no toca nada)
 *   node scripts/auditar-equivalencias-cdu.js --reparar    (reescribe con la tabla SOLO las de CLASE LCC que la contradicen)
 *
 * OJO: las equivalencias de SIGNATURA COMPLETA o de Dewey que difieren de la tabla NO se reparan nunca: son
 * específicas de su código y suelen ser MÁS FINAS que la tabla (que es gruesa a propósito). Repararlas
 * degradaría clasificaciones buenas. Ver el comentario de `esClaseLcc` más abajo.
 *
 * --reparar SOLO corrige la CACHÉ. Los documentos afectados NO se tocan aquí, porque cambiar su CDU MUEVE su
 * carpeta en el árbol: eso es una operación masiva y va aparte (acción «Investigar CDU» con «Forzar», o
 * `reidentificar-sin-isbn --cdu --forzar`), con copia de seguridad hecha antes.
 */
import 'dotenv/config';
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { buscarEquivalenciaExterna, lccACDUEspecifica, guardarEquivalencia } from '../src/clasificador-cdu.js';

const REPARAR = process.argv.includes('--reparar');

// Una CDU «refina» a otra si empieza por ella: «512.64» refina «51»; «004.8:…» NO refina «51».
const refina = (cdu, base) => String(cdu).startsWith(String(base));

async function main() {
    const db = await conectarDB();
    const entradas = await db.collection('equivalencias_cdu').find({}).toArray();

    console.log(`\n🔎 Auditoría de equivalencias CDU — ${entradas.length} entradas aprendidas`);
    console.log(`   Modo: ${REPARAR ? '⚠️  REPARAR (reescribe la caché)' : 'solo informe (no toca nada)'}\n`);

    // DOS CASOS MUY DISTINTOS, que hay que separar o el informe engaña:
    //   · CLASE LCC («qa», «pn»: solo letras) → se aplica a TODOS los libros de la clase. Si contradice a la
    //     tabla, es CONTAMINACIÓN: una decisión de un libro convertida en regla. Esto es lo que se repara.
    //   · SIGNATURA COMPLETA («pn1993.5.j3 j37 2010») o Dewey → específica de ESE código. Suele ser MÁS FINA que
    //     la tabla, que es gruesa a propósito (y en sitios, errónea: la tabla manda todo PN a 82-literatura,
    //     pero PN1993-1999 es CINE, y ahí la IA acierta con 791.4). NO se repara: se estropearía lo bueno.
    //     Además las signaturas completas están dormidas desde el 4-sep (el LCC ahora se busca por clase).
    const esClaseLcc = (e) => e.sistema_origen === 'lcc' && /^[a-z]{1,3}$/i.test(String(e.codigo_origen).trim());

    const contradictorias = [];   // de CLASE: las peligrosas
    let especificasDistintas = 0, sinTabla = 0, refinan = 0;

    let respaldoGenerico = 0;
    for (const e of entradas) {
        const tabla = await buscarEquivalenciaExterna(e.sistema_origen, e.codigo_origen);
        if (!tabla) { sinTabla++; continue; }            // la tabla no llega a este código: la caché es la única fuente
        if (refina(e.cdu, tabla)) { refinan++; continue; } // coherente (igual o más precisa)
        if (!esClaseLcc(e)) { especificasDistintas++; continue; }
        // MISMA regla que resolverCDU: solo cuenta como contaminación si la tabla tiene una entrada ESPECÍFICA para
        // la clase. Si solo tiene el respaldo de la letra («qp» → el «5» de la Q), la IA puede tener razón («612»,
        // fisiología, lo es) y no se toca.
        const especifica = lccACDUEspecifica(e.codigo_origen);
        if (!especifica || refina(e.cdu, especifica)) { respaldoGenerico++; continue; }
        contradictorias.push({ ...e, tabla: especifica });
    }

    console.log(`   Coherentes con la tabla (iguales o más precisas):     ${refinan}`);
    console.log(`   Fuera del alcance de la tabla:                        ${sinTabla}`);
    console.log(`   Específicas que difieren de la tabla (NO se tocan):   ${especificasDistintas}`);
    console.log('      ↳ signaturas completas o Dewey: suelen ser más finas que la tabla; no son contaminación');
    console.log(`   De clase, frente a un respaldo genérico (NO se tocan): ${respaldoGenerico}`);
    console.log('      ↳ la tabla no tiene esa clase y solo rellena con la letra: la IA puede tener razón');
    console.log(`   ⚠️  De CLASE LCC que CONTRADICEN a la tabla:           ${contradictorias.length}\n`);

    if (!contradictorias.length) { console.log('   ✔ Ninguna equivalencia de clase contradice a la tabla.\n'); process.exit(0); }

    // Documentos que HEREDARON cada entrada mala: tienen ese código Y exactamente esa CDU.
    // Para LCC se compara por clase (lo que hace la búsqueda) con un prefijo insensible a mayúsculas.
    const col = db.collection('biblioteca');
    let totalDocs = 0;
    for (const e of contradictorias) {
        const campo = e.sistema_origen === 'lcc' ? 'lcc' : 'dewey';
        const patron = e.sistema_origen === 'lcc' ? new RegExp(`^${e.codigo_origen}`, 'i') : new RegExp(`^${e.codigo_origen}`);
        const n = await col.countDocuments({ [campo]: patron, cdu: e.cdu });
        totalDocs += n;
        console.log(`   ${e.sistema_origen}:${e.codigo_origen}`.padEnd(18)
            + `aprendido «${e.cdu}» [${e.fuente}]  ·  la tabla dice «${e.tabla}»  ·  ${n} documento(s) afectados`);
        if (REPARAR) await guardarEquivalencia(e.sistema_origen, e.codigo_origen, e.tabla, 'Manual');
    }

    console.log(`\n   Documentos que heredaron una CDU contradictoria: ${totalDocs}`);
    if (REPARAR) console.log(`   ✔ Caché reescrita con la tabla en ${contradictorias.length} entrada(s).`);
    else console.log('   → Para corregir la caché: --reparar   (los documentos van aparte: MUEVEN carpetas)');
    console.log('');
    process.exit(0);
}

main().catch((e) => { console.error('❌', e); process.exit(1); });
