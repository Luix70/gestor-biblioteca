import fs from 'fs';

export async function obtenerFichaCompletaPorISBN(isbn) {
  const endpointUrl = 'https://bne.es';
  const isbnLimpio = isbn.replace(/[- ]/g, '');

  const query = `
    PREFIX bne: <http://bne.es>
    SELECT ?libro ?tituloCompleto
    WHERE {
      ?libro bne:P3013 "${isbnLimpio}" .
      OPTIONAL { ?libro bne:P3004 ?tituloCompleto . }
    }
    LIMIT 1
  `;

  try {
    const bodyParams = new URLSearchParams();
    bodyParams.append('query', query);
    bodyParams.append('format', 'application/sparql-results+json'); // Formato explícito MIME

    const response = await fetch(endpointUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/sparql-results+json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' // Simulamos un navegador
      },
      body: bodyParams.toString()
    });

    console.log(`\n=== PASO 1: Diagnóstico de Conexión ===`);
    console.log(`Código de Estado HTTP: ${response.status} ${response.statusText}`);
    console.log(`Content-Type devuelto: ${response.headers.get('content-type')}`);

    const textoCuerpo = await response.text();

    // Si el contenido recibido es HTML, diagnosticamos la raíz del problema
    if (!response.ok || textoCuerpo.trim().startsWith('<!DOCTYPE')) {
      console.error(`\n❌ ¡El servidor rechazó la consulta y devolvió una página HTML!`);
      
      // Guardamos el HTML para que puedas inspeccionarlo visualmente abriéndolo en Chrome
      fs.writeFileSync('./bne_error_dump.html', textoCuerpo);
      console.log(`💾 Se ha guardado el documento de error completo en: ./bne_error_dump.html`);

      // Intentamos extraer el título del error o el mensaje técnico dentro de las etiquetas HTML
      const matchTitulo = textoCuerpo.match(/<title>([\s\S]*?)<\/title>/i);
      const matchH1 = textoCuerpo.match(/<h1>([\s\S]*?)<\/h1>/i);
      const matchPre = textoCuerpo.match(/<pre>([\s\S]*?)<\/pre>/i); // Virtuoso suele escribir los errores sintácticos aquí

      console.log(`\n=== PASO 2: Análisis del Mensaje de Error ===`);
      if (matchTitulo) console.log(`Etiqueta <title>: ${matchTitulo[1].trim()}`);
      if (matchH1) console.log(`Etiqueta <h1>: ${matchH1[1].trim()}`);
      if (matchPre) console.log(`Detalle técnico <pre>: ${matchPre[1].trim()}`);
      
      return null;
    }

    // Si es JSON válido, procedemos de manera regular
    const data = JSON.parse(textoCuerpo);
    console.log(`\n✅ ¡Respuesta JSON válida recibida!`);
    return data;

  } catch (error) {
    console.error(`\n🚨 Fallo crítico en el bloque catch:`, error.message);
    throw error;
  }
}
