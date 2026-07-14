// src/config.js — Ajustes configurables del proyecto (NO secretos).
//
// FUENTE ÚNICA de los valores por defecto de todos los "tweakables" numéricos. Va en git, así que
// se edita tanto en el repositorio como en la app desplegada (en el NAS es /app/src/config.js por
// el bind mount; reinicia el contenedor para aplicar). Los SECRETOS y rutas NO van aquí: viven en
// `.env` (ver `.env.example`).
//
// Prioridad: variable de entorno (.env) > este fichero. Es decir:
//   - edita AQUÍ para un cambio permanente y compartido (viaja con git);
//   - usa `.env` en el NAS para un override puntual que SOBREVIVA a los despliegues (este fichero
//     se sobrescribe al desplegar desde git; `.env` está excluido del rsync).
//
// Se importa lo PRIMERO (tras dotenv) en app.js y vigilante.js: siembra process.env con estos
// valores para las claves que `.env` no haya fijado, de modo que el resto del código las lee con
// el habitual `process.env.X`.

export const AJUSTES = {
    // --- General ---
    PORT: 3000,                     // puerto de la API REST
    // Fuentes para "buscar copia" al sanear ilegibles de Cuarentena (JSON [{nombre,url}]; {q}=consulta).
    // Estos dominios ROTAN (Anna's Archive / Z-Library cambian de TLD a menudo): cuando uno deje de
    // resolver, edita su dominio aquí —o, mejor, en `.env` (FUENTES_COPIA, sobrevive a los despliegues)—.
    FUENTES_COPIA: JSON.stringify([
        { nombre: "Anna's Archive", url: 'https://annas-archive.gl/search?q={q}' },
        { nombre: 'Z-Library', url: 'https://z-library.sk/s/?q={q}' },
        { nombre: 'Libgen', url: 'https://libgen.bz/index.php?req={q}' },
        { nombre: 'Gutenberg', url: 'https://www.gutenberg.org/ebooks/search/?query={q}' },
    ]),
    HTTP_TIMEOUT_MS: 20000,         // timeout de TODA llamada HTTP a las APIs bibliográficas
    OL_TIMEOUT_MS: 20000,           // timeout de OpenLibrary; el circuit-breaker evita esperar en cada fallo
    DNB_TIMEOUT_MS: 15000,          // timeout de Deutsche Nationalbibliothek (SRU público)
    BNF_TIMEOUT_MS: 15000,          // timeout de la Bibliothèque nationale de France (SRU público)

    // --- Vigilante del Inbox ---
    PAUSA_INGESTA_MS: 1500,         // pausa entre recursos (no saturar APIs)
    REPOSO_INBOX_MS: 2500,          // espera tras el último cambio antes de procesar (ruta por eventos)
    VIGILANTE_POLL_MS: 1500,        // intervalo de sondeo de chokidar
    VIGILANTE_ESCANEO_MS: 10000,    // cada cuánto se reescanea el Inbox (red de seguridad del NAS)
    VIGILANTE_ESTABILIDAD_MS: 1500, // ventana para confirmar que un archivo terminó de escribirse
    VIGILANTE_AUTOSTART: '0',       // '1' = arranca catalogando ya; por defecto arranca PAUSADO (se activa en el Panel)
    INBOX_HUERFANO_MS: 600000,      // tras este tiempo con 0 bytes → fantasma → Cuarentena (10 min)

    // --- Mantenimiento (Conformador) ---
    MANTENIMIENTO_REPOSO_MS: 300000, // Inbox inactivo necesario antes de una pasada (5 min)
    MANTENIMIENTO_LOTE: 25,          // documentos por pasada (disparo automático)
    MANTENIMIENTO_PAUSA_MS: 800,     // pausa entre documentos durante el mantenimiento
    MANTENIMIENTO_DESC_LOTE: 0,      // descripciones de clasificación (CDU/Dewey/LCC) por pasada del Conformador.
                                     // 0 = OFF (por defecto): se generan bajo demanda (al abrir el ⓘ). Para un
                                     // backfill controlado usa mejor la CAMPAÑA «descripciones» del panel (ajustable).

    // --- Campañas de fondo (backfill autorreparable al reposo; ajustables en el panel) ---
    CAMPANAS_PAUSA_MS: 700,          // ritmo entre elementos de una tanda de campaña (respeta a las APIs)
    DESC_LOTE_IA: 6,                 // descripciones CDU/Dewey/LCC por LLAMADA de IA (batch → menos coste/llamadas)
    DESC_PAUSA_MS: 400,              // ritmo entre códigos al describir

    // --- Portadas (resolver-portada) ---
    PORTADA_ANCHO_OBJETIVO: 1000,   // ancho ideal; por debajo se intenta mejorar
    PORTADA_ANCHO_DECENTE: 500,     // si ya hay algo así de ancho, no se descargan portadas remotas
    PORTADA_ANCHO_MINIMO: 100,      // por debajo = imagen degenerada y se descarta (el 1x1 de OL)

    // --- PDF: extracción de texto, rasterizado y OCR ---
    PDF_PAGINAS_FRENTE: 15,         // nº de primeras páginas de las que se extrae texto (ISBN/título)
    PDF_PAGINAS_FONDO: 5,           // nº de últimas páginas de las que se extrae texto
    PDF_RASTER_ANCHO: 1024,         // ancho del rasterizado de portada (poppler)
    PDF_OCR_PAGINAS: 5,             // nº de primeras páginas (+ la última) a rasterizar para OCR/barras. OJO: la
                                    // página de CRÉDITOS/ISBN suele ser la 4ª-5ª → con menos se perdía. Mín. 5.
    PDF_OCR_ANCHO: 1600,            // ancho del rasterizado para OCR/barras (alto = ISBN en letra pequeña legible)
    PDF_BARRAS_ANCHO: 2000,         // ancho equivalente de los recortes del código de barras (alto pero acotado para no asfixiar al Atom)

    // --- Clasificación por nº de páginas (solo PDF) ---
    // Un PDF ESCANEADO con MENOS de N páginas → libro de 'papel' (un ejemplar físico fino escaneado); el
    // PDF se CONSERVA igualmente en la carpeta junto a las páginas extraídas (salvaguarda). Con N o más
    // páginas se mantiene como PDF digital.
    CLASIF_PAPEL_MAX_PAGINAS: 12,
    // Un PDF LEGIBLE (con capa de texto) con MENOS de N páginas y SIN identidad propia de libro (ISBN/CIP
    // propio) → 'articulo' (si trae DOI) o 'capitulo' (fragmento de un libro), no un libro. Con N o más
    // páginas se decide libro/revista por el contenido (ISBN/ISSN), como siempre.
    CLASIF_CAPITULO_MAX_PAGINAS: 20,

    // --- DjVu (rasterizado bajo demanda para el visor / la extracción de imágenes) ---
    // Nº MÁXIMO de páginas DjVu que se rasterizan A LA VEZ. Cada una lanza ddjvu+pdftoppm (procesos nativos
    // pesados): el visor pide muchas miniaturas de golpe y, sin cola, una docena simultánea COLGABA el NAS
    // (Atom, 2 núcleos). 1 = seguro en el Atom; súbelo en una máquina con más núcleos.
    DJVU_CONCURRENCIA: 1,
};

// Siembra process.env con los valores de AJUSTES que .env NO haya definido (env > config).
for (const [clave, valor] of Object.entries(AJUSTES)) {
    if (process.env[clave] === undefined || process.env[clave] === '') {
        process.env[clave] = String(valor);
    }
}

export default AJUSTES;
