# Gestor de Biblioteca — Agente de catalogación automatizada

Agente que ingesta archivos de libros y revistas (EPUB, PDF, imágenes escaneadas), extrae y enriquece sus metadatos, los clasifica con **CDU** (Clasificación Decimal Universal) y los persiste en **MongoDB**, además de organizar los archivos en disco y generar fichas en JSON y **MARC 21**. Diseñado para correr en un contenedor Docker sobre un NAS, con una carpeta `Inbox` vigilada y una API REST.

> El código, los comentarios y los identificadores están en **español**.

---

## Technologies Used

| Tecnología | Uso en el proyecto |
|---|---|
| **Node.js (ESM)** | Runtime. `"type": "module"` — todo es `import`/`export`, sin build ni transpilación. |
| **Express 5** | API REST de ingesta y servidor estático de imágenes (`/recursos`). |
| **MongoDB (driver `mongodb`) — Atlas** | Persistencia. Colecciones con validación `$jsonSchema`. La BD es cloud: la conectividad real condiciona el manejo de errores. |
| **Multer** | Recepción de archivos subidos por la API (`multipart/form-data`). |
| **chokidar** | Vigilancia de la carpeta `Inbox` (eventos de sistema de archivos con `awaitWriteFinish`). |
| **@google/generative-ai (Gemini 2.5 Flash)** | Visión multimodal (leer ISBN/datos de imágenes y portadas) e inferencia de CDU. |
| **Google Books API** | Fuente bibliográfica gratuita (sinopsis, categorías, portada). Vía `axios`. |
| **OpenLibrary API** | Fuente bibliográfica gratuita (ISBN, editorial, año, Dewey/LCC, sinopsis). Vía `axios`. |
| **unpdf** | Extracción de texto y metadatos (info-dict) de PDF (wrapper ESM de pdf.js). |
| **adm-zip + cheerio** | Lectura de EPUB: descompresión del ZIP y parseo del OPF/Dublin Core (XML). |
| **sharp** | Optimización de imágenes (reencuadre, normalización, JPEG) antes de la visión IA. |
| **axios** | Cliente HTTP para todas las APIs externas. |
| **dotenv** | Carga de configuración desde `.env`. |
| **epub2** | (Heredado) lector EPUB alternativo, ya no usado por el flujo activo. |
| **better-sqlite3** | Índice **FTS5 local** de búsqueda (`busqueda.db`) y el volcado offline **Fichero** (OL+BNE) para Descubrir. C, sin SIMD (apto Atom). El Fichero corre en *worker thread* (es síncrono). |
| **poppler-utils** (`pdfinfo`/`pdftoppm`) | Rasterizado de PDF y recortes del código de barras (C, sin SIMD) en lugar de sharp. |
| **zxing-wasm** | Lectura local de EAN del código de barras (sin IA) como pre-paso a la visión. |
| **PWA · Web NFC · Service Worker · pdf.js** (cliente) | Panel `public/index.html`: instalable y **offline**; lectura/escritura de etiquetas NFC; explosión de PDF y lectura de barras **en el navegador**; medición/recorte con la alfombrilla reglada (sin IA). |

### Configuración (`.env` en la raíz)

```
MONGO_URI=...                 # cadena de conexión a MongoDB Atlas
MONGO_DB_NAME=Biblioteca
GEMINI_API_KEY=...
GOOGLE_BOOKS_API_KEY=...
PATH_INBOX=./Inbox            # carpeta vigilada
PATH_CDU=./CDU                # árbol de catálogo (salida)
PATH_CUARENTENA=./Cuarentena  # recursos no identificables
PATH_REINTENTOS=./Reintentos  # recursos con fallo transitorio
PORT=3000                     # opcional
# DESACTIVAR_VIGILANTE=1      # opcional: API sin vigilante
# PAUSA_INGESTA_MS / REPOSO_INBOX_MS  # opcional: ritmo del vigilante
```

---

## General Purpose

Convertir cualquier archivo de un libro o revista en un **registro bibliográfico completo y clasificado**, gastando **los mínimos recursos de IA**. El principio rector es una **escalera de coste**:

1. **El propio archivo** (metadatos EPUB/PDF, ISBN/ISSN en el texto) — coste cero.
2. **APIs gratuitas** (OpenLibrary, Google Books) — sin IA.
3. **IA (Gemini)** — solo para los huecos (visión sobre imágenes, inferencia de CDU).

El **ISBN es el eje**: obtenerlo barato permite que una llamada gratuita resuelva el resto. Dos reglas transversales:

- **Conservadurismo:** lo que aporta el archivo nunca se sobrescribe con datos de Internet/IA; las fuentes externas solo rellenan huecos.
- **Consistencia de clasificación:** las equivalencias entre sistemas (Dewey/LC → CDU) se **aprenden** y se cachean para reutilizarlas sin volver a gastar IA.

Salida por cada recurso: un documento en `biblioteca` (MongoDB) + los archivos copiados a `CDU/<cdu>/<libros|revistas>/<id>/` junto a `registro.json` y `registro.marc.xml`.

---

## Workflow

```
                 ┌──────────────────────┐         ┌────────────────────────┐
   POST /api/    │      app.js          │         │     vigilante.js        │
   ingestar  ───►│ (Express + Multer)   │         │ (chokidar → Inbox)      │
                 └──────────┬───────────┘         └───────────┬────────────┘
                            │     agrupar() (varias imágenes = 1 libro)     │
                            └───────────────┬───────────────────────────────┘
                                            ▼
                          servicio-ingesta.js · ingestarRecurso({rutas, contexto})
                                            │
       ┌────────────────────────────────────┼─────────────────────────────────────┐
       ▼ (1) EXTRAER                         ▼ (2) ENRIQUECER                        ▼ (3) PERSISTIR
  orquestador.js                      motor-enriquecimiento.js               motor-catalogo.js
   ├─ epub → lector-epub.js            └─ proveedor-metadatos.js              ├─ autores/editorial → ObjectId
   ├─ pdf  → lector-pdf.js                ├─ Tier2: buscador-bibliografico    ├─ dedup isbn→issn→título
   ├─ img  → procesador-imagenes           │        + buscador-google-books   └─ insertar / fusionar (upgrade)
   │         + agente.js (visión)          ├─ Tier3a: visión (Gemini)
   └─ otro → por nombre de archivo          └─ Tier3c: clasificador-cdu.js
                                                       (caché → API → IA, aprende)
                                            │
                                            ▼ (4) GESTIÓN DE ARCHIVOS
                          copiar a CDU/<cdu>/<libros|revistas>/<isbn|issn|_id>/
                          + registro.json + registro.marc.xml  (marc21.js, rutas.js)
                                            │
                                            ▼
                  ÉXITO: doc en MongoDB + archivos en CDU + ficha JSON/MARC
                  FALLO: gestor-fallos.js → Cuarentena (identificación) | Reintentos (infra)
```

**Pasos detallados:**
1. **Entrada y agrupación.** Llega un archivo (API) o un lote (Inbox). `agrupar()` separa cada epub/pdf como unidad propia y junta **todas las imágenes sueltas en un único libro**. Las subcarpetas del Inbox se tratan como una unidad.
2. **Extracción (Tier 1).** Según el tipo: EPUB (OPF/Dublin Core + portada), PDF (info-dict + capa de texto + regex ISBN/ISSN, marca si está escaneado), o imágenes (visión Gemini sobre el grupo).
3. **Enriquecimiento (Tier 2/3).** Se rellenan huecos con OpenLibrary y Google Books; la visión aporta pistas de ISBN; la CDU se resuelve con la caché de equivalencias o IA. Fusión **conservadora**.
4. **Persistencia.** Se resuelven autores/editorial a referencias `ObjectId`, se deduplica y se inserta o **fusiona** (rellena huecos y promociona `pendiente`→`completado`).
5. **Gestión de archivos.** Se copian los originales y las portadas al árbol CDU y se escriben las fichas `registro.json` y `registro.marc.xml`.
6. **Resultado / fallo.** Éxito → catálogo + disco. Fallo → Cuarentena o Reintentos con `estado.json`.

---

## Panel de control web (PWA)

Además de la API y el Inbox por carpeta, `app.js` sirve un **panel web de una sola página** (`public/index.html`) que es la interfaz de uso diario. **Móvil-first**, instalable como **PWA** y operable **sin conexión** para parte de su función. Resumen de prestaciones (detalle de uso en `instructions.txt §7`):

- **Sesión y roles:** login admin/invitado con **token HMAC firmado** que sobrevive a reinicios (~2 días). El invitado es **estrictamente de solo lectura** (ninguna mutación, ninguna IA) y, por defecto, no ve el contenido **NSFW** (conmutable por el admin).
- **Búsqueda y catálogo:** índice local **SQLite-FTS** (rápido, insensible a acentos; cae a Mongo si falta). Filtros plegables: tipo, soporte (papel/digital), ámbito/estantería, CDU, estrellas, **🔞 solo NSFW**, orden; paginación arriba y abajo; valoración por estrellas; borrado por lotes (admin); **🔭 Descubrir** (busca en el volcado *Fichero* OL+BNE lo que no tienes).
- **Ficha:** datos + clasificaciones con ⓘ y recuento drillable, identificadores clicables, ISBN alternativos, sinopsis, chip **📍 ubicación**; acciones admin: editar/bloquear, **imágenes** (editor en navegador: rotar, recortar, **perspectiva** con auto-bordes), **📐 medir**, conformar, enriquecer, reprocesar, eliminar, **📶 grabar NFC**.
- **Inbox operativo:** subir/arrastrar/cámara/compartir (Web Share Target desde Adobe Scan). PDF de escaneo **explotado a imágenes en el navegador** + lectura de código de barras (ISBN) sin IA. Interruptores persistentes: **🚥 Supervisado** (revisar/aceptar o **descartar** el alta), **📐 Tapete**, **🖼️ Elegir portada**, autopiloto con cola.
- **Tapete (alfombrilla reglada, sin IA, en el navegador):** mide el libro por el paso de la **rejilla de 1 cm** (robusto al giro del tapete y del libro), recorta+endereza (homografía) y guarda las **dimensiones**; **calibración por tono** (cualquier color de tapete/luz) y **🔍 Probar** (máscara + contorno + medida).
- **NFC (Web NFC, Android/Chrome):** etiqueta de **libro** con enlace a la ficha + **datos offline** (ubicación, título, autor, editorial, colección, CDU, ISBN, con tope de capacidad) para recolocar sin conexión; etiqueta de **estantería** que lista sus libros; lectura online→ficha / offline→tarjeta con ubicación.
- **Ubicaciones:** ámbitos/estanterías gestionados como colecciones (crear por lotes, renombrar, fusionar, mover, explotar, eliminar, NFC de estantería).
- **Actividad:** vigilante, Conformador, integridad, sanear, visión (proveedores), reindexar FTS, permisos de invitados, logs en vivo. **Cuarentena:** no-identificados, ilegibles (flujo de saneamiento) y duplicados.
- **Offline (service worker):** estrategia *network-first* — online trae lo último (los despliegues se ven al instante), offline sirve la copia cacheada y arranca en modo lectura-NFC.

---

## Modules — purpose, functions, dependencies, interlinking

### Puntos de entrada

#### `src/app.js`
API REST + arranque del vigilante. **Libs:** `express`, `multer`, `dotenv`.
- Sirve `PATH_CDU` en `/recursos` (estático, para que el front-end recupere portadas).
- `POST /api/ingestar`: recibe archivos (`multer.array('files')`), lee `ubicacion` del cuerpo, agrupa con `agrupar()` y procesa cada unidad con `ingestarRecurso()`; enruta fallos a Cuarentena/Reintentos; limpia temporales. `GET /health`.
- Al escuchar, lanza `iniciarVigilante()` salvo `DESACTIVAR_VIGILANTE=1`.
- **Usa:** `servicio-ingesta`, `utils/agrupador`, `gestor-fallos`, `vigilante`.

#### `src/vigilante.js`
Vigía de la carpeta `Inbox`. **Libs:** `chokidar`, `fs/promises`.
- `iniciarVigilante()` → observa `Inbox` con `awaitWriteFinish`; tras un periodo de reposo procesa la cola **en serie** con una pausa entre ítems (no saturar APIs).
- Construye unidades (subcarpetas como bloque; imágenes sueltas agrupadas en un libro), procesa con `ingestarRecurso()`, limpia el Inbox al terminar y enruta fallos.
- **Usa:** `servicio-ingesta`, `utils/agrupador`, `gestor-fallos`.

### Orquestación

#### `src/servicio-ingesta.js`  ⭐ pipeline compartido
`ingestarRecurso({ rutas, contexto })` — usado por **ambos** puntos de entrada. Orquesta extracción → catalogación → copia a CDU → enlace de rutas → fichas JSON/MARC. Devuelve `{_id, operacion, estado, isbn, issn, carpeta, rutaWeb, documento}`. Adjunta el documento parcial a errores de infraestructura para poder reanudar. **Libs:** `axios` (descarga de portadas remotas), `fs/promises`.
- **Usa:** `orquestador`, `motor-catalogo` (`procesarCatalogo`, `actualizarDocumento`), `utils/rutas`, `marc21`.

#### `src/orquestador.js`
`procesarRecurso(entrada)` — enruta por tipo de archivo y devuelve `{documento, activos}` (activos = imágenes a guardar; la primera es la portada). `detectarTipo(ruta)` clasifica `epub|pdf|imagen|otro-formato|desconocido`. Aplica reglas conservadoras (PDF escaneado sin ISBN propio nunca se da por verificado) y lanza `ErrorIdentificacion` si no hay título. **Libs:** `fs/promises`.
- **Usa:** `utils/lector-epub`, `utils/lector-pdf`, `agente`, `procesador-imagenes`, `motor-enriquecimiento`, `utils/parsear-nombre`, `errores`.

### Lectores (Tier 1 — extracción del archivo)

#### `src/utils/lector-epub.js`
`extraerMetadatosEpub(ruta)` — abre el EPUB como ZIP, parsea el OPF/Dublin Core (título, autores, ISBN, editorial, idioma, sinopsis limpia de HTML, año, palabras_clave) y extrae la portada (o la página de créditos) en base64. **Libs:** `adm-zip`, `cheerio`, `fs/promises`.

#### `src/utils/lector-pdf.js`
`extraerMetadatosPdf(ruta)` — info-dict (Title/Author), capa de texto, regex de ISBN e ISSN, y `texto_legible` (false si está escaneado). Usa `parsearNombre()` para deducir título/autores o, si el nombre está fechado (revista), año e idioma. **Libs:** `unpdf`, `fs/promises`. **Usa:** `utils/identificadores` (`extraerISSN`), `utils/parsear-nombre`.

#### `src/agente.js`
`analizarImagenesRecurso(buffers, datosEpub)` — envía un grupo de imágenes a Gemini con instrucciones de bibliotecario y devuelve un documento estructurado (tipo_recurso, título, cdu, idioma, isbn/issn, editorial, sinopsis, etc.). **Libs:** `@google/generative-ai`, `dotenv`.

#### `src/procesador-imagenes.js`
`optimizarImagenRecurso(buffer)` — reencuadra, normaliza y convierte a JPEG (1000 px) para reducir tokens antes de la visión. **Libs:** `sharp`.

### Enriquecimiento (Tier 2/3)

#### `src/motor-enriquecimiento.js`  ⭐ autoridad de fusión conservadora
`enriquecerMetadatos(datosBase, contexto)` — combina datos crudos del lector con fuentes externas **sin sobrescribir** lo del archivo (`primerValido`). Normaliza sinopsis (`sinopsis`/`sinopsis_nativa`), valida y descarta ISBN/ISSN con dígito de control inválido, calcula `estado_verificacion`, aplica la excepción de "editoriales falsas" (ePubLibre → editorial real de la API prevalece) y elimina campos internos/nulos antes de persistir. **Usa:** `utils/proveedor-metadatos`, `utils/identificadores`.

#### `src/utils/proveedor-metadatos.js`
`buscarMetadatosExternos(titulo, autor, imagenBase64, opciones)` — flujo maestro de fuentes externas: Tier 3a (visión → pistas de ISBN), Tier 2a (OpenLibrary), Tier 2b (Google Books), Tier 3c (CDU vía `resolverCDU`). Degrada con alerta si una API de red falla (no aborta). Devuelve `datosExtra` (isbn, sinopsis, editorial, año, idioma, categorías, dewey, lcc, portadas_remotas, cdu, alertas). **Libs:** `@google/generative-ai` (visión), `axios`. **Usa:** `buscador-bibliografico`, `buscador-google-books`, `clasificador-cdu`.

#### `src/utils/buscador-bibliografico.js`
`buscarPorCriterios(criterios)` — OpenLibrary: lookup por ISBN y, si falla/404, búsqueda por título+autor (autocorrige ISBN mal leído). Normaliza isbn, editorial, año, **dewey, lcc**, y recupera la sinopsis del `work`. Lanza `ErrorInfraestructura` en fallo de red (no en 404). **Libs:** `axios`. **Usa:** `errores`.

#### `src/utils/buscador-google-books.js`
`buscarEnGoogleBooks(criterios)` — Google Books por ISBN o título+autor. Normaliza isbn, editorial, año, idioma, categorías y URL de portada. Lanza `ErrorInfraestructura` en fallo de red. **Libs:** `axios`. **Usa:** `errores`.

#### `src/clasificador-cdu.js`  ⭐ aprendizaje de equivalencias
- `resolverCDU({dewey, lcc, categoria, titulo, sinopsis})` — **caché aprendida → API externa (preparada) → IA**; al derivar por IA, **aprende** la equivalencia Dewey/LC→CDU.
- `buscarEquivalencia(sistema, codigo)` / `guardarEquivalencia(...)` — lectura/escritura tolerante a fallos en `equivalencias_cdu`.
- **Libs:** `@google/generative-ai`. **Usa:** `database`.

### Persistencia y salida

#### `src/motor-catalogo.js`
- `procesarCatalogo(documento)` — resuelve `autores`/`editorial` (string → `ObjectId`, crea si no existe), deduplica por **isbn → issn → título**, y **inserta o fusiona** (`calcularActualizacion`: rellena huecos, promociona `pendiente`→`completado`, une formatos/palabras_clave/imágenes/alertas). Traduce errores de Mongo a `ErrorInfraestructura` y detecta la violación de esquema (código 121).
- `actualizarDocumento(_id, campos)` — `$set` posterior (ruta_base/imagenes/portada).
- **Libs:** `mongodb` (indirecto). **Usa:** `database`, `errores`.

#### `src/database.js`
`conectarDB()` — cliente singleton de MongoDB (fuerza IPv4, DNS de Google para SRV). Devuelve la base `MONGO_DB_NAME`. **Libs:** `mongodb`, `node:dns`.

#### `src/marc21.js`
`aMARCXML(doc)` — genera un registro **MARC 21 (MARCXML, esquema MARC21/slim de la LoC)**: leader (m/s), `008` (año+idioma ISO-639-2), `020` ISBN, `022` ISSN, `041` idioma, `080` CDU, `100`/`700` autores, `245` título, `264` publicación, `520` sinopsis, `653` materias, `856` enlace. Sin dependencias externas.

#### `src/utils/rutas.js`
- `sanitizarSegmento(s)` — vuelve un texto seguro como nombre de carpeta en **Windows y Linux** (`141.78:81'37` → `141.78_81`), evita reservados.
- `rutaCatalogo({cdu, tipo_recurso, isbn, issn, id})` — construye `<cdu>/<libros|revistas>/<hoja>` y su versión web (`/recursos/...`).

### Utilidades

#### `src/utils/identificadores.js`
Validación con dígito de control: `validarISBN` (10/13), `validarISBN13`, `validarISBN10`, `validarISSN`, `normalizarIdentificador`, y `extraerISSN(texto)` (tolerante al espacio fino francés `ISSN : ...`). Sin dependencias.

#### `src/utils/parsear-nombre.js`
`parsearNombre(nombre)` — distingue **libro** (`Título - Autor1- Autor2` → autores) de **revista fechada** (`… Mes-Mes Año` → `año_edicion` + `idioma`, **no** autores). Sin dependencias.

#### `src/utils/agrupador.js`
`agrupar(rutas)` → unidades de proceso (cada epub/pdf por su lado; **todas las imágenes juntas = un libro**). `esImagen(ruta)`. Sin dependencias.

### Manejo de errores

#### `src/errores.js`
Clases `ErrorInfraestructura` (transitorio → Reintentos) y `ErrorIdentificacion` (manual → Cuarentena); helpers `esErrorDeRed(error)` (distingue red/timeout/5xx/429 de un 404 legítimo) y `esErrorDeMongo(error)`.

#### `src/gestor-fallos.js`
- `enviarACuarentena(rutas, estado)` — **mueve** los archivos a `Cuarentena/<etiqueta>/` con `estado.json` (revisión manual).
- `enviarAReintentos(rutas, estado)` — **copia** a `Reintentos/<etiqueta>/` con `estado.json` (reproceso).
- **Libs:** `fs/promises`.

### Archivos heredados (no usar en el flujo activo)
`src/controlador-ingesta.js` (antiguo handler REST, sustituido por `servicio-ingesta`), `src/procesador-epub.js` (lector epub2; el activo es `utils/lector-epub.js`), `src/utils/procesador-archivos.js` (solo lo usa el controlador antiguo) y `src/auditoria-apis.js` (diagnóstico puntual de modelos Gemini).

---

## Error Handling

El pipeline distingue dos tipos de fallo y los enruta a carpetas distintas, siempre conservando el trabajo hecho:

| Tipo | Clase | Cuándo | Acción | Carpeta |
|---|---|---|---|---|
| **Identificación** | `ErrorIdentificacion` | No se obtiene ni un título tras agotar archivo/APIs/IA; visión falla sobre un libro físico; formato no soportado. | **Mover** el recurso para revisión manual. | `Cuarentena/<etiqueta>/` + `estado.json` |
| **Infraestructura** | `ErrorInfraestructura` | No se alcanza un recurso externo: APIs (red/timeout/5xx/429) o **MongoDB Atlas**. | **Copiar** el recurso para reprocesar; se adjunta el documento parcial. | `Reintentos/<etiqueta>/` + `estado.json` |

**Principios:**
- **Degradación elegante de APIs bibliográficas:** un fallo de red de OpenLibrary o Google Books **no aborta** la ingesta; se registra una alerta y se continúa con lo disponible. Como MongoDB es Atlas (cloud), una caída real de conectividad se manifiesta como error de Mongo → Reintentos.
- **Visión/CDU IA** degradan a `null`/`'000'` sin romper el flujo.
- **Validación de esquema (código 121):** si el documento no cumple el `$jsonSchema`, se lanza un error claro (no se reintenta — es un problema de datos). Por eso los campos internos/nulos se eliminan antes de persistir.
- **Identificadores inválidos** (ISBN/ISSN con dígito de control erróneo, típico de OCR/visión) se descartan con alerta y el registro queda `pendiente`.
- **`estado_verificacion`:** `completado` solo si hay título + CDU + identificador válido (ISBN o ISSN); si no, `pendiente` para revisión humana. Todas las incidencias quedan en `alertas_agente`.
- **`estado.json`** en Cuarentena/Reintentos guarda los archivos, el documento parcial, la fase alcanzada y el error, para reanudar sin redundancias.
- **Concurrencia:** ejecutar **una sola instancia** del vigilante; dos procesos compiten por el Inbox (un borrado a mitad de copia provoca `ENOENT`).

---

## Test requirements

- **Sin framework de test** (no hay Jest/Mocha). Las pruebas son scripts ejecutables con Node en `Test Battery/`.
- **Requisitos previos:** `.env` válido con `MONGO_URI`, `GEMINI_API_KEY`, `GOOGLE_BOOKS_API_KEY`; conexión a Internet (APIs + Gemini + Atlas). Verifícalo con `node "Test Battery/test-credenciales.js"`.
- **Batería principal** (12 casos reales de la biblioteca, archivos incluidos en `Test Battery/`):
  - Todos: `node "Test Battery/run-battery.js"`
  - **Un caso o subconjunto** (equivale a "un único test"): `node "Test Battery/run-battery.js" 12` o `1,3,12`.
  - Casos: 1–3 EPUB (3 = lote de 10, serializado), 4–7 PDF (5 escaneado, 6 antiguo pre-ISBN, 7 lote), 8–11 imágenes (9/10 grupos = 1 libro; 11 revista escaneada), 12 PDF revista. Inserta/actualiza en MongoDB y deja un JSON por carpeta en `_resultado/`.
- **Pruebas aisladas** en `Test Battery/`: `test-conservador.js` (fusión conservadora EPUB), `test-vision-api.js` (visión + APIs), `test-api.js` (proveedor), `test-lector.js` (cadena EPUB), `test-vision.js` (visión).
- **Métodos de ingesta en vivo** (requieren `npm start` en marcha): `test-endpoint.js` (POST a la API) y `test-inbox.js` (deposita archivos en el Inbox para el vigilante).
- **Mantenimiento:** `node "Test Battery/regenerar-registros.js"` regenera `registro.json` + `registro.marc.xml` de todo el catálogo sin usar APIs ni IA.
- **Comprobación de sintaxis** (sin ejecutar): `node --check <archivo>`.
- **Aviso:** la batería **escribe en MongoDB y en disco** (CDU). No es idempotente en cuanto a contenido (la CDU vía IA es no determinista), pero sí en cuanto a deduplicación (re-ejecutar actualiza, no duplica).

---

## Database schemes — colecciones y reglas de validación

Base de datos `Biblioteca` (MongoDB Atlas). Todas las colecciones usan validación `$jsonSchema`.

### `biblioteca` — registro bibliográfico principal

**Requeridos:** `tipo_recurso`, `titulo`, `cdu`, `idioma`, `formatos`, `ubicacion`.

| Campo | Tipo | Reglas / notas |
|---|---|---|
| `tipo_recurso` | enum | `libro` \| `revista` |
| `titulo` | string | |
| `cdu` | string | CDU real (con `:`/`'`); el árbol de carpetas usa una versión saneada |
| `idioma` | string | código (p. ej. `es`, `fr`) |
| `formatos` | array<enum> | `papel`, `digital`, `epub`, `pdf`, `mobi`, `cbr`, `djvu`, `zip`, `rar` |
| `ubicacion` | object | requiere `ambito` (string) y `estanteria` (string) |
| `isbn` | string | validado (dígito de control); ausente si inválido |
| `issn` | string | validado |
| `autores` | array<objectId> | referencias a `autores` |
| `editorial` | objectId | referencia a `editoriales` |
| `año_edicion` | number | |
| `numero_edicion` | number | |
| `volumen` | string | |
| `volumen_numero` | number\|string | |
| `periodo` | string | |
| `obra_madre_id` | objectId | obra a la que pertenece (colecciones/series) |
| `sinopsis` | string | |
| `palabras_clave` | array<string> | |
| `estado_verificacion` | enum | `completado` \| `pendiente` (¿requiere revisión humana?) |
| `alertas_agente` | array<string> | trazas de incidencias de la automatización |
| `ruta_base` | string | ruta web del recurso (`/recursos/...`) |
| `nfc` | object | `{ uid, url_vinculada, fecha_vinculacion(date) }` |
| `fecha_ingreso` | date | |

> Campos extra que el servicio añade y el esquema admite (no están en `required` ni prohibidos): `imagenes` (`[{ruta, tipo, origen}]`), `portada` (string), `fecha_actualizacion` (date).

**Índices:** `_id`, `isbn`, `{issn, numero_edicion}`, `tipo_recurso`, `autores`, `cdu`, `idioma`, `obra_madre_id`, `{ubicacion.ambito, ubicacion.estanteria}`.

### `autores`
**Requeridos:** `nombre`.

| Campo | Tipo | Notas |
|---|---|---|
| `nombre` | string | nombre completo normalizado |
| `alias` | array<string> | variantes/pseudónimos |

**Índices:** `_id`, `nombre`.

### `editoriales`
**Requeridos:** `nombre`.

| Campo | Tipo | Notas |
|---|---|---|
| `nombre` | string | |
| `pais` | string | |

**Índices:** `_id`, `nombre`.

### `equivalencias_cdu` — caché de equivalencias aprendidas
**Requeridos:** `sistema_origen`, `codigo_origen`, `cdu`, `fuente`. `additionalProperties: true`.

| Campo | Tipo | Reglas / notas |
|---|---|---|
| `sistema_origen` | enum | `dewey` \| `lcc` \| `categoria` \| `bne` |
| `codigo_origen` | string | código/categoría normalizado (ej. Dewey `510`, LC `QA`) |
| `cdu` | string | CDU equivalente |
| `fuente` | enum | `Google Books` \| `OpenLibrary` \| `ISBNdb` \| `BNE` \| `IA` \| `Manual` |
| `verificado` | bool | `false` = asignada por IA; `true` = validada manualmente |
| `descripcion` | string\|null | |
| `usos` | int | nº de reutilizaciones (cache hits) |
| `fecha_creacion` | date | |

**Índice único:** `{sistema_origen, codigo_origen}` (clave lógica de la equivalencia).
