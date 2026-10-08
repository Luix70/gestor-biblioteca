# Tareas pendientes en el NAS y resumen de trabajos

> Lista viva: se actualiza con cada cambio que deje un script por ejecutar. Marca `[x]` lo que vayas haciendo.
> Última actualización: **2026-10-08**, comprobada contra la base (diarios `deshacer[]`, selecciones y recuentos).
> El detalle de lo ya hecho antes del 8-oct está en el historial de git de este fichero.

## Antes de cada paso

- **Copia de la base**: `sudo docker exec -t gestor-biblioteca node scripts/copia-base.js` → `/app/logs/copias-bd/<fecha>/`
  (conserva las 10 últimas). Restaurar: `scripts/restaurar-base.js --desde <fecha> --coleccion biblioteca [--ids …] [--ejecutar]`.
- **Copia del disco** (si el paso mueve carpetas): `sudo /volume1/docker/GestorBiblioteca/scripts/sincronizar-copia.sh --forzar`.
- **Desplegar** la última versión (`actualizar-GestorBiblioteca.sh`) si el script es nuevo.
- Todos los scripts van **en seco por defecto** (sin `--ejecutar`) y son **reanudables**.

---

## 1. Scripts por ejecutar

### 1.1 Libros sin editorial (5.535) — usa APIs, horas
- [ ] `sudo docker exec -it gestor-biblioteca node scripts/reclasificar-editoriales.js --sin-editorial`
- [ ] `sudo docker exec -it gestor-biblioteca node scripts/reclasificar-editoriales.js --sin-editorial --ejecutar`

Cascada gratuita (nombre de fichero → Fichero → colección → OpenLibrary → Google). `--ia` añade IA de texto (barata).

### 1.2 Carpetas-contenedor (opcional)
- [x] (8-oct: 9 contenedores separados; los «118 anidados» restantes eran miembros de árboles preservados —77 de TXtras, 1 de Oxford Bookworms—, anidados a propósito: ya no se cuentan) `sudo docker exec -it gestor-biblioteca node scripts/reparar-carpetas-anidadas.js --separar` (en seco) y `--separar --ejecutar`

Quedan 118 documentos viviendo dentro de la carpeta de otro y 12 «carpetas-contenedor». Ya no es peligroso (borrar,
reprocesar o fundir versiones respetan lo que hay dentro desde el 7-oct), pero separarlas deja 1 documento ↔ 1 carpeta.
**Mueve carpetas: copia del disco antes.**

### 1.2 bis Prefijo de subida en nombres, títulos e ISBN (8-oct) — en el NAS (renombra ficheros)
- [ ] Desplegar (la subida ya no antepone la hora; el lector de ISBN ya no toma cifras dentro de un número más largo).
- [ ] Copia; `sudo docker exec -it gestor-biblioteca node scripts/quitar-prefijo-subida.js` (en seco 8-oct: 319 documentos — ficheros
      con «1791441939492-…» delante, algunos títulos y 10 ISBN falsos sacados del prefijo, p. ej. «1791441939» compartido
      por 5 libros) y `--ejecutar`. Los que se quedan sin ISBN los recoge la campaña «Recuperar ISBN que faltan».

### 1.2 ter Descripciones de CDU inventadas (8-oct) — solo BD, IA de texto barata
- [ ] Desplegar (la IA describe cada código con la tabla de su clase/división, sus lugares, la descripción del padre y
      la Dewey/LCC de la que salió; no se guarda una que contradiga su división).
- [x] **HECHO 8-oct** (2.466 códigos; 1.076 descripciones nuevas, 771 de IA sustituidas). Importar el **UDC Summary** oficial (es + en, ~2.430 códigos): `sudo docker exec -it gestor-biblioteca node
      scripts/importar-udc-summary.js` (descarga ~40 min la primera vez, a la caché `logs/udcs/`; en seco no escribe) y
      luego `--ejecutar` (usa la caché). Sus códigos pasan a descripción oficial verificada (`fuente:'udcs'`; la de IA
      se copia a `cdu_descripciones_retiradas`) y la IA recibe sus antepasados oficiales como referencia obligatoria.
- [ ] `sudo docker exec -it gestor-biblioteca node scripts/regenerar-descripciones-cdu.js` (en seco 8-oct: ~300 incoherentes, p. ej.
      «94(430).085» = «Geología de la Antártida») y `--ejecutar --regenerar` (o sin `--regenerar`: las rehace Mantenimiento
      poco a poco). `--lugar` añade las que nombran otro lugar (más ruidosa: mirar la lista).
- [x] Resultado (8-oct): las 306 se retiraron por la mañana y Mantenimiento rehízo 281 (175 códigos con libros, 441 libros);
      la mayoría mejoraron («94(437)» Chequia ya no es «Geografía de Cataluña»), unas pocas empeoraron («93:327» →
      «Historiografía… España»). El detector era demasiado estricto con la clase 94 (retiraba «Genocidio», «Administración
      Johnson» por no decir «historia»); arreglado: vale cualquier palabra de acontecimiento, época o poder. Las de IA que
      queden mal se tratan en la §4, fase 4 (rehacer por tandas con las referencias oficiales del UDC Summary).
- [ ] Estudiar aparte: ~400 libros cuya CDU lleva un auxiliar de lugar que no casa con su materia («321.2(44)» = Francia
      para un libro sobre China); muchos son CDU de la BNE: no se tocan sin revisar. → ver **§4, estrategia de la CDU**.

### 1.3 Al final
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/integridad.js --reparar --informe /app/logs/integridad.txt`
      — además resuelve los **11 duplicados exactos** que dejó la verificación de hashes (el otro va a la Papelera, entero).
- [ ] Panel → **Búsqueda → Reindexar** (recoge todos los cambios de títulos, autores y editoriales de estos días).

---

## 2. Revisión a mano en el panel (selecciones)

En Búsqueda: filtrar por la selección; las acciones están en ⚙️ Acciones de la barra de selección.

| Selección | Docs | Qué hacer |
|---|---|---|
| **ISBN de otro libro de la serie (cotejo)** | 1.190 | Su ISBN es probablemente el de otro libro de la serie: 🔎 Extraer ISBN con «forzar», o corregirlo a mano |
| **Colección contradicha por la autoridad** | 370 | Decidir si la colección es la buena |
| **Editorial sin confirmar (sin ISBN, en lugar del maquetador)** | 300 | Ordenar por «Editorial» → por grupos de portadas → ✅ Confirmar editorial o ✏️ Asignar datos |
| **Editorial a revisar — su colección coincide con el prefijo** | 59 | Ídem (los más sospechosos: empezar por estos) |
| **Editorial a revisar (prefijo ISBN)** | 565 | Ídem |
| **Versiones por revisar** | 5.754 (2.705 grupos) | Ordenar por ISBN; si son el mismo libro, 🔗 Fusionar versiones (conserva todos los ficheros) |
| **ISBN compartido** | 1.122 (397 grupos) | Títulos distintos con el mismo ISBN: corregir el ISBN de los que no sean |
| **Autor artefacto sin sustituto** | 15 | Ponerles el autor a mano |
| «CDU de la BNE de otra lengua» / «ISBN de otra lengua» | 17 / 16 | Corregir a mano (de la pasada del 30-sep) |

Y sueltos:
- [ ] Editoriales que sigan separadas siendo la misma → página Editoriales → modo selección → 🔗 Combinar.
- [ ] «El Oro del Los Tigres» → «El oro de los tigres»; «ALMA CAPRICHOS EL MAL POETA» → «Alma. Caprichos. El mal poema».
- [ ] «Hervé This, Pierre Gagnaire»: son dos autores (el lector de menciones no puede distinguirlo de «Apellido, Nombre»).
- [ ] ~48 cabeceras de revista con nombre de fichero (muchas son libros o artículos tipados como revista).

---

## 4. CDU: revisar las equivocadas y sus descripciones — ESTRATEGIA (8-oct)

- [ ] **Revisar posibles CDU equivocadas y descripciones equivocadas** siguiendo esta estrategia.

**Por qué es delicado.** La CDU decide la **carpeta** de cada libro en el disco (`CDU/<cdu>/libros/…`) y el **árbol de
navegación** del panel y de la **copia sin conexión** (USB). Cambiar una CDU **mueve carpetas**: un error se multiplica
(una equivalencia mala mueve cientos de libros a la vez, como la de las clases LCC en septiembre). Por eso: **primero
diagnosticar sin tocar nada, corregir el ORIGEN antes que los libros, aplicar por tandas pequeñas, y verificar**.

**Lo que se sabe (8-oct).** 66.019 libros: 57.661 **sin `cdu_fuente`** (anteriores a que se anotara; origen desconocido),
4.172 del clasificador, 3.850 de la **BNE**, 319 manuales (+ 3.607 con `cdu_manual`), 3.411 en **000**. La caché
`equivalencias_cdu` tiene **10.193 equivalencias aprendidas de la IA sin verificar** (+ 5.347 verificadas): es la vía
por la que un error llega a muchos libros. Descripciones: 306 incoherentes con su división (§1.2 ter).

**Reglas de seguridad (para todas las fases).**
1. Antes de cada fase que escriba: **copia de la base** (`copia-base.js`) **y del disco** (`sincronizar-copia.sh --forzar`).
2. Todo en **seco por defecto**; el seco escribe un **informe** (`--informe`) que se revisa antes de `--ejecutar`.
3. **Nunca** se toca una CDU **manual** (rango 4) ni se baja de rango (`utils/prioridad-cdu.js`: manual > impresa >
   BNE > deducida). Una CDU de la BNE solo la cambia una evidencia de rango igual o mayor, o una persona.
4. Las carpetas se mueven **solo** con `reubicarPorCdu` (copia verificada, diario de movimientos, lleva consigo a los
   anidados) y en **tandas** (`--limite 200`), comprobando entre tanda y tanda.
5. Cada cambio deja **`deshacer[]`** (CDU y carpeta de antes) y la selección del lote, para poder revertirlo.
6. Al terminar cada fase: `integridad.js` (diagnóstico), `recolocar-por-cdu.js` en seco (debe dar 0), campaña de
   sidecars al día, **Reindexar**, y **sincronizar la copia USB** (navegación sin conexión al día).

**Fase 1 — Diagnóstico (no escribe nada).** Un script `auditar-cdu.js` que puntúa cada libro con las pruebas que hay
y lo clasifica por **confianza** (alta / media / baja) en un informe y en selecciones (sin mover nada):
   - **contra su propia evidencia**: la Dewey/LCC del libro (tabla determinista), la CDU de la BNE por su ISBN, la
     CDU impresa (CIP), sus materias/palabras clave y su título → ¿coinciden en la **clase** y la **división**?
   - **lugar**: el auxiliar de lugar del código frente a los lugares del título y las materias (`lugarContradice`);
   - **hermanos**: la CDU frente a la mayoritaria de su colección, serie u obra (un tomo de historia entre 20 de
     física es sospechoso);
   - **literatura**: `821.x` (la lengua) frente a la lengua original / nacionalidad del autor;
   - **procedencia**: si la CDU es exactamente la de una equivalencia aprendida **sin verificar** (marca el origen);
   - **descripción incoherente** del código (`descripcionContradice`), como señal más.

**Fase 2 — Corregir el ORIGEN: la caché de equivalencias.** Antes que los libros. `auditar-equivalencias-cdu.js`
ordenado por **nº de libros que dependen** de cada equivalencia IA sin verificar; revisar las de más uso (a mano o con
la tabla determinista), corregirlas y marcarlas `verificado`. Arreglar una equivalencia arregla todos sus libros en
la fase 3 de una vez y con criterio.

**Fase 3 — Aplicar por niveles de confianza** (siempre con las reglas de seguridad):
   - **A, automático**: hay una evidencia de **mayor rango** que contradice una CDU deducida (BNE o CIP impresa frente a
     IA/caché/crosswalk) → `aplicarCduConPrioridad` (ya existe: Conformador `aplicar-cdu-bne`), por tandas.
   - **B, propuesto**: la Dewey/LCC del propio libro o la equivalencia corregida dan otra CDU de mismo rango → se
     **propone** (selección «CDU propuesta») y se aprueba por grupos en el panel antes de aplicar.
   - **C, a mano**: lugar que no casa, BNE que contradice su materia, hermanos discordantes sin otra prueba →
     selección para revisar; **nunca** automático.
   - Los **000** (3.411) van aparte: no hay CDU que perder; se clasifican con la cascada normal (sin IA primero).

**Fase 4 — Descripciones** (no mueven nada; se pueden hacer ya).
   - **Causa encontrada (8-oct)**: al clasificar un LIBRO con IA, su respuesta (la materia de ese libro) se guardaba
     como descripción del CÓDIGO, y nunca se revisaba: «12 Epistemología y lógica: Willard Van Orman Quine», «908
     Portugal», «572.4 Botánica – Fisiología vegetal» (572 es Antropología física; sus dos libros, de la BNE, están
     bien). **Cortado**: ya no se siembra; la descripción se genera desde el código, con referencias. Por eso las
     ~15.000 descripciones `fuente:'ia'` sin verificar son todas sospechosas, no solo las 306 incoherentes.
   - **Autoridad** (HECHO en código 8-oct, falta ejecutarlo: §1.2 ter): `scripts/importar-udc-summary.js` importa el
     **UDC Summary** oficial (~2.430 códigos; licencia CC BY-SA 3.0, citado en el ⓘ del panel). udcdata.info está
     fuera de línea mientras el Consorcio lo revisa para la MRF12; se usan dos réplicas: español de
     vocabularyserver.com/udc/es (TemaTres, 2019) e inglés + jerarquía de vocabs.rossio.fcsh.unl.pt (Skosmos). Tabla
     completa en `udc_summary`; descripciones `fuente:'udcs'` verificadas; la IA solo para los códigos que no estén,
     con las piezas oficiales (número, antepasados, lugar, lengua) como referencia obligatoria. Cuando el Consorcio
     publique el servicio nuevo (MRF12), repetir la importación desde allí.
   - Pendiente: usar `udc_summary` en el diagnóstico de la Fase 1 (una CDU cuyo número principal no esté en el
     resumen ni sea subdivisión de uno suyo es sospechosa).
   - Mientras tanto: `regenerar-descripciones-cdu.js --ejecutar --regenerar` (las 306 incoherentes); después, rehacer
     por tandas las `ia` sin verificar empezando por los códigos con más libros.

**Fase 5 — Verificación final.** Integridad, recolocar-por-cdu en seco = 0, sidecars, Reindexar, copia USB; y una
muestra a mano del árbol de navegación (que las ramas grandes —94, 821, 5x— contienen lo que dicen).

**Que no vuelva a pasar (ingesta).** Al clasificar, contrastar la CDU propuesta con la evidencia del propio libro
(clase de su Dewey/LCC, lugar del título) antes de aceptarla; una equivalencia IA solo pasa a la caché si casa con esa
evidencia; y la descripción del código se genera con referencias (hecho el 8-oct).

---

## 3. Más adelante

- [ ] **Library Genesis** (volcado de su base de datos) → `U:\_DUMPEDCATALOGS\` y su ETL como el de Crossref: el **MD5
      de cada fichero** + ISBN, serie, editorial, idioma → identificar ripeos sin ISBN y sin IA; enlaces a copias para
      Cuarentena y los huecos de colecciones/obras.
- [ ] British National Bibliography (CC0), DNB alemana, Library of Congress (LCC/Dewey → CDU sin IA), Wikidata
      (nacionalidad de autores → CDU de literatura).
- [ ] **ISBN de los DjVu desde su capa de texto** (`djvutxt`): ~96 DjVu sin ISBN.
- [ ] **Imagen Docker en Debian 11**: cuando haya que rehacer la capa de apt, apuntar apt a `archive.debian.org`.
      NO migrar a Debian 12: DSM 6.2.4 → Docker 20.10.3 bloquea `clone3` y Node no arrancaría.

---

## Lo que ya hace el sistema solo (no hay que lanzar nada)

- **Campañas de fondo** (Mantenimiento → Campañas): Sidecars, Recuperar ISBN que faltan, Resolver ediciones pendientes,
  **Cotejar título por ISBN (v2)**, y las tareas del Conformador (aplicar-cdu-bne, re-clasificar-cdu, ubicar-segun-cdu).
- **Integridad** repara sola las imágenes que apuntan fuera de su carpeta y las portadas que no existen.
- **La ingesta** aplica a cada libro nuevo todo lo aprendido: identificación por ISBN y edición, editorial real (una
  sola puerta que reconoce grafías y sellos), autores depurados y menciones explotadas con su rol, títulos limpios
  (sin mención pegada, sin mayúsculas, sin el nombre del fichero; formato Z-Library), idioma por el texto, revistas
  por el nombre, CDU por prioridad y carpeta según la ficha.

---

## Hecho (registro)

### 30-sep → 8-oct
- **Reidentificación y reparaciones** (30-sep/1-oct): 2.587 ISBN recuperados; `reparar-tras-reidentificacion` (fases
  1-15), CDU modernizadas (3.168), carpetas anidadas reparadas, Crossref sin conexión (`crossref.db`) e índice de series.
- **Colecciones** (2-oct): `reorganizar-colecciones` — 20.726 cambios; 673 colecciones retiradas; carpetas → selecciones.
- **Revistas y libros** (5-oct): libros-como-revista (50), revistas-como-libro (124), títulos de los números unificados
  (1.724), cabeceras colapsadas en el catálogo.
- **Editoriales** (5/6-oct): grafías fundidas (1.706 + 524 en la 2.ª pasada, sellos por prefijo ISBN; Montena 569),
  números de revista alineados con su cabecera (595), referencias colgantes reparadas (830), prefijo ISBN (96), triaje (97).
- **Imágenes** (5-oct): 693 documentos (690 de Don Miki) con el carrusel apuntando a la carpeta vieja, reparados.
- **Hashes y versiones** (6/7-oct): 457 hashes nuevos; versiones: 0 fusiones seguras, 3.082 selecciones → 2.
- **Títulos** (7-oct): cotejo que puso títulos de otro libro deshecho (1.122); falsos «títulos originales» (`--revisar-
  existentes`); mención pegada y mayúsculas (1.335); títulos que eran el nombre del fichero (412).
- **Autores** (7-oct): menciones explotadas en personas con su rol (1.391 libros, 1.307 registros), grafías fundidas y
  artefactos fuera (`depurar-autores`, 761 retirados), «Eliminar» con autoría desde el panel (265). Quedan 0 «[?]_».
- **Otros**: separar-autores-fusionados y marcar-autores-basura (0 pendientes), recuperar-titulo-original (7 h, una vez),
  portadas sospechosas revisadas.

### 15 → 29 de septiembre
- **Revistas**: inspección con IA de árboles, sin catálogos de libros, fecha y número por carpeta, portada leída al
  inspeccionar; saneado de los números contaminados.
- **ISBN del fichero** (EPUB/PDF/MOBI: OPF, créditos, CIP, CDU impresa) e **identificación de la edición sin ISBN**
  (Fichero, BNE en línea, OpenLibrary; traductor, colección, indicios; definitiva/provisional/dudosa).
- **CDU por prioridad** (manual > impresa > BNE > deducida) y la carpeta siempre según la ficha; carpetas compartidas
  separadas.
- **Portadas artefacto** detectadas y saltadas en la ingesta; acción «🚩 Portada sospechosa…».
- Campañas nuevas, panel de Campañas sin 504, Dashboard con ediciones por elegir / ISBN provisional / dudoso.
