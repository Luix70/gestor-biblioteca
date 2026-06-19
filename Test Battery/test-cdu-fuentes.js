/**
 * Diagnóstico de fuentes CDU — segunda ronda.
 * Prueba BNE Primo (nuevo sistema desde 2021), SPARQL vía POST, DNB SRU,
 * y LOC con timeout mayor y User-Agent de navegador.
 *
 * Uso:  node "Test Battery/test-cdu-fuentes.js" [isbn]
 * Ej:   node "Test Battery/test-cdu-fuentes.js" 9788491041795
 */
import 'dotenv/config';
import '../src/config.js';
import axios from 'axios';

const ISBN = process.argv[2] || '9788491041795';
const ISBN_LIMPIO = ISBN.replace(/-/g, '');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function probar(nombre, fn) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`Probando: ${nombre}`);
    console.log('─'.repeat(60));
    try {
        const inicio = Date.now();
        const resultado = await fn();
        console.log(`✔ OK en ${Date.now() - inicio} ms`);
        const texto = typeof resultado === 'string' ? resultado : JSON.stringify(resultado, null, 2);
        console.log(texto.slice(0, 1500));
    } catch (e) {
        console.log(`✘ ERROR: ${e.message} (${e.code || e.response?.status || ''})`);
        if (e.response?.data) console.log('  body:', String(e.response.data).slice(0, 300));
    }
}

// ── BNE Primo (Ex Libris Alma — sistema actual desde 2021) ─────────────────

await probar('BNE Primo API — vid 34BNE_BNE1', async () => {
    const r = await axios.get('https://api-eu.hosted.exlibrisgroup.com/primo/v1/search', {
        params: { vid: '34BNE_BNE1', q: `isbn,contains,${ISBN_LIMPIO}`, limit: 1, offset: 0 },
        timeout: 20000, headers: { 'User-Agent': UA },
    });
    return r.data;
});

await probar('BNE Primo API — vid 34BNE_VU1', async () => {
    const r = await axios.get('https://api-eu.hosted.exlibrisgroup.com/primo/v1/search', {
        params: { vid: '34BNE_VU1', q: `isbn,contains,${ISBN_LIMPIO}`, limit: 1, offset: 0 },
        timeout: 20000, headers: { 'User-Agent': UA },
    });
    return r.data;
});

await probar('BNE Primo — URL pública del catálogo (descubrir VID)', async () => {
    // Si redirige a Primo, la URL final revelará el VID real
    const r = await axios.get('https://catalogo.bne.es', {
        timeout: 15000, headers: { 'User-Agent': UA },
        maxRedirects: 5,
    });
    // Buscar menciones de vid= o exlibrisgroup en el HTML
    const menciones = (r.data.match(/(vid=[^&"'\s]+|exlibrisgroup[^"'\s]*)/g) || []).slice(0, 5);
    return { status: r.status, url_final: r.request?.res?.responseUrl || '(no redirect)', menciones };
});

// ── BNE SPARQL vía POST ────────────────────────────────────────────────────

await probar('BNE SPARQL vía POST (no GET)', async () => {
    const query = `SELECT ?s ?p WHERE { ?s ?p "${ISBN_LIMPIO}" . } LIMIT 5`;
    const r = await axios.post('http://datos.bne.es/sparql',
        new URLSearchParams({ query, format: 'application/sparql-results+json' }).toString(),
        { timeout: 15000, headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json', 'User-Agent': UA } }
    );
    return r.data;
});

// ── DNB (Deutsche Nationalbibliothek) — SRU público ───────────────────────

await probar('DNB SRU — MARCXML por ISBN (DDC en campo 082)', async () => {
    const r = await axios.get('https://services.dnb.de/sru/dnb', {
        params: {
            version: '1.1',
            operation: 'searchRetrieve',
            query: `isbn=${ISBN_LIMPIO}`,
            recordSchema: 'MARC21-xml',
            maximumRecords: '1',
        },
        timeout: 20000, headers: { 'User-Agent': UA },
    });
    return r.data.slice(0, 3000);
});

// ── LOC con timeout mayor y User-Agent ────────────────────────────────────

await probar('LOC — www.loc.gov/books JSON (timeout 30 s)', async () => {
    const r = await axios.get('https://www.loc.gov/books/', {
        params: { q: `isbn:${ISBN_LIMPIO}`, fo: 'json' },
        timeout: 30000, headers: { 'User-Agent': UA },
    });
    const d = r.data;
    // Mostrar solo los primeros resultados
    if (d.results) d.results = d.results.slice(0, 2);
    return d;
});

await probar('LOC — www.loc.gov/search JSON (timeout 30 s)', async () => {
    const r = await axios.get('https://www.loc.gov/search/', {
        params: { q: `isbn:${ISBN_LIMPIO}`, fo: 'json' },
        timeout: 30000, headers: { 'User-Agent': UA },
    });
    const d = r.data;
    if (d.results) d.results = d.results.slice(0, 2);
    return d;
});

// ── VIAF (Virtual International Authority File) ────────────────────────────

await probar('VIAF — búsqueda por ISBN (enlaza registros de múltiples bibliotecas)', async () => {
    const r = await axios.get('https://www.viaf.org/viaf/search', {
        params: { query: `local.isbn all "${ISBN_LIMPIO}"`, maximumRecords: 1, httpAccept: 'application/json' },
        timeout: 15000, headers: { 'User-Agent': UA },
    });
    return r.data;
});

console.log('\n✅ Diagnóstico completo.');
