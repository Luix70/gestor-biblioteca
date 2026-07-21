/**
 * CATÁLOGO DE SCRIPTS EJECUTABLES DESDE EL PANEL (Mantenimiento → «Ejecutar script»).
 *
 * Es la LISTA BLANCA: solo se puede lanzar lo que está aquí. El panel nunca recibe una ruta ni un comando —
 * manda un `id` de esta tabla y unos VALORES para los parámetros declarados; el servidor construye el argv y
 * lanza `node scripts/<id>.js …argv` con spawn (array de argumentos, SIN shell), así que un valor con
 * «; rm -rf» viaja como un único argumento a Node, no se interpreta. Cada script, además, es DRY-RUN por
 * defecto y valida sus propias entradas.
 *
 * Modelo de un parámetro:
 *   { nombre, flag?, tipo, etiqueta, ayuda?, ejemplo?, requerido?, multi? }
 *     tipo 'texto'|'numero' → input; si hay `flag` se emite «flag valor», si no, es POSICIONAL (solo el valor).
 *     tipo 'switch'         → checkbox; emite el `flag` a secas cuando está activo.
 *     multi:true            → varias líneas → varios argumentos (rutas, ids…).
 *
 * `aplica`: el flag que significa «hazlo de verdad» (por defecto '--ejecutar'; en integridad es '--reparar').
 *   null = el script no tiene modo de aplicación (diagnóstico solo-lectura, o reconstrucción derivada segura):
 *   se ejecuta sin contraseña. Cuando `aplica` NO es null, el modo APLICAR exige contraseña de admin.
 */

// Categorías (orden de presentación en el desplegable).
export const CATEGORIAS_SCRIPTS = [
    'Diagnóstico', 'Integridad y disco', 'Cuarentena y duplicados',
    'Obras, series y colecciones', 'Revistas', 'Autores y editoriales',
    'Metadatos y clasificación', 'Imágenes y portadas', 'Inbox', 'Infraestructura',
];

const S = (o) => o; // azúcar para legibilidad

export const CATALOGO_SCRIPTS = [
    // ── Diagnóstico (solo lectura; sin contraseña) ───────────────────────────
    S({ id: 'dry-run', cat: 'Diagnóstico', escribe: false, aplica: null,
        resumen: 'Qué haría el vigilante con el Inbox actual (sin tocar nada)',
        proposito: 'Llama a la MISMA función que decide de verdad (planificarInbox). Muestra qué se catalogaría y, sobre todo, QUÉ SE QUEDA FUERA Y POR QUÉ. No cataloga, mueve ni borra.',
        params: [{ nombre: 'json', flag: '--json', tipo: 'switch', etiqueta: 'Salida JSON' }] }),
    S({ id: 'diagnostico-revistas', cat: 'Diagnóstico', escribe: false, aplica: null,
        resumen: 'Revistas conflacionadas / carpetas colisionadas',
        proposito: 'Distingue REGISTRO PERDIDO (fichero en disco sin documento) de COLISIÓN DE CARPETA (varios documentos en la misma carpeta). Solo informa.', params: [] }),
    S({ id: 'diagnostico-revistas-libro', cat: 'Diagnóstico', escribe: false, aplica: null,
        resumen: 'Revistas que en realidad son libros',
        proposito: 'Colecciones-revista de 1 miembro y documentos revista con señal de libro (CIP / ISBN propio / editorial / serie). No escribe.',
        params: [{ nombre: 'lista', flag: '--lista', tipo: 'switch', etiqueta: 'Detalle por documento' }] }),
    S({ id: 'buscar-sin-autor', cat: 'Diagnóstico', escribe: false, aplica: null,
        resumen: 'Documentos sin ningún autor ni contribuyente',
        proposito: 'Lista los documentos que quedaron sin autor. Filtro opcional por texto en título/nombre de archivo. No escribe nada.',
        params: [{ nombre: 'filtro', tipo: 'texto', etiqueta: 'Filtro (opcional)', ejemplo: 'visualization' }] }),
    S({ id: 'auditoria-integridad', cat: 'Diagnóstico', escribe: false, aplica: null,
        resumen: 'Auditoría de integridad por-ítem (detallada, solo lectura)',
        proposito: 'La auditoría antigua con salida CLI minuciosa. El paso consolidado y CON reparación es «integridad».', params: [] }),
    S({ id: 'muestra-fichero', cat: 'Diagnóstico', escribe: false, aplica: null,
        resumen: 'Qué roles/idioma son recuperables del Fichero local',
        proposito: 'Mide, sin mover el .db de varios GB, qué información de roles y de idioma original trae el volcado — para afinar las campañas de fondo.', params: [] }),
    S({ id: 'verificar-gemini', cat: 'Diagnóstico', escribe: false, aplica: null,
        resumen: 'Comprueba que las claves Gemini del .env funcionan',
        proposito: 'Una llamada mínima por clave contra el modelo que usa la app. No escribe nada; enmascara las claves en la salida.', params: [] }),

    // ── Integridad y disco ───────────────────────────────────────────────────
    S({ id: 'integridad', cat: 'Integridad y disco', escribe: true, aplica: '--reparar', peligroso: true,
        resumen: 'Diagnostica y (al aplicar) repara DB↔disco en una pasada',
        proposito: 'Consolida auditoría + duplicados + recolector + dedup por hash. En modo DIAGNÓSTICO no toca nada. En modo REPARAR poda solo ramas literalmente vacías y dedup por hash exacto (todo a la Papelera); una carpeta CON ficheros NO se toca. Escribe además un informe detallado si das ruta.',
        params: [{ nombre: 'informe', flag: '--informe', tipo: 'texto', etiqueta: 'Ruta del informe (opcional)', ejemplo: '/app/logs/integridad.txt' }] }),
    S({ id: 'limpiar-huerfanos', cat: 'Integridad y disco', escribe: true, aplica: '--ejecutar',
        resumen: 'Poda autores/editoriales sin referencias y obras/colecciones vacías',
        proposito: 'Borra lo que nada más limpia: autores y editoriales con 0 documentos y obras/colecciones sin miembros. Se recrean solos si un documento futuro los necesita.', params: [] }),
    S({ id: 'regenerar-registros', cat: 'Integridad y disco', escribe: true, aplica: '--ejecutar',
        resumen: 'Regenera los sidecars registro.json / .marc.xml desde Mongo',
        proposito: 'Reescribe los dos sidecars de cada carpeta con los datos actuales de la base (resolviendo autores/editorial a nombres). Útil tras correcciones masivas. No toca nada más.', params: [] }),
    S({ id: 'separar-carpetas-compartidas', cat: 'Integridad y disco', escribe: true, aplica: '--ejecutar',
        resumen: 'Da carpeta propia a documentos que comparten una por colisión',
        proposito: 'Cuando varios documentos comparten una carpeta y se pisan los sidecars/portadas (el catálogo los tiene bien, solo mal alojados), mueve cada uno a su carpeta adyacente y corrige la BD. No reingesta ni usa IA.', params: [] }),
    S({ id: 'relocalizar-documentos', cat: 'Integridad y disco', escribe: true, aplica: '--ejecutar',
        resumen: 'Corrige ruta_base obsoletas buscando el fichero en el árbol',
        proposito: 'Cuando la carpeta de un documento no está donde dice la base, busca el fichero por su nombre en el árbol y corrige la ruta (y portada/imágenes). No mueve nada. Si el nombre aparece en varios sitios, no elige: lo señala.',
        params: [{ nombre: 'coleccion', flag: '--coleccion', tipo: 'texto', etiqueta: 'Id de colección (opcional)', ejemplo: '6a53bbb3c0a40089cd18b956' }] }),
    S({ id: 'restaurar-originales', cat: 'Integridad y disco', escribe: false, aplica: '--ejecutar',
        resumen: 'Recupera el fichero original desaparecido de la carpeta de un doc',
        proposito: 'Busca el .epub/.pdf que falta en Reintentos/Inbox/Cuarentena y lo copia de vuelta (copia NO destructiva; no borra el respaldo). No toca Mongo.', params: [] }),

    // ── Cuarentena y duplicados ──────────────────────────────────────────────
    S({ id: 'organizar-cuarentena', cat: 'Cuarentena y duplicados', escribe: false, aplica: '--ejecutar',
        resumen: 'Ordena Cuarentena en subcarpetas por categoría',
        proposito: 'Clasifica los depósitos en duplicados / no-identificados / otros. Hashea cada fichero y lo compara con la biblioteca para detectar duplicados reales.', params: [] }),
    S({ id: 'reprocesar-cuarentena', cat: 'Cuarentena y duplicados', escribe: false, aplica: '--ejecutar',
        resumen: 'Devuelve depósitos de Cuarentena al Inbox para recatalogar',
        proposito: 'Reingiere con el pipeline actual (que ya no descarta lo que tiene ISBN/ISSN válido). Mueve por rename atómico; borra el depósito solo tras confirmar la salida.', params: [] }),
    S({ id: 'resolver-duplicados', cat: 'Cuarentena y duplicados', escribe: false, aplica: '--ejecutar',
        resumen: 'Auto-resuelve el backlog de Cuarentena/duplicados',
        proposito: 'Mismo hash → borra el entrante; formato distinto → conserva ambos; mismo formato y hash distinto → conserva el mayor. (Ya incluido en «integridad».)', params: [] }),
    S({ id: 'purgar-duplicados', cat: 'Cuarentena y duplicados', escribe: false, aplica: '--ejecutar',
        resumen: 'Purga SEGURA de Cuarentena/duplicados',
        proposito: 'Re-verifica por contenido que el gemelo catalogado sigue en disco ANTES de borrar. Si no está, no borra: podría ser la única copia.', params: [] }),
    S({ id: 'purgar-ilegibles', cat: 'Cuarentena y duplicados', escribe: true, aplica: '--ejecutar', peligroso: true,
        resumen: 'Retira PDFs catalogados ilegibles (estructura dañada)',
        proposito: 'Mueve el fichero a Cuarentena/ilegibles y borra su documento + carpeta. Necesita poppler. Deja de haber registros apuntando a ficheros rotos.', params: [] }),
    S({ id: 'sanear-catalogo', cat: 'Cuarentena y duplicados', escribe: true, aplica: '--ejecutar',
        resumen: 'Sanea el catálogo con el pipeline actual (re-home + portadas)',
        proposito: 'Deshace daños de ingestas viejas, sin red y sin pérdida. Con «reclasificar» re-ingiere cómics mal archivados (usa IA).',
        params: [
            { nombre: 'limite', flag: '--limite', tipo: 'numero', etiqueta: 'Límite (para probar)', ejemplo: '50' },
            { nombre: 'reclasificar', flag: '--reclasificar', tipo: 'switch', etiqueta: 'Reclasificar cómics (usa IA)' },
        ] }),

    // ── Obras, series y colecciones ──────────────────────────────────────────
    S({ id: 'agrupar-en-obra', cat: 'Obras, series y colecciones', escribe: true, aplica: '--ejecutar', peligroso: true,
        resumen: 'Agrupa documentos sueltos en UNA obra multivolumen',
        proposito: 'Reúne varios documentos bajo una sola CDU y una carpeta (<cdu>/obras/<obra>/vol-N). Para colecciones catalogadas tomo a tomo sin ISBN. Mueve ficheros (nunca borra); si el destino existe, salta ese tomo. ⚠ Copia de seguridad antes de aplicar.',
        params: [
            { nombre: 'patron', flag: '--patron', tipo: 'texto', requerido: true, etiqueta: 'Patrón (regex sobre nombre_archivo)', ejemplo: 'Encyclopedie.*cbz$' },
            { nombre: 'titulo', flag: '--titulo', tipo: 'texto', requerido: true, etiqueta: 'Título de la obra', ejemplo: 'Grabados de la Encyclopédie' },
            { nombre: 'cdu', flag: '--cdu', tipo: 'texto', requerido: true, etiqueta: 'CDU', ejemplo: '76' },
            { nombre: 'esperados', flag: '--esperados', tipo: 'numero', etiqueta: 'Nº esperado (red de seguridad)', ejemplo: '16', ayuda: 'Si el patrón no casa exactamente este número, no toca nada.' },
        ] }),
    S({ id: 'unificar-serie-revista', cat: 'Obras, series y colecciones', escribe: true, aplica: '--ejecutar', peligroso: true,
        resumen: 'Unifica una serie (colección de números) catalogada a trozos',
        proposito: 'Un tipo, una CDU, una carpeta (<cdu>/revistas/<issn>/<clave>). El título manda sobre el numero_issue guardado. ⚠ Copia de seguridad antes: toca cientos de documentos.',
        params: [
            { nombre: 'coleccion', flag: '--coleccion', tipo: 'texto', requerido: true, etiqueta: 'Id de colección', ejemplo: '6a53bbb3c0a40089cd18b956' },
            { nombre: 'cdu', flag: '--cdu', tipo: 'texto', requerido: true, etiqueta: 'CDU', ejemplo: '741.5' },
            { nombre: 'esperados', flag: '--esperados', tipo: 'numero', etiqueta: 'Nº esperado (red de seguridad)', ejemplo: '692' },
        ] }),
    S({ id: 'agrupar-hermanos', cat: 'Obras, series y colecciones', escribe: true, aplica: '--ejecutar',
        resumen: 'Agrupa en obras los tomos con nº romano/final en el título',
        proposito: '«Título, I» · «Título, II» que la ingesta no detecta sola. SEGURO: exige ≥2 hermanos con el mismo prefijo y números distintos.', params: [] }),
    S({ id: 'consolidar-obras', cat: 'Obras, series y colecciones', escribe: true, aplica: '--ejecutar',
        resumen: 'Reúne los tomos dispersos de una obra en su carpeta canónica',
        proposito: 'Reubica cada tomo a <cdu>/obras/<obra>/vol-N. Córrelo después de «backfill-volumen-tomo» si hubo colisiones vol-x.', params: [] }),
    S({ id: 'backfill-volumen-tomo', cat: 'Obras, series y colecciones', escribe: true, aplica: '--ejecutar',
        resumen: 'Rellena volumen_numero en tomos que lo tenían nulo',
        proposito: 'Re-parsea el número desde el nombre («…Vol1.pdf»). No mueve carpetas (eso lo hace «consolidar-obras» después).', params: [] }),
    S({ id: 'consolidar-colecciones', cat: 'Obras, series y colecciones', escribe: true, aplica: '--ejecutar',
        resumen: 'Funde colecciones de libros duplicadas por nº en el nombre',
        proposito: '«Alianza Cien 15» + «Alianza 100 10» → una sola + coleccion_numero.', params: [] }),
    S({ id: 'unificar-colecciones', cat: 'Obras, series y colecciones', escribe: true, aplica: '--ejecutar',
        resumen: 'Funde colecciones iguales por mayúsculas/acentos/ISSN',
        proposito: 'Agrupa por componentes conexos (nombre normalizado o ISSN compartido), elige canónica y reasigna miembros.', params: [] }),
    S({ id: 'limpiar-colecciones-falsas', cat: 'Obras, series y colecciones', escribe: true, aplica: '--ejecutar',
        resumen: 'Libro colgando de una colección-basura de 1 miembro',
        proposito: 'Reprocesa «nuevo desde cero» (re-lee el CIP) el libro que quedó ligado a una colección falsa, y borra la colección vacía.', params: [] }),
    S({ id: 'sanear-colecciones-issn', cat: 'Obras, series y colecciones', escribe: true, aplica: '--ejecutar',
        resumen: 'Colecciones con nombre-placeholder → nombre real por ISSN',
        proposito: 'Su propio ISSN, un DOI de Springer o «Creator:…» como nombre → nombre real por ISSN (Wikidata, sin IA); funde o renombra.', params: [] }),
    S({ id: 'sanear-nombres-serie-issn', cat: 'Obras, series y colecciones', escribe: true, aplica: '--ejecutar',
        resumen: 'Serie cuyo nombre es un título de libro → nombre por ISSN',
        proposito: 'La 1ª monografía se llevó su título a la cabecera. Resuelve el nombre autoritativo por ISSN (Wikidata → ISSN Portal). Solo renombra.', params: [] }),
    S({ id: 'purgar-multipart', cat: 'Obras, series y colecciones', escribe: true, aplica: '--ejecutar', peligroso: true,
        resumen: 'Purga una obra multivolumen mal catalogada para re-ingerir',
        proposito: 'Borra la obra + tomos de la BD y MUEVE sus carpetas a la Papelera (recuperable).',
        params: [{ nombre: 'objetivo', tipo: 'texto', requerido: true, multi: true, etiqueta: 'ISBN de obra o título (uno por línea)', ejemplo: '0787653624' }] }),

    // ── Revistas ─────────────────────────────────────────────────────────────
    S({ id: 'reclasificar-libros', cat: 'Revistas', escribe: true, aplica: '--ejecutar',
        resumen: 'Libros mal clasificados como revista → libro',
        proposito: 'Por señal fuerte (ISBN en el nombre, título-artefacto). Solo BD, reversible.', params: [] }),
    S({ id: 'reclasificar-revistas-a-libros', cat: 'Revistas', escribe: true, aplica: '--ejecutar',
        resumen: '«Revista» que es libro por colección-de-1 con señal fuerte',
        proposito: 'CIP o prefijo de editorial y sin ISSN: reprocesa nuevo desde cero y borra la colección falsa.', params: [] }),
    S({ id: 'reclasificar-revistas-por-senal', cat: 'Revistas', escribe: true, aplica: '--ejecutar',
        resumen: 'Revistas que son libro por CIP / ISBN propio / editorial',
        proposito: 'Complementa al anterior (no por colección, sino por señal directa).', params: [] }),

    // ── Autores y editoriales ────────────────────────────────────────────────
    S({ id: 'enriquecer-autores', cat: 'Autores y editoriales', escribe: true, aplica: '--ejecutar',
        resumen: 'Foto + bio + seudónimos de autores (gratis, sin IA)',
        proposito: 'Desde OpenLibrary + Wikidata + Wikipedia, en tandas de 25. Solo autores con libros a los que les falte. Conservador salvo «sobrescribir».',
        params: [
            { nombre: 'limite', flag: '--limite', tipo: 'numero', etiqueta: 'Límite', ejemplo: '50' },
            { nombre: 'sobrescribir', flag: '--sobrescribir', tipo: 'switch', etiqueta: 'Sobrescribir lo existente' },
        ] }),
    S({ id: 'roles-autores', cat: 'Autores y editoriales', escribe: true, aplica: '--ejecutar',
        resumen: 'Contribuciones (traductor/ilustrador…) e idioma original',
        proposito: 'Desde OpenLibrary + Fichero por ISBN, SIN IA, tandas de 25. Conservador: no pisa lo que ya haya.',
        params: [{ nombre: 'limite', flag: '--limite', tipo: 'numero', etiqueta: 'Límite', ejemplo: '100' }] }),
    S({ id: 'separar-autores-fusionados', cat: 'Autores y editoriales', escribe: true, aplica: '--ejecutar',
        resumen: 'Un registro de autor que son varias personas → una por nombre',
        proposito: 'Reparte «Rochegrosse & Rackham & Clarke» en una persona por nombre, resuelta como en la ingesta.', params: [] }),
    S({ id: 'unificar-autores-grafia', cat: 'Autores y editoriales', escribe: true, aplica: '--ejecutar',
        resumen: 'Funde autores iguales por mayúsculas/acentos',
        proposito: '«JEAN TOUCHARD» = «Jean Touchard». ESTRICTO: por nombre normalizado, nunca por parecido.', params: [] }),
    S({ id: 'recuperar-contribuciones', cat: 'Autores y editoriales', escribe: true, aplica: '--ejecutar',
        resumen: 'Repara contribuciones que apuntan a un autor inexistente',
        proposito: 'Reconstruye el nombre por ISBN (Fichero + OpenLibrary, sin IA) y lo re-resuelve. Solo toca refs rotas.', params: [] }),
    S({ id: 'marcar-autores-basura', cat: 'Autores y editoriales', escribe: true, aplica: '--ejecutar',
        resumen: 'Marca «[?]_» los autores artefacto (Creator:, URLs, ISBNs)',
        proposito: 'Para filtrarlos en el panel y reingerir a mano. NO borra: solo renombra. Con «quitar» retira el prefijo.',
        params: [{ nombre: 'quitar', flag: '--quitar', tipo: 'switch', etiqueta: 'Quitar el prefijo en vez de ponerlo' }] }),
    S({ id: 'reclasificar-editoriales', cat: 'Autores y editoriales', escribe: true, aplica: '--ejecutar',
        resumen: 'Reclasifica el campo editorial en lote (cascada de fuentes)',
        proposito: 'Busca la casa real (Fichero → OpenLibrary → Google → IA opcional) e informa por transición. Para depurar en masa (p. ej. «ePubLibre»).',
        params: [
            { nombre: 'editorial', flag: '--editorial', tipo: 'texto', etiqueta: 'Editorial a corregir', ejemplo: 'ePubLibre' },
            { nombre: 'id', flag: '--id', tipo: 'texto', etiqueta: 'Id de una editorial (alternativa)' },
            { nombre: 'sin', flag: '--sin-editorial', tipo: 'switch', etiqueta: 'Solo los que no tienen editorial' },
            { nombre: 'todos', flag: '--todos', tipo: 'switch', etiqueta: 'Todos' },
            { nombre: 'limite', flag: '--limite', tipo: 'numero', etiqueta: 'Límite', ejemplo: '500' },
            { nombre: 'ia', flag: '--ia', tipo: 'switch', etiqueta: 'Permitir IA (de pago)' },
        ] }),

    // ── Metadatos y clasificación ────────────────────────────────────────────
    S({ id: 're-enriquecer-degradados', cat: 'Metadatos y clasificación', escribe: true, aplica: '--ejecutar',
        resumen: 'Re-enriquece (sobrescribiendo) lotes ingeridos con APIs caídas',
        proposito: 'Título = nombre de archivo, cdu «00», sin autor… Con un ISBN, rellena autor/editorial desde OL/Fichero (autoritativo). No mueve ficheros.', params: [] }),
    S({ id: 'recuperar-titulo-original', cat: 'Metadatos y clasificación', escribe: true, aplica: '--ejecutar',
        resumen: 'Backfill del título original (obras traducidas), sin IA',
        proposito: 'Abre el EPUB/PDF y lee «Título original:» de la página de créditos. Debe correr donde estén los ficheros.', params: [] }),
    S({ id: 'reparar-pdf-como-papel', cat: 'Metadatos y clasificación', escribe: true, aplica: '--ejecutar',
        resumen: 'Repara PDF/EPUB digitales marcados por error como «papel»',
        proposito: 'Re-etiqueta digital, recorta a 6 imágenes (resto a la Papelera), restaura el fichero si faltaba y corrige la BD.', params: [] }),
    S({ id: 'describir-clasificaciones', cat: 'Metadatos y clasificación', escribe: true, aplica: '--ejecutar',
        resumen: 'Backfill de descripciones CDU+Dewey+LCC que faltan (IA+caché)',
        proposito: 'La versión «de una sentada» de lo que el Conformador hace en tandas.',
        params: [{ nombre: 'limite', flag: '--limite', tipo: 'numero', etiqueta: 'Límite (para probar)', ejemplo: '20' }] }),

    // ── Imágenes y portadas ──────────────────────────────────────────────────
    S({ id: 'reparar-portadas', cat: 'Imágenes y portadas', escribe: true, aplica: '--ejecutar',
        resumen: 'Repara portadas faltantes / imágenes de carrusel rotas',
        proposito: 'Poda referencias muertas y re-resuelve la portada (reusa una imagen válida o extrae la 1ª página, encogida). «forzar» re-extrae aunque exista (exige acotar con id o patrón); «invertir» fuerza la vuelta del negativo.',
        params: [
            { nombre: 'sinportada', flag: '--sin-portada', tipo: 'switch', etiqueta: 'Solo los que NO tienen portada (rápido)' },
            { nombre: 'id', flag: '--id', tipo: 'texto', etiqueta: 'Id de un documento', ejemplo: '6a5e2b291d9c072868af9ff2' },
            { nombre: 'patron', flag: '--patron', tipo: 'texto', etiqueta: 'Patrón (regex sobre nombre_archivo)', ejemplo: 'Encyclopedie.*cbz$' },
            { nombre: 'forzar', flag: '--forzar', tipo: 'switch', etiqueta: 'Re-extraer aunque exista (exige id o patrón)' },
            { nombre: 'invertir', flag: '--invertir', tipo: 'switch', etiqueta: 'Invertir el negativo (con «forzar»)' },
        ] }),
    S({ id: 'corregir-polaridad-cbz', cat: 'Imágenes y portadas', escribe: true, aplica: '--ejecutar',
        resumen: 'Corrige láminas bitonales en negativo dentro de un cbz',
        proposito: 'Reescribe cada PNG con la paleta al revés SIN recomprimir (minutos). Verifica página a página; idempotente. Se le da una ruta de cbz o una carpeta.',
        params: [{ nombre: 'ruta', tipo: 'texto', requerido: true, multi: true, etiqueta: 'Ruta(s) de cbz o carpeta (una por línea)', ejemplo: '/app/CDU/7/76/76/obras/Grabados de la Encyclopédie' }] }),

    // ── Inbox ────────────────────────────────────────────────────────────────
    S({ id: 'utilidades', cat: 'Inbox', escribe: true, aplica: '--ejecutar', peligroso: true,
        resumen: 'Operaciones manuales sobre carpetas del Inbox',
        proposito: 'expandir · aplanar · limpiar · comprimir · renombrar, previas a la ingesta. Rehúsa aplicar si el vigilante está activo. Las rutas son relativas al Inbox; admite comodín «carpeta/*».',
        params: [
            { nombre: 'operacion', tipo: 'texto', requerido: true, etiqueta: 'Operación', ejemplo: 'aplanar', ayuda: 'expandir · expandir-aqui · aplanar · limpiar · comprimir · renombrar' },
            { nombre: 'rutas', tipo: 'texto', requerido: true, multi: true, etiqueta: 'Ruta(s) relativas al Inbox (una por línea)', ejemplo: 'Grabados/*' },
            { nombre: 'propagar', flag: '--propagar', tipo: 'switch', etiqueta: 'Propagar a subcarpetas' },
            { nombre: 'unicas', flag: '--solo-unicas', tipo: 'switch', etiqueta: '(aplanar) solo carpetas de 1 fichero' },
        ] }),

    // ── Infraestructura ──────────────────────────────────────────────────────
    S({ id: 'reindexar-busqueda', cat: 'Infraestructura', escribe: false, aplica: null,
        resumen: 'Reconstruye el índice de búsqueda (busqueda.db)',
        proposito: 'Derivado y seguro: vacía y re-inserta desde Mongo. Úsalo tras el 1er despliegue o una recuperación. Mientras no exista, la búsqueda cae a $regex.', params: [] }),
    S({ id: 'setup-mongo', cat: 'Infraestructura', escribe: true, aplica: null,
        resumen: 'Crea índices + validadores de Mongo (idempotente)',
        proposito: 'Seguro de ejecutar varias veces. Córrelo tras tocar el esquema.', params: [] }),
    S({ id: 'describir-cdus', cat: 'Metadatos y clasificación', escribe: true, aplica: '--ejecutar',
        resumen: 'Backfill de descripciones SOLO-CDU (predecesora)',
        proposito: 'Variante solo-CDU de «describir-clasificaciones».',
        params: [{ nombre: 'limite', flag: '--limite', tipo: 'numero', etiqueta: 'Límite', ejemplo: '5' }] }),
    S({ id: 'retirar-bne-cdus', cat: 'Infraestructura', escribe: true, aplica: '--ejecutar', peligroso: true,
        resumen: 'Elimina de Atlas la colección retirada bne_cdus',
        proposito: 'Redundante: el Fichero trae el volcado BNE completo. Muestra tamaño en dry-run.', params: [] }),
];

const POR_ID = new Map(CATALOGO_SCRIPTS.map((s) => [s.id, s]));

/** Un script de la lista blanca por id, o null si no está permitido. */
export function scriptPorId(id) {
    return POR_ID.get(String(id || '')) || null;
}

/** Valor de un parámetro válido: sin caracteres de control (nada que rompa un argumento o inyecte líneas). */
function valorLimpio(v, { multi = false } = {}) {
    const s = String(v);
    // Nunca NUL. En multi se permiten saltos de línea (se separan fuera); en simple, no.
    if (s.includes('\0')) return null;
    if (!multi && /[\r\n]/.test(s)) return null;
    return s;
}

/**
 * Construye el ARGV para spawn a partir de un script de la lista blanca y los valores del formulario.
 * Devuelve { ok, argv, motivo? }. NO se ejecuta nada aquí: solo se arma el array de argumentos.
 * `aplicar` = true añade el flag de aplicación del script (p. ej. --ejecutar / --reparar).
 */
export function construirArgv(script, valores = {}, aplicar = false) {
    if (!script) return { ok: false, motivo: 'script no permitido' };
    const v = valores || {};
    const argv = [];

    for (const p of script.params || []) {
        const bruto = v[p.nombre];
        if (p.tipo === 'switch') {
            if (bruto === true || bruto === 'true' || bruto === 1 || bruto === '1') argv.push(p.flag);
            continue;
        }
        // texto / numero
        const vacio = bruto === undefined || bruto === null || String(bruto).trim() === '';
        if (vacio) {
            if (p.requerido) return { ok: false, motivo: `falta el parámetro «${p.etiqueta || p.nombre}»` };
            continue;
        }
        const partes = p.multi ? String(bruto).split(/\r?\n/).map((x) => x.trim()).filter(Boolean) : [String(bruto).trim()];
        for (const parte of partes) {
            const limpio = valorLimpio(parte, { multi: false });
            if (limpio === null) return { ok: false, motivo: `valor no válido en «${p.etiqueta || p.nombre}»` };
            if (p.tipo === 'numero' && !/^-?\d+$/.test(limpio)) return { ok: false, motivo: `«${p.etiqueta || p.nombre}» debe ser un número` };
            if (p.flag) argv.push(p.flag);
            argv.push(limpio);
        }
    }

    if (aplicar && script.aplica) argv.push(script.aplica);
    return { ok: true, argv };
}

/** Metadatos para el panel (sin nada sensible; es lo que se sirve al cliente). */
export function catalogoParaPanel() {
    return CATALOGO_SCRIPTS.map((s) => ({
        id: s.id, cat: s.cat, resumen: s.resumen, proposito: s.proposito,
        escribe: !!s.escribe, peligroso: !!s.peligroso, aplica: s.aplica || null,
        params: (s.params || []).map((p) => ({
            nombre: p.nombre, tipo: p.tipo, etiqueta: p.etiqueta, ayuda: p.ayuda || '',
            ejemplo: p.ejemplo || '', requerido: !!p.requerido, multi: !!p.multi,
        })),
    }));
}
