/**
 * Buscador en la BIBLIOTECA NACIONAL DE ESPAÑA por su SRU (el catálogo actual, sistema Alma de Ex Libris).
 *
 *   SRU: https://catalogo.bne.es/view/sru/34BNE_INST   ·   recordSchema=marcxml (MARC 21)
 *   CQL: alma.isbn=<isbn>   ·   alma.title="…" AND alma.creator="…"   ·   alma.publisher="…"
 *
 * Por qué vuelve la BNE en línea (se había retirado): el antiguo acceso era el SPARQL de datos.bne.es, que da
 * 403 y era redundante con el volcado BNE del Fichero. Pero ese volcado tiene AGUJEROS medidos: 2016-2018 van
 * muy flacos (27 k, 13 k y 21 k registros frente a 60-80 k de los demás años) y termina en 2024. El «Vampiro»
 * de Valdemar Gótica (2018) no está en la parte BNE del volcado; este SRU lo devuelve en 1-3 s, y además:
 *   · BUSCA SIN ISBN, por título + autor (o + editorial): justo lo que hace falta cuando el ripeo borró el ISBN.
 *   · Trae la CDU (080) ya asignada por la BNE → CDU sin IA y con autoridad.
 *   · Trae la colección con su número (490), el traductor (700 $e) y la lengua (008).
 *
 * Campos MARC 21 (confirmados contra registros reales):
 *   020$a ISBN · 245$a/$b título/subtítulo · 100$a autor · 700$a+$e colaboradores y su rol · 264|260 $b editorial
 *   $c año · 490$a/$v colección y nº · 080$a CDU · 082$a Dewey · 300$a páginas · 300$c dimensiones · 008/35-37 lengua
 *
 * Degradación elegante, como el resto de buscadores: error de red → null (y se pausa un rato, para no dejar
 * cada ingesta esperando un timeout); no hallado → {} o []; hallado → objeto(s).
 */
import { http } from './http.js';
import * as cheerio from 'cheerio';
import { esErrorDeRed } from '../errores.js';
import { validarISBN } from './identificadores.js';

const SRU = 'https://catalogo.bne.es/view/sru/34BNE_INST';
const TIMEOUT = Number(process.env.BNE_TIMEOUT_MS || 20000);

// Circuit-breaker: tras un fallo de RED, la BNE se omite unos minutos (se reintenta sola después).
const PAUSA_MS = Number(process.env.BNE_PAUSA_MS || 15 * 60 * 1000);
let pausadaHasta = 0;
export const bneDisponible = () => Date.now() >= pausadaHasta;

// MARC 008/35-37 usa códigos de 3 letras; el resto del pipeline, ISO 639-1.
const LANG = {
    spa: 'es', eng: 'en', fre: 'fr', fra: 'fr', ger: 'de', deu: 'de', ita: 'it', por: 'pt', cat: 'ca', glg: 'gl',
    baq: 'eu', eus: 'eu', lat: 'la', grc: 'el', gre: 'el', rus: 'ru', dut: 'nl', nld: 'nl', ara: 'ar', jpn: 'ja', chi: 'zh',
};
const idioma639 = (c) => { const k = String(c || '').trim().toLowerCase(); return LANG[k] || (k && k !== '|||' ? k.slice(0, 2) : null); };

/** Quita la puntuación ISBD final de MARC (« :», « /», « ;», « ,», « =», «.»). */
function limpiar(s) {
    const t = String(s == null ? '' : s).replace(/\s*[/:;,.=]\s*$/, '').trim();
    return t || null;
}
const anioDe = (s) => { const m = String(s || '').match(/(1[4-9]\d{2}|20\d{2})/); return m ? Number(m[1]) : null; };
const paginasDe = (s) => { const m = String(s || '').match(/(\d{1,5})\s*(?:p\b|pág|páginas|h\b)/i); return m ? Number(m[1]) : null; };

// Rol del colaborador (700 $e) → rol canónico del sistema. Solo los que interesan; el resto se ignora.
function rolDe(e) {
    const t = String(e || '').toLowerCase();
    if (/trad/.test(t)) return 'traductor';
    if (/ilustr/.test(t)) return 'ilustrador';
    if (/pr[oó]log/.test(t)) return 'prologuista';
    if (/\bed(\.|itor)|coord|compil/.test(t)) return 'editor';
    return null;
}

/** Un <record> MARC 21 → la forma común de los buscadores. */
function registroMarc($, rec) {
    const sub = (tag, code) => rec.find(`datafield[tag="${tag}"] subfield[code="${code}"]`).first().text().trim();
    const isbns = rec.find('datafield[tag="020"] subfield[code="a"]')
        .map((i, s) => validarISBN($(s).text().trim().split(/\s/)[0])).get().filter(Boolean);

    // 100 = autor principal. Los COAUTORES van en 700 con el rol «autor»: sin ellos la BNE parecería listar menos
    // autores de los que tiene el libro (y un llamador podría creer que sobran los que ya teníamos).
    const autores = [];
    const principal = limpiar(sub('100', 'a'));
    if (principal) autores.push(principal);
    const contribuciones = [];
    rec.find('datafield[tag="700"]').each((i, df) => {
        const nombre = limpiar($(df).find('subfield[code="a"]').first().text());
        const e = $(df).find('subfield[code="e"]').map((j, s) => $(s).text()).get().join(' ');
        if (!nombre) return;
        if (/\bautor|coautor/i.test(e) && !autores.includes(nombre)) { autores.push(nombre); return; }
        const rol = rolDe(e);
        if (rol) contribuciones.push({ nombre, rol });
    });

    // TRADUCTORES: los 700 con rol de traductor y, sobre todo, la mención de responsabilidad (245 $c), donde la
    // BNE casi siempre los escribe («Isaac Asimov ; traducción, Ana I. Domínguez…», «[P. Giralt Gorina
    // traducción]») aunque no haya 700. Una TRADUCCIÓN es de una edición concreta: distingue ediciones de un
    // mismo título mejor que nada (Plaza & Janés y Bruguera: Pilar Giralt; La Factoría: Domínguez y Rodríguez).
    const traductores = contribuciones.filter((c) => c.rol === 'traductor').map((c) => c.nombre);
    for (const trozo of sub('245', 'c').split(';')) {
        if (/tradu|transl/i.test(trozo)) traductores.push(trozo.replace(/[\[\]]/g, ' ').trim());
    }

    return {
        isbn: isbns[0] || null,
        isbns,
        traductores,
        titulo: limpiar(sub('245', 'a')),
        subtitulo: limpiar(sub('245', 'b')),
        autores,
        contribuciones_nombres: contribuciones,
        editorial: limpiar(sub('264', 'b') || sub('260', 'b')),
        año_edicion: anioDe(sub('264', 'c') || sub('260', 'c')),
        idioma: idioma639((rec.find('controlfield[tag="008"]').first().text() || '').slice(35, 38)),
        paginas: paginasDe(sub('300', 'a')),
        dimensiones: limpiar(sub('300', 'c')),
        coleccion_nombre: limpiar(sub('490', 'a')),
        coleccion_numero: limpiar(sub('490', 'v'))?.replace(/^(n[º°o.]*|vol\.?)\s*/i, '') || null,
        cdu: limpiar(sub('080', 'a')),
        dewey: limpiar(sub('082', 'a')),
        fuente: 'bne',
    };
}

/** Lanza una consulta CQL y devuelve los registros; null si la BNE no responde. */
async function consultar(cql, max = 10) {
    if (!bneDisponible()) return null;
    let res;
    try {
        res = await http.get(SRU, {
            params: { version: '1.2', operation: 'searchRetrieve', query: cql, recordSchema: 'marcxml', maximumRecords: String(max) },
            timeout: TIMEOUT,
        });
    } catch (e) {
        if (esErrorDeRed(e) || (e.response?.status >= 500)) {
            pausadaHasta = Date.now() + PAUSA_MS;
            console.warn(`⚠️  BNE inalcanzable (${e.code || e.response?.status}): pausada ${Math.round(PAUSA_MS / 60000)} min.`);
            return null;
        }
        return [];    // consulta mal formada o similar: sin resultados, no es una caída
    }
    const $ = cheerio.load(String(res.data), { xmlMode: true });
    if ((parseInt($('numberOfRecords').first().text(), 10) || 0) === 0) return [];
    return $('recordData > record').map((i, r) => registroMarc($, $(r))).get();
}

// Una cadena dentro de comillas CQL: sin comillas ni barras (romperían la consulta) ni puntuación de título.
const cqlTexto = (s) => String(s || '').replace(/["\\]/g, ' ').replace(/[:;]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Por ISBN. Admite varios candidatos (10/13): el catálogo indexa las dos formas, pero no siempre.
 * @returns {Promise<object|null>} null = BNE caída · {} = no hallado · objeto = registro
 */
export async function buscarEnBNE({ isbns }) {
    const candidatos = [...new Set((Array.isArray(isbns) ? isbns : [isbns]).filter(Boolean).map((s) => String(s).replace(/-/g, '')))];
    for (const isbn of candidatos) {
        const r = await consultar(`alma.isbn=${isbn}`, 1);
        if (r === null) return null;
        if (r.length) return r[0];
    }
    return {};
}

/**
 * EDICIONES por título + autor (y, si no hay autor, + editorial). Para identificar un libro sin ISBN: el
 * llamador decide cuál es la suya (identificar-edicion.js, con reglas estrictas).
 * @returns {Promise<Array|null>} null = BNE caída · [] = nada
 */
export async function buscarEdicionesEnBNE({ titulo, autor = null, editorial = null, max = 25 }) {
    // Título principal, sin subtítulo: el catálogo lo tiene en 245$a y el subtítulo aparte.
    const t = cqlTexto(String(titulo || '').split(/\s[:.]\s|:\s/)[0]);
    if (!t) return [];
    // Del autor, el APELLIDO: «Ewers, Hanns Heinz» y «Hanns Heinz Ewers» deben dar lo mismo.
    const a = String(autor || '').includes(',') ? String(autor).split(',')[0] : String(autor || '').trim().split(/\s+/).pop();
    const partes = [`alma.title="${t}"`];
    if (cqlTexto(a)) partes.push(`alma.creator="${cqlTexto(a)}"`);
    else if (cqlTexto(editorial)) partes.push(`alma.publisher="${cqlTexto(editorial)}"`);
    return consultar(partes.join(' AND '), max);
}
