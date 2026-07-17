/**
 * INFORME DE INTEGRIDAD EN TEXTO PLANO — el informe .txt que descarga el panel.
 *
 * El panel enseña una tabla con los recuentos y una muestra de 12 elementos por fila. Eso vale para echar un
 * vistazo, pero no para TRABAJAR: si hay 174 casos, ni los ves todos ni te los puedes llevar. Esto rinde el
 * informe COMPLETO (`informe.detalles`, sin recortar) a un texto que se lee en cualquier sitio, se archiva y
 * se puede comparar con el del mes que viene para ver si algo empeora.
 *
 * La decisión de diseño: NO es un volcado del JSON. Cada categoría explica QUÉ SIGNIFICA y QUÉ HACER, porque
 * un informe que solo dice «rutaBaseDesajustada: 6» obliga a venir a leer el código para saber si eso es grave.
 * El objetivo es que quien lo abra pueda actuar sin preguntarle a nadie.
 */

const RAYA = '─'.repeat(78);
const DOBLE = '═'.repeat(78);
const num = (n) => new Intl.NumberFormat('es-ES').format(n || 0);

/**
 * Catálogo de categorías: etiqueta, si la arregla el botón «Reparar» o pide mano, qué significa y qué hacer.
 * El orden es el de la tabla del panel (primero lo que puede implicar pérdida, luego la limpieza rutinaria).
 * `muestra` dice de qué lista de `detalles` sale cada una (las dos filas de hash comparten lista).
 */
const CATEGORIAS = [
    {
        clave: 'docsSinCarpeta', lista: 'docsSinCarpeta', auto: false,
        etiqueta: 'Docs sin carpeta',
        que: 'El documento está en la base de datos, pero la carpeta a la que apunta su `ruta_base` NO existe en el disco.',
        hacer: 'Mirar en la Papelera (la carpeta suele estar ahí, reciclada por una reparación anterior) y restaurarla. Si no aparece, el fichero se perdió: borra el registro o vuelve a ingerir el original.',
    },
    {
        clave: 'docsSinFicheroOriginal', lista: 'docsSinFicheroOriginal', auto: false,
        etiqueta: 'Docs sin fichero original',
        que: 'La carpeta existe, pero dentro NO está el fichero que el documento dice tener (`nombre_archivo`). Suele quedar la portada y los sidecars, que engañan: parece que hay algo.',
        hacer: 'Buscar el fichero en la Papelera y restaurarlo. Si no está, es un candidato a Cuarentena/ilegibles: consigue una copia sana y usa el flujo de saneamiento.',
    },
    {
        clave: 'docsConAudiosRotos', lista: 'docsConAudiosRotos', auto: false,
        etiqueta: 'Audiolibros con pistas que faltan',
        que: 'Un audiolibro cuyo `audios[]` apunta a mp3 que no están en el disco. Era un PUNTO CIEGO histórico: la comprobación de arriba EXCLUYE a los audiolibros (su original no es un pdf/epub), así que un audiolibro sin sus pistas era invisible — el documento se lista en el catálogo y solo al pulsar «reproducir» descubres que no hay nada.',
        hacer: 'Restaurar las pistas desde la Papelera, o volver a ingerir la colección de origen.',
    },
    {
        clave: 'rutaBaseCompartida', lista: 'rutaBaseCompartida', auto: false,
        etiqueta: 'Varios docs en la misma carpeta',
        que: 'Dos o más documentos comparten `ruta_base`, rompiendo la regla 1 documento ↔ 1 carpeta. Se pisan los sidecars (registro.json, portadas) entre ellos.',
        hacer: 'Abrir la ficha de uno y usar «Reprocesar» para que se re-aloje en su propia carpeta. No se automatiza: separar dos ficheros distintos sin riesgo no es trivial. (Los árboles transmedia con `ruta_fija` NO cuentan: ahí comparten carpeta a propósito.)',
    },
    {
        clave: 'ramasMuertas', lista: 'ramasMuertas', auto: true,
        etiqueta: 'Ramas vacías / muertas',
        que: 'Carpetas del árbol CDU sin ningún contenido útil (ni fichero, ni imagen, ni registro) y sin hojas vivas por debajo. Restos normales de mover/borrar documentos.',
        hacer: 'Las poda el botón «Diagnosticar y reparar». Van a la Papelera, no se borran.',
    },
    {
        clave: 'registroSinDocumento', lista: 'registroSinDocumento', auto: false,
        etiqueta: 'Registro sin documento',
        que: 'La carpeta tiene su registro.json pero ni fichero ni imágenes: el manifiesto sobrevivió y el contenido no.',
        hacer: 'El registro.json dice qué había (título, ISBN): úsalo para buscar el fichero en la Papelera o para reingerirlo.',
    },
    {
        clave: 'carpetasHuerfanas', lista: 'carpetasHuerfanas', auto: true,
        etiqueta: 'Carpetas huérfanas',
        que: 'Carpetas con registro.json cuyo documento ya NO está en Mongo (borrado sin limpiar el disco).',
        hacer: 'Las recicla el botón «Reparar». Ojo: si el fichero te interesa, sácalo ANTES o restáuralo luego de la Papelera.',
    },
    {
        clave: 'rutaBaseDesajustada', lista: 'rutaBaseDesajustada', auto: true,
        etiqueta: 'ruta_base desajustada',
        que: 'El documento en Mongo apunta a una carpeta y el fichero está en otra (típico tras renombrar o reclasificar).',
        hacer: 'Lo cuadra el botón «Reparar»: deja la BD apuntando a donde de verdad está el fichero y recicla la carpeta sobrante.',
    },
    {
        clave: 'hashDuplicadosGrupos', lista: 'hashDuplicados', auto: true,
        etiqueta: 'Duplicados por hash (grupos)',
        que: 'Grupos de documentos cuyo fichero es BYTE A BYTE idéntico. Es el ÚNICO caso en que la política permite borrar: una copia exacta no aporta nada.',
        hacer: 'El botón «Reparar» conserva el mejor de cada grupo (el más completo: verificado, con ISBN, con título real) y recicla el resto. Los tomos de obra y los árboles `ruta_fija` se respetan y no se tocan.',
    },
    {
        clave: 'cuarentenaDuplicados', lista: 'cuarentenaDuplicados', auto: true,
        etiqueta: 'Cuarentena/duplicados',
        que: 'Depósitos a la espera: llegó un fichero con el mismo identificador que uno ya catalogado, pero con contenido DISTINTO. No se decide solo — se guarda.',
        hacer: 'Resolver a mano desde la Cuarentena, o dejar que el botón «Reparar» aplique la política de tamaño/fecha.',
    },
];

/** Una línea «etiqueta ......... valor» alineada a 78 columnas. */
function linea(etiqueta, valor, sello = '') {
    const der = `${valor}${sello ? '  ' + sello : ''}`;
    const puntos = Math.max(3, 60 - etiqueta.length - String(valor).length);
    return `  ${etiqueta} ${'.'.repeat(puntos)} ${der}`;
}

/**
 * Renderiza un elemento de un listado. Los hay de tres formas: ruta suelta, ficha de doc, o grupo.
 * Aquí NO se parten las líneas largas (rutas, nombres de fichero, títulos) aunque se salgan de las 78
 * columnas: una ruta cortada en dos no se puede copiar ni buscar, que es justo para lo que sirve el informe.
 * Solo se envuelve la prosa (el «qué es / qué hacer»), que sí se lee de corrido.
 */
function elemento(x, i) {
    const n = String(i + 1).padStart(4, ' ');
    // 1) Ruta suelta (ramas muertas, huérfanas, registro sin doc, depósitos de cuarentena).
    if (typeof x === 'string') return `${n}. ${x}`;
    // 2) Grupo (varios docs en la misma carpeta / duplicados por hash).
    if (Array.isArray(x.docs)) {
        const cab = x.ruta ? `${n}. carpeta: ${x.ruta}` : `${n}. hash: ${x.hash || '(?)'}`;
        return [cab, ...x.docs.map((d) => '        · ' + resumenDoc(d))].join('\n');
    }
    // 3) Ficha de documento.
    const l = [`${n}. ${x.titulo || '(sin título)'}`];
    const campo = (k, v) => { if (v) l.push(`      ${k.padEnd(9)}${v}`); };
    campo('id', x.id);
    campo('archivo', x.archivo);
    campo('ruta', x.ruta);
    campo('isbn', x.isbn);
    campo('issn', x.issn);
    campo('cdu', x.cdu);
    campo('formatos', (x.formatos || []).join(', '));
    campo('faltan', x.faltan);
    if (x.enDisco) { campo('en disco', x.enDisco); campo('en BD', x.enBD); }
    // Las pistas que faltan, una por línea: sin esto, «faltan 3/12» no sirve para ir a buscarlas.
    if (Array.isArray(x.pistas) && x.pistas.length) {
        l.push('      pistas que faltan:');
        for (const p of x.pistas) l.push(`        · ${p}`);
    }
    return l.join('\n');
}

const resumenDoc = (d) =>
    `${d.titulo || '(sin título)'}  [${d.id}]${d.archivo ? `  ${d.archivo}` : ''}${d.isbn ? `  ISBN ${d.isbn}` : ''}`;

/**
 * Rinde el informe a texto plano.
 * @param {object} informe - lo devuelto por `verificarIntegridad` (CON `detalles`).
 * @param {object} [opts]
 * @param {boolean} [opts.detalle=true] - `false` = solo cabecera + resumen (+ reparado): es lo que se escupe
 *        por consola en el CLI, donde volcar 120.000 líneas al log de una tarea programada no ayuda a nadie.
 *        El panel y el .txt lo piden entero. Un solo renderizador para los dos → no pueden desincronizarse.
 * @returns {string}
 */
export function informeTexto(informe, { detalle = true } = {}) {
    if (!informe) return 'No hay ningún diagnóstico ejecutado todavía.\n';
    const D = informe.diagnostico || {}, T = informe.detalles || {}, R = informe.reparado;
    const fecha = new Date(informe.ts).toLocaleString('es-ES');
    const out = [];

    out.push(DOBLE);
    out.push('  INFORME DE INTEGRIDAD · Gestor Biblioteca');
    out.push(DOBLE);
    out.push(`  Generado    : ${fecha}`);
    out.push(`  Documentos  : ${num(informe.totalDocs)} en el catálogo`);
    out.push(`  Modo        : ${informe.reparar ? 'diagnóstico + REPARACIÓN (lo retirado está en la Papelera)' : 'solo diagnóstico (no se ha tocado nada)'}`);
    out.push('');

    // ── Resumen ──
    out.push(RAYA);
    out.push('  RESUMEN');
    out.push(RAYA);
    let problemas = 0;
    for (const c of CATEGORIAS) {
        const v = D[c.clave] ?? 0;
        problemas += v;
        out.push(linea(c.etiqueta, num(v), v > 0 ? (c.auto ? '[auto]' : '[manual]') : ''));
        // «Sobrantes» no es una categoría propia: es un recuento derivado de los grupos de hash (cuántas copias
        // se reciclarían). Va colgando de SU fila, que suelta al final no se entiende de qué habla.
        if (c.clave === 'hashDuplicadosGrupos' && D.hashDuplicadosDocs)
            out.push(linea('  └ copias sobrantes que se reciclarían', num(D.hashDuplicadosDocs)));
    }
    out.push('');
    out.push(envolver('[auto]  ', 'lo arregla el botón «Diagnosticar y reparar». Todo lo retirado va a la Papelera; nunca se borra.'));
    out.push(envolver('[manual]', 'requiere decidir: abre la ficha del documento y usa Reprocesar / Eliminar.'));
    out.push('');
    if (!problemas) {
        out.push('  ✔ Sin incidencias. El catálogo y el disco están cuadrados.');
        out.push('');
    }

    // ── Reparaciones hechas ──
    if (R) {
        const et = {
            ramasPodadas: 'Ramas podadas',
            rutasReparadas: 'ruta_base reparadas',
            carpetasHuerfanasRecicladas: 'Carpetas huérfanas recicladas',
            hashDuplicadosEliminados: 'Copias exactas eliminadas',
            cuarentenaResueltos: 'Depósitos de Cuarentena resueltos',
        };
        out.push(RAYA);
        out.push('  REPARADO EN ESTA PASADA (todo lo retirado está en la Papelera)');
        out.push(RAYA);
        for (const k of Object.keys(et)) out.push(linea(et[k], num(R[k] ?? 0)));
        out.push('');
    }

    // ── Detalle por categoría ──
    let n = 0;
    if (!detalle) {
        if (problemas) out.push(envolver('', 'Para el detalle de cada caso (qué documento, qué ruta, qué pista falta): descarga el informe desde el panel, o vuelve a lanzar esto con «--informe <ruta.txt>».'));
        out.push('');
        return out.join('\n') + '\n';
    }
    for (const c of CATEGORIAS) {
        const v = D[c.clave] ?? 0;
        if (!v) continue;
        const lista = T[c.lista] || [];
        out.push('');
        out.push(RAYA);
        out.push(`  ${++n}) ${c.etiqueta.toUpperCase()} — ${num(v)} ${v === 1 ? 'caso' : 'casos'}   ${c.auto ? '[auto]' : '[manual]'}`);
        out.push(RAYA);
        out.push(envolver('Qué es   :', c.que));
        out.push(envolver('Qué hacer:', c.hacer));
        out.push('');
        lista.forEach((x, i) => out.push(elemento(x, i)));
        // Si la lista no cuadra con el recuento, se dice. Un informe que disimula un descuadre es justo lo que
        // nos ha costado el día de hoy.
        if (lista.length !== v) out.push(`      (listados ${lista.length} de ${num(v)})`);
    }

    out.push('');
    out.push(DOBLE);
    out.push('  Fin del informe · Gestor de Biblioteca · Integridad');
    out.push(DOBLE);
    return out.join('\n') + '\n';
}

/**
 * Párrafo «Etiqueta: texto» partido a 78 columnas, con la continuación alineada BAJO EL TEXTO (no bajo la
 * etiqueta), que es como se lee de un golpe.
 * La etiqueta se pasa APARTE a propósito: al partir por palabras (`split(/\s+/)`) se colapsa cualquier
 * espacio, así que una etiqueta alineada a mano dentro del texto perdía su alineación por el camino.
 */
function envolver(etiqueta, texto, ancho = 78) {
    const izq = '  ' + etiqueta + ' ';
    const sangria = ' '.repeat(izq.length);
    const libre = ancho - izq.length;
    const lineas = [];
    let act = '';   // línea en curso, todavía SIN prefijo
    for (const p of texto.split(/\s+/).filter(Boolean)) {
        if (act && act.length + 1 + p.length > libre) { lineas.push(act); act = p; }
        else act = act ? `${act} ${p}` : p;
    }
    if (act) lineas.push(act);
    return lineas.map((l, i) => (i === 0 ? izq : sangria) + l).join('\n');
}
