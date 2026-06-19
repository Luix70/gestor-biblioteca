/**
 * Diagnóstico Europeana — comprueba qué devuelve la API para ISBNs de nuestra biblioteca.
 * Uso: node "Test Battery/test-europeana.js" [isbn]
 */
import 'dotenv/config';
import '../src/config.js';
import axios from 'axios';

const KEY = process.env.EUROPEANA_API_KEY;
if (!KEY) { console.error('EUROPEANA_API_KEY no encontrada en .env'); process.exit(1); }
console.log(`API key: ${KEY.slice(0, 8)}...`);

const ISBN = process.argv[2] || '9788491041795';
console.log(`ISBN de prueba: ${ISBN}\n`);

// ── 1. Search API (REST JSON) ──────────────────────────────────────────────
async function probarSearchAPI() {
    console.log('── Search API (REST JSON) ─────────────────────────────────');
    const r = await axios.get('https://api.europeana.eu/record/v2/search.json', {
        params: { query: `proxy_dc_identifier:${ISBN}`, wskey: KEY, profile: 'rich', rows: 3 },
        timeout: 15000,
    });
    console.log(`totalResults: ${r.data.totalResults}`);
    if (!r.data.items?.length) { console.log('Sin resultados.\n'); return; }
    const item = r.data.items[0];
    console.log(`Título:       ${item.title}`);
    console.log(`dataProvider: ${item.dataProvider}`);
    console.log(`provider:     ${item.provider}`);
    console.log(`dcIdentifier: ${JSON.stringify(item.dcIdentifier)}`);
    console.log(`dcSubject:    ${JSON.stringify(item.dcSubject)}`);
    console.log(`dctermsSubject: ${JSON.stringify(item.dctermsSubject)}`);
    console.log(`Todos los campos: ${Object.keys(item).join(', ')}`);

    // Si hay resultado, buscar el record completo
    if (item.id) {
        console.log(`\nRecord ID: ${item.id}`);
        const rec = await axios.get(`https://api.europeana.eu/record/v2${item.id}.json`, {
            params: { wskey: KEY, profile: 'full' },
            timeout: 15000,
        });
        const proxies = rec.data.object?.proxies || [];
        for (const p of proxies) {
            if (p.dcSubject || p.dctermsSubject) {
                console.log(`\nProxy (${p.about}):`);
                console.log(`  dcSubject:      ${JSON.stringify(p.dcSubject)}`);
                console.log(`  dctermsSubject: ${JSON.stringify(p.dctermsSubject)}`);
            }
        }
    }
    console.log();
}

// ── 2. SPARQL (por si el Search API no da CDU) ────────────────────────────
async function probarSPARQL() {
    console.log('── SPARQL ─────────────────────────────────────────────────');
    const query = `
PREFIX dc: <http://purl.org/dc/elements/1.1/>
PREFIX ore: <http://www.openarchives.org/ore/terms/>
PREFIX edm: <http://www.europeana.eu/schemas/edm/>
SELECT ?subject ?type WHERE {
  ?proxy dc:identifier "${ISBN}" .
  OPTIONAL { ?proxy dc:subject ?subject . }
  OPTIONAL { ?proxy dc:type ?type . }
} LIMIT 10`;
    const r = await axios.get('https://sparql.europeana.eu/', {
        params: { query, format: 'application/sparql-results+json' },
        timeout: 20000,
        headers: { Accept: 'application/sparql-results+json' },
    });
    const bindings = r.data?.results?.bindings || [];
    console.log(`Resultados SPARQL: ${bindings.length}`);
    for (const b of bindings) {
        console.log(`  subject: ${b.subject?.value || '-'}  type: ${b.type?.value || '-'}`);
    }
    console.log();
}

try { await probarSearchAPI(); } catch (e) {
    console.error(`Search API error: ${e.response?.status} ${e.message}`);
    if (e.response?.data) console.log(String(e.response.data).slice(0, 300));
}

try { await probarSPARQL(); } catch (e) {
    console.error(`SPARQL error: ${e.response?.status} ${e.message}`);
    if (e.response?.data) console.log(String(e.response.data).slice(0, 300));
}

console.log('✅ Test completo.');
