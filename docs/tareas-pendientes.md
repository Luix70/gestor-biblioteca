# Tareas pendientes en el NAS y resumen de trabajos

> Lista viva: se actualiza con cada cambio que deje un script por ejecutar. Marca `[x]` lo que vayas haciendo.
> Última actualización: 2026-09-29 (hash regenerable + portadas artefacto corregido).

## Antes de nada

- [ ] **Copia de seguridad de la base de datos** (Atlas). Casi todo lo de abajo escribe en muchos documentos.
- [ ] **Desplegar la última versión** con el script de actualización de siempre (`actualizar-GestorBiblioteca.sh`).
      Sin esto, los scripts nuevos no están en el NAS.

Todos los scripts van **en seco por defecto**: primero se lanzan sin `--ejecutar`, se revisa lo que proponen y solo
entonces se repiten con `--ejecutar`. Todos son **reanudables**: si se cortan, se vuelven a lanzar y siguen.

## Scripts por ejecutar (en este orden)

### 1. Colocar cada libro en la carpeta de su CDU
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/recolocar-por-cdu.js`
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/recolocar-por-cdu.js --ejecutar`

Mueve a su sitio los libros cuya carpeta no refleja la CDU de la ficha (medido: ~451). La tarea del Conformador
«ubicar-segun-cdu» hace lo mismo poco a poco; el script lo hace de una vez. *(Si ya lo ejecutaste tras el 28-sep,
el dry-run dirá 0.)*

### 2. Recuperar los ISBN que faltan (y cotejar con ellos)
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/reidentificar-sin-isbn.js --todos`
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/reidentificar-sin-isbn.js --todos --ejecutar`

Busca el ISBN en el propio fichero y, si el ripeo lo quitó, identifica la edición por autoridad (Fichero, BNE,
OpenLibrary), con traductor, editorial, colección e indicios aprendidos. Con el ISBN rellena todo lo que falte, pone
la editorial de la edición, aplica la CDU de la BNE (moviendo la carpeta) y corrige títulos pobres. Asigna la edición
más probable: **definitiva**, **provisional** (varias de la misma editorial) o **dudosa** (una sola posible).
Salta lo ya revisado. La campaña «Recuperar ISBN que faltan» hace lo mismo a reposo (**páusala mientras corre el script**).

### 3. Resolver las «Edición por elegir» (~1.232)
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/reidentificar-sin-isbn.js --edicion-por-elegir`
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/reidentificar-sin-isbn.js --edicion-por-elegir --ejecutar`

Re-investiga los que esperaban tu elección y les asigna la más probable (muestra de 30: 30 asignados). La campaña
«Resolver ediciones pendientes» hace lo mismo a reposo (**páusala mientras corre el script**). Después, si quieres,
revisa en el Dashboard las filas **«ISBN provisional»** e **«ISBN dudoso»** (opcional: el registro ya está completo).

### 4. Portadas falsas (la misma imagen en libros distintos)
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/detectar-portadas-artefacto.js`

Crea una selección **«Portada sospechosa …»** por grupo (no toca los documentos). Luego, en el panel, sobre cada
selección: **🚩 Portada sospechosa…** → re-extraer omitiendo la sospechosa / primera página de texto / quitar.
(El 1.er barrido encontró grupos como 415 EPUB en español con la misma imagen y 30 libros de ciencia con un banner.)

### 4 bis. Hashes que hayan quedado viejos
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/verificar-hashes.js`
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/verificar-hashes.js --ejecutar`

Detecta los documentos cuyo fichero se modificó después de calcular su hash y los recalcula (si sale igual, solo
anota la huella). La primera vez saldrán muchos «sospechosos» que no lo son (carpetas movidas o restauradas estos
días): el recálculo los confirma. Después, Integridad lo vigila solo.

### 4 ter. Libros catalogados varias veces (versiones del mismo libro)
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/fusionar-versiones.js`
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/fusionar-versiones.js --ejecutar`

Mismo ISBN, formato y título con ficheros algo distintos (2.416 grupos, 5.123 documentos medidos el 29-sep). Sin
`--ejecutar` crea selecciones «Versiones por revisar …» e «ISBN compartido …»; con `--ejecutar` fusiona solo los
seguros (todos los ficheros se conservan como versiones). Los que queden, desde el panel: «🔗 Fusionar versiones».
Los «ISBN compartido» (títulos distintos, 257 grupos) tienen un ISBN falso: hay que corregirlo, no fusionar.

### 5. Autores fusionados en uno (pendiente desde julio)
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/separar-autores-fusionados.js`
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/separar-autores-fusionados.js --ejecutar`
- [ ] Después: `sudo docker exec -t gestor-biblioteca node scripts/marcar-autores-basura.js` (en seco y luego `--ejecutar`)

Separa «autores» que eran varias personas en un solo registro (dry-run de julio: 285 grupos, 314 libros).

### 6. Título original desde los créditos (pendiente desde julio)
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/recuperar-titulo-original.js`
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/recuperar-titulo-original.js --ejecutar`

Lee la página de créditos de EPUB/PDF (sin IA) y guarda el título original (~11.635 candidatos).

### 7. Libros sin editorial
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/reclasificar-editoriales.js --sin-editorial`
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/reclasificar-editoriales.js --sin-editorial --ejecutar`

Cascada gratuita (nombre de archivo → Fichero → colección → OpenLibrary → Google). `--ia` añade IA de texto (barata).

### 8. Al final
- [ ] Panel → **Búsqueda → Reindexar** (el índice del NAS no recogió los renombres de revistas del 15-sep).
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/integridad.js --informe /app/logs/integridad.txt` (diagnóstico).

### Revisiones a mano (sin script)
- [ ] 129 documentos catalogados como **revista** que parecen libros, y 54 cabeceras cuya CDU pudo salir del Dewey
      de un libro (ofrecido el 17-sep, no hecho).

## Lo que ya hace el sistema solo (no hay que lanzar nada)

Campañas de fondo activas (Mantenimiento → Campañas): **Sidecars**, **Recuperar ISBN que faltan**, **Resolver
ediciones pendientes**, **Cotejar título por ISBN**, y las tareas del Conformador (**aplicar-cdu-bne**,
**re-clasificar-cdu**, **ubicar-segun-cdu**). Y desde el 29-sep **la ingesta** ya aplica todo lo de abajo a cada
libro nuevo: entra identificado, con su edición, su editorial, su CDU por prioridad y en su carpeta.

---

## Resumen de trabajos (15 → 29 de septiembre de 2026)

### Revistas (14-17 sep)
- Inspección con IA de árboles profundos; botón «🤖 IA» por carpeta; carpetas nuevas a cualquier nivel.
- Las revistas ya **no pasan por catálogos de libros** (incidente L'Histoire: «11.pdf» → «11/22/63»); fecha y número
  por carpeta; portada leída al inspeccionar; cada número guiado entra **sin IA**.
- ISSN cotejado siempre con el registro; saneado de los números contaminados (hecho el 17-sep).

### Copia USB (17 sep)
- Registro por bloques, aviso de poco espacio, prueba del correo de aviso.

### ISBN: extraerlo del fichero (27-28 sep)
- **EPUB**: se lee de verdad el OPF (con prefijos `opf:`) y las páginas de créditos: ISBN, bloque CIP, Dewey/LC y
  **CDU impresa**. Lo mismo generalizado a PDF y MOBI.

### Identificar la edición sin ISBN (28-29 sep)
- Por **autoridad**: Fichero local, **BNE en línea** (su SRU, nuevo) y OpenLibrary, en el orden que dicta la lengua.
- Pruebas: título, autor, editorial, año, **colección y número**, **traductor** (del fichero o anotado en el título),
  **indicios colección → editorial** aprendidos de cada identificación («Solaris ficción» → La Factoría de Ideas).
- Decide solo: reduce candidatas (fuera otras lenguas, otras traducciones, reimpresores bajo demanda) y asigna la
  más probable: **definitiva**, **provisional** o **dudosa**. La ficha permite confirmar o cambiar.
- La editorial de la edición confirmada sustituye a una errónea; «ePubLibre», «Unknown Publisher»… nunca son editorial.
- **Google Books** fallaba por cuota diaria agotada (no baneo): ahora se respeta hasta el reinicio.
- **Libros homónimos**: la cascada ya no acepta el libro de otro autor que OpenLibrary/Google devuelven por título
  (caso ISBN 9791387600075: Tim Weiner, no Laura Gallego).
- «Parado una hora»: la búsqueda en el Fichero era lentísima en el Atom; ahora consulta precisa + progreso por libro.

### CDU y carpetas (28 sep)
- **Prioridad**: manual > impresa en el libro > BNE (bibliotecarios) > deducida (Dewey/LCC, caché, IA); una CDU de
  rango mayor sustituye a la de menor **moviendo la carpeta**.
- **La carpeta refleja la ficha**: recolocación por CDU y tipo; colisiones resueltas con sufijo propio.
- **Carpetas compartidas separadas**: 1 documento ↔ 1 carpeta, con sus sidecars e imágenes (ejecutado: 75 devueltos).
- Salvaguarda: si el registro de la BNE es de otro libro (ISBN sospechoso) no se reclasifica; se marca para revisar.

### Portadas (28-29 sep)
- **Portadas artefacto** (la misma imagen en libros distintos): se detectan, se registran y la ingesta las salta
  (también la página equivalente de un PDF, por huella perceptiva).
- Acción **«🚩 Portada sospechosa…»**: re-extraer omitiendo la falsa, primera página de texto (EPUB: página compuesta
  con su portadilla) o quitarla (pasa a portada la siguiente imagen).

### Campañas y panel (28-29 sep)
- Campañas nuevas: **Recuperar ISBN que faltan** y **Resolver ediciones pendientes**; un libro solo se da por revisado
  cuando no queda esperanza (si una fuente estaba caída, se reintenta a las 6 h).
- El panel de Campañas ya no da **504** (contadores en caché).
- Dashboard: **Edición por elegir**, **ISBN provisional**, **ISBN dudoso**.
