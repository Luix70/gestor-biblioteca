# Tareas pendientes en el NAS y resumen de trabajos

> Lista viva: se actualiza con cada cambio que deje un script por ejecutar. Marca `[x]` lo que vayas haciendo.
> Última actualización: 2026-09-30 (reparaciones tras revisar el log completo de la pasada de ISBN).

## Antes de nada

- [x] **Copia de seguridad de la base de datos** (Atlas). Casi todo lo de abajo escribe en muchos documentos.
      Desde el 29-sep hay herramienta (Atlas gratuito no hace copias): `sudo docker exec -t gestor-biblioteca node
      scripts/copia-base.js` → /app/logs/copias-bd/<fecha>/ (conserva las 10 últimas). Restaurar: `scripts/restaurar-base.js
      --desde <fecha> --coleccion biblioteca [--ids …] [--ejecutar]` (en seco por defecto). **Hacerla antes de cada paso.**
- [x] **Copia del disco** (árbol CDU → USB): `sudo /volume1/docker/GestorBiblioteca/scripts/sincronizar-copia.sh --forzar`
- [x] **Desplegar la última versión** con el script de actualización de siempre (`actualizar-GestorBiblioteca.sh`).
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

### 3 bis. Reparaciones tras la pasada del 29/30-sep (desplegar primero la versión con los arreglos)
- [ ] Desplegar la última versión (incluye el arreglo de arranque `d737ba3` y los del log completo)
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/reparar-tras-reidentificacion.js`   (en seco: ~10 min)
- [ ] Copia de la base (`scripts/copia-base.js`) **y** del disco (la reparación mueve ~3.000 carpetas)
- [ ] `sudo docker exec -t gestor-biblioteca node scripts/reparar-tras-reidentificacion.js --ejecutar`
- [ ] Revisar las selecciones que deja (abajo) y, al final, encender Conformador y campañas

Todo en un comando. En seco medido el 30-sep con la pasada ya terminada (6.795 libros, 2.587 ISBN). Orden de
ejecución: 1, 2, 3, 7, 10, 8, 9, 12, 4, 5, 11, 6. Se puede ir por partes con `--fases 10,8,9`.

1. **Colaboradores** (traductor, ilustrador…) que la pasada dio a ediciones provisionales o dudosas: se quitan
   (son de la edición; vuelven al confirmarla). ~155.
2. **Editoriales falsas** impuestas (Distribooks, Firebird Distributing, Libros Sin Fronteras): se devuelve la
   anterior. 3.
3. **Editoriales con puntuación** («Valdemar,», «Ultramar.», «[Destino»): 76 se fusionan con la de nombre limpio,
   51 se renombran.
7. **Colecciones con «/**/» en el nombre**: 25 colecciones (12 fusiones, 13 renombradas) y 58 libros.
10. **Editoriales que la visión leyó en la cubierta de ePubLibre** (su logotipo): **281** libros con «se», «Se»,
   «ge», «9e», «n/a»… y **208** con «Seix Barral» sin serlo (su ISBN no es 978-84-322, o no tienen). Se les quita;
   la fase 5 la rellena por el prefijo del ISBN donde pueda. Otros **480** libros sin ISBN cuya editorial sustituyó
   a «ePubLibre» sin nada que la avale → selección **«Editorial sin confirmar (sin ISBN, en lugar del maquetador)»**.
8. **Deshacer y rehacer 155 identificaciones** que el motor corregido hace de otra manera: 116 tomos con el ISBN
   del CONJUNTO (enciclopedias Gale/Macmillan, etc.), 25 con el ISBN de otro título (8 de «Routledge Library
   Editions»), 7 con el ISBN de otra editorial que el del nombre del fichero («Bambini sorriso di Dio»), 5 con la
   edición «MP3 PACK» y 2 glosarios. Vuelven a como estaban (CDU y carpeta incluidas) y se reidentifican.
   **Necesita los ficheros: solo en el NAS.** Para ver en seco qué les pondría: `--fases 8 --con-reidentificar`.
9. **Títulos**: 13 que la pasada cambió por el mismo con una coletilla («Recycling» → «Recycling, Level 3») recuperan
   el suyo; **213 títulos-artefacto con ISBN** de toda la base («9780226…UChicagoPress.Patient_Zero…», «Unknown»)
   se cotejan otra vez (ahora también con Crossref) y, si nadie responde, toman el título del nombre del fichero (83).
12. **CDU contaminada por clase LCC** (`reparar-cdu-contaminada.js`): 1.082 libros con una CDU aprendida de UN libro
   y servida a toda su clase (historia y literaturas: «lcc:e → 972.5», «pa → 791.43»…). 309 se arreglan sin IA (a
   94 se les devuelve la que tenían); **773 necesitan IA** → selección **«CDU por reclasificar (clase LCC
   contaminada)»**; los rehace el Conformador (tarea re-clasificar-cdu) cuando lo enciendas.
4. **CDU limpia y en notación moderna** (`modernizar-cdu.js`): **3.168 CDU y 2.764 carpetas** (eran 474/791 con solo
   la literatura): encabezamientos pegados («929 Tesla, Nikola» → «929» + materia «Tesla, Nikola»), historia
   (946 → 94(460), 937 → 94(37), 940.53 → 94(100)"1939/1945"), biografía (92 → 929) y las juveniles 087.5.
   El ensayo lista las transiciones: **míralas antes de ejecutar**.
5. **Editorial por el prefijo del ISBN** (`editoriales-por-prefijo.js`): 247 huecos/basura (más los que deja la
   fase 10); ~890 a la selección «Editorial a revisar (prefijo ISBN)», sin tocarlos.
11. **Para revisar a mano** (no cambia nada): selección **«CDU de la BNE de otra lengua»** (17: Hemingway o
   Stephen King como literatura española, «821.11(73)», «821.122.2») y **«ISBN de otra lengua»** (16: «1984» con
   ISBN alemán, «La lotería» con uno ruso).
6. **Reidentificar otra vez** (`--todos --edicion-por-elegir`): los 135 «con esperanza», lo deshecho en la fase 8
   que no se resolviera, y las ediciones por elegir (ISBN probable + datos de la obra). Tarda horas; en seco se salta.

### 3 ter. Índice de series (para el trabajo de colecciones)
- [ ] **Volver a copiar** `series.db` al NAS: se reconstruyó el 30-sep por la tarde (las series juntas con «/**/»
  cuentan ahora en cada una).
- [ ] Copiar `D:\gestor-biblioteca\Fichero\series.db` (2,9 GB, construido en el PC el 30-sep) a la carpeta Fichero del
  NAS (`U:\Fichero\series.db`). Sin reiniciar nada: se abre la primera vez que se consulta.
- [ ] Probar: `sudo docker exec -t gestor-biblioteca node scripts/consultar-serie.js "Graduate texts in mathematics"`

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

### Imagen Docker: Debian 11 sin soporte (a resolver ANTES de tocar la parte de apt del Dockerfile)
- [ ] Seguir en Debian 11 (bullseye) apuntando apt a `archive.debian.org` cuando haya que rehacer la capa de apt.
      Hoy funciona porque esa capa sale de la caché de Docker; si hubiera que rehacerla falla con 404 (29-sep).
      NO migrar a Debian 12 (bookworm): el NAS tiene DSM 6.2.4 → Docker 20.10.3 (< 20.10.10), cuyo seccomp bloquea
      `clone3` y Node no arrancaría (salvo `security_opt: seccomp:unconfined`, que no conviene).

### Revisiones a mano (sin script)
- [ ] **Libros catalogados como revista** (~129; el usuario pidió que se le recuerde, 29-sep). Llevan el ISSN de su
      SERIE y por eso entraron como revista: p. ej. «DK Eyewitness Travel Guide» (…/revistas/1542-1554/2014) o
      «Collider Physics within the Standard Model» (Lecture Notes in Physics, …/revistas/0075-8450…/2017). Pasarlos a
      libro (el ISSN va a su colección-serie, como las series de Springer), recolocar su carpeta y revisar las 54
      cabeceras cuya CDU pudo salir del Dewey de un libro. Ofrecido el 17-sep, no hecho.

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
