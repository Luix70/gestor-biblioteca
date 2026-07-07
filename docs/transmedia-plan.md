# Plan — Documentos TRANSMEDIA + AUDIOLIBROS (rama `feature/transmedia`)

## Qué es
Un **transmedia** es una **estructura de carpetas/ficheros** (p. ej. *Oxford Bookworms Library*: 863 PDF,
2.083 MP3, 142 `cover.jpg`, un `.txt`) que se cataloga como **UNA colección** cuya estructura de disco se
**conserva VERBATIM**, colgando de **una sola rama CDU**. Es un **modo de ingesta paralelo** al normal (que
re-organiza cada fichero en `<cdu>/libros/<isbn>/`): aquí NO se reorganiza nada.

Un **audiolibro** es el caso particular de transmedia de **una sola unidad** centrada en audio:
- audio-solo (sin PDF) → `naturaleza:'audiolibro'`, ficha = portada + **playlist**;
- audio + texto → `naturaleza:'audiolibro'`, ficha = **visor PDF (como ahora) + playlist**.

## Principio rector (CRÍTICO)
**Añadir siempre; borrar NUNCA; verificar la copia íntegra ANTES de borrar nada.** La estructura del disco
queda intacta. El deduplicador por hash existente (`atajoPorHash` en ingesta, dedup-por-hash de
`integridad.js`) **NO debe eliminar** ningún fichero de un transmedia.

## Modelo de datos
- **Colección** `tipo:'transmedia'` (colecciones.js): nombre, **CDU deducida y EDITABLE** (ya hay modo
  edición de colección: presentación/ISSN/editorial/CDU/fechas), `descripcion` (del `.txt` o a mano),
  `raiz_web` (la carpeta raíz preservada). Todos los miembros comparten esa CDU.
- **Miembros = cada PDF** es un documento independiente (`doc.coleccion` → la colección), PLANO, con:
  - **`ruta_fija: true`** → Integridad/Conformador **no re-alojan ni podan** su carpeta (respetan el árbol).
  - `ruta_base`/`nombre_archivo` apuntan a su carpeta REAL dentro del árbol preservado.
  - **`nivel`** (Stage 0–6, del nombre de la carpeta de nivel), **`unidad`** (título del libro, p. ej.
    «Red Roses», de la carpeta de la unidad), **`rol_material`**: `lectura` · `test` · `ejercicios` ·
    `solucionario` · `glosario` · `guia` (deducido de carpeta/nombre: Activities/Tests→test, Exercise
    Answers→solucionario, Activity Worksheets→ejercicios, Glossary→glosario, el PDF con el título→lectura).
  - `portada` = el `cover.jpg` de su unidad; se **siguen extrayendo páginas** del PDF como sidecars del
    carrusel y para identificar (eso es AÑADIR, nunca borra el original).
  - `audios: [{ ruta, titulo, orden }]` en el doc `lectura`/audiolibro de la unidad (los mp3 de su `Audio/`).
- **Identificación SIN IA** (863 docs: imposible/caro con IA): puramente ESTRUCTURAL — autor+título del
  nombre de la carpeta de unidad («S0 Christine Lindop - Red Roses»), nivel de la carpeta Stage, rol del
  nombre/subcarpeta. ISBN opcional (si el CIP/texto lo trae), NO necesario. Cumple [[minimize-ai-ingestion]].

## Hash-dedup dentro del transmedia
Dos PDF de la MISMA unidad con **el mismo hash** (`Red Roses [1].pdf` == `[2].pdf`) → **UN solo documento**
(da igual a cuál apunte la ficha), pero **AMBOS ficheros permanecen en disco**. Hashes DISTINTOS (versiones
diferentes) → dos documentos. El dedup global por hash **excluye** los `ruta_fija` (nunca borra sus ficheros).

## Ingesta (preservar árbol)
1. **Detección** (vigilante): carpeta con subcarpetas anidadas que MEZCLAN PDF + audio → modo transmedia
   (override manual: marcador `.transmedia` en la raíz, o elección al soltar).
2. **Copia VERBATIM** del árbol a `<cdu>/transmedia/<nombre-colección>/…` (incluye `.txt`, `cover.jpg`, `Audio/`,
   `Activities/`…). Copia→VERIFICA (tamaño/hash) → solo entonces se recicla el origen del Inbox a la Papelera
   (nunca se borra sin verificar). CDU: deducida (editable después).
3. **Walk** del árbol copiado: por cada PDF, crear el doc miembro (nivel/unidad/rol_material, portada del
   cover, audios de la unidad), con `ruta_fija:true`. Dedup por hash (un doc, sin borrar ficheros).

## Integridad / Conformador
`ruta_fija:true` (o pertenecer a una colección `tipo:'transmedia'`) → **excluidos** de: reubicar por CDU,
podar carpetas, 1-doc-↔-1-carpeta, dedup-por-hash-que-borra. Se verifican (existencia) pero no se mueven/borran.

## Ficha / panel
- **Reproductor de audio**: `<audio controls>` + **playlist** (orden natural de los mp3) en la ficha de un
  doc con `audios[]`. Un audiolibro con PDF muestra **visor PDF + playlist**.
- **Filtros**: por `nivel`, `unidad`, `rol_material` dentro de la colección; y el tipo/naturaleza audiolibro.
- La colección se navega como las demás (ficha de colección con sus miembros).

## Fases
1. **Núcleo**: `naturaleza:'audiolibro'` + colección `tipo:'transmedia'` + `ruta_fija` + exclusión en
   Integridad/dedup; ingesta que PRESERVA el árbol (copia-verifica-verbatim) y crea miembros planos por PDF
   (identificación estructural, sin IA); enlace de audios.
2. **Reproductor** de audio + playlist en la ficha (+ audiolibro con/sin PDF).
3. **Panel**: filtros por nivel/unidad/rol; presentación de la colección (del `.txt`).

## Decisiones acordadas con el usuario (2026-07-07)
- CDU: **deducida pero editable**. · Estructura: **plana** (miembros etiquetados). · `[1]`/`[2]` iguales por
  hash → **un doc, sin borrar ficheros**. · `.txt`+covers se copian **tal cual**; se siguen extrayendo páginas
  (añadir sí, borrar no); **verificar copia íntegra antes de borrar nada**. · Audiolibro puede llevar PDF →
  ficha con visor PDF + playlist.
