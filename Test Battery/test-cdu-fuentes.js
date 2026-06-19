/**
 * Diagnóstico de fuentes CDU: muestra exactamente qué responden BNE y LOC
 * para un ISBN conocido, antes de parsear nada.
 *
 * Uso:  node "Test Battery/test-cdu-fuentes.js" [isbn]
 * Ej:   node "Test Battery/test-cdu-fuentes.js" 9788491041795
 */
import 'dotenv/config';
import '../src/config.js';
import axios from 'axios';

const ISBN = process.argv[2] || '9788491041795';
const ISBN_LIMPIO = ISBN.replace(/-/g, '');

async function probar(nombre, fn) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Probando: ${nombre}`);
    console.log('─'.repeat(60));
    try {
        const inicio = Date.now();
        const resultado = await fn();
        console.log(`✔ OK en ${Date.now() - inicio} ms`);
        console.log(typeof resultado === 'string'
            ? resultado.slice(0, 1000)
            : JSON.stringify(resultado, null, 2).slice(0, 1000));
    } catch (e) {
        console.log(`✘ ERROR: ${e.message} (${e.code || e.response?.status || ''})`);
    }
}

// ── BNE ────────────────────────────────────────────────────────────────────

await probar('BNE SPARQL — predicate P1001/P4020', async () => {
    const query = `
PREFIX bnedef: <http://datos.bne.es/def/>
SELECT DISTINCT ?cdu WHERE {
  ?rec bnedef:P1001 "${ISBN_LIMPIO}" .
  ?rec bnedef:P4020 ?cdu .
} LIMIT 5`;
    const r = await axios.get('http://datos.bne.es/sparql', {
        params: { query, format: 'application/sparql-results+json' },
        timeout: 15000,
        headers: { Accept: 'application/sparql-results+json' },
    });
    return r.data;
});

await probar('BNE SPARQL — buscar cualquier triple con el ISBN (descubrir predicado)', async () => {
    const query = `SELECT ?s ?p ?o WHERE { ?s ?p "${ISBN_LIMPIO}" . } LIMIT 10`;
    const r = await axios.get('http://datos.bne.es/sparql', {
        params: { query, format: 'application/sparql-results+json' },
        timeout: 15000,
        headers: { Accept: 'application/sparql-results+json' },
    });
    return r.data;
});

await probar('BNE SPARQL — buscar con bibo:isbn13', async () => {
    const query = `
PREFIX bibo: <http://purl.org/ontology/bibo/>
SELECT ?s ?p ?o WHERE {
  ?s bibo:isbn13 "${ISBN_LIMPIO}" .
  ?s ?p ?o .
} LIMIT 20`;
    const r = await axios.get('http://datos.bne.es/sparql', {
        params: { query, format: 'application/sparql-results+json' },
        timeout: 15000,
        headers: { Accept: 'application/sparql-results+json' },
    });
    return r.data;
});

await probar('BNE SRU (Sierra) — búsqueda por ISBN', async () => {
    const url = `https://catalogo.bne.es/sru?version=1.1&operation=searchRetrieve&query=dc.identifier="${ISBN_LIMPIO}"&recordSchema=marcxml&maximumRecords=1`;
    const r = await axios.get(url, { timeout: 15000 });
    return r.data.slice(0, 2000);
});

await probar('BNE catalog — URL clásica SirsiDynix por ISBN', async () => {
    const url = `https://catalogo.bne.es/uhtbin/cgisirsi/?searchdata1=${ISBN_LIMPIO}&srchfield1=020`;
    const r = await axios.get(url, { timeout: 15000, headers: { 'User-Agent': 'Mozilla/5.0' } });
    return r.data.slice(0, 2000);
});

// ── LOC ────────────────────────────────────────────────────────────────────

await probar('LOC — catalog JSON search por ISBN', async () => {
    const r = await axios.get('https://catalog.loc.gov/vwebv/search', {
        params: { searchCode: 'ISAB', searchArg: ISBN_LIMPIO, searchType: '1', recCount: '1' },
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return r.data.slice(0, 3000);
});

await probar('LOC — www.loc.gov/search JSON', async () => {
    const r = await axios.get('https://www.loc.gov/search/', {
        params: { q: `isbn:${ISBN_LIMPIO}`, fo: 'json' },
        timeout: 15000,
    });
    return r.data;
});

await probar('LOC — lccn.loc.gov MODS directo (requiere lccn conocido; usando ISBN como fallback)', async () => {
    const r = await axios.get(`https://lccn.loc.gov/${ISBN_LIMPIO}.mods.xml`, { timeout: 15000 });
    return r.data.slice(0, 2000);
});

console.log('\n✅ Diagnóstico completo.');
