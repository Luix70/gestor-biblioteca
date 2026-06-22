# Contexto del proyecto — gestor-biblioteca

> Conocimiento **durable** del proyecto: el *porqué* de las decisiones y las restricciones no
> obvias. Viaja con el repositorio (git), así que cualquier máquina o asistente lo tiene.
> `CLAUDE.md` explica *cómo trabajar* en el repo; este documento es la *memoria acumulada*.
> Idioma de código/comentarios/identificadores: **español** (mantener esa convención).

---

## 1. Qué es y objetivo rector

Agente de catalogación de biblioteca. Ingiere ficheros de libros/revistas (EPUB, PDF, sets de
imágenes escaneadas; pre- y post-ISBN), extrae y enriquece metadatos, los clasifica por **CDU**
y persiste documentos validados por `$jsonSchema` en **MongoDB Atlas**. Corre en Docker sobre un
NAS Synology con una carpeta `Inbox` vigilada.

**Principio de coste:** extraer el máximo de datos gastando los MÍNIMOS recursos de IA, por una
escalera de escalado: fichero → APIs gratuitas (OpenLibrary, Google Books) → IA (Gemini) solo
para huecos. **El ISBN es el pivote**: conseguirlo barato y una llamada API gratis resuelve el resto.

---

## 2. Arquitectura del pipeline (resumen; canónico en `CLAUDE.md`)

Todo pasa por un único servicio compartido para que los dos puntos de entrada se comporten igual:

- **Puntos de entrada:** `src/app.js` (API REST `POST /api/ingestar` + sirve `/recursos` estático
  + lanza el vigilante) y `src/vigilante.js` (watcher del Inbox). `npm start` arranca ambos;
  `DESACTIVAR_VIGILANTE=1` deja solo la API. **Una sola instancia a la vez** (dos watchers compiten
  por el Inbox → ENOENT a mitad de copia).
- **Pipeline compartido** (`src/servicio-ingesta.js` · `ingestarRecurso`):
  `orquestador.js` (extrae por tipo) → `motor-enriquecimiento.js` (enriquece, conservador) →
  `motor-catalogo.js` (resuelve refs + dedup + upsert) → copia a árbol CDU + escribe
  `registro.json`/`registro.marc.xml`.
- **Tipos** (`orquestador.js`): EPUB → `utils/lector-epub.js`; PDF → `utils/lector-pdf.js`;
  grupo de imágenes → `agente.js` (visión Gemini); formatos conocidos sin lector (mobi/cbr/djvu/
  zip/rar) → catalogados por nombre.
- **Fallos** (`errores.js` + `gestor-fallos.js`): `ErrorIdentificacion` → **Cuarentena** (revisión
  manual); `ErrorInfraestructura` → **Reintentos**. Las APIs degradan con alerta; como Mongo es
  Atlas, una caída real de red sale como error Mongo → Reintentos.

---

## 3. Principios rectores (no negociables)

- **Fusión conservadora** (`motor-enriquecimiento.js` es la única autoridad): el dato del
  **fichero es la verdad** y NUNCA se sobrescribe con Internet/IA; lo externo solo rellena huecos
  (`primerValido()` trata null/''/[] como ausencia). Excepción 1: editoriales falsas
  (`EDITORIALES_NO_VALIDAS`: ePubLibre, Lectulandia…) sí las sustituye una editorial real de las
  APIs. Excepción 2: para el **ISBN**, las APIs ganan a la visión (la visión es lo menos fiable).
- **El ISBN es el pivote.** Los buscadores aceptan **varios candidatos** (variantes 10/13, del
  texto y del nombre de archivo) y prueban cada uno: un libro suele estar indexado por una sola de
  sus formas (evita 404). `utils/identificadores.js` valida dígitos de control y convierte 10↔13.
- **Modelo de imágenes:** un libro tiene VARIAS imágenes; `imagenes: [{ruta, tipo, origen}]` +
  un `portada` (string) que el front-end muestra sin recorrer el array. Cubierta del fichero/escaneo
  gana; las remotas (`portadas_remotas`) son candidatas de respaldo.
- **CDU con caché de equivalencias** (`clasificador-cdu.js` + colección `equivalencias_cdu`):
  caché aprendida (Dewey/LCC→CDU) → API externa → IA; al derivar por IA, **aprende** la equivalencia
  para que el siguiente libro con ese código sea un acierto de caché gratis.
- **Esquema permisivo:** el `$jsonSchema` de `biblioteca` **no** fija `additionalProperties:false`
  (requeridos: tipo_recurso, titulo, cdu, idioma, formatos, ubicacion). Por eso campos extra como
  `ruta_base`, `imagenes`, `portada`, `nombre_archivo`, `mantenimiento` son válidos. Nunca persistir
  campos null/''/[] (rompen el schema → error 121).

---

## 4. Restricciones del NAS (CRÍTICO — no obvias y fáciles de re-pisar)

Host de despliegue: Synology **DS1511+**, CPU Intel **Atom D525**, DSM/kernel antiguos.

1. **CPU sin SSE4.2/AVX (hasta SSSE3)** → libs SIMD nativas lanzan *illegal instruction*. Por eso
   se eliminó **sharp** (único `.node` del árbol). **Excepción permitida:** el Dockerfile instala
   **`poppler-utils`** (`pdftoppm`/`pdfinfo`): es un binario de SISTEMA con detección de CPU en
   runtime (pixman cae a SSE2/SSSE3), así que SÍ corre en el Atom. No lo quites pensando que
   rompe la regla. Las dimensiones de imagen se leen con un parser JS puro (`utils/medir-imagen.js`).
2. **Kernel sin `getrandom()`** → contenedores **Alpine/musl** mueren ("unable to get random
   bytes"). Usar Debian/glibc: base **`node:18-bullseye-slim`**. Clonar en el NAS por **tarball**
   (wget+tar), sin git ni Alpine.
3. **Node 18** (Node 20+ no corre en este CPU) no tiene `File` global. `cheerio ^1.2` arrastra
   `undici@7` que lo referencia → boot loop. **Fijar `cheerio` a `1.0.0`** (→ undici 6).
4. **Synology Docker = Compose v1** → usar **`docker-compose`** (con guion).
5. **Los eventos de chokidar NO se disparan sobre el bind mount del NAS** (sobre todo al soltar por
   SMB). El fichero está dentro del contenedor (la app corre como **root**, lee aunque los modos
   sean 000) pero el `add` nunca llega. Por eso `vigilante.js` hace un **escaneo periódico**
   (`setInterval → procesarCola`, propio `fs.readdir`), independiente de los eventos.
6. **Saltos de línea LF** en todo el repo (`.gitattributes` `* text=auto eol=lf`): un `.sh` con
   CRLF rompe el intérprete (`set: pipefail: invalid option name`).

**Gotcha de despliegue:** compose hace bind-mount del código (`/volume1/docker/GestorBiblioteca:/app`)
→ el código que corre es esa carpeta, NO la imagen; `node_modules` vive en un **volumen anónimo**
que persiste entre rebuilds. Tras cambiar dependencias hay que **`docker-compose down -v`** antes de
`up -d --build`, o el volumen viejo ensombrece los módulos nuevos.

**Despliegue:** script `actualizar-GestorBiblioteca.sh` (en `/volume1/docker/`, ejecutar con **sudo**):
pull del tarball de `main` → `down -v` → `rsync -a --delete` con exclusiones ancladas (`.env`,
`node_modules`, dirs de datos) → `up -d --build` → `logs -f`. Datos en
`/volume3/BIBLIOTECA DIGITAL/{Inbox,CDU,Cuarentena,Reintentos}`. `.env` (MONGO_URI, MONGO_DB_NAME,
GEMINI_API_KEY, GOOGLE_BOOKS_API_KEY) junto al `docker-compose.yml`, `chmod 600`, nunca en git/imagen.
**Rollback:** la etiqueta git **`nas-estable`** marca el último commit bueno desplegado;
revertir = `git reset --hard nas-estable` + push -f + re-desplegar.

---

## 5. Subsistemas añadidos (historia y porqué)

- **Portadas de calidad** (`utils/medir-imagen.js`, `resolver-portada.js`, `rasterizar-pdf.js`):
  el bug de cubierta EPUB era `$('#'+id)` con id `cover.jpg` (el punto = clase CSS, nunca casa) →
  ahora selector de atributo `item[id="..."]` y se elige la imagen más grande. `resolverPortada`
  ordena candidatas (embebida → remotas → rasterizado PDF con poppler) y descarta degeneradas
  (el GIF 1×1 que OpenLibrary sirve como marcador; la URL usa `?default=false` para que dé 404).
  ISBN de Dublin Core robusto: variantes de scheme/`urn:isbn:` **con validación de dígito de
  control** (descarta los UUID, cuyo hex contiene tiradas que parecen ISBN-10).
- **OCR de PDF escaneado** (`utils/ocr-pdf.js`): si `texto_legible` es false, el nombre de archivo
  suele ser basura (`(ebook - pdf) Título` → título `"(ebook"`) y arrastra a un libro equivocado.
  Se rasterizan las **5 primeras páginas + la última** a 1600px y la **visión** (Gemini) lee
  título/autores/ISBN de la portadilla/créditos/código de barras. El esquema de visión ahora
  extrae `autores` (faltaba). Las páginas se conservan como **sidecars** referenciados en `imagenes[]`.
- **Copia transaccional + nombre real** (`servicio-ingesta.js`, `vigilante.js`): ficheros acababan
  en CDU con **0 bytes** y aun así se borraban del Inbox → pérdida de datos. Dos defensas:
  (a) `unidadEstable` exige tamaño estable y >0 antes de procesar (carrera de escritura SMB);
  (b) `copiarArchivos` verifica que el destino tenga el mismo tamaño que el origen y el vigilante
  **solo borra del Inbox si `copiaIntegra`**. Se guarda `nombre_archivo` (y `archivos_originales`)
  con el nombre real del fichero (el título normalizado no basta para recuperarlo/descargarlo).
- **Conformador — mantenimiento durmiente** (`src/mantenimiento/`): tras `MANTENIMIENTO_REPOSO_MS`
  (5 min) de Inbox inactivo, repasa la BD y "conforma" los documentos a un **registro de tareas
  extensible** (`tareas.js`: `{id, version, aplica, ejecutar}`). Cede SIEMPRE a la ingesta (lock
  `procesando` + `debeAbortar`), procesa por lotes, y sella cada doc con `mantenimiento_firma`
  (subir `version` de una tarea fuerza re-pasarla por todo el catálogo). **Salta sin sellar** los
  docs cuya carpeta no está en esta máquina → un arranque local no "conforma" en falso los del NAS.
  Tareas iniciales: `completar-nombre-archivo`, `revisar-portada` (re-resuelve si falta/baja calidad;
  NO toca libros 'papel'/escaneados), `generar-sidecars-pdf`. Futuras (slot listo): revisar CDU,
  duplicados, colecciones, completar datos.

---

## 6. Flujo de trabajo y otras notas

- **Ciclo:** rama → cambio → test → merge a `main` → push → `actualizar-GestorBiblioteca.sh` en el NAS.
- **Batería de pruebas** (`Test Battery/`, **gitignored**): `node "Test Battery/run-battery.js" [ids]`.
  Casos reales; escribe en Atlas y un JSON por caso. No la borres pensando que es basura.
- **Mayoría de la biblioteca = ediciones ePubLibre**: sin ISBN en Dublin Core (solo UUID + id EPL),
  por eso para esos libros se tira de título/autor; el "tesoro" de DC ahí es título/autor/sinopsis/
  materias, que sí se usan.
- **Reproceso idempotente:** dedup por isbn → issn → título; corregir un libro mal identificado y
  reprocesar crea un registro NUEVO (otra clave) y deja el viejo → hay que borrar el viejo a mano.
- **Secretos:** el `.env` es la única fuente; las env vars son visibles en el panel Docker de DSM
  (inherente a Docker) — la defensa es restringir acceso al NAS + usuario Atlas con IP allowlist.

---

## Plano del próximo ciclo — STREAMLINE de la discriminación (2026-06)

> *Por qué:* el desarrollo caso-a-caso dejó la decisión "¿qué es esto?" desperdigada
> (`detectarTipo` por extensión, `pareceRevista`, `esFechada`, rama de PDF escaneado, `parsearNombre`,
> el enriquecedor). La mayor inversión es un **discriminador** limpio. El mismo rastro estructurado
> que produce sirve de feedback en tiempo real para el futuro front-end → ordenar AHORA y construir
> el front-end LUEGO son el mismo trabajo.

### Fases explícitas (contrato entre etapas)
```
unidad (carpeta Inbox / subida API)
  → NORMALIZE     quita ruido: desanida (A/A/x), separa carga útil / sidecars / portadas,
                  IGNORA nombres-basura de carpeta (timestamps, hashes, "New folder", scanner)
  → DISCRIMINATE  ¿qué TIPO es?  (libro / revista / colección / audiolibro / obra multivolumen)
  → IDENTIFY      consigue el identificador (ISBN / ISSN / ISBN-de-obra)
  → CLASSIFY      CDU (ya sólido)
  → ENRICH+FILE   rellena huecos, persiste, copia al árbol
```
Cada fase emite una **ficha de identificación** estructurada (`{ tipo, confianza, señal_decisiva,
identificador, fuente }`), que se PERSISTE en el documento (catálogo auto-documentado + permite que
el Conformador revisite los de baja confianza) y se EMITE como evento (feed para el front-end).

### Escalera de proveedores (más barato/fiable primero; parar al estar seguro)
- **DISCRIMINATE:** estructural (audio→audiolibro; varios docs→colección; imágenes→escaneado;
  2 ISBN + "Tomo N"→obra) → metadatos de fichero (OPF, info-dict, ffprobe) → señales de contenido
  (ISSN/fecha→revista) → **agente IA que lee portada/créditos/índice/prefacio** (último recurso).
- **IDENTIFY:** metadatos embebidos → **nombre de fichero** (convenciones: ePubLibre, LibGen
  `Autor-Título-Editorial (Año)`, fecha, ISBN-suelto) → **BD local BNE/OL** (volcado en NAS;
  rápida/offline) → APIs externas (OL/GB/BNE/DNB) → OCR (visión) → agente IA.
La escalera debe ser una **lista ordenada de "proveedores"** (cada uno con coste/fiabilidad/
aplicabilidad), no secuencias hardcodeadas. Añadir la BD local o reordenar = config, no cirugía.

### Obra multivolumen (concepto NUEVO, distinto de colección)
- **colección** = serie editorial de obras independientes (abierta, sin "ISBN de la serie",
  la completitud no aplica). Ya existe (`colecciones` + `coleccion`/`coleccion_numero`).
- **obra multivolumen** = UNA obra en N tomos, con **ISBN de obra** propio, extensión fija y
  **completitud relevante**. NUEVA colección `obras { titulo, isbn_obra (único), editorial,
  total_volumenes, coleccion? }`. Cada tomo es un doc `biblioteca` normal (`tipo_recurso:"libro"`)
  con `obra` (ObjectId) + `volumen_numero` + `volumen_titulo` + `isbn_obra` denormalizado.
- Composición: `coleccion ⊃ obra ⊃ volumen` (resuelve "una colección de enciclopedias").
- Ejemplo real (Sartre, Aguilar, créditos): serie "biblioteca de autores modernos";
  obra "Obras Completas" `ISBN 84-03-04989-7 (obra completa)`; tomo "I — Teatro"
  `ISBN 84-03-04071-7 (tomo I)`. → hay que extraer DOS ISBN **con su rol**.
- Extracción con rol: `ISBN … (obra completa|o.c.|complete|set)` → obra; `ISBN …
  (tomo|vol|volumen|t.) <I/II/3…>` → tomo + número (romano→árabe). Multiidioma ES/EN/FR.
- Almacenamiento: tratar la obra como una cabecera de revista →
  `<cdu_obra>/obras/<isbn_obra|titulo>/<volumen-N>/` (los tomos juntos, bajo la CDU de la OBRA).
- **Completitud:** huecos internos (presentes 1,2,4 → falta 3) detectables SIN saber el total;
  "falta el final" necesita `total_volumenes` (de la BD/API por el ISBN de obra, o los créditos).
  → informe `obras-incompletas` (misma forma que los huecos de números de revista).

### Audiolibros (discriminar por CONTENIDO, no por la carpeta)
Una carpeta cuyo contenido es AUDIO = un audiolibro (todas las pistas = capítulos de una obra),
igual que imágenes-en-carpeta = un libro escaneado. Extensiones amplias
(.m4b/.mp3/.m4a/.aac/.ogg/.opus/.flac/.wav/.aax/.wma…). Metadatos vía **ffprobe** (añadir ffmpeg
al Dockerfile). Suele no tener ISBN (ASIN como mucho) → va por la vía sin-ISBN ya existente.
Schema: añadir `audiolibro` al enum `tipo_recurso` y formatos de audio al enum `formatos` (estos
DOS sí están constreñidos); nuevo segmento de árbol `audiolibros/`.

### Secuencia recomendada
1. **Refactor a fases + escalera de proveedores** del orquestador (núcleo: hacerlo con la batería
   de 12 casos como red, añadiendo antes casos de "anidado-con-ruido" y "dos-ISBN").
2. **BD local BNE/OL** como primer gran proveedor de IDENTIFY.
3. **Obras multivolumen** y **audiolibros** como discriminadores/proveedores sobre la espina limpia.
4. **Front-end** consumiendo la ficha/eventos que las fases ya emiten; la ingesta por API tiene
   PRECEDENCIA → unificar Inbox + API en UNA cola priorizada (el Conformador ya cede al vigilante;
   mismo patrón un nivel arriba).

### Ruido en el Inbox (caso real)
`_SIN CLASIFICAR/25012015-1743/25012015-1743/{cover.jpg, "Prabhakar Gondhalekar-The Grip of
Gravity-Cambridge University Press (200…).pdf"}` → NORMALIZE desanida el `X/X`, ignora el nombre
timestamp, separa `cover.jpg` (candidata a portada) del PDF (1 doc → libro suelto). El nombre del
PDF es convención **LibGen** (`Autor-Título-Editorial (Año)`) → identifica casi solo (título+autor
→ ISBN por BD local/API). Parser de nombre multi-convención = de los wins más baratos.
