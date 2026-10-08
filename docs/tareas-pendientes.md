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
- [ ] `sudo docker exec -it gestor-biblioteca node scripts/reparar-carpetas-anidadas.js --separar` (en seco) y `--separar --ejecutar`

Quedan 118 documentos viviendo dentro de la carpeta de otro y 12 «carpetas-contenedor». Ya no es peligroso (borrar,
reprocesar o fundir versiones respetan lo que hay dentro desde el 7-oct), pero separarlas deja 1 documento ↔ 1 carpeta.
**Mueve carpetas: copia del disco antes.**

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
