/**
 * INFORME DE INTEGRIDAD — el informe descargable del panel, en DOS formatos que salen del MISMO sitio.
 *
 * El panel enseña una tabla con los recuentos y una muestra de 12 elementos por fila. Eso vale para echar un
 * vistazo, pero no para TRABAJAR: si hay 174 casos, ni los ves todos ni te los puedes llevar.
 *
 *  · `informeHtml` — para TRABAJAR el informe: ramas desplegables (las 160 ramas muertas no te tapan el resto)
 *    y cada documento ENLAZA a su ficha, que es lo que el texto plano no puede hacer.
 *  · `informeTexto` — para ARCHIVARLO: se lee en cualquier parte, se busca con grep y se compara con el del mes
 *    que viene para ver si algo empeora. Un diff de HTML no lo lee nadie.
 *
 * Los dos comen de la MISMA tabla `CATEGORIAS`: qué es cada cosa y qué hacer con ella se escribe UNA vez. Todo
 * el trabajo de estos días ha salido de listas paralelas que se desincronizan; esto no va a ser otra.
 *
 * La decisión de diseño: NO es un volcado del JSON. Un informe que solo dice «rutaBaseDesajustada: 6» obliga a
 * leerse el código para saber si eso es grave. Quien lo abra debe poder actuar sin preguntarle a nadie.
 */

const RAYA = '─'.repeat(78);
const DOBLE = '═'.repeat(78);
const num = (n) => new Intl.NumberFormat('es-ES').format(n || 0);
/** Escape HTML. Los títulos y las rutas vienen de la BD y del disco: pueden traer <, >, & y comillas. */
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
    // Y lo que SÍ hay en la carpeta: si están la portada y los sidecars pero no el pdf, el fichero se perdió;
    // si no hay nada, la carpeta es un cascarón. Eso decide qué hacer, y aquí se ve sin ir al NAS.
    if (Array.isArray(x.contenido)) {
        if (!x.contenido.length) l.push('      hay dentro: nada, la carpeta está vacía');
        else {
            l.push('      hay dentro:');
            for (const c of x.contenido) l.push(`        · ${c}`);
        }
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

// ════════════════════════════════ INFORME EN HTML ════════════════════════════════
// Autocontenido (estilos embebidos, sin red: se abre desde el disco años después y se ve igual) y sin JS: las
// ramas desplegables son <details>/<summary> del propio navegador.

const CSS = `
:root{--bg:#fff;--fg:#1c2027;--mut:#5d6672;--line:#e2e6ec;--card:#f7f9fc;--card2:#eef2f7;--warn:#b3541e;--ok:#1f7a4c;--link:#1a5fb4}
@media (prefers-color-scheme:dark){:root{--bg:#161b22;--fg:#e6e9ef;--mut:#98a2b3;--line:#2b3240;--card:#1c222c;--card2:#232b37;--warn:#e8a33d;--ok:#4ec98a;--link:#7cb0f0}}
*{box-sizing:border-box}
body{margin:0 auto;max-width:1080px;padding:28px 18px 60px;background:var(--bg);color:var(--fg);
     font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
h1{font-size:21px;margin:0 0 4px}
.sub{color:var(--mut);font-size:13px;margin-bottom:22px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:18px}
table{width:100%;border-collapse:collapse;font-size:14px}
td{padding:7px 4px;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:none}
td.n{text-align:right;font-variant-numeric:tabular-nums;font-weight:600;width:80px}
td.s{text-align:center;width:78px}
a{color:var(--link)}
.tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid currentColor;white-space:nowrap}
.tag.auto{color:var(--ok)}.tag.man{color:var(--warn)}
.hay{color:var(--warn)}
details{border:1px solid var(--line);border-radius:10px;margin-bottom:12px;background:var(--card);overflow:hidden}
summary{cursor:pointer;padding:12px 16px;font-weight:600;list-style:none;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
summary::-webkit-details-marker{display:none}
summary::before{content:"▸";color:var(--mut);font-weight:400}
details[open]>summary::before{content:"▾"}
details[open]>summary{border-bottom:1px solid var(--line)}
.body{padding:14px 16px}
.expl{background:var(--card2);border-radius:8px;padding:10px 12px;margin-bottom:14px;font-size:13.5px}
.expl b{color:var(--mut);font-weight:600}
ol.items{margin:0;padding-left:26px}
ol.items>li{margin-bottom:12px}
.campos{color:var(--mut);font-size:12.5px;margin-top:2px}
.campos div{white-space:nowrap;overflow-x:auto}
.mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:12.5px}
.k{display:inline-block;min-width:74px;opacity:.75}
ul.grp{margin:6px 0 0;padding-left:18px;font-size:13.5px}
.pistas{margin:4px 0 0;padding-left:18px}
.pistas li{color:var(--warn)}
.foot{color:var(--mut);font-size:12px;text-align:center;margin-top:30px}
.ok{color:var(--ok);font-weight:600}
`;

/** Un documento: enlace a su ficha (si sabemos la URL del panel) + los campos que lo identifican. */
function docHtml(x, base) {
    const t = escH(x.titulo || '(sin título)');
    const cab = base && x.id ? `<a href="${escH(base)}/?doc=${escH(x.id)}" target="_blank" rel="noopener">${t}</a>` : `<b>${t}</b>`;
    const campo = (k, v) => (v ? `<div><span class="k">${k}</span><span class="mono">${escH(v)}</span></div>` : '');
    const pistas = Array.isArray(x.pistas) && x.pistas.length
        ? `<ul class="pistas mono">${x.pistas.map((p) => `<li>${escH(p)}</li>`).join('')}</ul>` : '';
    // LO QUE SÍ HAY en la carpeta, con cada fichero ENLAZADO. Se enlazan los FICHEROS, no la carpeta: el árbol
    // CDU se sirve estático en /recursos, pero express.static NO lista directorios (eso es serve-index, que no
    // está montado) — y encima /recursos es PÚBLICO, así que activar el listado expondría la biblioteca entera
    // a cualquiera. Un fichero sí se abre en el navegador (pdf/imágenes salen inline).
    let contenido = '';
    if (Array.isArray(x.contenido)) {
        contenido = x.contenido.length
            ? `<div><span class="k">hay dentro</span></div><ul class="grp">${x.contenido.map((c) => {
                const url = base && x.ruta ? encodeURI(`${base}${x.ruta}/${c}`) : null;
                return `<li class="mono">${url ? `<a href="${escH(url)}" target="_blank" rel="noopener">${escH(c)}</a>` : escH(c)}</li>`;
            }).join('')}</ul>`
            : `<div><span class="k">hay dentro</span><span class="mono">nada: la carpeta está vacía</span></div>`;
    }
    return cab + `<div class="campos">`
        + campo('id', x.id) + campo('archivo', x.archivo) + campo('ruta', x.ruta)
        + campo('isbn', x.isbn) + campo('issn', x.issn) + campo('cdu', x.cdu)
        + campo('formatos', (x.formatos || []).join(', ')) + campo('faltan', x.faltan)
        + (x.enDisco ? campo('en disco', x.enDisco) + campo('en BD', x.enBD) : '')
        + pistas + contenido + `</div>`;
}

/** Un elemento del listado, en cualquiera de sus tres formas (ruta suelta · grupo · ficha de documento). */
function elementoHtml(x, base) {
    if (typeof x === 'string') return `<li class="mono">${escH(x)}</li>`;
    if (Array.isArray(x.docs)) {
        const cab = x.ruta ? `<span class="mono">${escH(x.ruta)}</span>` : `<span class="mono">hash ${escH(x.hash || '?')}</span>`;
        return `<li>${cab}<ul class="grp">${x.docs.map((d) => `<li>${docHtml(d, base)}</li>`).join('')}</ul></li>`;
    }
    return `<li>${docHtml(x, base)}</li>`;
}

/**
 * Rinde el informe a una página HTML autocontenida.
 * @param {object} informe - lo devuelto por `verificarIntegridad` (CON `detalles`).
 * @param {object} [opts]
 * @param {string} [opts.base] - URL del panel (p.ej. «http://nas:3000») para enlazar cada documento a su ficha.
 *        Tiene que ser ABSOLUTA: el fichero se descarga y se abre desde el disco, donde un enlace relativo
 *        apuntaría a file:/// y no llevaría a ninguna parte.
 * @returns {string}
 */
export function informeHtml(informe, { base = '' } = {}) {
    if (!informe) return '<!doctype html><meta charset="utf-8"><p>No hay ningún diagnóstico ejecutado todavía.';
    const D = informe.diagnostico || {}, T = informe.detalles || {}, R = informe.reparado;
    const fecha = new Date(informe.ts).toLocaleString('es-ES');
    const h = [];

    h.push('<!doctype html><html lang="es"><head><meta charset="utf-8">');
    h.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
    h.push(`<title>Integridad · ${escH(fecha)}</title><style>${CSS}</style></head><body>`);
    h.push(`<h1>🩺 Informe de integridad</h1>`);
    h.push(`<div class="sub">${escH(fecha)} · ${num(informe.totalDocs)} documentos en el catálogo · `
        + `${informe.reparar ? 'diagnóstico + <b>REPARACIÓN</b> (lo retirado está en la Papelera)' : 'solo diagnóstico (no se ha tocado nada)'}</div>`);

    // ── Resumen: cada fila con casos salta a su sección ──
    let problemas = 0;
    const filas = [];
    for (const c of CATEGORIAS) {
        const v = D[c.clave] ?? 0;
        problemas += v;
        const et = v > 0 ? `<a href="#c-${c.clave}">${escH(c.etiqueta)}</a>` : escH(c.etiqueta);
        const sello = v > 0 ? `<span class="tag ${c.auto ? 'auto' : 'man'}">${c.auto ? 'auto' : 'manual'}</span>` : '';
        filas.push(`<tr><td>${et}</td><td class="s">${sello}</td><td class="n ${v > 0 ? 'hay' : ''}">${num(v)}</td></tr>`);
        if (c.clave === 'hashDuplicadosGrupos' && D.hashDuplicadosDocs)
            filas.push(`<tr><td style="padding-left:18px;color:var(--mut)">└ copias sobrantes que se reciclarían</td><td></td><td class="n">${num(D.hashDuplicadosDocs)}</td></tr>`);
    }
    h.push(`<div class="card"><table>${filas.join('')}</table>`);
    h.push('<div class="sub" style="margin:12px 0 0;font-size:12px">'
        + '<span class="tag auto">auto</span> lo arregla el botón «Diagnosticar y reparar»; todo lo retirado va a la Papelera, nunca se borra. '
        + '<span class="tag man">manual</span> requiere decidir: abre la ficha del documento y usa Reprocesar / Eliminar.</div>');
    if (!problemas) h.push('<p class="ok">✔ Sin incidencias. El catálogo y el disco están cuadrados.</p>');
    h.push('</div>');

    // ── Reparaciones hechas ──
    if (R) {
        const et = {
            ramasPodadas: 'Ramas podadas', rutasReparadas: 'ruta_base reparadas',
            carpetasHuerfanasRecicladas: 'Carpetas huérfanas recicladas',
            hashDuplicadosEliminados: 'Copias exactas eliminadas',
            cuarentenaResueltos: 'Depósitos de Cuarentena resueltos',
        };
        h.push('<div class="card"><b>🛠 Reparado en esta pasada</b> <span class="sub">(todo lo retirado está en la Papelera)</span><table style="margin-top:8px">');
        for (const k of Object.keys(et)) h.push(`<tr><td>${escH(et[k])}</td><td class="n">${num(R[k] ?? 0)}</td></tr>`);
        h.push('</table></div>');
    }

    // ── Detalle por categoría, cada una en su rama desplegable ──
    let n = 0;
    for (const c of CATEGORIAS) {
        const v = D[c.clave] ?? 0;
        if (!v) continue;
        const lista = T[c.lista] || [];
        // Las listas cortas se abren solas; las largas (160 ramas muertas) van plegadas para que la página no
        // sea un muro y se pueda ojear el conjunto de un vistazo.
        const abierta = lista.length <= LIMITE_ABIERTA ? ' open' : '';
        h.push(`<details id="c-${c.clave}"${abierta}><summary>${++n}) ${escH(c.etiqueta)} — ${num(v)} ${v === 1 ? 'caso' : 'casos'}`
            + ` <span class="tag ${c.auto ? 'auto' : 'man'}">${c.auto ? 'auto' : 'manual'}</span></summary><div class="body">`);
        h.push(`<div class="expl"><b>Qué es:</b> ${escH(c.que)}<br><b>Qué hacer:</b> ${escH(c.hacer)}</div>`);
        h.push(`<ol class="items">${lista.map((x) => elementoHtml(x, base)).join('')}</ol>`);
        if (lista.length !== v) h.push(`<div class="sub">(listados ${lista.length} de ${num(v)})</div>`);
        h.push('</div></details>');
    }

    h.push('<div class="foot">Gestor de Biblioteca · Integridad</div></body></html>');
    return h.join('\n');
}

/** A partir de cuántos elementos una rama nace PLEGADA (por debajo se abre sola). */
const LIMITE_ABIERTA = 30;

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
