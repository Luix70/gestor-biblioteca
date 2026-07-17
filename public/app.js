// ═══════════════════════════════════════════════════════════════════════════════════════════════════════
//  Bibliotheca Ludoviciana — Panel web (PWA). TODO el front-end vive en este archivo. Es un script CLÁSICO
//  (NO un módulo): se carga con <script src> y muchas de sus funciones se referencian desde onclick="…" en
//  index.html y desde las plantillas HTML que se generan aquí. POR ESO los nombres GLOBALES (funciones y
//  const/let de nivel superior) NO deben renombrarse sin actualizar TODAS sus referencias (app.js + index.html).
//
//  Idiomas usados por todo el archivo (memorízalos y el resto se lee solo):
//    $(sel)          → primer elemento que casa el selector CSS      (document.querySelector)
//    $$(sel)         → array con TODOS los que casan                 (querySelectorAll → array)
//    api(ruta,opts)  → fetch a /api con el token; devuelve el JSON o lanza Error(motivo)
//    esc(txt)        → escapa &<>" para incrustar datos en HTML sin inyección
//    encUrl(ruta)    → %-codifica una ruta /recursos por segmentos
//    toast(msg,tipo) → aviso efímero: tipo 'ok' (verde) | 'bad' (rojo) | 'warn' (ámbar)
//
//  Mapa de regiones (busca los banners «── … ──»): nav · dashboard · obras/colecciones · ficha/detalle ·
//    búsqueda y catálogo · logs · integridad · inbox · NFC · tapete/visión (CV) · editor de imágenes ·
//    ubicaciones · auth · arranque.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════

// Atajos de selección del DOM (estilo jQuery). $ = el primero; $$ = todos, ya como array real.
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

// Marca de versión del front: se imprime en consola al cargar para comprobar que el despliegue trae lo último.
const APP_BUILD = 'ordenar libros (posición+NFC) + reordenar estanterías (↑/↓/arrastrar) · 2026-07-01';
try {
  console.log('%c📚 Bibliotheca build: ' + APP_BUILD, 'color:#28d9a8;font-weight:700');
} catch (_) {}

// ── Estado global de sesión y de algunas vistas ──────────────────────────────────────────────────────
let TOKEN = localStorage.getItem('panel_token') || ''; // token HMAC de sesión (persiste en el navegador)
let ROL = null; // rol tras el login: 'admin' | 'guest'
let USER = null; // nombre del usuario autenticado
let detalle = null; // vista de detalle abierta: { tipo:'obra'|'doc', id, ctx? } · null = ninguna
let FUENTES = [],
  sanCtx = null; // «buscar copia» (fuentes cacheadas) + depósito de saneamiento en curso
let sanSel = new Set(),
  sanPoll = null; // ids marcados para procesar por lotes + timer de sondeo de progreso
let APP_OFFLINE = false; // arranque sin red: solo lectura NFC; silencia el ruido de errores de servidor

// Llama a la API REST del panel (/api…). Pone el token, normaliza errores y devuelve el JSON ya parseado.
// Lanza Error(motivo) si la respuesta no es OK; si no hay red, un Error con .sinRed=true (para silenciarlo offline).
const api = async (ruta, opciones = {}) => {
  const cabeceras = { 'Content-Type': 'application/json', ...(opciones.headers || {}) };
  if (TOKEN) cabeceras['Authorization'] = 'Bearer ' + TOKEN;
  let resp;
  try {
    resp = await fetch('/api' + ruta, { ...opciones, headers: cabeceras });
  } catch (_) {
    const err = new Error('Sin conexión con el servidor');
    err.sinRed = true;
    throw err;
  }
  if (resp.status === 401) {
    mostrarLogin();
    throw new Error('Sesión caducada — vuelve a entrar');
  }
  const texto = await resp.text();
  let json;
  try {
    json = texto ? JSON.parse(texto) : {};
  } catch {
    json = { raw: texto };
  }
  if (!resp.ok) throw new Error(json.motivo || json.message || resp.status);
  return json;
};

// Formatea un tamaño en bytes → B/KB/MB/… (1 decimal salvo para bytes enteros).
const fmtBytes = (bytes) => {
  if (!bytes) return '0 B';
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
  const exponente = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, exponente)).toFixed(exponente ? 1 : 0) + ' ' + unidades[exponente];
};

// Aviso efímero (esquina). tipo: 'ok' (verde, por defecto) | 'bad' (rojo) | 'warn' (ámbar).
const toast = (mensaje, tipo = 'ok') => {
  // En modo sin conexión se silencian los errores de red (todo lo de servidor falla): evita el ruido.
  if (
    APP_OFFLINE &&
    tipo === 'bad' &&
    /sin conexi|failed to fetch|networkerror|load failed/i.test(String(mensaje))
  )
    return;
  const el = document.createElement('div');
  el.className = 'toast ' + (tipo === 'ok' ? '' : tipo);
  el.textContent = mensaje;
  $('#toast').append(el);
  setTimeout(() => el.remove(), 3800);
};

// ── Sonidos cortos con WebAudio (sin ficheros → funcionan offline en la PWA). Se necesita un gesto del
// usuario para arrancar el AudioContext; captura/NFC ocurren tras una interacción, así que es válido. ──
let _audioCtx = null;
function _tono({ freq = 880, dur = 0.12, tipo = 'sine', vol = 0.18, hasta = null, retardo = 0 } = {}) {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = _audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const t0 = ctx.currentTime + retardo;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = tipo; o.frequency.setValueAtTime(freq, t0);
    if (hasta) o.frequency.exponentialRampToValueAtTime(hasta, t0 + dur);
    g.gain.setValueAtTime(vol, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g); g.connect(ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.02);
  } catch (_) {}
}
const sonidoCaptura = () => _tono({ freq: 1180, hasta: 1500, dur: 0.06, tipo: 'square', vol: 0.14 }); // «click» agudo de disparo
const sonidoNfcLectura = () => _tono({ freq: 920, dur: 0.11, tipo: 'sine', vol: 0.2 });                // lectura: un tono
const sonidoNfcEscritura = () => { _tono({ freq: 620, dur: 0.09, vol: 0.2 }); _tono({ freq: 990, dur: 0.14, vol: 0.2, retardo: 0.1 }); }; // escritura: dos tonos ascendentes

// ── Modelo de interacción unificado de las listas (Catálogo, obras, colecciones, autores, ubicaciones) ──
// Clic/toque simple = acción PRINCIPAL (abrir la ficha). Doble clic (PC) o pulsación larga (móvil) =
// CONMUTAR el modo selección (sin perder lo seleccionado). Además del botón «Modo selección» y del realce
// de las tarjetas, un indicador de modo (pastilla inferior) avisa en qué modo estamos.
function setModoVisual(activo) {
  document.body.classList.toggle('modo-seleccion', !!activo);
}
// Controles internos de una tarjeta que NO deben disparar el gesto (estrellas, badges, enlaces, botones).
const _ES_CTRL_TARJETA = 'a,button,input,select,textarea,label,.ratebar,.stars,.st,.rclear,.rnsfw,.nfctag';
// Adjunta a `el` el gesto unificado: onTap (toque/clic corto) y onModo (doble clic / pulsación larga).
// No añade latencia en móvil (usa touchend directo); en PC distingue clic simple de doble con un pequeño
// retardo. Ignora los toques que nacen sobre un control interno de la tarjeta.
function attachGesto(el, onTap, onModo) {
  let lpTimer = null, lp = false, movido = false, ctrl = false, sx = 0, sy = 0, tocado = false;
  el.addEventListener('touchstart', (e) => {
    tocado = true; lp = false; movido = false;
    ctrl = !!(e.target.closest && e.target.closest(_ES_CTRL_TARJETA));
    if (ctrl) return;
    const t = e.touches && e.touches[0]; sx = t ? t.clientX : 0; sy = t ? t.clientY : 0;
    lpTimer = setTimeout(() => { lp = true; try { navigator.vibrate && navigator.vibrate(25); } catch (_) {} onModo(); }, 500);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const t = e.touches && e.touches[0];
    if (t && (Math.abs(t.clientX - sx) > 10 || Math.abs(t.clientY - sy) > 10)) { movido = true; clearTimeout(lpTimer); }
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    clearTimeout(lpTimer);
    if (ctrl) return;                          // el toque fue sobre un control interno
    if (lp) { lp = false; e.preventDefault(); return; }   // fue pulsación larga
    if (movido) { movido = false; return; }    // fue scroll
    e.preventDefault();                         // evita el click sintético posterior
    onTap();
  });
  let clickTimer = null;
  el.addEventListener('click', (e) => {
    if (tocado) { tocado = false; return; }     // el touch ya lo gestionó
    if (e.target.closest && e.target.closest(_ES_CTRL_TARJETA)) return;
    if (clickTimer) return;                     // el 2º clic lo captura dblclick
    clickTimer = setTimeout(() => { clickTimer = null; onTap(); }, 220);
  });
  el.addEventListener('dblclick', (e) => {
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
    if (e.target.closest && e.target.closest(_ES_CTRL_TARJETA)) return;
    e.preventDefault();
    onModo();
  });
  // Evita el menú contextual nativo (copiar/descargar imagen…) que Android/desktop abren con la pulsación
  // larga / clic derecho sobre la tarjeta: aquí ese gesto es NUESTRO (conmutar modo selección).
  el.addEventListener('contextmenu', (e) => { if (!(e.target.closest && e.target.closest(_ES_CTRL_TARJETA))) e.preventDefault(); });
}

// Escapa &<>" para incrustar texto de datos dentro de HTML generado (evita inyección y roturas de marcado).
const esc = (txt) =>
  String(txt ?? '').replace(
    /[&<>"]/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch],
  );

// %-codifica una ruta /recursos por SEGMENTOS (mantiene las '/'): así una URL con '#', '%', espacios o
// acentos en la carpeta no se rompe (el navegador trunca en '#'); Express la des-codifica y casa el fichero.
const encUrl = (ruta) =>
  String(ruta || '')
    .split('/')
    .map(encodeURIComponent)
    .join('/');

// Copia al portapapeles con respaldo (la API clipboard exige contexto seguro; en LAN/http no está disponible).
function copiar(texto) {
  const avisarOk = () => toast('Copiado al portapapeles');
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard
      .writeText(texto)
      .then(avisarOk)
      .catch(() => copiarFallback(texto, avisarOk));
  else copiarFallback(texto, avisarOk);
}
function copiarFallback(texto, avisarOk) {
  const ta = document.createElement('textarea');
  ta.value = texto;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    avisarOk();
  } catch {
    toast('No se pudo copiar', 'bad');
  }
  document.body.removeChild(ta);
}

// ── nav (navegación entre las páginas del panel) ─────────────────────────────────────────────────────
// Título de la barra superior según la página activa.
// Etiquetas de las páginas. Los IDs internos (`inbox`, `activity`) se mantienen a propósito: renombrarlos
// obligaría a tocar deep-links, `loaders`, el historial de vistas y decenas de `go(...)` sin ganar nada.
const titles = {
  dashboard: 'Dashboard',
  activity: 'Mantenimiento',
  cuar: 'Cuarentena',
  pap: 'Papelera',
  obras: 'Obras',
  colecciones: 'Colecciones',
  autores: 'Autores',
  editoriales: 'Editoriales',
  inbox: 'Entrada',
  search: 'Catálogo',
};
let logTimer = null; // intervalo de refresco de los logs en vivo (solo activo en la página Actividad)

// Cambia de página: marca el botón de nav, muestra su <section>, ajusta el título, carga sus datos
// (loaders[pagina]) y apila la vista en el historial (para el botón atrás del móvil).
function go(pagina) {
  detalle = null;
  setModoVisual(false); // al cambiar de página se apaga el indicador; cada lista lo re-aplica si procede
  $$('#nav button').forEach((boton) => boton.classList.toggle('on', boton.dataset.p === pagina));
  $$('.page').forEach((seccion) => seccion.classList.remove('on'));
  $('#p-' + pagina).classList.add('on');
  $('#title').textContent = titles[pagina] || pagina;
  // LOGS al final de ENTRADA y de MANTENIMIENTO: en las dos quieres ver qué está haciendo el sistema (qué
  // cataloga el vigilante / qué hace el Conformador). La tarjeta es ÚNICA y se MUEVE a la página activa —
  // duplicarla habría repetido ids (#logView, #logAuto…) y roto el visor. En el resto de páginas se para el
  // temporizador: nadie está mirando.
  const conLogs = pagina === 'inbox' || pagina === 'activity';
  const card = $('#logCard');
  if (conLogs && card) {
    $('#p-' + pagina).appendChild(card);   // appendChild MUEVE el nodo (no lo copia): conserva sus handlers
    logAuto();                             // (si hay tarjeta, están sus controles: #logAuto, #logView…)
  } else if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('open');
  loaders[pagina] && loaders[pagina]();
  apilarVista({ v: 'page', p: pagina });
}
$('#nav').onclick = (ev) => {
  const boton = ev.target.closest('button[data-p]');
  if (boton && !boton.disabled) go(boton.dataset.p);
};
$('#burger').onclick = () => {
  $('#sidebar').classList.toggle('open');
  $('#scrim').classList.toggle('open');
};
$('#scrim').onclick = () => {
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('open');
};
// Botón «recargar»: si hay ficha/obra/colección abierta, la re-abre (sin apilar); si no, recarga la página actual.
$('#refresh').onclick = () => {
  if (detalle) {
    const det = detalle;
    _supNav = true;
    try {
      det.tipo === 'obra'
        ? verObra(det.id)
        : det.tipo === 'coleccion'
          ? verColeccion(det.id)
          : verDoc(det.id, det.ctx);
    } finally {
      _supNav = false;
    }
    refrescarEstado();
    return;
  }
  const paginaActual = $$('#nav button.on')[0]?.dataset.p || 'dashboard';
  loaders[paginaActual] && loaders[paginaActual]();
  refrescarEstado();
};
setInterval(() => ($('#clock').textContent = new Date().toLocaleTimeString('es-ES')), 1000);

// Versión desplegada en el pie del menú («v1.<serie>»), para saber de un vistazo qué build corre tras un
// despliegue sin adivinar. Es pública (sin auth) → se pide al cargar, incluso antes del login. El tooltip
// muestra el commit/rama por si hace falta el detalle. Degrada en silencio si el endpoint no responde.
(async () => {
  try {
    const r = await fetch('/api/version');
    if (!r.ok) return;
    const v = await r.json();
    const el = $('#appVer');
    if (el && v && v.etiqueta) {
      el.textContent = v.etiqueta;
      el.title = `Versión desplegada: ${v.etiqueta}${v.commit ? ` · commit ${v.commit}` : ''}${v.rama ? ` (${v.rama})` : ''}`;
    }
  } catch (_) {
    /* sin red / endpoint viejo: se queda el «v1» por defecto */
  }
})();

// ── Historial de navegación (clave en móvil): el botón ATRÁS del navegador/sistema navega DENTRO de la
//    app (entre pantallas visitadas) y, al llegar a la raíz, pide confirmación (doble-atrás) en vez de
//    salir y perderlo todo. Cada go()/verDoc/verObra/verColeccion apila una entrada (history.pushState);
//    popstate la reconstruye. Se inicia en arrancar() tras el login.
//    `_supNav` (suprimir-navegación) evita apilar cuando somos NOSOTROS quienes reconstruimos una vista. ──
let _supNav = false,
  _salirArmado = false,
  _salirT = null;
function apilarVista(estado) {
  if (_supNav) return;
  try {
    history.pushState(estado, '');
  } catch {
    /* navegador sin history */
  }
}
// Instantánea de la vista actual (página o ficha) para re-apilarla en el "guard" de salida.
function _estadoActual() {
  if (detalle) return { v: 'det', tipo: detalle.tipo, id: detalle.id, ctx: detalle.ctx };
  return { v: 'page', p: $$('#nav button.on')[0]?.dataset.p || 'search' };
}
// Reconstruye una vista a partir de un estado del historial (al pulsar atrás/adelante).
function _renderEstado(estado) {
  _supNav = true;
  try {
    if (!estado || estado.v === 'page') go((estado && estado.p) || 'search');
    else if (estado.v === 'det') {
      if (estado.tipo === 'obra') verObra(estado.id);
      else if (estado.tipo === 'coleccion') verColeccion(estado.id);
      else verDoc(estado.id, estado.ctx);
    }
  } finally {
    _supNav = false;
  }
}
function volverAtras() {
  history.back();
} // los botones «←» internos usan el historial
// Al llegar a la raíz (entrada "guard"): primer atrás avisa; el segundo en <2,5 s sale de verdad.
function _intentarSalir() {
  if (_salirArmado) {
    _salirArmado = false;
    history.back();
    return;
  } // 2º «atrás» seguido → salir de verdad
  _salirArmado = true;
  toast('Pulsa «atrás» otra vez para salir');
  _supNav = true;
  try {
    history.pushState(_estadoActual(), '');
  } finally {
    _supNav = false;
  } // re-atrapar: seguir dentro
  clearTimeout(_salirT);
  _salirT = setTimeout(() => (_salirArmado = false), 2500);
}
window.addEventListener('popstate', (ev) => {
  const estado = ev.state;
  if (estado && estado.guard) return _intentarSalir();
  _renderEstado(estado);
});
function iniciarHistorial() {
  try {
    history.replaceState({ guard: true }, '');
  } catch {
    /* navegador sin history */
  }
}

// ── estado (indicadores «pill» de la barra superior + panel de la página Actividad) ──────────────────
// Refresca los puntos de estado (vigilante del Inbox / mantenimiento) y la tabla de estado del Conformador.
async function refrescarEstado() {
  try {
    const estado = await api('/estado');
    const vigilanteActivo = estado.vigilante.activo,
      vigilanteProcesando = estado.vigilante.procesando;
    $('#dVig').className = 'dot ' + (vigilanteProcesando ? 'busy' : vigilanteActivo ? 'ok' : 'off');
    const mantManual = estado.conformador.mantenimientoManual,
      modo = estado.conformador.modo;
    $('#dMant').className = 'dot ' + (mantManual ? 'busy' : modo === 'diferido' ? 'ok' : ''); // apagado = neutral, no rojo
    // Página Vigilante
    $('#vSwitch').checked = vigilanteActivo;
    $('#vLabel').textContent = vigilanteActivo ? 'Activo' : 'Pausado';
    $('#vSub').textContent = vigilanteProcesando
      ? 'procesando el Inbox…'
      : vigilanteActivo
        ? 'observando el Inbox'
        : 'los ficheros esperan en el Inbox';
    // Estado del Conformador: "Estado" = indicador en vivo; "Modo" = ajuste (manual/automático), no un error.
    const modoTxt =
      modo === 'diferido' ? 'Automático (al reposo)' : modo === 'apagado' ? 'Manual (a demanda)' : modo;
    $('#mEstado').innerHTML = `<table>
     <tr><td>Estado</td><td><span class="tag ${mantManual ? 'warn' : 'mut'}">${mantManual ? 'ejecutándose…' : 'en reposo'}</span></td></tr>
     <tr><td>Modo</td><td><span class="tag ${modo === 'diferido' ? 'ok' : 'mut'}">${modoTxt}</span></td></tr>
     <tr><td>Última revisión</td><td class="muted">${estado.conformador.ultimaRevision ? new Date(estado.conformador.ultimaRevision).toLocaleString('es-ES') : '—'}</td></tr></table>`;
  } catch (e) {}
}

// ── dashboard (portada: cifras clave, tablas de anomalías/defectos, top de CDU y gráfico de ingesta) ──
async function loadDashboard() {
  // 1) Estadísticas: tarjetas de totales + tablas «necesita atención» y «defectos» + top de CDU.
  try {
    const stats = await api('/estadisticas?detalle=1');
    // Tarjetas de cabecera: [icono, valor, etiqueta, claseExtra].
    const tarjetas = [
      ['📚', stats.total, 'Documentos', 'acc'],
      ['📖', stats.libros, 'Libros', ''],
      ['📰', stats.revistas_total, 'Revistas (números)', ''],
      ['🗂', stats.colecciones, 'Colecciones', ''],
    ];
    $('#stats').innerHTML = tarjetas
      .map(
        ([icono, valor, etiqueta, clase]) =>
          `<div class="stat ${clase}"><div class="ic">${icono}</div><div class="v">${(valor ?? 0).toLocaleString('es-ES')}</div><div class="k">${etiqueta}</div></div>`,
      )
      .join('');
    const anom = stats.anomalias || {},
      def = stats.defectos || {};
    // Cada fila (rowN) es un contador clicable → abre la Búsqueda con ese subconjunto (filtrarCatalogo).
    $('#aten').innerHTML = `<table>
      ${rowN('Obras incompletas', anom.obras_incompletas, 'warn', 'obras_incompletas', 'Tomos de obras incompletas')}
      ${rowN('Obras a revisar', anom.obras_revision, anom.obras_revision ? 'bad' : 'ok', 'obras_revision', 'Tomos de obras a revisar')}
      ${rowN('Tomos sin número (?)', anom.tomos_sin_numero, anom.tomos_sin_numero ? 'bad' : 'ok', 'tomos_sin_numero', 'Tomos sin número')}
      ${rowN('Docs a revisar', anom.docs_revision, anom.docs_revision ? 'bad' : 'ok', 'revision', 'Documentos a revisar')}</table>`;
    $('#defs').innerHTML = `<table>
      ${rowN('Libros sin ISBN', def.libros_sin_isbn, 'mut', 'sin_isbn', 'Libros sin ISBN')}${rowN('Libros sin autor', def.libros_sin_autor, def.libros_sin_autor ? 'warn' : 'ok', 'sin_autor', 'Libros sin autor')}
      ${rowN('Sin hash', def.sin_hash, 'mut', 'sin_hash', 'Sin hash')}${rowN('Sin portada', def.sin_portada, 'mut', 'sin_portada', 'Sin portada')}
      ${rowN('CDU genérica', def.cdu_generica, 'mut', 'cdu_generica', 'CDU genérica')}${rowN('Pendientes', def.pendientes, def.pendientes ? 'warn' : 'ok', 'pendientes', 'Pendientes')}
      ${rowN('Sin colección', def.sin_coleccion, 'mut', 'sin_coleccion', 'Sin colección')}</table>`;
    $$('#aten [data-filtro],#defs [data-filtro]').forEach(
      (el) => (el.onclick = () => filtrarCatalogo(el.dataset.filtro, el.dataset.etq)),
    );
    // Top 100 de CDU con más documentos (tabla de clasificaciones clicable).
    const topCdu = (stats.cdu?.detalle || [])
      .filter((c) => c.cdu && c.cdu !== 'sin_cdu')
      .slice(0, 100)
      .map((c) => ({ sistema: 'cdu', codigo: c.cdu, titulo: c.titulo_es, n: c.documentos }));
    $('#cdus').innerHTML = topCdu.length
      ? `<div style="max-height:340px;overflow:auto"><table class="clastab">${topCdu.map((clas) => filaClas(clas, true)).join('')}</table></div>`
      : '<div class="empty">—</div>';
    attachClas('#cdus');
  } catch (e) {
    toast('Estadísticas: ' + e.message, 'bad');
  }
  // 2) Gráfico de barras: documentos ingestados por día (últimos 30). Cada barra abre ese día en la Búsqueda.
  try {
    const ingesta = await api('/ingesta?dias=30');
    const maxDia = Math.max(1, ...ingesta.serie.map((d) => d.n));
    $('#chart').innerHTML = ingesta.serie.length
      ? ingesta.serie
          .map(
            (d) =>
              `<div class="bar" data-dia="${esc(d.dia)}" title="Ver ${d.n} ingestado(s) el ${esc(d.dia)}" style="height:${Math.round((d.n / maxDia) * 100)}%;cursor:pointer"><span>${d.dia.slice(5)}: ${d.n}</span></div>`,
          )
          .join('')
      : '<div class="empty" style="margin:auto">Sin ingesta reciente</div>';
    $$('#chart .bar[data-dia]').forEach((barra) => (barra.onclick = () => filtrarPorDia(barra.dataset.dia)));
  } catch (e) {}
}
// Fila de conteo del dashboard: etiqueta + número con color (tag). Si hay filtro y el valor > 0, el número
// es un enlace que abre la Búsqueda con esos documentos.
const rowN = (etiqueta, valor, colorTag, filtro, etqFiltro) => {
  const n = valor ?? 0;
  const badge = `<span class="tag ${colorTag}">${n}</span>`;
  const celda =
    n > 0 && filtro
      ? `<a class="cntclas" data-filtro="${esc(filtro)}" data-etq="${esc(etqFiltro || filtro)}" title="Ver estos documentos en el Catálogo">${badge}</a>`
      : badge;
  return `<tr><td>${etiqueta}</td><td style="text-align:right">${celda}</td></tr>`;
};

// ── mantenimiento (Conformador): programar/detener desde la página Actividad ─────────────────────────
// Programa el mantenimiento con el modo (activar) e intervalo elegidos en los <select>.
$('#mStart').onclick = async () => {
  try {
    const resp = await api('/mantenimiento', {
      method: 'POST',
      body: JSON.stringify({ activar: +$('#mActivar').value, intervalo: +$('#mIntervalo').value }),
    });
    toast(resp.mensaje || 'Mantenimiento programado');
    refrescarEstado();
  } catch (e) {
    toast(e.message, 'bad');
  }
};
// Detiene el mantenimiento automático (modo 'apagado' = solo a demanda).
$('#mStop').onclick = async () => {
  try {
    await api('/mantenimiento/modo', { method: 'POST', body: JSON.stringify({ modo: 'apagado' }) });
    toast('Mantenimiento detenido', 'warn');
    refrescarEstado();
  } catch (e) {
    toast(e.message, 'bad');
  }
};

// ── vigilante del Inbox: interruptor activar/pausar ──────────────────────────────────────────────────
$('#vSwitch').onchange = async (ev) => {
  try {
    const resp = await api('/vigilante', {
      method: 'POST',
      body: JSON.stringify({ activo: ev.target.checked }),
    });
    toast('Vigilante ' + (resp.activo ? 'activado' : 'pausado'), resp.activo ? 'ok' : 'warn');
    refrescarEstado();
  } catch (err) {
    toast(err.message, 'bad');
  }
};

// ── cuarentena ──
// Consulta de búsqueda: limpia serializaciones (Epublibre [id]/(rN), marcas de fuente, hashes de
// descarga) y normaliza separadores → "Autor Título" buscable.
const consultaCopia = (d) => {
  let s = d.titulo || (d.archivos && d.archivos[0]) || d.nombre || '';
  s = s.replace(/\.[a-z0-9]{2,4}$/i, ''); // extensión
  s = s.replace(/\[[^\]]*\]/g, ' '); // [81401] (ids/brackets)
  s = s.replace(/\((?:r|v)\d[\w.]*\)/gi, ' '); // (r1.0)/(v2) revisiones
  s = s.replace(/\((?:z-?lib|annas?[\s-]?archive|libgen)[^)]*\)/gi, ' '); // marcas de fuente
  s = s.replace(/\b[0-9a-f]{16,}\b/gi, ' '); // hashes de descarga
  s = s.replace(/[_,–—-]+/g, ' '); // separadores → espacio
  return s.replace(/\s+/g, ' ').trim();
};
// Pliegue de categorías de Cuarentena, persistido en localStorage (qué categorías quedan colapsadas).
const foldGet = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem('cuarFold') || '[]'));
  } catch {
    return new Set();
  }
};
const foldSet = (plegadas) => {
  try {
    localStorage.setItem('cuarFold', JSON.stringify([...plegadas]));
  } catch {}
};
// Sincroniza la casilla «todas» (master) de una tarjeta según cuántas de sus filas estén marcadas.
function sincMaster(card) {
  const master = card && card.querySelector('[data-selall]');
  if (!master) return;
  const casillas = [...card.querySelectorAll('[data-sel]')],
    marcadas = casillas.filter((cb) => cb.checked).length;
  master.checked = marcadas > 0 && marcadas === casillas.length;
  master.indeterminate = marcadas > 0 && marcadas < casillas.length;
}
// Modal de confirmación con contraseña ENMASCARADA (reutiliza el overlay del comparador).
// Resuelve con la contraseña escrita, o null si se cancela.
function modalPassword({ titulo, aviso }) {
  return new Promise((resolver) => {
    $('#cmpModal').innerHTML = `<div class="box card" style="max-width:420px">
    <h3 style="margin-top:0">${titulo}</h3>
    <div class="muted" style="margin:-4px 0 14px">${aviso}</div>
    <label>Contraseña de administrador</label>
    <input type="password" id="pwInput" autocomplete="current-password">
    <div id="pwErr" style="color:var(--bad);font-size:12px;min-height:15px;margin-top:6px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
      <button class="btn" id="pwCancel">Cancelar</button><button class="btn bad" id="pwOk">🗑 Eliminar</button>
    </div></div>`;
    $('#cmpScrim').style.display = 'block';
    $('#cmpModal').style.display = 'grid';
    const input = $('#pwInput');
    setTimeout(() => input.focus(), 30);
    const cerrarCon = (valor) => {
      cerrarCmp();
      resolver(valor);
    };
    $('#pwCancel').onclick = () => cerrarCon(null);
    $('#cmpScrim').onclick = () => cerrarCon(null);
    $('#pwOk').onclick = () => {
      if (!input.value) {
        $('#pwErr').textContent = 'Escribe la contraseña';
        input.focus();
        return;
      }
      cerrarCon(input.value);
    };
    input.onkeydown = (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        $('#pwOk').click();
      } else if (ev.key === 'Escape') cerrarCon(null);
    };
  });
}
// Sube una copia sana y la PREPARA (no cataloga aún) en el depósito (multipart; usa fetch propio por el FormData).
async function prepararCopia(id, file) {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('id', id);
  const cabeceras = {};
  if (TOKEN) cabeceras['Authorization'] = 'Bearer ' + TOKEN;
  const resp = await fetch('/api/saneamiento/reemplazar', {
    method: 'POST',
    headers: cabeceras,
    body: formData,
  });
  if (resp.status === 401) {
    mostrarLogin();
    throw new Error('Sesión caducada — vuelve a entrar');
  }
  const texto = await resp.text();
  let json;
  try {
    json = texto ? JSON.parse(texto) : {};
  } catch {
    json = { raw: texto };
  }
  if (!resp.ok && !json.motivo) throw new Error(json.message || resp.status);
  return json;
}
// Muestra/oculta el botón «Procesar seleccionados (N)» del saneamiento por lotes según la selección actual.
function actualizarBotonLote() {
  const nSel = sanSel.size,
    boton = $('#sanProcesar');
  if (!boton) return;
  boton.style.display = nSel ? 'inline-flex' : 'none';
  boton.textContent = `▶ Procesar seleccionados (${nSel})`;
}
// Página Cuarentena: pinta cada categoría de depósitos (no-identificados/ilegibles/duplicados…) como una
// tarjeta plegable con sus filas (título, estado, acciones: reingestar/comparar/reemplazar/procesar/descartar)
// y cablea todos sus botones. Reutiliza consultaCopia() para el enlace «buscar copia». (Función de render larga;
// el gran literal HTML se deja tal cual a propósito para no arriesgar su marcado.)
async function loadCuar() {
  try {
    if (!FUENTES.length) {
      try {
        FUENTES = (await api('/saneamiento/fuentes')).fuentes || [];
      } catch {}
    }
    const c = await api('/cuarentena');
    const cats = Object.keys(c);
    const fold = foldGet();
    const listosIds = new Set();
    cats.forEach((k) =>
      c[k].forEach((d) => {
        if (d.listo) listosIds.add(d.id);
      }),
    );
    sanSel = new Set([...sanSel].filter((id) => listosIds.has(id)));
    $('#cuarCount').textContent = cats.reduce((s, k) => s + c[k].length, 0) + ' depósito(s)';
    $('#cuarBody').innerHTML = cats.length
      ? cats
          .map((cat) => {
            const dup = cat === 'duplicados',
              col = fold.has(cat);
            const listas = c[cat].filter((d) => d.listo);
            const master = listas.length
              ? `<label class="masterchk admin-only" title="Seleccionar/quitar todas las listas"><input type="checkbox" data-selall="${esc(cat)}" ${listas.every((d) => sanSel.has(d.id)) ? 'checked' : ''}> todas</label>`
              : '';
            const dcat = `<span style="margin-left:auto;display:flex;gap:8px">${dup ? `<button class="btn admin-only" id="reproAllDup">♻ Reprocesar todos</button>` : ''}<button class="btn bad admin-only" data-desccat="${esc(cat)}" title="Eliminar TODA la categoría → Papelera (pide contraseña)">🗑 categoría</button></span>`;
            return `<div class="card" style="margin-bottom:14px">
      <h3 class="cuar-head${col ? ' col' : ''}" data-fold="${esc(cat)}"><span class="fold-tri">▾</span><span>${esc(cat)} · ${c[cat].length}</span>${cat === 'ilegibles' ? ` <span class="muted" style="font-weight:400;font-size:11px;text-transform:none;letter-spacing:0">· sube copia sana → «lista» → Procesar</span>` : ''}${master}${dcat}</h3>
      <div class="cuar-body"${col ? ' style="display:none"' : ''}>
      <table><tr><th></th><th>Título / archivo</th><th>Estado</th><th></th></tr>${c[cat]
        .map((d) => {
          const q = consultaCopia(d);
          const links =
            !dup && FUENTES.length
              ? `<div class="buscar">🔎 copia: ${FUENTES.map((f) => `<a href="${esc(f.url.replace('{q}', encodeURIComponent(q)))}" target="_blank" rel="noopener">${esc(f.nombre)}</a>`).join(' · ')}</div>`
              : '';
          const chk = d.listo
            ? `<input type="checkbox" class="admin-only" data-sel="${esc(d.id)}" ${sanSel.has(d.id) ? 'checked' : ''}>`
            : '';
          const estado = dup
            ? `<span class="muted">${esc(d.error || '—')}</span>`
            : d.listo
              ? `<span class="tag ok">✓ lista</span> <span class="muted mono" style="font-size:11px">${esc(d.reemplazo || '')}</span>${d.error_proceso ? `<div class="tag bad" style="margin-top:4px">⛔ ${esc(d.error_proceso)}</div>` : ''}`
              : `<span class="muted">${esc(d.error || '—')}</span>`;
          let acc = dup
            ? `<button class="btn" data-cmp="${esc(d.id)}">⚖ Comparar</button> <button class="btn admin-only" data-re="${esc(d.id)}">↻ Reingestar</button>`
            : d.listo
              ? `<button class="btn pri admin-only" data-proc="${esc(d.id)}" title="Catalogar esta copia ya">▶ Procesar</button> <button class="btn admin-only" data-rep="${esc(d.id)}" title="Subir otra copia">⤓ Cambiar</button>`
              : `<button class="btn admin-only" data-rep="${esc(d.id)}" title="Subir una copia sana (queda lista para procesar)">⤓ Reemplazar</button>${cat === 'ilegibles' ? '' : ` <button class="btn admin-only" data-re="${esc(d.id)}">↻ Reingestar</button>`}`;
          acc += ` <button class="btn bad admin-only" data-desc="${esc(d.id)}" data-tit="${esc(d.titulo || d.archivos[0] || d.nombre || '')}" title="Descartar: carpeta completa → Papelera, fuera de Cuarentena">🗑</button>`;
          return `<tr${d.listo ? ' style="background:rgba(40,217,168,.05)"' : ''}>
        <td style="width:24px">${chk}</td>
        <td>${esc(d.titulo || d.archivos[0] || d.nombre)}<div class="muted mono">${esc(d.archivos.join(', '))}</div>${links}</td>
        <td>${estado}</td>
        <td style="text-align:right;white-space:nowrap">${acc}</td></tr>`;
        })
        .join('')}</table></div></div>`;
          })
          .join('')
      : '<div class="empty">Cuarentena vacía 🎉</div>';
    $$('#cuarBody .cuar-head').forEach(
      (h) =>
        (h.onclick = (e) => {
          if (e.target.closest('input,button,label,a')) return;
          const cat = h.dataset.fold,
            f = foldGet();
          f.has(cat) ? f.delete(cat) : f.add(cat);
          foldSet(f);
          h.classList.toggle('col');
          const body = h.nextElementSibling;
          if (body) body.style.display = h.classList.contains('col') ? 'none' : '';
        }),
    );
    $$('#cuarBody [data-re]').forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          try {
            const r = await api('/cuarentena/reingestar', {
              method: 'POST',
              body: JSON.stringify({ id: b.dataset.re }),
            });
            if (r.ok) {
              toast(`Reingestados ${r.movidos}/${r.total} → Inbox`);
              loadCuar();
            } else {
              toast(r.motivo, 'warn');
              b.disabled = false;
            }
          } catch (e) {
            toast(e.message, 'bad');
            b.disabled = false;
          }
        }),
    );
    $$('#cuarBody [data-cmp]').forEach((b) => (b.onclick = () => abrirComparador(b.dataset.cmp)));
    $$('#cuarBody [data-rep]').forEach(
      (b) =>
        (b.onclick = () => {
          sanCtx = { id: b.dataset.rep };
          const inp = $('#sanFile');
          inp.value = '';
          inp.click();
        }),
    );
    $$('#cuarBody [data-proc]').forEach((b) => (b.onclick = () => procesarSaneados([b.dataset.proc])));
    $$('#cuarBody [data-desc]').forEach(
      (b) =>
        (b.onclick = async () => {
          if (
            !confirm(
              `¿Descartar «${b.dataset.tit || 'este depósito'}»?\n\nSe mueve a la Papelera (carpeta COMPLETA, recuperable) y sale de Cuarentena.`,
            )
          )
            return;
          b.disabled = true;
          try {
            const r = await api('/cuarentena/descartar', {
              method: 'POST',
              body: JSON.stringify({ id: b.dataset.desc }),
            });
            if (r.ok) {
              toast('Descartado → Papelera', 'warn');
              loadCuar();
            } else {
              toast(r.motivo, 'warn');
              b.disabled = false;
            }
          } catch (e) {
            toast(e.message, 'bad');
            b.disabled = false;
          }
        }),
    );
    $$('#cuarBody [data-desccat]').forEach(
      (b) =>
        (b.onclick = async () => {
          const cat = b.dataset.desccat;
          const pwd = await modalPassword({
            titulo: `🗑 Eliminar categoría «${esc(cat)}»`,
            aviso: `Se moverá TODA la categoría «${esc(cat)}» a la Papelera (recuperable, con las carpetas intactas). Confirma con tu contraseña de administrador.`,
          });
          if (pwd == null) return;
          b.disabled = true;
          try {
            const r = await api('/cuarentena/categoria/descartar', {
              method: 'POST',
              body: JSON.stringify({ cat, password: pwd }),
            });
            if (r.ok) {
              toast(`Categoría «${cat}» → Papelera (${r.movidos}/${r.total})`, 'warn');
              loadCuar();
            } else {
              toast(r.motivo, 'warn');
              b.disabled = false;
            }
          } catch (e) {
            toast(e.message, 'bad');
            b.disabled = false;
          }
        }),
    );
    $$('#cuarBody [data-sel]').forEach(
      (b) =>
        (b.onchange = () => {
          b.checked ? sanSel.add(b.dataset.sel) : sanSel.delete(b.dataset.sel);
          sincMaster(b.closest('.card'));
          actualizarBotonLote();
        }),
    );
    $$('#cuarBody [data-selall]').forEach((m) => {
      sincMaster(m.closest('.card'));
      m.onchange = () => {
        const card = m.closest('.card');
        card.querySelectorAll('[data-sel]').forEach((cb) => {
          cb.checked = m.checked;
          m.checked ? sanSel.add(cb.dataset.sel) : sanSel.delete(cb.dataset.sel);
        });
        m.indeterminate = false;
        actualizarBotonLote();
      };
    });
    actualizarBotonLote();
    if ($('#reproAllDup'))
      $('#reproAllDup').onclick = async () => {
        if (
          !confirm(
            'Devuelve TODOS los duplicados al Inbox para re-evaluarlos con la lógica actual (los idénticos se borran, los de otro formato se separan, solo los conflictos reales vuelven). ¿Seguir?',
          )
        )
          return;
        const b = $('#reproAllDup');
        b.disabled = true;
        try {
          const r = await api('/cuarentena/duplicados/reprocesar-todos', { method: 'POST' });
          toast(`Reprocesando ${r.movidos} fichero(s) de ${r.depositos} depósito(s) → Inbox`);
          loadCuar();
        } catch (e) {
          toast(e.message, 'bad');
          b.disabled = false;
        }
      };
  } catch (e) {
    toast(e.message, 'bad');
  }
}
$('#sanProcesar').onclick = () => procesarSaneados([...sanSel]);
// Lanza el proceso por lotes (segundo plano) y sigue el progreso.
async function procesarSaneados(ids) {
  if (!ids || !ids.length) return;
  try {
    const r = await api('/saneamiento/procesar', { method: 'POST', body: JSON.stringify({ ids }) });
    if (!r.ok) {
      toast(r.motivo || 'no se pudo iniciar', 'warn');
      return;
    }
    toast(`Procesando ${ids.length} copia(s) en segundo plano…`);
    seguirSaneamiento();
  } catch (e) {
    toast(e.message, 'bad');
  }
}
function seguirSaneamiento() {
  if (sanPoll) clearInterval(sanPoll);
  const pintar = (s) => {
    const p = $('#sanProgreso');
    if (!p) return;
    if (s.enCurso) {
      p.style.display = 'inline';
      p.textContent = `⏳ Procesando ${s.hechos + s.fallos + 1}/${s.total}…`;
    } else p.style.display = 'none';
  };
  const tick = async () => {
    try {
      const s = await api('/saneamiento/estado');
      pintar(s);
      if (!s.enCurso) {
        clearInterval(sanPoll);
        sanPoll = null;
        if (s.total)
          toast(
            `Saneamiento: ${s.hechos} catalogado(s)${s.fallos ? ` · ${s.fallos} fallo(s)` : ''}`,
            s.fallos ? 'warn' : 'ok',
          );
        loadCuar();
      }
    } catch {}
  };
  sanPoll = setInterval(tick, 2000);
  tick();
}
// Selector de fichero para "Reemplazar/Cambiar" → PREPARA la copia (no cataloga; eso es el lote).
$('#sanFile').onchange = async (e) => {
  const file = e.target.files && e.target.files[0];
  const ctx = sanCtx;
  sanCtx = null;
  if (!file || !ctx) return;
  if (file.size < 1024) {
    toast(`Ese fichero parece vacío o dañado (${fmtBytes(file.size)}); elige otra copia`, 'warn');
    return;
  }
  toast(`Subiendo «${file.name}»…`);
  try {
    const r = await prepararCopia(ctx.id, file);
    if (r.ok) {
      toast(`✓ Copia lista (${fmtBytes(r.bytes || file.size)}). Pulsa «Procesar» cuando quieras.`);
      loadCuar();
    } else toast(r.motivo || 'no se pudo preparar la copia', 'warn');
  } catch (err) {
    toast(err.message, 'bad');
  }
};

// Comparador de duplicados: catalogado vs entrante, con la recomendación resaltada.
function cerrarCmp() {
  desbloquearRotacion(); // libera el bloqueo de rotación del etiquetado NFC (no-op si no estaba activo)
  $('#cmpScrim').style.display = 'none';
  $('#cmpModal').style.display = 'none';
  $('#cmpModal').innerHTML = '';
}

// ── Bloqueo de rotación de pantalla (Screen Orientation API) ────────────────────────────────────────
// IGNORA la autorrotación del sistema. Chrome exige PANTALLA COMPLETA para bloquear en una pestaña normal;
// en la PWA instalada (standalone) suele bastar sin ella. Por eso, si el bloqueo directo falla, se ENTRA en
// pantalla completa y se reintenta (recordando que fuimos nosotros, para salir al soltar). Lo usan el
// etiquetado NFC (temporal, se libera en cerrarCmp) y el PIN manual (persistente). Degrada en silencio.
let _fsPorRotacion = false; // ¿entramos NOSOTROS en pantalla completa para poder bloquear?
async function _fijarOrientacion(tipo) {
  const o = screen.orientation;
  if (!o || !o.lock) return false;
  try { await o.lock(tipo); return true; } catch (_) { /* quizá exige pantalla completa: se intenta abajo */ }
  try {
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
      _fsPorRotacion = true;
      await o.lock(tipo);
      return true;
    }
  } catch (_) {}
  return false;
}
function _soltarOrientacion() {
  try { if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock(); } catch (_) {}
  if (_fsPorRotacion) {
    _fsPorRotacion = false;
    try { if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen(); } catch (_) {}
  }
}
// NFC: bloquea la orientación ACTUAL al abrir el modal de etiquetado (no fuerza girar).
async function bloquearRotacion() {
  const o = screen.orientation;
  await _fijarOrientacion((o && o.type) || 'natural');
}
// NFC: libera al cerrar el modal — salvo que el PIN manual esté activo (entonces manda el pin).
function desbloquearRotacion() {
  if (_pinRot) return;
  _soltarOrientacion();
}

// ── PIN de orientación (manual, solo móvil): fija la pantalla en la orientación ACTUAL hasta soltarlo ──────
// Botón 📌 en la barra superior, visible SOLO en móvil (puntero grueso) y con soporte de la Screen Orientation
// API. Independiente del bloqueo del NFC: mientras el pin esté activo, cerrar un modal NFC NO suelta la
// orientación (desbloquearRotacion lo respeta). Se recuerda entre sesiones y se re-aplica al cargar (en la PWA
// instalada funciona sin más; en pestaña puede requerir volver a pulsarlo).
let _pinRot = false, _pinTipo = null;
function pinRotSoportado() {
  return !!(screen.orientation && screen.orientation.lock) && matchMedia('(pointer: coarse)').matches;
}
async function alternarPinRot() {
  if (!(screen.orientation && screen.orientation.lock)) return;
  if (_pinRot) {
    _pinRot = false; _pinTipo = null;
    localStorage.removeItem('pin_rotacion');
    _soltarOrientacion(); // libera y, si entramos en pantalla completa para bloquear, sale de ella
    toast('Orientación liberada');
  } else {
    _pinTipo = screen.orientation.type || 'natural'; // fija la orientación ACTUAL (la que haya al pulsar)
    if (await _fijarOrientacion(_pinTipo)) {
      _pinRot = true;
      localStorage.setItem('pin_rotacion', _pinTipo);
      toast('📌 Orientación fijada');
    } else {
      _pinTipo = null;
      toast('No se pudo fijar la orientación en este dispositivo', 'warn');
    }
  }
  pintarPinRot();
}
function pintarPinRot() {
  const b = $('#pinRot');
  if (!b) return;
  b.classList.toggle('pri', _pinRot);
  b.title = _pinRot
    ? '📌 Orientación FIJADA — toca para liberar'
    : 'Fijar la orientación actual de la pantalla (no rotará)';
}
function iniciarPinRot() {
  const b = $('#pinRot');
  if (!b || !pinRotSoportado()) return; // en escritorio / sin soporte, el botón queda oculto
  b.style.display = '';
  b.onclick = alternarPinRot;
  // Si el bloqueo usó pantalla completa y el usuario sale de ella (Atrás/Esc), el bloqueo se pierde:
  // refleja el estado real (suelta el pin) para que el icono no mienta.
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement && _fsPorRotacion) {
      _fsPorRotacion = false;
      if (_pinRot) { _pinRot = false; _pinTipo = null; localStorage.removeItem('pin_rotacion'); pintarPinRot(); }
    }
  });
  const guardado = localStorage.getItem('pin_rotacion');
  if (guardado) {
    _pinTipo = guardado; // re-aplica el pin recordado (best-effort; en la PWA instalada funciona al cargar)
    screen.orientation.lock(guardado).then(() => { _pinRot = true; pintarPinRot(); }).catch(() => {});
  }
  pintarPinRot();
}
iniciarPinRot();

// ── Paginación reutilizable (Catálogo, miembros de colección/obra, Autores, Descubrir…) ──────────────
// Controles: primera ⏮ · anterior ‹ · SALTO a página (input numérico) · siguiente › · última ⏭. Devuelve ''
// con una sola página. Se cablea con wirePager(contenedor, p, tp, ir). Usa CLASES (no ids) → puede haber varios
// pagers a la vez (arriba/abajo) sin colisionar. `ir(np)` recibe la página ya validada (1..tp).
function pagerControles(p, tp) {
  if (!(tp > 1)) return '';
  const d = (cond) => (cond ? ' disabled' : '');
  return `<button class="btn pgBtn pgFirst"${d(p <= 1)} title="Primera página">⏮</button>`
    + `<button class="btn pgBtn pgPrev"${d(p <= 1)} title="Página anterior">‹</button>`
    + `<span class="pgJump">Pág. <input class="pgInput" type="number" inputmode="numeric" min="1" max="${tp}" value="${p}" aria-label="Ir a la página"> / ${tp}</span>`
    + `<button class="btn pgBtn pgNext"${d(p >= tp)} title="Página siguiente">›</button>`
    + `<button class="btn pgBtn pgLast"${d(p >= tp)} title="Última página">⏭</button>`;
}
function wirePager(cont, p, tp, ir) {
  if (!cont) return;
  const q = (c) => cont.querySelector(c);
  const irA = (np) => { np = Math.min(Math.max(1, np | 0), tp); if (np !== p) ir(np); };
  const f = q('.pgFirst'), pv = q('.pgPrev'), nx = q('.pgNext'), ls = q('.pgLast'), inp = q('.pgInput');
  if (f && !f.disabled) f.onclick = () => irA(1);
  if (pv && !pv.disabled) pv.onclick = () => irA(p - 1);
  if (nx && !nx.disabled) nx.onclick = () => irA(p + 1);
  if (ls && !ls.disabled) ls.onclick = () => irA(tp);
  if (inp) {
    // Saltar a la página tecleada (Enter o al perder el foco); se acota a 1..tp y se refleja en el input.
    const salto = () => { const np = Math.min(Math.max(1, parseInt(inp.value, 10) || p), tp); inp.value = np; if (np !== p) ir(np); };
    inp.onchange = salto;
    inp.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); salto(); } };
  }
}
async function abrirComparador(id) {
  try {
    const d = await api('/cuarentena/duplicado?id=' + encodeURIComponent(id));
    if (!d.ok) {
      toast(d.motivo || 'no se pudo comparar', 'warn');
      return;
    }
    const col = (lado, o, win) => {
      const cuerpo = o.existe
        ? [
            `📄 <span class="mono">${esc(o.archivo || '—')}</span>`,
            `Tamaño: <b>${fmtBytes(o.bytes)}</b>`,
            o.paginas != null ? `Páginas: <b>${o.paginas}</b>` : '',
            o.mtime ? `Fecha: ${new Date(o.mtime).toLocaleDateString()}` : '',
            `Legible: ${o.legible ? '✅' : '⛔ no'}`,
            lado === 'existente' && o.isbn ? `ISBN: ${esc(o.isbn)}` : '',
            lado === 'existente' && o.es_obra ? `<span style="color:var(--warn)">⚠ tomo de obra</span>` : '',
          ]
            .filter(Boolean)
            .join('<br>')
        : `<span style="color:var(--bad)">${esc(o.motivo || 'no disponible')}</span>`;
      return `<div class="cmpcol${win ? ' win' : ''}"><h4>${lado === 'existente' ? '📚 Catalogado' : '📥 Entrante'}${win ? '<span class="winbadge">★ recomendado</span>' : ''}</h4>${cuerpo}</div>`;
    };
    const obra = !!(d.existente && d.existente.es_obra);
    $('#cmpModal').innerHTML = `<div class="box card">
      <h3 style="margin-top:0">⚖ Comparar duplicado</h3>
      <div class="muted" style="margin:-4px 0 12px">${esc(d.titulo || d.identificador || id)}</div>
      <div class="cmpcols">${col('existente', d.existente, d.recomendado === 'existente')}${col('entrante', d.entrante, d.recomendado === 'entrante')}</div>
      <div class="muted" style="margin-top:10px">Recomendación: <b>conservar el ${d.recomendado === 'entrante' ? 'entrante' : 'catalogado'}</b> — ${esc(d.motivo)}${d.identico ? ' · contenido idéntico' : ''}</div>
      ${obra ? `<div style="color:var(--warn);margin-top:8px">⚠ El catalogado es un tomo de obra: solo puedes conservar el catalogado (el reemplazo se hace desde Obras).</div>` : ''}
      <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
        <button class="btn admin-only" id="cmpKeepEx">📚 Quedarse con el catalogado</button>
        <button class="btn admin-only" id="cmpKeepEn"${obra ? ' disabled' : ''}>📥 Quedarse con el entrante</button>
        <button class="btn admin-only" id="cmpKeepBoth" title="Son ediciones/ejemplares distintos: catalogar el entrante como documento aparte">📑 Conservar ambos</button>
        <button class="btn" id="cmpClose">Cerrar</button>
      </div></div>`;
    $('#cmpScrim').style.display = 'block';
    $('#cmpModal').style.display = 'grid';
    $('#cmpClose').onclick = cerrarCmp;
    $('#cmpScrim').onclick = cerrarCmp;
    const resolver = async (quedarse) => {
      const avisos = {
        entrante:
          'Se retirará el documento catalogado (a la Papelera) y el entrante volverá al Inbox para recatalogarse. ¿Seguir?',
        existente: 'El entrante se descartará a la Papelera (recuperable). ¿Seguir?',
        ambos:
          'Se conservarán LOS DOS: el catalogado queda igual y el entrante volverá al Inbox para catalogarse como documento DISTINTO. ¿Seguir?',
      };
      if (!confirm(avisos[quedarse])) return;
      try {
        const r = await api('/cuarentena/duplicado/resolver', {
          method: 'POST',
          body: JSON.stringify({ id, quedarse }),
        });
        if (r.ok) {
          const msg = {
            entrante: `Catalogado retirado · entrante → Inbox (${r.movidos}/${r.total})`,
            existente: 'Entrante descartado a la Papelera',
            ambos: `Conservados ambos · entrante → Inbox como distinto (${r.movidos}/${r.total})`,
          };
          toast(msg[quedarse]);
          cerrarCmp();
          loadCuar();
        } else toast(r.motivo, 'warn');
      } catch (e) {
        toast(e.message, 'bad');
      }
    };
    if ($('#cmpKeepEx')) $('#cmpKeepEx').onclick = () => resolver('existente');
    if ($('#cmpKeepEn')) $('#cmpKeepEn').onclick = () => resolver('entrante');
    if ($('#cmpKeepBoth')) $('#cmpKeepBoth').onclick = () => resolver('ambos');
  } catch (e) {
    toast(e.message, 'bad');
  }
}

// ── papelera ──
// Página Papelera: totales (tamaño/ficheros/subcarpetas) + tabla de subcarpetas con «ver» y «vaciar».
async function loadPap() {
  try {
    const papelera = await api('/papelera');
    $('#papStats').innerHTML =
      `<div class="stat acc"><div class="ic">♻</div><div class="v">${fmtBytes(papelera.bytes)}</div><div class="k">Tamaño total</div></div>
    <div class="stat"><div class="ic">📄</div><div class="v">${papelera.ficheros}</div><div class="k">Ficheros</div></div>
    <div class="stat"><div class="ic">📁</div><div class="v">${papelera.subcarpetas.length}</div><div class="k">Subcarpetas</div></div>`;
    $('#papBody').innerHTML = papelera.subcarpetas.length
      ? `<table><tr><th>Subcarpeta</th><th>Ficheros</th><th>Tamaño</th><th></th></tr>
    ${papelera.subcarpetas
      .map(
        (
          sub,
        ) => `<tr><td class="mono">${esc(sub.nombre)}</td><td>${sub.ficheros}</td><td>${fmtBytes(sub.bytes)}</td>
      <td style="text-align:right"><button class="btn" data-ver="${esc(sub.nombre)}">ver</button> ${sub.restaurable ? `<button class="btn admin-only" data-restore="${esc(sub.nombre)}" title="Devolver el fichero/carpeta a su ubicación original (no pisa lo que ya exista allí)">↩️ restaurar</button> ` : ''}<button class="btn bad admin-only" data-del="${esc(sub.nombre)}">vaciar</button></td></tr>`,
      )
      .join('')}</table>`
      : '<div class="empty">Papelera vacía</div>';
    $$('#papBody [data-restore]').forEach(
      (b) =>
        (b.onclick = async () => {
          if (!confirm('¿Restaurar «' + b.dataset.restore + '» a su ubicación original?')) return;
          b.disabled = true;
          try {
            const r = await api('/papelera/restaurar', { method: 'POST', body: JSON.stringify({ sub: b.dataset.restore }) });
            if (!r.ok) { toast(r.motivo, 'bad'); b.disabled = false; return; }
            const partes = [`↩️ ${r.restaurados} restaurado(s)`];
            if (r.conflictos && r.conflictos.length) partes.push(`${r.conflictos.length} ya existían (conservados en Papelera)`);
            if (r.errores && r.errores.length) partes.push(`${r.errores.length} con error`);
            toast(partes.join(' · '), r.conflictos?.length || r.errores?.length ? 'warn' : 'ok');
            loadPap();
          } catch (e) { toast(e.message, 'bad'); b.disabled = false; }
        }),
    );
    $$('#papBody [data-del]').forEach(
      (b) =>
        (b.onclick = async () => {
          if (!confirm('¿Vaciar ' + b.dataset.del + '? (irreversible)')) return;
          try {
            await api('/papelera/vaciar', { method: 'POST', body: JSON.stringify({ sub: b.dataset.del }) });
            toast('Subcarpeta vaciada', 'warn');
            loadPap();
          } catch (e) {
            toast(e.message, 'bad');
          }
        }),
    );
    $$('#papBody [data-ver]').forEach(
      (b) =>
        (b.onclick = async () => {
          try {
            const r = await api('/papelera/contenido?sub=' + encodeURIComponent(b.dataset.ver));
            alert(
              b.dataset.ver +
                '\\n\\n' +
                (r.ficheros.map((f) => `• ${f.nombre} (${fmtBytes(f.bytes)})`).join('\\n') || '(vacía)'),
            );
          } catch (e) {
            toast(e.message, 'bad');
          }
        }),
    );
  } catch (e) {
    toast(e.message, 'bad');
  }
}
$('#papVaciarAll').onclick = async () => {
  if (!confirm('¿Vaciar TODA la papelera? (irreversible)')) return;
  try {
    await api('/papelera/vaciar', { method: 'POST', body: JSON.stringify({}) });
    toast('Papelera vaciada', 'warn');
    loadPap();
  } catch (e) {
    toast(e.message, 'bad');
  }
};

// ── obras ──
// Purga (borra) una obra multivolumen y sus tomos por isbn_obra/título. `ejecutar=false` = simulación
// (lista lo que se borraría); `true` = borra de verdad (los ficheros de los tomos van a la Papelera).
async function purga(ejecutar) {
  const clave = $('#purgaClave').value.trim();
  if (!clave) return toast('Indica isbn_obra o título', 'warn');
  if (ejecutar && !confirm('¿Purgar "' + clave + '"? Elimina la obra y sus tomos (ficheros → Papelera).'))
    return;
  try {
    const resp = await api('/obras/purgar', { method: 'POST', body: JSON.stringify({ clave, ejecutar }) });
    if (!resp.ok) return ($('#purgaOut').innerHTML = `<span class="tag bad">${esc(resp.motivo)}</span>`);
    if (resp.simulacion)
      $('#purgaOut').innerHTML =
        `<div class="muted">Obra «${esc(resp.obra.titulo)}» — se eliminarían ${resp.tomos.length} tomo(s):</div>
      <table>${resp.tomos.map((tomo) => `<tr><td>vol ${tomo.vol ?? '?'}</td><td>${esc(tomo.titulo)}</td><td class="mono muted">${esc(tomo.isbn || '—')}</td></tr>`).join('')}</table>`;
    else {
      $('#purgaOut').innerHTML =
        `<span class="tag ok">Eliminados ${resp.eliminados} tomo(s) + la obra. Ya puedes re-soltarla.</span>`;
      toast('Obra purgada');
      loadObras();
    }
  } catch (err) {
    toast(err.message, 'bad');
  }
}
$('#purgaSim').onclick = () => purga(false);
$('#purgaExec').onclick = () => purga(true);
// ── ESTANTERÍA (shelf) de obras y colecciones: rejilla con portada, filtro, selección y acciones en lote ──
const shelf = { obra: { items: [], sel: new Set(), modo: false }, coleccion: { items: [], sel: new Set(), modo: false } };
async function loadObras() {
  try {
    shelf.obra.items = await api('/obras');
    shelf.obra.sel.clear();
    pintarShelf('obra');
  } catch (e) {
    toast(e.message, 'bad');
  }
}
async function loadColecciones() {
  try {
    const tipo = $('#colsTipo') ? $('#colsTipo').value : '';
    shelf.coleccion.items = await api('/colecciones' + (tipo ? '?tipo=' + encodeURIComponent(tipo) : ''));
    shelf.coleccion.sel.clear();
    pintarShelf('coleccion');
  } catch (e) {
    toast(e.message, 'bad');
  }
}
function stackCover(portadas, ph) {
  const ps = (portadas || []).filter(Boolean).slice(0, 3);
  if (!ps.length) return `<div class="ph">${ph}</div>`;
  if (ps.length === 1)
    return `<img src="${esc(encUrl(ps[0]))}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=ph>${ph}</div>'">`;
  return `<div class="stack">${ps
    .slice()
    .reverse()
    .map((p) => `<img src="${esc(encUrl(p))}" loading="lazy">`)
    .join('')}</div>`; // frontal = ps[0] (último)
}
function shelfCard(kind, x) {
  const esObra = kind === 'obra',
    nombre = esObra ? x.titulo : x.nombre,
    ph = esObra ? '📚' : x.tipo === 'revista' ? '📰' : '📚';
  const cov = stackCover(x.portadas && x.portadas.length ? x.portadas : x.portada ? [x.portada] : [], ph);
  const estado = esObra
    ? `${x.volumenes_presentes || 0}/${x.total_volumenes || '?'} tomos ${x.completa ? '<span class="tag ok">completa</span>' : '<span class="tag warn">incompleta</span>'}${x.revision_requerida ? ' <span class="tag bad">revisar</span>' : ''}`
    : `${x.tipo === 'revista' ? '📰 revista' : '📚 libro'} · ${x.miembros || 0}${x.revision_requerida ? ' <span class="tag bad">revisar</span>' : ''}`;
  const sel = shelf[kind].sel.has(x._id);
  const req =
    esObra && x.isbn_obra
      ? ` <button class="rbtn shreq admin-only" data-req="${esc(x._id)}" title="Re-consultar título/sinopsis por ISBN">↻</button>`
      : '';
  return `<div class="vol${sel ? ' sel' : ''}" data-${kind}="${esc(x._id)}" data-nombre="${esc((nombre || '').toLowerCase())}"><span class="selmark">✓</span><div class="cov">${cov}</div><div class="meta"><div class="n">${esc(recortar(nombre || '—', 60))}${x.nsfw ? ' 🔞' : ''}${req}</div><div class="t">${estado}</div><div style="margin-top:5px">${ratingBar(esObra ? 'obras' : 'colecciones', x._id, x.valoracion, x.nsfw)}</div></div></div>`;
}
function pintarShelf(kind) {
  const cont = kind === 'obra' ? $('#obrasBody') : $('#colsBody');
  if (!cont) return;
  const st = shelf[kind];
  cont.innerHTML = `<div class="row" style="margin-bottom:10px"><input id="shf_${kind}" placeholder="🔍 filtrar por nombre…" autocomplete="off" style="flex:1" value="${esc(st.filtro || '')}"></div>
    <div id="shbulk_${kind}"></div>
    ${st.items.length ? `<div class="vol-grid${st.modo && ROL === 'admin' ? ' selmode' : ''}">${st.items.map((x) => shelfCard(kind, x)).join('')}</div>` : `<div class="empty">Sin ${kind === 'obra' ? 'obras' : 'colecciones'}</div>`}`;
  const fi = $('#shf_' + kind);
  // El filtro por nombre se CONSERVA entre re-renders (p. ej. al entrar en Modo selección): se guarda en
  // st.filtro y se re-aplica tras cada pintado, en vez de perderse al reconstruir el input.
  const aplicarFiltro = () => {
    const q = st.filtro || '';
    $$(`#${cont.id} .vol[data-${kind}]`).forEach((c) => {
      c.style.display = (c.dataset.nombre || '').includes(q) ? '' : 'none';
    });
  };
  if (fi) fi.oninput = () => { st.filtro = fi.value.toLowerCase(); aplicarFiltro(); };
  if (st.filtro) aplicarFiltro();
  // Interacción unificada: clic/toque = abrir la colección/obra (o marcar en Modo selección); doble clic /
  // pulsación larga = conmutar el modo (conservando la selección).
  $$(`#${cont.id} .vol[data-${kind}]`).forEach((el) =>
    attachGesto(
      el,
      () => {
        const id = el.dataset[kind];
        if (st.modo && ROL === 'admin') {
          st.sel.has(id) ? st.sel.delete(id) : st.sel.add(id);
          el.classList.toggle('sel', st.sel.has(id));
          renderShelfBulk(kind);
        } else kind === 'obra' ? verObra(id) : verColeccion(id);
      },
      () => alternarShelfModo(kind, el.dataset[kind]),
    ),
  );
  setModoVisual(st.modo && ROL === 'admin');
  $$(`#${cont.id} .shreq`).forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      b.textContent = '…';
      try {
        const r = await api('/obras/requery', {
          method: 'POST',
          body: JSON.stringify({ id: b.dataset.req }),
        });
        if (r.ok) {
          toast('Obra actualizada → ' + r.titulo);
          loadObras();
        } else {
          toast(r.motivo, 'warn');
          b.disabled = false;
          b.textContent = '↻';
        }
      } catch (err) {
        toast(err.message, 'bad');
        b.disabled = false;
        b.textContent = '↻';
      }
    };
  });
  attachRating('#' + cont.id);
  renderShelfBulk(kind);
}
// Conmuta el Modo selección de la lista de obras/colecciones (botón «Modo selección» o gesto doble-clic /
// pulsación-larga en una tarjeta). Re-renderiza para aplicar/quitar el modo.
function alternarShelfModo(kind, selId) {
  if (ROL !== 'admin') return;
  const st = shelf[kind];
  const entrando = !st.modo;
  st.modo = !st.modo;
  if (entrando && st.modo && selId) st.sel.add(selId); // al ENTRAR por gesto, marca ya esa tarjeta
  setModoVisual(st.modo);
  pintarShelf(kind);
}
function renderShelfBulk(kind) {
  const el = $('#shbulk_' + kind);
  if (!el) return;
  const cont = kind === 'obra' ? $('#obrasBody') : $('#colsBody'),
    st = shelf[kind];
  if (ROL !== 'admin') {
    el.innerHTML = '';
    return;
  }
  const ids = st.items.map((x) => x._id),
    enSel = ids.filter((id) => st.sel.has(id)).length,
    todas = enSel > 0 && enSel === ids.length;
  const nom = kind === 'obra' ? 'obra' : 'colección';
  const modoBtn = `<button class="btn${st.modo ? ' pri' : ''}" id="shModo" title="Modo selección: tocar una tarjeta la marca. Modo previsualización: tocar abre la ${nom}. Doble clic / pulsación larga en una tarjeta también conmuta. La selección se conserva.">${st.modo ? '🖱 Modo selección' : '👁 Modo previsualización'}</button>`;
  const tools = st.modo ? `<button class="btn" id="shAll">${todas ? 'Quitar' : 'Todas'}</button>` : '';
  const acc = st.sel.size
    ? `<span style="margin-left:auto"></span><b>${st.sel.size}</b> sel.
    <button class="btn pri" id="shCat" title="Ver en el Catálogo los libros de las ${kind === 'obra' ? 'obras' : 'colecciones'} seleccionadas">🔍 Mostrar en Catálogo</button>
    ${st.sel.size >= 2 ? `<button class="btn" id="shMerge">⛙ Fusionar</button>` : ''}
    <button class="btn" id="shExpl">💥 Explotar</button>
    <button class="btn bad" id="shDel">🗑 Eliminar vacías</button>
    <button class="btn" id="shClr">Limpiar</button>`
    : '';
  el.innerHTML = `<div class="bulkbar">${modoBtn}${tools}${acc}</div>`;
  $('#shModo').onclick = () => alternarShelfModo(kind);
  if ($('#shAll'))
    $('#shAll').onclick = () => {
      const on = !todas;
      ids.forEach((id) => (on ? st.sel.add(id) : st.sel.delete(id)));
      $$(`#${cont.id} .vol`).forEach((c) => c.classList.toggle('sel', st.sel.has(c.dataset[kind])));
      renderShelfBulk(kind);
    };
  if (st.sel.size) {
    $('#shCat').onclick = () => mostrarShelfEnCatalogo(kind);
    const mg = $('#shMerge');
    if (mg) mg.onclick = () => shelfFusionar(kind);
    $('#shExpl').onclick = () => shelfExplotar(kind);
    $('#shDel').onclick = () => shelfEliminar(kind);
    $('#shClr').onclick = () => {
      st.sel.clear();
      $$(`#${cont.id} .vol.sel`).forEach((c) => c.classList.remove('sel'));
      renderShelfBulk(kind);
    };
  }
}
// Envía las colecciones/obras seleccionadas al Catálogo (muestra sus libros, filtrando por ellas).
function mostrarShelfEnCatalogo(kind) {
  const st = shelf[kind];
  const ids = [...st.sel];
  if (!ids.length) return;
  const clave = kind === 'obra' ? 'obras' : 'colecciones';
  const etq = `${kind === 'obra' ? '📚' : '🗂️'} ${ids.length} ${kind === 'obra' ? 'obra(s)' : 'colección(es)'}`;
  irBusquedaFiltro({ [clave]: ids.join(','), etiqueta: etq });
}
function shelfSel(kind) {
  const st = shelf[kind];
  return st.items.filter((x) => st.sel.has(x._id));
}
async function shelfFusionar(kind) {
  const sel = shelfSel(kind);
  if (sel.length < 2) return;
  const esObra = kind === 'obra',
    nom = (x) => (esObra ? x.titulo : x.nombre);
  const opts = sel
    .map(
      (x, i) =>
        `<label class="pkitem" style="cursor:pointer;gap:8px"><input type="radio" name="mgd" value="${esc(x._id)}"${i === 0 ? ' checked' : ''}> ${esc(nom(x) || '—')}</label>`,
    )
    .join('');
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:480px"><h3 style="margin-top:0">⛙ Fusionar ${sel.length} ${esObra ? 'obras' : 'colecciones'}</h3>
    <div class="muted" style="margin:-4px 0 8px">Elige cuál CONSERVAR (las demás vuelcan sus miembros en ella y desaparecen):</div>
    <div class="pklist">${opts}</div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px"><button class="btn" id="mgX">Cancelar</button><button class="btn pri" id="mgOk">Fusionar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#mgX').onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
  $('#mgOk').onclick = async () => {
    const destino = ($('input[name=mgd]:checked') || {}).value;
    if (!destino) return;
    try {
      const r = await api(esObra ? '/obras/fusionar' : '/colecciones/fusionar', {
        method: 'POST',
        body: JSON.stringify({ ids: sel.map((x) => x._id), destino }),
      });
      if (!r.ok) {
        toast(r.motivo, 'bad');
        return;
      }
      cerrarCmp();
      toast(
        `${r.movidos} miembro(s) → «${esObra ? r.destino.titulo : r.destino.nombre}»; ${r.fusionadas} fusionada(s)`,
      );
      esObra ? loadObras() : loadColecciones();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
}
async function shelfExplotar(kind) {
  const sel = shelfSel(kind);
  if (!sel.length) return;
  const esObra = kind === 'obra';
  if (
    !confirm(
      `Explotar ${sel.length} ${esObra ? 'obra(s)' : 'colección(es)'}: sus miembros quedan como documentos sueltos y el grupo desaparece. Los ficheros NO se tocan. ¿Seguir?`,
    )
  )
    return;
  let lib = 0;
  for (const x of sel) {
    try {
      const r = await api(esObra ? '/obras/explotar' : '/colecciones/explotar', {
        method: 'POST',
        body: JSON.stringify({ id: x._id }),
      });
      if (r.ok) lib += r.liberados || 0;
    } catch {}
  }
  toast(`Explotado: ${lib} documento(s) liberado(s)`);
  esObra ? loadObras() : loadColecciones();
}
async function shelfEliminar(kind) {
  const sel = shelfSel(kind);
  if (!sel.length) return;
  const esObra = kind === 'obra';
  if (
    !confirm(
      `Eliminar las ${esObra ? 'obras' : 'colecciones'} VACÍAS de la selección (las que tengan miembros se omiten). ¿Seguir?`,
    )
  )
    return;
  let del = 0,
    om = 0;
  for (const x of sel) {
    try {
      const r = await api(esObra ? '/obras/eliminar' : '/colecciones/eliminar', {
        method: 'POST',
        body: JSON.stringify({ id: x._id }),
      });
      r.ok ? del++ : om++;
    } catch {
      om++;
    }
  }
  toast(`${del} eliminada(s)${om ? `, ${om} omitida(s) (no vacías)` : ''}`);
  esObra ? loadObras() : loadColecciones();
}

// ── detalle: obra → tomos → ficha (drill-down clicable, mobile-first) ──
const recortar = (s, n) => {
  s = String(s || '');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
// Distintivo 📶 (etiqueta NFC vinculada) para superponer en cualquier miniatura/portada de un documento.
function nfcBadge(d) {
  return d && d.nfc && (d.nfc.fecha_vinculacion || d.nfc.uid)
    ? '<span class="nfctag" title="Etiqueta NFC vinculada">📶</span>'
    : '';
}
function mostrarDetalle() {
  setModoVisual(false); // una ficha no es una lista: apaga el indicador de modo selección
  $$('.page').forEach((s) => s.classList.remove('on'));
  $('#p-detalle').classList.add('on');
  $('#sidebar').classList.remove('open');
  $('#scrim').classList.remove('open');
  window.scrollTo(0, 0);
}

async function verObra(id) {
  detalle = { tipo: 'obra', id };
  mostrarDetalle();
  apilarVista({ v: 'det', tipo: 'obra', id });
  $('#title').textContent = 'Obra';
  $('#p-detalle').innerHTML = '<div class="card"><div class="muted">Cargando obra…</div></div>';
  try {
    const r = await api('/obras/' + encodeURIComponent(id));
    pintarObra(r);
  } catch (e) {
    $('#p-detalle').innerHTML =
      `<div class="crumb"><a onclick="go('obras')">← Obras</a></div><div class="empty">${esc(e.message)}</div>`;
  }
}

function tomoCard(d, numero, falta) {
  if (falta)
    return `<div class="vol falta"><div class="cov"><div class="ph">∅</div></div><div class="meta"><div class="n">Tomo ${numero}</div><div class="t">falta</div></div></div>`;
  const cov = d.portada
    ? `<img src="${esc(encUrl(d.portada))}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=ph>📕</div>'">`
    : '<div class="ph">📕</div>';
  const fmt = (d.formatos || [])
    .slice(0, 3)
    .map((f) => `<span class="fmt">${esc(f)}</span>`)
    .join('');
  const numChip = ROL === 'admin'
    ? `<button class="btn" style="padding:1px 7px;font-size:11px;line-height:1.6" data-renum="${esc(d._id)}" title="Cambiar el nº de tomo">Tomo ${esc(numero ?? '?')} ✏️</button>`
    : `Tomo ${numero ?? '?'}`;
  return `<div class="vol" data-doc="${esc(d._id)}"><div class="cov">${cov}${nfcBadge(d)}</div><div class="meta"><div class="n">${numChip} ${fmt}${badgesDoc(d)}</div><div class="t">${esc(d.volumen_titulo || d.titulo || '—')}</div></div></div>`;
}

let _obraR = null; // última obra pintada (para el editor «Numerar tomos»)
function pintarObra(r) {
  _obraR = r;
  const o = r.obra,
    desc = o.cdu_desc;
  const numBtn =
    ROL === 'admin'
      ? `<button class="btn" id="obraNumerar" title="Asignar o corregir el número de tomo de cada libro de la obra">🔢 Numerar tomos</button>`
      : '';
  const rango = rangoFechas(o.fecha_inicio, o.fecha_fin);
  const sub =
    [o.isbn_obra ? 'ISBN obra ' + o.isbn_obra : '', o.editorial, o.coleccion, rango]
      .filter(Boolean)
      .map(esc)
      .join(' · ') || '—';
  const editBtn = ROL === 'admin' ? '<button class="btn admin-only" id="obraEditar" style="margin-top:8px;padding:4px 10px;font-size:12px" title="Editar título, sinopsis, ISBN de obra, editorial, CDU, total de tomos y fechas">✏️ Editar datos</button>' : '';
  const head = `<div class="crumb"><a onclick="go('obras')">Obras</a> › <span>${esc(recortar(o.titulo, 50))}</span></div>
    <div class="det-head"><button class="det-back" title="Volver" onclick="volverAtras()">←</button>
      <div class="det-title"><h2>${esc(o.titulo || '(sin título)')}</h2><div class="sub">${sub}</div>
        <div style="margin-top:8px">${o.completa ? '<span class="tag ok">completa</span>' : '<span class="tag warn">incompleta</span>'} ${o.revision_requerida ? '<span class="tag bad">revisar</span>' : ''} <span class="muted">${o.volumenes_presentes || 0} presentes · ${Math.max(0, (o.total_volumenes || 0) - (o.volumenes_presentes || 0))} ausentes · ${o.total_volumenes || '?'} total</span></div>
        <div style="margin-top:8px">${ratingBar('obras', o._id, o.valoracion, o.nsfw)}</div>
        ${o.cdu ? `<div class="mono muted" style="margin-top:8px">CDU ${esc(o.cdu)}${desc && desc.titulo_es ? ' · ' + esc(desc.titulo_es) : ''}</div>` : ''}
        ${o.descripcion ? `<p class="muted" style="font-size:12px;margin-top:6px">${esc(o.descripcion)}</p>` : ''}
        ${desc && desc.descripcion_es ? `<details style="margin-top:6px"><summary class="muted" style="cursor:pointer;font-size:12px">Descripción CDU</summary><p class="muted" style="font-size:12px;margin-top:6px">${esc(desc.descripcion_es)}</p></details>` : ''}
        ${editBtn}<button class="btn" id="obraCompartir" style="margin-top:8px;margin-left:6px;padding:4px 10px;font-size:12px" title="Compartir un enlace a esta obra (todos sus tomos + descarga)">🔗 Compartir</button>
      </div></div>`;
  const vols = r.volumenes.length
    ? r.volumenes.map((v) => tomoCard(v.doc, v.numero, !v.presente)).join('')
    : '<div class="empty">Sin tomos registrados</div>';
  const sin =
    r.sin_numero && r.sin_numero.length
      ? `<div class="card" style="margin-top:14px"><h3 style="color:var(--warn)">Tomos sin número (${r.sin_numero.length})</h3><div class="vol-grid">${r.sin_numero.map((d) => tomoCard(d, '?', false)).join('')}</div></div>`
      : '';
  $('#p-detalle').innerHTML =
    head +
    `<div class="card"><div id="selbarDet"></div><div class="row" style="align-items:center;justify-content:space-between;gap:8px"><h3 style="margin:0">Tomos</h3>${numBtn}</div><div class="vol-grid" style="margin-top:10px">${vols}</div></div>` +
    sin;
  // «Mostrar en Catálogo» de la selección → orden por Nº de tomo (numérico).
  montarSelDocs({ scopeSel: '#p-detalle', barSel: '#selbarDet', verCtx: { obra: { _id: o._id, titulo: o.titulo } }, titulo: `📚 ${recortar(o.titulo || 'obra', 30)}`, orden: 'obra' });
  attachRating('#p-detalle');
  // Renumerado directo de un tomo (admin). r.volumenes = [{doc, numero, presente}]; r.sin_numero = [doc].
  const docsObra = [...(r.volumenes || []).filter((v) => v.doc).map((v) => ({ d: v.doc, n: v.numero })), ...(r.sin_numero || []).map((d) => ({ d, n: d.volumen_numero }))];
  $$('#p-detalle [data-renum]').forEach((b) => (b.onclick = () => {
    const it = docsObra.find((x) => String(x.d._id) === b.dataset.renum);
    if (it) renumerarVolumenRapido({ tipo: 'obra', grupoId: o._id, docId: it.d._id, actual: it.n, titulo: it.d.volumen_titulo || it.d.titulo, total: o.total_volumenes });
  }));
  if ($('#obraNumerar')) $('#obraNumerar').onclick = () => numerarTomos();
  if ($('#obraEditar')) $('#obraEditar').onclick = () => editarGrupo('obra', o);
  if ($('#obraCompartir')) $('#obraCompartir').onclick = () => compartirGrupo('obra', o._id, o.titulo);
}

// Editor «Numerar tomos»: lista cada libro de la obra con un campo para su nº de tomo (vacío = sin
// número) + el total de tomos de la obra. «⚙️ Orden automático» rellena la numeración por INDICIOS
// (nº existente / «Vol/Tomo N» del título/OCR/nombre de archivo) y es editable a mano antes de guardar.
// Guarda vía POST /obras/:id/numerar y re-pinta la obra.
function numerarTomos() {
  const r = _obraR;
  if (!r) return;
  const o = r.obra;
  const filas = [];
  for (const v of r.volumenes) if (v.presente && v.doc) filas.push({ d: v.doc, numero: v.numero });
  for (const d of r.sin_numero || []) filas.push({ d, numero: '' });
  const ordenadas = () =>
    filas.slice().sort((a, b) => (a.numero === '' ? 1e9 : a.numero) - (b.numero === '' ? 1e9 : b.numero));
  const cardRow = (f) => {
    const d = f.d;
    const cov = d.portada
      ? `<img src="${esc(encUrl(d.portada))}" loading="lazy" style="width:56px;height:78px;object-fit:cover;border-radius:4px;flex:none">`
      : '<div style="width:56px;height:78px;display:grid;place-items:center;background:var(--card2,#eee);border-radius:4px;flex:none;font-size:24px">📕</div>';
    return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--bord,#e5e5e5)">
        ${cov}
        <div style="flex:1;min-width:0"><div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.volumen_titulo || d.titulo || '—')}</div><div class="muted mono" style="font-size:11px">${esc(d.isbn || '')}</div></div>
        <input type="number" min="1" class="numinput" data-doc="${esc(d._id)}" value="${f.numero === '' ? '' : esc(f.numero)}" placeholder="—" inputmode="numeric" style="width:64px;text-align:center">
      </div>`;
  };
  const pintarFilas = () => {
    $('#numFilas').innerHTML =
      filas.length ? ordenadas().map(cardRow).join('') : '<div class="muted">Esta obra no tiene libros.</div>';
  };
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:540px;width:94vw">
      <h3 style="margin-top:0">🔢 Numerar tomos — ${esc(recortar(o.titulo, 40))}</h3>
      <div class="muted" style="font-size:12px;margin-bottom:8px">Asigna el nº de tomo de cada libro. Vacío = «sin número». Dos tomos con el mismo número → el segundo queda «sin número» para revisión.</div>
      <div style="margin-bottom:8px"><button class="btn" id="numAuto" title="Rellena la numeración deduciéndola de los indicios (nº ya asignado, «Vol./Tomo N» del título/OCR/nombre de archivo). Puedes corregirla antes de guardar.">⚙️ Orden automático</button></div>
      <div id="numFilas" style="max-height:50vh;overflow:auto"></div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:12px"><label style="font-size:13px">Total de tomos de la obra:</label><input type="number" min="0" id="numTotal" value="${o.total_volumenes || ''}" placeholder="?" inputmode="numeric" style="width:64px;text-align:center"></div>
      <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="numCancel">Cancelar</button><button class="btn pri" id="numSave">Guardar</button></div>
    </div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  pintarFilas();
  $('#numCancel').onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
  // Orden automático por indicios: ordena por nº inferido (los sin indicio, al final por título) y
  // asigna 1..N secuencial. Editable a mano después.
  $('#numAuto').onclick = () => {
    const inf = filas.map((f) => ({
      f,
      n: inferirNumTomo(f.d),
      t: String(f.d.volumen_titulo || f.d.titulo || f.d.nombre_archivo || ''),
    }));
    inf.sort((a, b) => (a.n == null ? 1e9 : a.n) - (b.n == null ? 1e9 : b.n) || a.t.localeCompare(b.t, 'es'));
    inf.forEach((x, i) => (x.f.numero = i + 1));
    pintarFilas();
    if (!$('#numTotal').value) $('#numTotal').value = String(filas.length);
  };
  $('#numSave').onclick = async () => {
    const numeros = {};
    $$('#numFilas .numinput').forEach((i) => (numeros[i.dataset.doc] = i.value.trim()));
    const total = $('#numTotal').value.trim();
    const btn = $('#numSave');
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    try {
      await api('/obras/' + encodeURIComponent(o._id) + '/numerar', {
        method: 'POST',
        body: JSON.stringify({ numeros, total }),
      });
      cerrarCmp();
      verObra(o._id); // re-pintar con el inventario nuevo
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Guardar';
      alert('No se pudo guardar la numeración: ' + e.message);
    }
  };
}

// ── colecciones: cabeceras de revista (números) + series de libros ──

async function verColeccion(id) {
  detalle = { tipo: 'coleccion', id };
  mostrarDetalle();
  apilarVista({ v: 'det', tipo: 'coleccion', id });
  $('#title').textContent = 'Colección';
  $('#p-detalle').innerHTML = '<div class="card"><div class="muted">Cargando colección…</div></div>';
  try {
    const r = await api('/colecciones/' + encodeURIComponent(id));
    pintarColeccion(r);
  } catch (e) {
    $('#p-detalle').innerHTML =
      `<div class="crumb"><a onclick="go('colecciones')">← Colecciones</a></div><div class="empty">${esc(e.message)}</div>`;
  }
}

// Normaliza texto para búsquedas: minúsculas y SIN acentos ("Matemáticas" → "matematicas"), como el índice
// FTS del servidor, para que el filtro por texto de la ficha de colección sea insensible a acentos/mayúsculas.
function normalizar(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(new RegExp('[\u0300-\u036f]', 'g'), '');
}

function miembroCard(d, numeroHTML) {
  const cov = d.portada
    ? `<img src="${esc(encUrl(d.portada))}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=ph>📕</div>'">`
    : '<div class="ph">📕</div>';
  const fmt = (d.formatos || [])
    .slice(0, 3)
    .map((f) => `<span class="fmt">${esc(f)}</span>`)
    .join('');
  // data-nivel/data-rol: los usa el filtro por CSS (mostrar/ocultar) de las colecciones transmedia, sin
  // re-renderizar (así no se pierde el cableado de selección). Vacíos e inocuos en revistas/series.
  // data-buscar: título + autores + unidad normalizados (minúsculas, sin acentos) para el filtro por texto.
  const rol = d.rol_material || (d.naturaleza === 'audiolibro' ? 'audiolibro' : '');
  const buscar = normalizar([d.titulo, (d.autores || []).join(' '), d.unidad].filter(Boolean).join(' '));
  return `<div class="vol" data-doc="${esc(d._id)}" data-nivel="${esc(d.nivel || '')}" data-rol="${esc(rol)}" data-buscar="${esc(buscar)}"><div class="cov">${cov}${nfcBadge(d)}</div><div class="meta"><div class="n">${numeroHTML || ''} ${fmt}${badgesDoc(d)}</div><div class="t">${esc(d.titulo || '—')}</div></div></div>`;
}

let _colR = null; // última colección pintada (para el editor «Numerar»)
function pintarColeccion(r) {
  _colR = r;
  const c = r.coleccion,
    desc = c.cdu_desc,
    esRev = c.tipo === 'revista',
    esTrans = c.tipo === 'transmedia';
  // «Numerar» solo tiene sentido en SERIES DE LIBROS (las revistas se ordenan por fecha/clave; la transmedia
  // conserva su estructura y no se numera).
  const numBtn =
    !esRev && !esTrans && ROL === 'admin'
      ? `<button class="btn" id="colNumerar" title="Asignar o corregir el nº de cada libro dentro de la colección">🔢 Numerar</button>
         <button class="btn" id="colLomos" title="Foto de los lomos → la IA lee título y nº de cada uno y renumera la colección (y adjunta el recorte del lomo)">📷 Numerar por lomos</button>`
      : '';
  const tipoLabel = esRev ? '📰 Revista (cabecera)' : esTrans ? '🎬 Colección transmedia' : '📚 Serie de libros';
  const rango = rangoFechas(c.fecha_inicio, c.fecha_fin);
  const sub = [c.issn ? 'ISSN ' + c.issn : '', c.editorial, rango].filter(Boolean).map(esc).join(' · ') || '—';
  const editBtn = ROL === 'admin' ? '<button class="btn admin-only" id="colEditar" style="margin-top:8px;padding:4px 10px;font-size:12px" title="Editar nombre, presentación, ISSN, editorial, CDU y fechas de la colección">✏️ Editar datos</button>' : '';
  const head = `<div class="crumb"><a onclick="go('colecciones')">Colecciones</a> › <span>${esc(recortar(c.nombre, 50))}</span></div>
    <div class="det-head"><button class="det-back" title="Volver" onclick="volverAtras()">←</button>
      <div class="det-title"><h2>${esc(c.nombre || '(sin título)')}</h2><div class="sub">${tipoLabel} · ${sub}</div>
        <div style="margin-top:8px"><span class="muted">${r.miembros.length} ${esRev ? 'número(s)' : esTrans ? 'documento(s)' : 'libro(s)'}</span> ${c.revision_requerida ? '<span class="tag bad">revisar</span>' : ''}</div>
        <div style="margin-top:8px">${ratingBar('colecciones', c._id, c.valoracion, c.nsfw)}</div>
        ${c.cdu ? `<div class="mono muted" style="margin-top:8px">CDU ${esc(c.cdu)}${desc && desc.titulo_es ? ' · ' + esc(desc.titulo_es) : ''}</div>` : ''}
        ${c.descripcion ? `<p class="muted" style="font-size:12px;margin-top:6px">${esc(c.descripcion)}</p>` : ''}
        ${editBtn}<button class="btn" id="colCompartir" style="margin-top:8px;margin-left:6px;padding:4px 10px;font-size:12px" title="Compartir un enlace a esta colección (todos sus documentos + descarga)">🔗 Compartir</button>
      </div></div>`;
  // Nº de cada miembro. En LIBROS y admin, es un botón: toca = renumerar ese volumen directo (mini-modal).
  const numeroChip = (d) => {
    if (esTrans) {
      // Transmedia: en vez de nº, se muestra el nivel (Stage) y el rol del material (el rol no-lectura ya
      // va en el título, pero un chip lo hace escaneable de un vistazo).
      const niv = d.nivel ? `<span class="tag">${esc(d.nivel)}</span>` : '';
      const rolT = d.naturaleza === 'audiolibro' ? '🔊 audio' : (d.rol_material && d.rol_material !== 'lectura' ? d.rol_material : '');
      return niv + (rolT ? ` <span class="tag">${esc(rolT)}</span>` : '');
    }
    if (esRev) return esc(d.clave_numero || (d.año_edicion ? String(d.año_edicion) : '') || 'nº ?');
    const lbl = d.coleccion_numero ? 'nº ' + d.coleccion_numero : 'nº —';
    return ROL === 'admin'
      ? `<button class="btn" style="padding:1px 7px;font-size:11px;line-height:1.6" data-renum="${esc(d._id)}" title="Cambiar el nº en la colección">${esc(lbl)} ✏️</button>`
      : esc(d.coleccion_numero ? 'nº ' + d.coleccion_numero : '');
  };
  const cards = r.miembros.length
    ? r.miembros.map((d) => miembroCard(d, numeroChip(d))).join('')
    : `<div class="empty">Sin ${esRev ? 'números' : esTrans ? 'documentos' : 'libros'} registrados</div>`;
  // Con colecciones grandes conviene FILTRAR + PAGINAR (868 documentos son mucho scroll). Los controles solo
  // aparecen si hay bastantes miembros; el filtrado es en CLIENTE por CSS (mostrar/ocultar) sin re-renderizar,
  // así no se pierde el cableado de selección ni se recargan las imágenes (lazy).
  const PAG = 60; // tarjetas por página
  const filtrable = r.miembros.length > 24;
  // Chips de nivel/material SOLO en transmedia.
  const rolDe = (d) => d.rol_material || (d.naturaleza === 'audiolibro' ? 'audiolibro' : '');
  const niveles = [...new Set(r.miembros.map((m) => m.nivel).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'es', { numeric: true }));
  const ORDEN_ROL = ['lectura', 'ejercicios', 'test', 'solucionario', 'glosario', 'guia', 'audiolibro'];
  const roles = ORDEN_ROL.filter((rol) => r.miembros.some((m) => rolDe(m) === rol));
  const chipf = (val, txt) => `<button class="btn filtChip" data-val="${esc(val)}" style="padding:3px 10px;font-size:12px">${esc(txt)}</button>`;
  const chipsBar = esTrans
    ? `<div class="row filtRow" data-grupo="nivel" style="flex-wrap:wrap;gap:6px;margin-bottom:6px">
         <span class="muted" style="align-self:center;font-size:12px">Nivel:</span>${chipf('', 'Todos')}${niveles.map((n) => chipf(n, n)).join('')}
       </div>
       <div class="row filtRow" data-grupo="rol" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">
         <span class="muted" style="align-self:center;font-size:12px">Material:</span>${chipf('', 'Todos')}${roles.map((x) => chipf(x, x)).join('')}
       </div>`
    : '';
  // Caja de búsqueda por título/autor (solo si hay bastantes miembros).
  const buscarBar = filtrable
    ? `<input id="colBuscar" type="search" placeholder="🔍 Filtrar por título o autor…" autocomplete="off"
         style="width:100%;margin-bottom:8px;padding:8px 12px;border-radius:9px;border:1px solid var(--line);background:var(--card2);color:var(--txt)">`
    : '';
  // Controles de paginación (aparecen solo si el resultado supera una página).
  const pagerBar = filtrable
    ? `<div id="colPager" class="row" style="justify-content:center;align-items:center;gap:10px;margin-top:12px;flex-wrap:wrap;display:none"></div>`
    : '';
  const tituloGrid = esRev ? 'Números' : esTrans ? 'Documentos' : 'Libros';
  const contadorHtml = filtrable ? ' <span id="colCount" class="muted" style="font-size:13px;font-weight:400"></span>' : '';
  $('#p-detalle').innerHTML =
    head +
    `<div class="card"><div id="selbarDet"></div><div class="row" style="align-items:center;justify-content:space-between;gap:8px"><h3 style="margin:0">${tituloGrid}${contadorHtml}</h3>${numBtn}</div>${chipsBar}${buscarBar}<div class="vol-grid" id="colGrid" style="margin-top:10px">${cards}</div>${pagerBar}</div>`;

  // ── Filtro (texto + nivel/material) + paginación, todo en CLIENTE ──────────────────────────────────────
  if (filtrable) {
    const sel = { nivel: '', rol: '', q: '' };
    let pagina = 1;
    const todas = () => [...$('#colGrid').querySelectorAll('.vol')];
    const coincide = (v) =>
      (!sel.nivel || v.dataset.nivel === sel.nivel) &&
      (!sel.rol || v.dataset.rol === sel.rol) &&
      (!sel.q || (v.dataset.buscar || '').includes(sel.q));
    const render = () => {
      const cs = todas();
      const filtr = cs.filter(coincide);
      const total = filtr.length;
      const paginas = Math.max(1, Math.ceil(total / PAG));
      if (pagina > paginas) pagina = paginas;
      const ini = (pagina - 1) * PAG;
      cs.forEach((v) => (v.style.display = 'none'));
      filtr.slice(ini, ini + PAG).forEach((v) => (v.style.display = ''));
      if ($('#colCount')) $('#colCount').textContent = `${total} de ${r.miembros.length}`;
      const pager = $('#colPager');
      if (pager) {
        pager.style.display = total > PAG ? 'flex' : 'none';
        pager.innerHTML = pagerControles(pagina, paginas); // primera/anterior/salto/siguiente/última
        wirePager(pager, pagina, paginas, irAPagina);
      }
    };
    const irAPagina = (p) => { pagina = p; render(); $('#colGrid').scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    // Buscador por texto (normalizado, insensible a acentos). Reinicia a la página 1.
    const inp = $('#colBuscar');
    if (inp) inp.oninput = () => { sel.q = normalizar(inp.value.trim()); pagina = 1; render(); };
    // Chips nivel/material (transmedia): marcan el activo de su grupo y reinician a la página 1.
    $$('#p-detalle .filtRow').forEach((row) => {
      const grupo = row.dataset.grupo;
      row.querySelectorAll('.filtChip').forEach((btn) => (btn.onclick = () => {
        sel[grupo] = btn.dataset.val;
        row.querySelectorAll('.filtChip').forEach((b) => b.classList.toggle('active', b === btn));
        pagina = 1; render();
      }));
      const todos = row.querySelector('.filtChip');
      if (todos) todos.classList.add('active'); // «Todos» por defecto
    });
    render(); // pinta la rejilla + los controles de paginación (que se cablean en cada render)
  }
  // «Mostrar en Catálogo» de la selección → orden por Nº de colección (numérico), salvo en revistas.
  montarSelDocs({ scopeSel: '#p-detalle', barSel: '#selbarDet', verCtx: { coleccion: { _id: c._id, nombre: c.nombre } }, titulo: `🗂️ ${recortar(c.nombre || 'colección', 30)}`, orden: esRev ? undefined : 'coleccion' });
  attachRating('#p-detalle');
  // Renumerado directo de un volumen (solo libros/admin).
  $$('#p-detalle [data-renum]').forEach((b) => (b.onclick = () => {
    const d = r.miembros.find((m) => String(m._id) === b.dataset.renum);
    if (d) renumerarVolumenRapido({ tipo: 'coleccion', grupoId: c._id, docId: d._id, actual: d.coleccion_numero, titulo: d.titulo });
  }));
  if ($('#colNumerar')) $('#colNumerar').onclick = () => numerarColeccion();
  if ($('#colLomos')) $('#colLomos').onclick = () => numerarPorLomos();
  if ($('#colEditar')) $('#colEditar').onclick = () => editarGrupo('coleccion', c);
  if ($('#colCompartir')) $('#colCompartir').onclick = () => compartirGrupo('coleccion', c._id, c.nombre);
}

// Rango de años de publicación: «1920–1960», «1980–actualidad» (fin vacío), «?–1960» (solo fin), '' si nada.
function rangoFechas(ini, fin) {
  if (!ini && !fin) return '';
  if (ini && fin) return `${ini}–${fin}`;
  if (ini) return `${ini}–actualidad`;
  return `?–${fin}`;
}

// Modal de edición de una COLECCIÓN u OBRA (misma interfaz). tipo: 'coleccion' | 'obra'; g = objeto actual.
function editarGrupo(tipo, g) {
  const esCol = tipo === 'coleccion';
  const nombreLbl = esCol ? 'Nombre' : 'Título';
  const nombreVal = esCol ? (g.nombre || '') : (g.titulo || '');
  // TIPO de la colección: serie de libros ↔ revista (cabecera). «transmedia»/«audiolibros» son ESTRUCTURALES
  // (dependen del árbol en disco), así que se muestran bloqueados. Sin tipo = legado ⇒ se trata como libro.
  const tipoActual = String(g.tipo || '').toLowerCase();
  const estructural = ['transmedia', 'audiolibros'].includes(tipoActual);
  const tipoCampo = !esCol
    ? ''
    : estructural
      ? `<div style="flex:1"><label style="display:block;margin-top:8px">Tipo</label>
           <input value="${esc(tipoActual)}" disabled title="Tipo estructural: no se cambia desde la ficha"></div>`
      : `<div style="flex:1"><label style="display:block;margin-top:8px">Tipo</label>
           <select id="egTipo">
             ${tipoActual ? '' : '<option value="" selected>(sin definir → libro)</option>'}
             <option value="libro"${tipoActual === 'libro' ? ' selected' : ''}>📚 Serie de libros</option>
             <option value="revista"${tipoActual === 'revista' ? ' selected' : ''}>📰 Revista (cabecera)</option>
           </select></div>`;
  // Campo identificador propio: colección → ISSN; obra → ISBN de obra.
  const idFila = esCol
    ? `${tipoCampo}<div style="flex:1"><label style="display:block;margin-top:8px">ISSN</label><input id="egIssn" value="${esc(g.issn || '')}" autocomplete="off"></div>`
    : `<div style="flex:1"><label style="display:block;margin-top:8px">ISBN de obra</label><input id="egIsbn" value="${esc(g.isbn_obra || '')}" autocomplete="off"></div>`;
  const extraObra = esCol ? '' : `<div style="flex:1"><label style="display:block;margin-top:8px">Total de tomos</label><input id="egTotal" value="${esc(g.total_volumenes || '')}" inputmode="numeric" autocomplete="off"></div>`;
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:520px;max-height:90vh;overflow:auto">
    <h3 style="margin-top:0">✏️ Editar ${esCol ? 'colección' : 'obra'}</h3>
    <label style="display:block;margin-top:4px">${nombreLbl}</label><input id="egNombre" value="${esc(nombreVal)}" autocomplete="off">
    <div class="row" style="gap:8px">${idFila}<div style="flex:1"><label style="display:block;margin-top:8px">Editorial</label><input id="egEdi" value="${esc(g.editorial || '')}" autocomplete="off"></div></div>
    ${esCol && !estructural ? '<div class="muted" style="font-size:11px;margin-top:4px">El tipo cambia el MODELO del grupo (serie de libros ↔ cabecera de revista, cuya autoridad es el ISSN). El tipo de cada documento miembro se cambia aparte con «🔀 Cambiar tipo».</div>' : ''}
    <div class="row" style="gap:8px"><div style="flex:1"><label style="display:block;margin-top:8px">CDU</label><input id="egCdu" value="${esc(g.cdu || '')}" autocomplete="off"></div>${extraObra}</div>
    <div class="row" style="gap:8px">
      <div style="flex:1"><label style="display:block;margin-top:8px">Año de inicio</label><input id="egIni" value="${esc(g.fecha_inicio || '')}" inputmode="numeric" placeholder="p. ej. 1920" autocomplete="off"></div>
      <div style="flex:1"><label style="display:block;margin-top:8px">Año de fin</label><input id="egFin" value="${esc(g.fecha_fin || '')}" inputmode="numeric" placeholder="vacío = actualidad" autocomplete="off"></div>
    </div>
    <label style="display:block;margin-top:8px">${esCol ? 'Presentación / descripción' : 'Sinopsis / descripción'}</label>
    <textarea id="egDesc" rows="5" style="width:100%;resize:vertical;font-family:inherit">${esc(g.descripcion || '')}</textarea>
    <div id="egErr" style="color:var(--bad);font-size:12px;min-height:15px;margin-top:6px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" id="egX">Cancelar</button><button class="btn pri" id="egOk">💾 Guardar</button></div>
  </div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#egX').onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
  $('#egOk').onclick = async () => {
    const campos = {
      editorial: $('#egEdi').value,
      cdu: $('#egCdu').value,
      fecha_inicio: $('#egIni').value,
      fecha_fin: $('#egFin').value,
      descripcion: $('#egDesc').value,
    };
    if (esCol) {
      campos.nombre = $('#egNombre').value;
      campos.issn = $('#egIssn').value;
      // Sin #egTipo (colección estructural) no se envía `tipo`: el backend lo deja intacto.
      if ($('#egTipo')) campos.tipo = $('#egTipo').value;
    } else { campos.titulo = $('#egNombre').value; campos.isbn_obra = $('#egIsbn').value; campos.total_volumenes = $('#egTotal').value; }
    try {
      const res = await api('/' + (esCol ? 'colecciones' : 'obras') + '/' + encodeURIComponent(g._id) + '/editar', { method: 'POST', body: JSON.stringify(campos) });
      if (!res.ok) { $('#egErr').textContent = res.motivo; toast(res.motivo, 'bad'); return; }
      cerrarCmp();
      toast('Guardado' + ((res.avisos || []).length ? ' · ' + res.avisos.join('; ') : ''));
      esCol ? verColeccion(g._id) : verObra(g._id);
    } catch (e) { $('#egErr').textContent = e.message; }
  };
}

// Editor «Numerar» de una serie de libros: un nº por libro (vacío = sin número, permitido). Distingue el
// número EDITORIAL (leído del ISBN/datos — prevalece) del AUTOMÁTICO (badge «auto»). «⚙️ Orden automático»
// respeta SIEMPRE los editoriales y (según el interruptor) conserva o rehace los automáticos, rellenando
// huecos y continuando desde el más alto. Guarda vía POST /colecciones/:id/numerar.
function numerarColeccion() {
  const r = _colR;
  if (!r) return;
  const c = r.coleccion;
  // Estado por libro: numero (string), auto (bool = asignado automáticamente), editorial (tiene nº no-auto).
  const filas = r.miembros.map((d) => ({
    d,
    numero: d.coleccion_numero != null ? String(d.coleccion_numero) : '',
    auto: d.coleccion_numero_auto === true,
  }));
  const numOf = (f) => { const n = parseInt(f.numero, 10); return Number.isFinite(n) ? n : null; };
  const ordenadas = () =>
    filas.slice().sort((a, b) => (numOf(a) == null ? 1e9 : numOf(a)) - (numOf(b) == null ? 1e9 : numOf(b)) || String(a.d.titulo || '').localeCompare(String(b.d.titulo || ''), 'es'));
  const cardRow = (f) => {
    const d = f.d;
    const cov = d.portada
      ? `<img src="${esc(encUrl(d.portada))}" loading="lazy" style="width:48px;height:66px;object-fit:cover;border-radius:4px;flex:none">`
      : '<div style="width:48px;height:66px;display:grid;place-items:center;background:var(--card2,#eee);border-radius:4px;flex:none;font-size:22px">📕</div>';
    const badge = f.numero === '' ? '' : f.auto
      ? '<span class="tag" style="font-size:10px;background:var(--card2);color:var(--mut)">auto</span>'
      : '<span class="tag ok" style="font-size:10px">editorial</span>';
    return `<div style="display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid var(--bord,#e5e5e5)">
        ${cov}
        <div style="flex:1;min-width:0"><div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.titulo || '—')}</div><div class="muted mono" style="font-size:11px">${esc(d.isbn || '')} ${badge}</div></div>
        <input type="number" min="1" class="cnuminput" data-doc="${esc(d._id)}" data-auto="${f.auto ? '1' : '0'}" value="${esc(f.numero)}" placeholder="—" inputmode="numeric" style="width:64px;text-align:center">
      </div>`;
  };
  const pintarFilas = () => {
    $('#cnFilas').innerHTML = filas.length ? ordenadas().map(cardRow).join('') : '<div class="muted">La colección no tiene libros.</div>';
    // Editar un nº a mano lo vuelve EDITORIAL (deja de ser auto).
    $$('#cnFilas .cnuminput').forEach((i) => (i.oninput = () => { i.dataset.auto = '0'; }));
  };
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:560px;width:94vw">
      <h3 style="margin-top:0">🔢 Numerar — ${esc(recortar(c.nombre, 40))}</h3>
      <div class="muted" style="font-size:12px;margin-bottom:8px">Nº de cada libro en la colección. Vacío = sin número (algunas colecciones no se numeran). El nº «editorial» (leído del ISBN/datos) prevalece; el «auto» cede.</div>
      <div style="margin-bottom:8px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="btn" id="cnAuto" title="Rellena los números que falten (y, si marcas la casilla, rehace los automáticos), respetando siempre los editoriales; rellena huecos y continúa desde el más alto.">⚙️ Orden automático</button>
        <label style="font-size:12px;display:flex;align-items:center;gap:5px"><input type="checkbox" id="cnRehacer"> rehacer también los «auto»</label>
      </div>
      <div id="cnFilas" style="max-height:50vh;overflow:auto"></div>
      <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="cnCancel">Cancelar</button><button class="btn pri" id="cnSave">Guardar</button></div>
    </div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  pintarFilas();
  $('#cnCancel').onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
  // Orden automático por indicios: respeta los EDITORIALES (fijos); opcionalmente rehace los auto; asigna a
  // los que queden sin número el siguiente HUECO libre (y luego continúa desde el más alto). Marca auto.
  $('#cnAuto').onclick = () => {
    const rehacer = $('#cnRehacer').checked;
    const fijos = new Set(); // números ocupados por EDITORIALES (y por auto si NO se rehacen)
    for (const f of filas) {
      const n = numOf(f);
      if (n == null) continue;
      if (!f.auto || !rehacer) fijos.add(n);
    }
    const libre = () => { let n = 1; while (fijos.has(n)) n++; fijos.add(n); return n; };
    // Recorre en el orden mostrado; a cada libro sin número fijo, le da el siguiente hueco.
    for (const f of ordenadas()) {
      const n = numOf(f);
      const esFijo = n != null && (!f.auto || !rehacer);
      if (esFijo) continue;               // editorial (o auto que se conserva) → intacto
      f.numero = String(libre());
      f.auto = true;                       // asignado automáticamente
    }
    pintarFilas();
  };
  $('#cnSave').onclick = async () => {
    const numeros = {}, auto = {};
    $$('#cnFilas .cnuminput').forEach((i) => { numeros[i.dataset.doc] = i.value.trim(); if (i.dataset.auto === '1') auto[i.dataset.doc] = true; });
    const btn = $('#cnSave');
    btn.disabled = true;
    btn.textContent = 'Guardando…';
    try {
      await api('/colecciones/' + encodeURIComponent(c._id) + '/numerar', { method: 'POST', body: JSON.stringify({ numeros, auto }) });
      cerrarCmp();
      verColeccion(c._id);
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Guardar';
      alert('No se pudo guardar la numeración: ' + e.message);
    }
  };
}

// Renumerar DIRECTAMENTE un solo volumen/tomo desde la ficha de la colección u obra (sin abrir el editor
// completo): mini-modal con un campo de nº. El nº puesto a mano es EDITORIAL (coleccion_numero_auto:false).
function renumerarVolumenRapido({ tipo, grupoId, docId, actual, titulo, total }) {
  const modal = $('#cmpModal'), scrim = $('#cmpScrim');
  const cual = tipo === 'obra' ? 'la obra' : 'la colección';
  modal.innerHTML = `<div class="box card" style="max-width:360px;width:92vw">
      <h3 style="margin-top:0">Nº en ${cual}</h3>
      <div class="muted" style="font-size:12px;margin-bottom:10px">${esc(recortar(titulo || '', 64))}</div>
      <input type="number" min="1" id="rvNum" value="${esc(actual != null ? actual : '')}" placeholder="—" inputmode="numeric" style="width:100%;text-align:center;font-size:20px;padding:10px;box-sizing:border-box">
      <div style="margin-top:8px;font-size:12px" class="muted">Vacío = sin número.</div>
      <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="rvCancel">Cancelar</button><button class="btn pri" id="rvSave">Guardar</button></div>
    </div>`;
  scrim.style.display = 'block'; modal.style.display = 'grid';
  scrim.onclick = cerrarCmp; $('#rvCancel').onclick = cerrarCmp;
  setTimeout(() => { const i = $('#rvNum'); if (i) { i.focus(); i.select(); } }, 40);
  const guardar = async () => {
    const val = $('#rvNum').value.trim();
    const btn = $('#rvSave'); btn.disabled = true; btn.textContent = 'Guardando…';
    try {
      if (tipo === 'obra') await api('/obras/' + encodeURIComponent(grupoId) + '/numerar', { method: 'POST', body: JSON.stringify({ numeros: { [docId]: val }, total }) });
      else await api('/colecciones/' + encodeURIComponent(grupoId) + '/numerar', { method: 'POST', body: JSON.stringify({ numeros: { [docId]: val }, auto: { [docId]: false } }) });
      cerrarCmp();
      tipo === 'obra' ? verObra(grupoId) : verColeccion(grupoId);
    } catch (e) { btn.disabled = false; btn.textContent = 'Guardar'; alert('No se pudo cambiar el nº: ' + e.message); }
  };
  $('#rvSave').onclick = guardar;
  $('#rvNum').onkeydown = (e) => { if (e.key === 'Enter') guardar(); };
}

// Recorta el rectángulo `bbox` (fracciones 0..1) de una imagen ya cargada y lo devuelve como data-URL JPEG.
// Para el camino de reserva (fotos completas → la IA da bbox). null si no cabe.
function _recortarLomo(imgEl, bbox, maxW = 380) {
  if (!imgEl || !bbox) return null;
  const iw = imgEl.naturalWidth, ih = imgEl.naturalHeight;
  const sx = Math.round(bbox.x * iw), sy = Math.round(bbox.y * ih);
  const sw = Math.round(bbox.w * iw), sh = Math.round(bbox.h * ih);
  if (sw < 4 || sh < 4) return null;
  const escala = Math.min(1, maxW / sw);
  const cw = Math.max(1, Math.round(sw * escala)), ch = Math.max(1, Math.round(sh * escala));
  const cv = document.createElement('canvas');
  cv.width = cw; cv.height = ch;
  cv.getContext('2d').drawImage(imgEl, sx, sy, sw, sh, 0, 0, cw, ch);
  try { return cv.toDataURL('image/jpeg', 0.85); } catch { return null; }
}

// ── SEGMENTACIÓN DE LOMOS EN EL NAVEGADOR (sin IA) ───────────────────────────────────────────────────
// Los lomos de una serie se tocan (sin hueco de tapete entre ellos) y separan por SURCOS finos y oscuros
// perpendiculares a su longitud. Se detectan por PERFIL DE PROYECCIÓN de luminancia: valles (surcos) del
// perfil por FILA (lomos horizontales, apilados) o por COLUMNA (lomos verticales, de pie). Se elige el eje
// con más surcos → orientación AUTO (así una foto en horizontal y otra en vertical se resuelven cada una).
// Devuelve bandas (una por lomo) como fracciones 0..1 del eje perpendicular; el admin las afina (dividir/
// quitar) y luego se recortan enderezadas y se mandan a la IA ya AISLADAS (mucho más preciso que pedir bbox).
function _suavizarProf(a, k) {
  const n = a.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - k); j < Math.min(n, i + k + 1); j++) { s += a[j]; c++; }
    out[i] = s / c;
  }
  return out;
}
// Valles (surcos) del perfil por PROMINENCIA: mínimo local cuya subida mínima a ambos lados supera un umbral
// del rango; se quedan los más prominentes respetando una separación mínima (minsep).
function _surcosLomos(prof, minsep) {
  const n = prof.length, sm = _suavizarProf(prof, Math.max(2, Math.round(n / 120)));
  let lo = Infinity, hi = -Infinity;
  for (const v of sm) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const rng = (hi - lo) || 1, cand = [];
  for (let i = 1; i < n - 1; i++) {
    if (sm[i] <= sm[i - 1] && sm[i] <= sm[i + 1]) {
      let l = sm[i]; for (let j = i; j > Math.max(-1, i - minsep * 2); j--) l = Math.max(l, sm[j]);
      let rr = sm[i]; for (let j = i; j < Math.min(n, i + minsep * 2); j++) rr = Math.max(rr, sm[j]);
      const prom = Math.min(l, rr) - sm[i];
      if (prom > rng * 0.06 && sm[i] < lo + rng * 0.78) cand.push([i, prom]);
    }
  }
  cand.sort((a, b) => b[1] - a[1]);
  const picked = [];
  for (const [i] of cand) if (picked.every((p) => Math.abs(i - p) >= minsep)) picked.push(i);
  picked.sort((a, b) => a - b);
  return picked;
}
// Segmenta un canvas en bandas de lomo. `forz`: 'v'|'h' fuerza orientación (null = auto). Descarta bandas
// muy finas y las que son mayoritariamente TAPETE (fondo verde). Devuelve { orient:'v'|'h', bandas:[{a,b}] }.
function segmentarLomos(canvas, forz) {
  const maxD = 1000, sc = Math.min(1, maxD / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * sc)), h = Math.max(1, Math.round(canvas.height * sc));
  const t = document.createElement('canvas'); t.width = w; t.height = h;
  t.getContext('2d').drawImage(canvas, 0, 0, w, h);
  const d = t.getContext('2d').getImageData(0, 0, w, h).data;
  const row = new Float32Array(h), col = new Float32Array(w), matRow = new Float32Array(h), matCol = new Float32Array(w);
  for (let y = 0; y < h; y++) {
    let s = 0, mm = 0; const o = y * w;
    for (let x = 0; x < w; x++) {
      const i = (o + x) * 4, L = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      s += L; col[x] += L;
      if (_verdeMat(d[i], d[i + 1], d[i + 2])) { mm++; matCol[x]++; }
    }
    row[y] = s / w; matRow[y] = mm / w;
  }
  for (let x = 0; x < w; x++) { col[x] /= h; matCol[x] /= h; }
  const surcRow = _surcosLomos(row, Math.max(6, Math.round(h / 45)));
  const surcCol = _surcosLomos(col, Math.max(6, Math.round(w / 45)));
  const horizontal = forz ? forz === 'h' : surcRow.length >= surcCol.length;
  const cuts = horizontal ? surcRow : surcCol, axis = horizontal ? h : w, matPerp = horizontal ? matRow : matCol;
  const bounds = [...new Set([0, ...cuts, axis])].sort((a, b) => a - b), bandas = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const a = bounds[i], b = bounds[i + 1], th = b - a;
    if (th < axis * 0.035) continue;             // demasiado fino (ruido / surco)
    let mm = 0; for (let k = a; k < b; k++) mm += matPerp[k];
    if (mm / Math.max(1, th) > 0.5) continue;     // mayoritariamente tapete → fondo
    bandas.push({ a: a / axis, b: b / axis });
  }
  return { orient: horizontal ? 'h' : 'v', bandas };
}
// Recorta una banda del canvas (a,b = fracciones del eje perpendicular) y la deja VERTICAL: los lomos
// horizontales (orient 'h', texto girado 90°) se rotan para que el texto quede legible. Lado largo ≤ cap.
function _recortarBanda(canvas, orient, a, b, cap = 900) {
  const W = canvas.width, H = canvas.height;
  let sx, sy, sw, sh;
  if (orient === 'v') { sx = Math.round(a * W); sw = Math.max(1, Math.round((b - a) * W)); sy = 0; sh = H; }
  else { sy = Math.round(a * H); sh = Math.max(1, Math.round((b - a) * H)); sx = 0; sw = W; }
  const tmp = document.createElement('canvas'); tmp.width = sw; tmp.height = sh;
  tmp.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  let out = tmp;
  if (orient === 'h') {
    const rt = document.createElement('canvas'); rt.width = sh; rt.height = sw;
    const cx = rt.getContext('2d'); cx.translate(sh / 2, sw / 2); cx.rotate(Math.PI / 2); cx.drawImage(tmp, -sw / 2, -sh / 2);
    out = rt;
  }
  const long = Math.max(out.width, out.height), s = Math.min(1, cap / long);
  if (s < 1) { const fc = document.createElement('canvas'); fc.width = Math.round(out.width * s); fc.height = Math.round(out.height * s); fc.getContext('2d').drawImage(out, 0, 0, fc.width, fc.height); out = fc; }
  try { return out.toDataURL('image/jpeg', 0.82); } catch { return null; }
}

// NUMERAR POR LOMOS (serie de libros): fotos de los cantos → SEGMENTACIÓN local (sin IA) en lomos aislados →
// el admin afina (dividir/quitar, girar orientación) → la IA lee título+nº de cada recorte limpio → revisión
// (libro/nº, adjuntar) → /numerar + adjunta recortes. Fotos: cámara o archivos existentes.
function numerarPorLomos() {
  const r = _colR;
  if (!r) return;
  const c = r.coleccion;
  const miembros = r.miembros || [];
  let fotos = [];        // File[] seleccionados
  let canvases = [];     // canvas a resolución (por foto) para segmentar/recortar
  let imgsCargadas = []; // Image[] (para el camino de reserva por bbox)
  let lomos = [];        // bandas planas { foto, orient, a, b } (a,b = fracciones del eje perpendicular)
  let forz = null;       // orientación forzada: null=auto, 'v', 'h'
  const scrim = $('#cmpScrim'), modal = $('#cmpModal');
  const optsMiembros = (sel) =>
    `<option value="">— sin asignar —</option>` +
    miembros.map((m) => `<option value="${esc(m._id)}"${String(m._id) === String(sel || '') ? ' selected' : ''}>${esc(recortar(m.titulo || '(sin título)', 46))}</option>`).join('');
  const cropDeLomo = (l) => _recortarBanda(canvases[l.foto], l.orient, l.a, l.b);

  function pintarCaptura() {
    modal.innerHTML = `<div class="box card" style="max-width:560px;width:94vw">
        <h3 style="margin-top:0">📷 Numerar por lomos — ${esc(recortar(c.nombre, 36))}</h3>
        <div class="muted" style="font-size:12px;margin-bottom:10px">Fotos de los <b>lomos</b> (cantos) alineados y con el texto legible — de la cámara o ya existentes. Se separarán en el navegador y la IA leerá el título y el número de cada uno.</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <label class="btn" style="display:inline-block">📷 Cámara<input type="file" id="lomCam" accept="image/*" capture="environment" multiple hidden></label>
          <label class="btn" style="display:inline-block">🖼️ Archivos<input type="file" id="lomFile" accept="image/*" multiple hidden></label>
        </div>
        <div id="lomThumbs" style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px"></div>
        <div style="margin-top:16px;display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="lomCancel">Cancelar</button><button class="btn pri" id="lomSeg" disabled>✂️ Separar lomos</button></div>
      </div>`;
    scrim.style.display = 'block';
    modal.style.display = 'grid';
    scrim.onclick = cerrarCmp;
    $('#lomCancel').onclick = cerrarCmp;
    const add = (e) => { fotos = fotos.concat([...e.target.files]); e.target.value = ''; canvases = []; imgsCargadas = []; pintarThumbs(); };
    $('#lomCam').onchange = add;
    $('#lomFile').onchange = add;
    $('#lomSeg').onclick = segmentarTodo;
    pintarThumbs();
  }
  function pintarThumbs() {
    const cont = $('#lomThumbs');
    if (!cont) return;
    cont.innerHTML = fotos
      .map((f, i) => `<span style="position:relative;display:inline-block"><img src="${URL.createObjectURL(f)}" style="width:78px;height:78px;object-fit:cover;border-radius:8px;border:1px solid var(--line)"><button class="btn bad" type="button" data-rm="${i}" title="Quitar" style="position:absolute;top:-7px;right:-7px;padding:0 6px;border-radius:50%;line-height:18px">✕</button></span>`)
      .join('');
    $$('#lomThumbs [data-rm]').forEach((b) => (b.onclick = () => { fotos.splice(+b.dataset.rm, 1); canvases = []; imgsCargadas = []; pintarThumbs(); }));
    if ($('#lomSeg')) $('#lomSeg').disabled = fotos.length === 0;
  }
  async function cargarCanvases() {
    if (canvases.length) return;
    canvases = []; imgsCargadas = [];
    for (const f of fotos) {
      const red = await reducirImagen(f, 1800, 0.85);
      const du = await fileADataURL(red);
      const im = new Image();
      await new Promise((ok) => { im.onload = ok; im.onerror = ok; im.src = du; });
      const cv = document.createElement('canvas');
      cv.width = im.naturalWidth || 1; cv.height = im.naturalHeight || 1;
      cv.getContext('2d').drawImage(im, 0, 0);
      canvases.push(cv); imgsCargadas.push(im);
    }
  }
  async function segmentarTodo() {
    const btn = $('#lomSeg');
    if (btn) { btn.disabled = true; btn.textContent = 'Separando…'; }
    try {
      await cargarCanvases();
      lomos = [];
      canvases.forEach((cv, fi) => {
        const { orient, bandas } = segmentarLomos(cv, forz);
        bandas.forEach((bd) => lomos.push({ foto: fi, orient, a: bd.a, b: bd.b }));
      });
      pintarLomos();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = '✂️ Separar lomos'; }
      alert('No se pudo separar los lomos: ' + e.message);
    }
  }
  function pintarLomos() {
    if (!lomos.length) {
      modal.innerHTML = `<div class="box card" style="max-width:520px;width:94vw"><h3 style="margin-top:0">✂️ Separar lomos</h3>
        <div class="muted">No detecté lomos automáticamente (mejor con la alfombrilla y los cantos bien alineados). Puedes enviar las fotos completas a la IA para que los localice ella.</div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap"><button class="btn" id="lomVolver">← Fotos</button><button class="btn" id="lomFallback">Enviar fotos completas</button></div></div>`;
      $('#lomVolver').onclick = pintarCaptura;
      $('#lomFallback').onclick = analizarCompletas;
      return;
    }
    const cards = lomos.map((l, i) => `<div style="flex:none;text-align:center">
        <img src="${cropDeLomo(l)}" style="height:150px;max-width:120px;object-fit:contain;border-radius:5px;border:1px solid var(--line);background:#0002">
        <div style="margin-top:3px;display:flex;gap:4px;justify-content:center"><button class="btn" data-split="${i}" title="Dividir en dos (si juntó dos libros)">✂️</button><button class="btn bad" data-del="${i}" title="Quitar (no es un lomo)">✕</button></div>
      </div>`).join('');
    const orLbl = forz === 'v' ? 'vertical' : forz === 'h' ? 'horizontal' : 'auto';
    modal.innerHTML = `<div class="box card" style="max-width:640px;width:96vw">
        <h3 style="margin-top:0">✂️ Lomos separados — ${esc(recortar(c.nombre, 28))}</h3>
        <div class="muted" style="font-size:12px;margin-bottom:6px">${lomos.length} lomo(s). Revisa: <b>✂️</b> divide uno que junte dos libros, <b>✕</b> quita lo que no sea un lomo. Si la orientación falla, cámbiala y re-separa.</div>
        <div id="lomStrip" style="display:flex;gap:8px;overflow-x:auto;padding:6px 2px">${cards}</div>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap">
          <button class="btn" id="lomOrient" title="Orientación de la detección">↻ Orientación: ${orLbl}</button>
          <div style="display:flex;gap:8px"><button class="btn" id="lomAtrasCap">← Fotos</button><button class="btn pri" id="lomLeer">🔍 Leer con IA (${lomos.length})</button></div>
        </div>
      </div>`;
    $$('#lomStrip [data-del]').forEach((b) => (b.onclick = () => { lomos.splice(+b.dataset.del, 1); pintarLomos(); }));
    $$('#lomStrip [data-split]').forEach((b) => (b.onclick = () => { const i = +b.dataset.split, l = lomos[i], mid = (l.a + l.b) / 2; lomos.splice(i, 1, { ...l, b: mid }, { ...l, a: mid }); pintarLomos(); }));
    $('#lomOrient').onclick = () => { forz = forz === null ? 'v' : forz === 'v' ? 'h' : null; segmentarTodo(); };
    $('#lomAtrasCap').onclick = pintarCaptura;
    $('#lomLeer').onclick = leerIA;
  }
  async function leerIA() {
    const btn = $('#lomLeer');
    if (btn) { btn.disabled = true; btn.textContent = 'Leyendo…'; }
    try {
      const crops = lomos.map(cropDeLomo).filter(Boolean);
      const resp = await api('/colecciones/' + encodeURIComponent(c._id) + '/lomos', { method: 'POST', body: JSON.stringify({ recortados: 1, imagenes: crops }) });
      pintarRevision(resp, (p) => crops[p.img] || null);
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = `🔍 Leer con IA (${lomos.length})`; }
      alert('No se pudieron leer los lomos: ' + e.message);
    }
  }
  async function analizarCompletas() {
    // Reserva: la segmentación no encontró lomos → se mandan las fotos completas y la IA da los bbox.
    try {
      await cargarCanvases();
      const dataurls = [];
      for (const im of imgsCargadas) { const du = im.src; dataurls.push(du); }
      const resp = await api('/colecciones/' + encodeURIComponent(c._id) + '/lomos', { method: 'POST', body: JSON.stringify({ imagenes: dataurls }) });
      pintarRevision(resp, (p) => (p.bbox ? _recortarLomo(imgsCargadas[p.img], p.bbox) : null));
    } catch (e) {
      alert('No se pudieron leer los lomos: ' + e.message);
    }
  }
  function pintarRevision(resp, cropDe) {
    const props = (resp && resp.propuesta) || [];
    // Recorte de cada lomo para la miniatura de revisión y para adjuntar (del recorte local o del bbox).
    props.forEach((p) => { p._crop = cropDe(p); });
    const sinEmp = (resp && resp.sin_emparejar_miembros) || [];
    if (!props.length) {
      modal.innerHTML = `<div class="box card" style="max-width:520px;width:94vw"><h3 style="margin-top:0">📷 Numerar por lomos</h3>
        <div class="muted">${esc((resp && resp.aviso) || 'No se detectaron lomos legibles.')} Prueba con una foto más nítida y con los lomos bien enfocados.</div>
        <div style="margin-top:14px;display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="lomVolver">Volver</button><button class="btn" id="lomCerrar2">Cerrar</button></div></div>`;
      $('#lomVolver').onclick = pintarCaptura;
      $('#lomCerrar2').onclick = cerrarCmp;
      return;
    }
    const fila = (p, idx) => {
      const thumb = p._crop
        ? `<img src="${p._crop}" style="width:44px;height:120px;object-fit:cover;border-radius:4px;flex:none;background:#0002" title="Recorte del lomo">`
        : `<div style="width:44px;height:120px;display:grid;place-items:center;background:var(--card2,#eee);border-radius:4px;flex:none">📖</div>`;
      const conf = p.confianza >= 60 ? 'ok' : p.confianza > 0 ? '' : 'bad';
      const confTxt = p.doc_id ? `<span class="tag ${conf}" style="font-size:10px">${p.confianza}%</span>` : '<span class="tag bad" style="font-size:10px">sin libro</span>';
      return `<div class="lomrow" data-idx="${idx}" style="display:flex;gap:10px;align-items:flex-start;padding:8px 0;border-bottom:1px solid var(--bord,#e5e5e5)">
          ${thumb}
          <div style="flex:1;min-width:0">
            <div style="font-size:12px" class="muted">Lee: <b>${esc(recortar(p.titulo_detectado || p.texto || '¿?', 44))}</b> ${confTxt}</div>
            <div style="margin-top:5px"><select class="lomSel" style="width:100%;font-size:12px">${optsMiembros(p.doc_id)}</select></div>
            <div style="margin-top:6px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
              <label style="font-size:12px;display:flex;align-items:center;gap:4px">Nº <input type="number" min="1" class="lomNum" value="${esc(p.numero || '')}" placeholder="—" inputmode="numeric" style="width:60px;text-align:center"></label>
              <label style="font-size:12px;display:flex;align-items:center;gap:5px" title="Adjuntar el recorte del lomo como imagen del libro"><input type="checkbox" class="lomAdj"${p._crop ? ' checked' : ' disabled'}> adjuntar lomo</label>
            </div>
          </div>
        </div>`;
    };
    const sinEmpHTML = sinEmp.length
      ? `<details style="margin-top:10px"><summary class="muted" style="font-size:12px">Sin emparejar: ${sinEmp.length} libro(s) de la colección</summary><div class="muted" style="font-size:12px;margin-top:6px">${sinEmp.map((m) => esc(recortar(m.titulo || '', 50))).join(' · ')}</div></details>`
      : '';
    modal.innerHTML = `<div class="box card" style="max-width:600px;width:96vw">
        <h3 style="margin-top:0">📷 Revisar lomos — ${esc(recortar(c.nombre, 30))}</h3>
        <div class="muted" style="font-size:12px;margin-bottom:6px">Revisa el libro y el nº de cada lomo (${props.length} detectado(s)). Corrige lo que haga falta; el nº leído del lomo es <b>editorial</b> (prevalece). Marca «adjuntar lomo» para guardar el recorte como imagen del libro.</div>
        <div id="lomFilas" style="max-height:52vh;overflow:auto">${props.map(fila).join('')}</div>
        ${sinEmpHTML}
        <div id="lomProg" class="muted" style="font-size:12px;margin-top:8px"></div>
        <div style="margin-top:12px;display:flex;gap:8px;justify-content:flex-end"><button class="btn" id="lomAtras">← Lomos</button><button class="btn" id="lomCancel2">Cancelar</button><button class="btn pri" id="lomAplicar">✅ Aplicar</button></div>
      </div>`;
    $('#lomAtras').onclick = () => (lomos.length ? pintarLomos() : pintarCaptura());
    $('#lomCancel2').onclick = cerrarCmp;
    $('#lomAplicar').onclick = () => aplicar(props);
  }
  async function aplicar(props) {
    // Lee lo revisado de cada fila (por si el admin cambió libro/nº/adjuntar).
    const filas = $$('#lomFilas .lomrow').map((row) => {
      const idx = +row.dataset.idx;
      return {
        p: props[idx],
        docId: row.querySelector('.lomSel').value.trim(),
        num: row.querySelector('.lomNum').value.trim(),
        adjuntar: row.querySelector('.lomAdj').checked,
      };
    });
    const numeros = {}, auto = {};
    for (const f of filas) {
      if (!f.docId) continue;
      if (f.num !== '') { numeros[f.docId] = f.num; auto[f.docId] = false; } // leído del lomo = editorial
    }
    const btn = $('#lomAplicar');
    btn.disabled = true;
    const prog = $('#lomProg');
    try {
      if (Object.keys(numeros).length) {
        prog.textContent = 'Guardando numeración…';
        await api('/colecciones/' + encodeURIComponent(c._id) + '/numerar', { method: 'POST', body: JSON.stringify({ numeros, auto }) });
      }
      // Adjunta los recortes marcados (secuencial, best-effort: un fallo no aborta el resto).
      const conCrop = filas.filter((f) => f.docId && f.adjuntar && f.p._crop);
      let n = 0, fallos = 0;
      for (const f of conCrop) {
        prog.textContent = `Adjuntando lomos… ${++n}/${conCrop.length}`;
        try {
          await api('/documentos/' + encodeURIComponent(f.docId) + '/imagenes/anadir', { method: 'POST', body: JSON.stringify({ base64: f.p._crop }) });
        } catch { fallos++; }
      }
      cerrarCmp();
      toast(`Lomos aplicados: ${Object.keys(numeros).length} nº · ${conCrop.length - fallos} recorte(s)${fallos ? ` · ${fallos} fallo(s)` : ''}.`);
      verColeccion(c._id);
    } catch (e) {
      btn.disabled = false;
      prog.textContent = '';
      alert('No se pudo aplicar: ' + e.message);
    }
  }
  pintarCaptura();
}

// Ids (en orden) de TODOS los resultados de la búsqueda actual del Catálogo, cacheados por «clave» de
// búsqueda (los mismos filtros → no se re-piden). Reutiliza el endpoint soloIds (como «Todos los resultados»).
let _catalogoNav = { clave: null, ids: [] };
async function idsDelCatalogo() {
  const clave = _paramsBusqueda().toString(); // sin page → identifica la búsqueda
  if (_catalogoNav.clave === clave && _catalogoNav.ids.length) return _catalogoNav.ids;
  const params = _paramsBusqueda();
  params.set('soloIds', '1');
  const r = await api('/catalogo?' + params.toString());
  _catalogoNav = { clave, ids: r.ids || [] };
  return _catalogoNav.ids;
}
// Pinta los controles de navegación en #fichaNav. `ctx.lista` = lista explícita; `ctx.catalogo` = todos los
// resultados del Catálogo (async). Sin lista → no muestra nada.
function pintarNavFicha(id, ctx) {
  const cont = $('#fichaNav');
  if (!cont) return;
  const render = (ids) => {
    if (!$('#fichaNav')) return; // la ficha ya cambió mientras se cargaban los ids
    const idx = (ids || []).indexOf(id);
    if (!ids || ids.length < 2 || idx < 0) {
      cont.innerHTML = '';
      return;
    }
    const b = (bid, txt, tit, dis) => `<button class="det-back" id="${bid}" ${dis ? 'disabled' : ''} title="${tit}">${txt}</button>`;
    cont.innerHTML =
      b('navFirst', '⏮', 'Primero', idx <= 0) +
      b('navPrev', '◀', 'Anterior', idx <= 0) +
      `<span class="muted" style="font-size:12px">${idx + 1}/${ids.length}</span>` +
      b('navNext', '▶', 'Siguiente', idx >= ids.length - 1) +
      b('navLast', '⏭', 'Último', idx >= ids.length - 1);
    const irA = (i) => { if (i >= 0 && i < ids.length) verDoc(ids[i], { ...ctx }); };
    if ($('#navFirst')) $('#navFirst').onclick = () => irA(0);
    if ($('#navPrev')) $('#navPrev').onclick = () => irA(idx - 1);
    if ($('#navNext')) $('#navNext').onclick = () => irA(idx + 1);
    if ($('#navLast')) $('#navLast').onclick = () => irA(ids.length - 1);
  };
  if (Array.isArray(ctx && ctx.lista)) render(ctx.lista);
  else if (ctx && ctx.catalogo) {
    cont.innerHTML = '<span class="muted" style="font-size:11px">…</span>';
    idsDelCatalogo().then(render).catch(() => { if ($('#fichaNav')) cont.innerHTML = ''; });
  } else cont.innerHTML = '';
}

// Patrón de SELECCIÓN reutilizable para cualquier lista de documentos (colección, obra, estantería…):
// «Modo selección» (tocar marca con tick, la selección persiste; si no, abre la ficha con navegación) +
// «Mostrar en Catálogo» de lo seleccionado. Mismo comportamiento y diseño que el Catálogo.
//   scopeSel = contenedor con las tarjetas [data-doc]; barSel = dónde pintar la barra; verCtx = contexto de
//   verDoc (volver/etiqueta); titulo = etiqueta del chip en el Catálogo.
function montarSelDocs({ scopeSel, barSel, verCtx = {}, titulo, orden }) {
  const scope = $(scopeSel);
  const bar = $(barSel);
  if (!scope || !bar) return;
  const cards = [...scope.querySelectorAll('[data-doc]')];
  const lista = cards.map((c) => c.dataset.doc); // orden mostrado (para navegar en la ficha)
  const sel = new Set();
  let modo = false;
  // Cada tarjeta necesita el tick ✓ (se inyecta si no lo trae).
  cards.forEach((c) => { if (!c.querySelector('.selmark')) c.insertAdjacentHTML('afterbegin', '<span class="selmark">✓</span>'); });
  const soloAdmin = ROL === 'admin';
  const alternar = () => { if (!soloAdmin) return; modo = !modo; scope.classList.toggle('selmode', modo); setModoVisual(modo); pintarBar(); };
  const pintarBar = () => {
    // En modo selección: botón «Todos/Ninguno» (selecciona/deselecciona todas las tarjetas de la página).
    const todos = modo ? ` <button class="btn" id="selall">${sel.size >= cards.length && cards.length ? '☐ Ninguno' : '☑ Todos'}</button>` : '';
    // ACCIONES DE PERTENENCIA: solo cuando estamos DENTRO de una obra/colección (verCtx lo dice). `montarSelDocs`
    // es compartido (ficha de autor, editoriales…), y ahí «expulsar de la obra» no significaría nada.
    const grupo = verCtx.obra ? 'obra' : verCtx.coleccion ? 'coleccion' : null;
    const accGrupo = grupo && sel.size
      ? ` <button class="btn" id="selMover" title="Mover los seleccionados a OTRA ${grupo === 'obra' ? 'obra' : 'colección'} (se conserva el nº de tomo; se reemplaza a cuál pertenece)">↗ Mover a otra ${grupo === 'obra' ? 'obra' : 'colección'}</button>
         <button class="btn bad" id="selExp" title="Sacar los seleccionados de esta ${grupo === 'obra' ? 'obra' : 'colección'}. NO se borran: quedan sueltos en el catálogo.">⏏ Expulsar</button>`
      : '';
    const acc = sel.size
      ? `<span style="margin-left:auto"></span><b>${sel.size}</b> sel. <button class="btn pri" id="selcat">🔍 Mostrar en Catálogo</button>${accGrupo} <button class="btn" id="selclr">Limpiar</button>`
      : '';
    bar.innerHTML = `<div class="bulkbar"><button class="btn${modo ? ' pri' : ''}" id="selmodo" title="Modo selección: tocar una tarjeta la marca. Modo previsualización: tocar abre su ficha. Doble clic / pulsación larga en una tarjeta también conmuta. La selección se conserva.">${modo ? '🖱 Modo selección' : '👁 Modo previsualización'}</button>${todos}${acc}</div>`;
    $('#selmodo').onclick = alternar;
    if ($('#selall')) $('#selall').onclick = () => {
      const marcarTodas = sel.size < cards.length;
      cards.forEach((c) => { if (marcarTodas) { sel.add(c.dataset.doc); c.classList.add('sel'); } else { sel.delete(c.dataset.doc); c.classList.remove('sel'); } });
      pintarBar();
    };
    if (sel.size) {
      $('#selcat').onclick = () => mostrarEnCatalogo([...sel], titulo || `${sel.size} libros`, orden);
      $('#selclr').onclick = () => { sel.clear(); cards.forEach((c) => c.classList.remove('sel')); pintarBar(); };
      if ($('#selExp')) $('#selExp').onclick = () => expulsarDeGrupoUI(grupo, [...sel]);
      if ($('#selMover')) $('#selMover').onclick = () => pickerGrupo(grupo, [...sel]);
    }
  };
  // Interacción unificada: clic/toque = abrir ficha (o marcar en Modo selección); doble clic / pulsación
  // larga = conmutar el modo (conservando la selección).
  cards.forEach((el) =>
    attachGesto(
      el,
      () => {
        const id = el.dataset.doc;
        if (modo && soloAdmin) {
          sel.has(id) ? sel.delete(id) : sel.add(id);
          el.classList.toggle('sel', sel.has(id));
          pintarBar();
        } else verDoc(id, { ...verCtx, lista });
      },
      () => {
        if (!soloAdmin) return;
        const entrando = !modo;
        alternar();
        if (entrando && modo) { sel.add(el.dataset.doc); el.classList.add('sel'); pintarBar(); } // marca la tarjeta del gesto
      },
    ),
  );
  if (soloAdmin) pintarBar();
}

async function verDoc(id, ctx) {
  detalle = { tipo: 'doc', id, ctx };
  mostrarDetalle();
  apilarVista({ v: 'det', tipo: 'doc', id, ctx });
  $('#title').textContent = 'Ficha';
  $('#p-detalle').innerHTML = '<div class="card"><div class="muted">Cargando ficha…</div></div>';
  try {
    const r = await api('/documentos/' + encodeURIComponent(id));
    pintarDoc(r, ctx);
  } catch (e) {
    $('#p-detalle').innerHTML =
      `<div class="crumb"><a onclick="go('obras')">← Obras</a></div><div class="empty">${esc(e.message)}</div>`;
  }
}

// Etiquetas legibles de los roles de ISBN alternativo (otras ediciones).
const ROL_ISBN = {
  tapa_dura: 'tapa dura',
  tapa_blanda: 'tapa blanda',
  ebook: 'ebook/digital',
  obra: 'obra completa',
  volumen: 'volumen',
  barras: 'código de barras',
  otro: 'otra edición',
};
const ROL_ISBN_OPC = [
  ['tapa_blanda', 'Tapa blanda'],
  ['tapa_dura', 'Tapa dura'],
  ['ebook', 'Ebook / digital'],
  ['obra', 'Obra completa'],
  ['volumen', 'Volumen'],
  ['barras', 'Código de barras'],
  ['otro', 'Otra edición'],
];
const CAMPOS_FICHA = [
  ['_oid', 'ID (Mongo)'], // el primero de todo: identidad del registro en la base
  ['subtitulo', 'Subtítulo'],
  ['titulo_original', 'Título original'], // obras traducidas; solo se muestra si difiere del título (ver especiales)
  ['_autores', 'Autor(es)'],
  ['_editorial', 'Editorial'],
  ['año_edicion', 'Año'],
  ['numero_edicion', 'Edición'],
  ['idioma', 'Idioma'],
  ['idioma_original', 'Idioma original'],
  ['narrador', 'Narrador'],
  ['_formatos', 'Formatos'],
  ['paginas', 'Páginas'],
  ['_dimensiones', 'Tamaño'],
  ['_isbn', 'ISBN'],
  ['_isbns_alt', 'Otras ediciones'],
  ['_issn', 'ISSN'],
  ['_issns_alt', 'Otros ISSN'],
  ['lccn', 'LCCN'],
  ['obra_titulo', 'Obra'],
  ['_isbn_obra', 'ISBN obra'],
  ['volumen_numero', 'Volumen nº'],
  ['volumen_titulo', 'Título del volumen'],
  ['_coleccion', 'Colección'],
  ['coleccion_numero', 'Nº en colección'],
  ['nivel', 'Nivel'],
  ['unidad', 'Unidad'],
  ['rol_material', 'Material'],
  ['numero_issue', 'Número'],
  ['mes_publicacion', 'Mes'],
  ['_estado', 'Estado'],
  ['_ubicacion', 'Ubicación'],
  ['nombre_archivo', 'Archivo'],
  ['_ruta', 'Ruta'],
  ['hash_contenido', 'Hash'],
  ['_ingreso', 'Ingresado'],
  ['_actualizado', 'Actualizado'],
];

// ── Clasificaciones (CDU/Dewey/LCC): fila (código · concisa · ⓘ · contador), popup ⓘ y filtro ──
function filaClas(x, sinSist) {
  const t = x.titulo ? esc(x.titulo) : '<span class="muted">—</span>';
  const cnt =
    x.n > 1
      ? `<a class="cntclas" data-sist="${esc(x.sistema)}" data-cod="${esc(x.codigo)}" title="Ver los ${x.n} documentos">${x.n}</a>`
      : `<span class="muted">${x.n || 1}</span>`;
  return `<tr>${sinSist ? '' : `<td class="mono muted" style="white-space:nowrap">${esc((x.sistema || '').toUpperCase())}</td>`}<td class="mono" style="white-space:nowrap">${esc(x.codigo)}</td><td>${t} <button class="iclas" data-sist="${esc(x.sistema)}" data-cod="${esc(x.codigo)}" title="Más información sobre esta clasificación">ⓘ</button></td><td style="text-align:right">${cnt}</td></tr>`;
}
function attachClas(scope) {
  $$(scope + ' .iclas').forEach((b) => (b.onclick = () => infoClasificacion(b.dataset.sist, b.dataset.cod)));
  $$(scope + ' .cntclas').forEach(
    (b) => (b.onclick = () => filtrarPorClasificacion(b.dataset.sist, b.dataset.cod)),
  );
}
async function infoClasificacion(sist, cod) {
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:520px"><h3 style="margin-top:0">${esc((sist || '').toUpperCase())} <span class="mono">${esc(cod)}</span></h3><div id="iclasBody" class="muted">Cargando…</div><div style="margin-top:14px;text-align:right"><button class="btn" id="iclasClose">Cerrar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#iclasClose').onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
  try {
    const r = await api(
      '/clasificacion?sistema=' + encodeURIComponent(sist) + '&codigo=' + encodeURIComponent(cod),
    );
    const b = $('#iclasBody');
    if (!b) return;
    b.classList.remove('muted');
    b.innerHTML = r.ok
      ? `${r.titulo ? `<div style="font-weight:600;margin-bottom:8px">${esc(r.titulo)}</div>` : ''}<div style="line-height:1.65;font-size:13px">${esc(r.descripcion || 'Sin descripción disponible (la IA no la generó).')}</div>`
      : `<span class="muted">${esc(r.motivo || 'no disponible')}</span>`;
  } catch (e) {
    const b = $('#iclasBody');
    if (b) b.textContent = e.message;
  }
}
// Filtro especial de Búsqueda (clasificación / contador del dashboard / día de ingesta): un único
// objeto `extra` con los parámetros que entiende /catalogo + una `etiqueta` para el chip. Limpia la
// caja de texto y abre la Búsqueda con EXACTAMENTE esos documentos.
function irBusquedaFiltro(extra) {
  // Si el filtro va sobre OBRAS (o sobre tomos concretos de una), el modo COLAPSADO no sirve: devolvería la
  // tarjeta de la obra, no los tomos que quieres ver/seleccionar. Se conmuta a EXPANDIDO automáticamente —
  // el usuario siempre puede volver a colapsar con la casilla (el modo se recuerda).
  if (extra && (extra.obras || extra.expandirObras)) modoTomos(true);
  estadoBusqueda.extra = extra;
  estadoBusqueda.page = 1;
  if ($('#sqQ')) $('#sqQ').value = '';
  if ($('#sqCdu')) $('#sqCdu').value = '';
  go('search');
}
// MODO del catálogo respecto a las obras: colapsado (una tarjeta por obra, por defecto) ↔ expandido (un tomo
// por tarjeta, teñidos). Se RECUERDA entre sesiones: es una preferencia de trabajo, no un capricho por búsqueda.
function modoTomos(expandido) {
  localStorage.setItem('cat_tomos', expandido ? '1' : '0');   // el botón de la barra se repinta al buscar
}
const modoTomosExpandido = () => localStorage.getItem('cat_tomos') === '1';
// Ver los libros de UNA ubicación (ámbito/estantería) en el Catálogo: FILTRA por esa ubicación y —si es
// una estantería concreta— ordena por su POSICIÓN física (visible y ajustable en el selector de orden).
// Punto ÚNICO usado por el deep-link ?amb=&est= (arranque) y por la lectura NFC de una etiqueta de
// estantería, para que ambos caminos se comporten igual (antes «llevaba al catálogo con todo mostrado»).
function verEstanteriaEnCatalogo(amb, est) {
  if (!amb) return;
  estadoBusqueda.extra = {
    ambito: amb,
    estanteria: est || undefined,
    etiqueta: '📍 ' + amb + (est ? ' · ' + est : ''),
  };
  estadoBusqueda.page = 1;
  go('search');
  if (!$('#sqQ')) construirSearch();
  if ($('#sqQ')) $('#sqQ').value = ''; // sin texto: solo el filtro de ubicación
  // Limpia otros filtros que arrastrasen de una búsqueda previa (para que muestre SOLO esta ubicación).
  if ($('#sqTipo')) $('#sqTipo').value = '';
  if ($('#sqSoporte')) $('#sqSoporte').value = '';
  if ($('#sqCdu')) $('#sqCdu').value = '';
  // Estantería concreta → orden por POSICIÓN física, reflejado en el selector (y modificable a mano).
  if (est && $('#sqOrden')) {
    $('#sqOrden').value = 'posicion';
    const b = $('#sqDir'); if (b) { b.dataset.dir = 'asc'; b.textContent = '↑ Asc'; }
    const w = $('#sqDirWrap'); if (w) w.style.display = '';
  }
  buscarCatalogo(1);
}
// Búsqueda por TEXTO libre (drill de ISSN/ISBN desde la ficha): pone la consulta en la caja y busca.
function buscarTexto(q) {
  estadoBusqueda.extra = null;
  estadoBusqueda.page = 1;
  go('search');
  if (!$('#sqQ')) construirSearch();
  $('#sqQ').value = q;
  if ($('#sqCdu')) $('#sqCdu').value = '';
  if ($('#sqTipo')) $('#sqTipo').value = '';
  buscarCatalogo(1);
}
function filtrarPorClasificacion(sist, cod) {
  irBusquedaFiltro({ clasSistema: sist, clasCodigo: cod, etiqueta: `${sist.toUpperCase()} ${cod}` });
}
// CDU inmediatamente SUPERIOR en la jerarquía (el «ámbito» virtual de un medio digital):
//  · si el código lleva auxiliares/cualificadores tras el número principal ((73), :81'37, -3, =111…),
//    el padre inmediato es el número principal a secas — p.ej. 821.111(73) → 821.111.
//  · si ya es número principal puro, baja un nivel quitando el último dígito (respetando el decimal) —
//    821.111 → 821.11, 82 → 8, 8 → «» (raíz).
function cduPadre(cdu) {
  const s = String(cdu || '').trim();
  const m = (s.match(/^[0-9]+(?:\.[0-9]+)*/) || [''])[0];
  if (!m) return '';
  if (m !== s) return m; // había auxiliares → el padre es el número principal
  if (m.includes('.')) return m.replace(/\.?[0-9]$/, '').replace(/\.$/, '');
  return m.length > 1 ? m.slice(0, -1) : '';
}
// El "estante virtual" de un DIGITAL es su CDU. Ver sus COMPAÑEROS DE ESTANTERÍA: los demás medios
// digitales clasificados con esa misma CDU (match EXACTO). Con `prefijo` se navega al ÁMBITO (CDU
// superior) mostrando todo lo que cuelga de él (match por prefijo, param `cdu` del servidor).
function verEstanteriaDigital(cdu, opts) {
  if (!cdu) return;
  const prefijo = opts && opts.prefijo;
  irBusquedaFiltro(
    prefijo
      ? { cdu, soporte: 'digital', etiqueta: `📂 CDU ${cdu}·* digitales` }
      : { clasSistema: 'cdu', clasCodigo: cdu, soporte: 'digital', etiqueta: `📚 CDU ${cdu} · digitales` },
  );
}
function filtrarColeccion(id, nombre) {
  irBusquedaFiltro({ coleccion: id, etiqueta: `Colección: ${nombre}` });
}
function filtrarCatalogo(filtro, etiqueta) {
  irBusquedaFiltro({ filtro, etiqueta: etiqueta || filtro });
}
function filtrarPorDia(dia) {
  irBusquedaFiltro({ dia, etiqueta: `Ingresados el ${dia}` });
}

function pintarDoc(r, ctx) {
  const d = r.doc,
    vo = ctx && ctx.obra,
    vc = ctx && ctx.coleccion,
    vol = ctx && ctx.volver;
  let inicio, back;
  if (vo) {
    inicio = `<a onclick="go('obras')">Obras</a> › <a onclick="verObra('${esc(vo._id)}')">${esc(recortar(vo.titulo, 32))}</a>`;
    back = `verObra('${esc(vo._id)}')`;
  } else if (vc) {
    inicio = `<a onclick="go('colecciones')">Colecciones</a> › <a onclick="verColeccion('${esc(vc._id)}')">${esc(recortar(vc.nombre, 32))}</a>`;
    back = `verColeccion('${esc(vc._id)}')`;
  } else if (vol) {
    inicio = `<a onclick="go('${esc(vol)}')">${esc(ctx.etiqueta || vol)}</a>`;
    back = `go('${esc(vol)}')`;
  } else {
    inicio = `<a onclick="go('obras')">Obras</a>`;
    back = `go('obras')`;
  }
  back = 'volverAtras()'; // el botón «←» de la ficha usa el historial (vuelve a donde estabas)
  const crumb = `<div class="crumb">${inicio} › <span>${esc(recortar(d.titulo, 40))}</span></div>`;
  const fmtFecha = (v) => {
    const t = new Date(v);
    return isNaN(t) ? esc(v) : t.toLocaleString('es-ES');
  };
  // Nombre de persona clicable → ficha del autor (autorFicha), si tenemos su id.
  const enlaceAutor = (nombre, id) =>
    id ? `<a class="rowlink" data-autid="${esc(id)}" title="Ver la ficha del autor">${esc(nombre)}</a>` : esc(nombre);
  const capRol = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1) : s);
  const especiales = {
    // Créditos estilo IMDB: autores primero (sin etiqueta) y luego los contribuyentes con su rol entre
    // paréntesis, uno por línea; todos clicables → ficha del autor.
    _autores: (() => {
      const lineas = [];
      (r.autores || []).forEach((n, i) => lineas.push(enlaceAutor(n, r.autores_ids && r.autores_ids[i])));
      (r.contribuciones || []).forEach((c) => {
        // Contribución no resuelta (persona borrada): se MUESTRA el id (marcado ⚠) pero SIN enlace (no hay ficha).
        const nom = c.desconocido ? `<span class="muted" title="Autor no encontrado (referencia rota)">${esc(c.nombre)}</span>` : enlaceAutor(c.nombre, c.persona);
        lineas.push(`${nom} <span class="muted" style="font-size:12px">(${esc(capRol(c.rol))})</span>`);
      });
      return lineas.length ? lineas.join('<br>') : null;
    })(),
    _editorial: r.editorial ? esc(r.editorial) : null,
    // Los contribuyentes ya se muestran junto a los autores (arriba), no en fila aparte.
    _contribuciones: null,
    _coleccion: r.coleccion
      ? (r.coleccion_id
          ? `<a class="rowlink" data-colid="${esc(r.coleccion_id)}" data-colnom="${esc(r.coleccion)}">${esc(r.coleccion)}</a>`
          : esc(r.coleccion)) + (d.coleccion_numero ? ` · nº ${esc(d.coleccion_numero)}` : '')
      : null,
    _formatos: (d.formatos || []).length
      ? d.formatos.map((f) => `<span class="fmt">${esc(f)}</span>`).join('')
      : null,
    _estado: d.estado_verificacion
      ? `<span class="tag ${d.estado_verificacion === 'completado' ? 'ok' : 'warn'}">${esc(d.estado_verificacion)}</span>`
      : null,
    _ubicacion: d.ubicacion
      ? esc([d.ubicacion.ambito, d.ubicacion.estanteria].filter(Boolean).join(' · ')) || null
      : null,
    // Tamaño: MEDIDO con el tapete (ancho_cm × alto_cm, preciso) y/o DECLARADO por la fuente bibliográfica
    // (`dimensiones`, una cadena que casi siempre trae solo el ALTO: «24 cm»). Si hay ambos, manda el medido y
    // el declarado se muestra al lado, atenuado. Antes el declarado no se veía en ninguna parte (905 docs).
    _dimensiones: (() => {
      const medido =
        d.ancho_cm && d.alto_cm
          ? `${esc(String(d.ancho_cm).replace('.', ','))} × ${esc(String(d.alto_cm).replace('.', ','))} cm`
          : null;
      const decl = typeof d.dimensiones === 'string' && d.dimensiones.trim() ? esc(d.dimensiones.trim()) : null;
      if (medido && decl) return `${medido} <span class="muted" style="font-size:11px" title="Tamaño declarado por la fuente bibliográfica">· declarado ${decl}</span>`;
      if (medido) return medido;
      if (decl)
        return `<span title="Tamaño DECLARADO por la fuente bibliográfica (suele ser solo el alto). Mídelo con el tapete para obtener ancho × alto.">${decl} <span class="muted" style="font-size:11px">· declarado</span></span>`;
      return null;
    })(),
    _ingreso: d.fecha_ingreso ? fmtFecha(d.fecha_ingreso) : null,
    _actualizado: d.fecha_actualizacion ? fmtFecha(d.fecha_actualizacion) : null,
    _ruta: d.ruta_base
      ? (() => {
          const rb = d.ruta_base.replace(/^\/recursos/, '');
          return `<span class="mono">${esc(rb)}</span> <button class="rbtn copybtn" data-copy="${esc(rb)}" title="Copiar la ruta">📋</button> <button class="rbtn" onclick="explorarArchivos('${esc(d._id)}','')" title="Explorar los archivos de esta carpeta / colección">🗂️</button>`;
        })()
      : null,
    obra_titulo: r.obra
      ? `<a onclick="verObra('${esc(r.obra._id)}')" class="rowlink">${esc(r.obra.titulo || d.obra_titulo || '(obra)')}</a>`
      : d.obra_titulo
        ? esc(d.obra_titulo)
        : null,
    // _id de Mongo (ObjectId): copiable y —para el admin— DRILLABLE: abre el documento EXACTO de la base en
    // JSON (solo lectura). Al invitado se le muestra el id a secas (el endpoint crudo es solo de admin).
    _oid:
      ROL === 'admin'
        ? `<a class="rowlink mono" data-oid="${esc(d._id)}" title="Ver el documento EXACTO de la base de datos (JSON)">${esc(d._id)}</a> <button class="rbtn copybtn" data-copy="${esc(d._id)}" title="Copiar el ID al portapapeles">📋</button>`
        : `<span class="mono">${esc(d._id)}</span> <button class="rbtn copybtn" data-copy="${esc(d._id)}" title="Copiar el ID al portapapeles">📋</button>`,
    // Identificadores DRILLABLES: clic → Búsqueda por ese ISSN/ISBN (ve TODO lo que lo comparte — útil
    // para destapar libros mal clasificados colgando de un ISSN de serie, o ediciones del mismo ISBN).
    _issn: d.issn
      ? `<a class="rowlink" data-q="${esc(d.issn)}" title="Ver todo lo que comparte este ISSN">${esc(d.issn)}</a>`
      : null,
    _isbn: d.isbn
      ? `<a class="rowlink" data-q="${esc(d.isbn)}" title="Ver todo lo que comparte este ISBN">${esc(d.isbn)}</a> <button class="rbtn copybtn" data-copy="${esc(d.isbn)}" title="Copiar el ISBN al portapapeles">📋</button>`
      : null,
    // DOI (identificador del ARTÍCULO): abre doi.org y se puede copiar. La REVISTA de origen y la CITA
    // (vol/nº/pp) acompañan al artículo, como el ISBN/colección a un libro/número.
    _doi: d.doi
      ? `<a class="rowlink" href="https://doi.org/${esc(d.doi)}" target="_blank" rel="noopener" title="Abrir el DOI en doi.org">${esc(d.doi)} ↗</a> <button class="rbtn copybtn" data-copy="${esc(d.doi)}" title="Copiar el DOI">📋</button>`
      : null,
    _revista: d.revista ? esc(d.revista) : null,
    _cita:
      d.articulo && (d.articulo.volumen || d.articulo.numero || d.articulo.paginas)
        ? esc(
            [
              d.articulo.volumen ? 'vol. ' + d.articulo.volumen : '',
              d.articulo.numero ? 'nº ' + d.articulo.numero : '',
              d.articulo.paginas ? 'pp. ' + d.articulo.paginas : '',
            ]
              .filter(Boolean)
              .join(' · '),
          )
        : null,
    // Otras ediciones (e-ISBN, tapa dura/blanda, obra completa, código de barras…), drillables.
    _isbns_alt:
      d.isbns_alternativos && d.isbns_alternativos.length
        ? d.isbns_alternativos
            .map(
              (a) =>
                `<a class="rowlink" data-q="${esc(a.isbn)}" title="Buscar este ISBN">${esc(a.isbn)}</a> <span class="muted" style="font-size:11px">(${esc(ROL_ISBN[a.rol] || a.rol || 'otra')})</span>`,
            )
            .join('<br>')
        : null,
    _isbn_obra: d.isbn_obra
      ? `<a class="rowlink" data-q="${esc(d.isbn_obra)}" title="Ver todo lo que comparte este ISBN de obra">${esc(d.isbn_obra)}</a>`
      : null,
    // Otros ISSN vistos (e-ISSN, ISSN de serie…) además del principal — drillables. Se filtra el primario.
    _issns_alt: (() => {
      const extra = (d.issn_candidatos || []).filter((x) => x && x !== d.issn);
      return extra.length
        ? [...new Set(extra)].map((x) => `<a class="rowlink" data-q="${esc(x)}" title="Buscar este ISSN">${esc(x)}</a>`).join('<br>')
        : null;
    })(),
    // TÍTULO ORIGINAL (obras traducidas): SOLO si difiere del título del propio documento. En antologías con
    // varios originales, se listan todos. Insensible a acentos/mayúsculas al comparar.
    titulo_original: (() => {
      const nrm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
      const lista = d.titulos_originales && d.titulos_originales.length > 1
        ? d.titulos_originales
        : d.titulo_original ? [d.titulo_original] : [];
      const dif = lista.filter((t) => t && nrm(t) !== nrm(d.titulo));
      return dif.length ? dif.map((t) => `<i>${esc(t)}</i>`).join('<br>') : null;
    })(),
    // IDIOMA ORIGINAL: SOLO si difiere del idioma del propio documento.
    idioma_original: d.idioma_original && d.idioma_original !== d.idioma ? esc(d.idioma_original) : null,
  };
  const valor = (k) => {
    if (k in especiales) return especiales[k];
    let v = d[k];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) return null;
    return esc(v);
  };
  const dl = CAMPOS_FICHA.map(([k, lab]) => {
    const v = valor(k);
    return v ? `<dt>${lab}</dt><dd>${v}</dd>` : '';
  }).join('');
  const sinopsis = d.sinopsis
    ? `<div class="card" style="margin-top:14px"><h3>Sinopsis</h3><p class="sinopsis-text">${esc(d.sinopsis)}</p></div>`
    : '';
  const palabras = (d.palabras_clave || []).length
    ? `<div style="margin-top:12px;display:flex;flex-wrap:wrap;gap:5px">${d.palabras_clave.map((p) => `<span class="tag mut">${esc(p)}</span>`).join('')}</div>`
    : '';
  const clas = (r.clasificaciones || []).length
    ? `<div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--line)"><div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600;margin-bottom:6px">Clasificación</div><table class="clastab">${r.clasificaciones.map((x) => filaClas(x)).join('')}</table></div>`
    : '';
  const alertas = (d.alertas_agente || []).length
    ? `<details style="margin-top:10px"><summary class="muted" style="cursor:pointer;font-size:12px">Notas del agente (${d.alertas_agente.length})</summary><div style="margin-top:6px">${d.alertas_agente.map((a) => `<div class="muted" style="font-size:12px">• ${esc(a)}</div>`).join('')}</div></details>`
    : '';
  const imgs =
    r.imagenes && r.imagenes.length ? r.imagenes : r.portada ? [{ ruta: r.portada, tipo: 'portada' }] : [];
  const nfcOv = nfcBadge(d);
  // (Se retiró el botón ✏️ superpuesto sobre el carrusel: sobraba ahí. La edición está en la fila de
  //  acciones «✏️ Editar», en la cabecera «✏️ Editar» y en el encabezado de la sección Imágenes.)
  // La imagen YA NO se abre al tocarla (abría una pestaña nueva). Ahora se amplía a pantalla completa con la
  // lupa (🔍), que abre la imagen visible del carrusel en un visor (lightbox).
  const carrusel = imgs.length
    ? `<div class="carousel" style="position:relative">${nfcOv}<div class="track" id="carTrack">${imgs.map((im) => `<img src="${esc(encUrl(im.ruta))}" loading="lazy">`).join('')}</div><button class="clupa" onclick="abrirLightbox()" title="Ver la imagen a pantalla completa">🔍</button>${imgs.length > 1 ? `<button class="cnav prev" onclick="carMove(-1)">‹</button><button class="cnav next" onclick="carMove(1)">›</button><div class="cdots" id="carDots">1 / ${imgs.length}</div>` : ''}</div>`
    : `<div class="filebox" style="position:relative">${nfcOv}<div class="ic">🖼️</div><div class="muted">Sin imágenes</div></div>`;
  // ── FICHA MÍNIMA (encabezado vistoso): título → estrellas → [papel: ex-libris | digital: descarga] →
  //    datos (autor/editorial/colección/CDU/ISBN/ISSN, drillables) → [papel: ubicación clicable]. Un badge
  //    en la esquina superior derecha explica al pulsarlo de dónde salen los datos (etiqueta NFC / base). ──
  const _fisico = (d.formatos || []).includes('papel');
  const _tag = !!(d.nfc && (d.nfc.fecha_vinculacion || d.nfc.uid));
  const subDoc = `${esc(d.tipo_recurso || '')}${d.naturaleza ? ' · ' + esc(d.naturaleza) : ''}${d.volumen_numero != null ? ' · tomo ' + esc(d.volumen_numero) : ''}${d.obra_titulo ? ' · ' + esc(recortar(d.obra_titulo, 40)) : ''}`;
  const origen = _fisico
    ? _tag
      ? 'Estos son los datos que lleva grabada la etiqueta NFC de este ejemplar.'
      : 'Ficha reconstruida a partir de la base de datos (este ejemplar aún no tiene etiqueta NFC).'
    : 'Ejemplar digital: en vez de ubicación física se ofrece la descarga.';
  const filasFmin = [
    // Título original (solo si difiere del título) + el IDIOMA original entre paréntesis al lado (solo si
    // difiere del idioma del doc). Ambas guardas viven en `especiales`.
    ['Título original', especiales.titulo_original
      ? especiales.titulo_original + (especiales.idioma_original ? ` <span class="muted">(${especiales.idioma_original})</span>` : '')
      : null],
    ['Autor', especiales._autores],
    ['Editorial', especiales._editorial],
    ['Colección', especiales._coleccion],
    ['Revista', especiales._revista],
    ['CDU', d.cdu ? `<span class="mono">${esc(d.cdu)}</span>` : null],
    ['ISBN', especiales._isbn],
    ['ISSN', especiales._issn],
    ['DOI', especiales._doi],
    ['Cita', especiales._cita],
  ]
    .filter((p) => p[1])
    .map((p) => `<dt>${p[0]}</dt><dd>${p[1]}</dd>`)
    .join('');
  const ubicFmin = (() => {
    // DIGITAL → estantería virtual por CDU: el propio código es el «estante» (con su descripción) y su
    // CDU inmediatamente superior el «ámbito». La descripción del estante ya viene en r.clasificaciones;
    // la del ámbito se rellena luego (fetch async, ver más abajo). Compañeros = digitales de esa CDU.
    if (!_fisico) {
      if (!d.cdu) return `<div class="fmin-ubic"><div class="lbl">Ubicación</div><div class="val"><span class="muted">Sin clasificar (asigna una CDU)</span></div></div>`;
      const clasCdu = (r.clasificaciones || []).find((x) => x.sistema === 'cdu' && String(x.codigo) === String(d.cdu));
      const descCdu = clasCdu && clasCdu.titulo ? ' · ' + esc(clasCdu.titulo) : '';
      const padre = cduPadre(d.cdu);
      const estante = `<span class="rowlink" id="ubicChip" data-cdu="${esc(d.cdu)}" style="color:var(--acc);cursor:pointer" title="Estante virtual por CDU · toca para ver los demás documentos digitales de este estante">📚 <span class="mono">${esc(d.cdu)}</span>${descCdu}</span>`;
      const amb = padre
        ? `<div class="muted" style="font-size:12px;margin-top:3px">Ámbito: <span class="rowlink" id="ubicAmbDig" data-cdu="${esc(padre)}" style="cursor:pointer" title="Toca para ver el ámbito superior">📂 <span class="mono">${esc(padre)}</span></span></div>`
        : '';
      return `<div class="fmin-ubic"><div class="lbl">Ubicación digital</div><div class="val">${estante}${amb}</div></div>`;
    }
    return `<div class="fmin-ubic"><div class="lbl">Ubicación</div><div class="val" style="display:flex;align-items:center;gap:8px">${_txtUbic(d) || ROL === 'admin' ? `<span class="rowlink" id="ubicChip" style="color:var(--acc);cursor:pointer" title="Toca para ver los libros de esta estantería">📍 ${esc(_txtUbic(d) || 'Sin asignar')}</span>${ROL === 'admin' ? '<button id="ubicEditBtn" class="btn" title="Cambiar la ubicación" style="padding:1px 8px;font-size:12px">✏️</button>' : ''}` : '<span class="muted">Sin asignar</span>'}</div></div>`;
  })();
  // Bajo el exlibris: la OBRA (con el ordinal del volumen, «Vol.: III») y la COLECCIÓN (con el nº del
  // libro/obra dentro de la colección, «Nº 678»). Primero la obra, luego la colección. Ambas clicables.
  const obraColFmin = (() => {
    const filas = [];
    const obraTit = (r.obra && r.obra.titulo) || d.obra_titulo;
    if (obraTit) {
      const obraLink = r.obra && r.obra._id ? `<a class="rowlink" onclick="verObra('${esc(r.obra._id)}')">${esc(obraTit)}</a>` : esc(obraTit);
      const vol = d.volumen_numero != null ? ` <b>Vol.: ${aRomano(d.volumen_numero)}</b>` : '';
      filas.push(`<div class="fmin-oc-fila"><span class="lbl">Obra</span> <span>${obraLink}${vol}</span></div>`);
    }
    if (r.coleccion) {
      const colLink = r.coleccion_id ? `<a class="rowlink" data-colid="${esc(r.coleccion_id)}" data-colnom="${esc(r.coleccion)}">${esc(r.coleccion)}</a>` : esc(r.coleccion);
      const num = d.coleccion_numero ? ` <b>Nº ${esc(d.coleccion_numero)}</b>` : '';
      filas.push(`<div class="fmin-oc-fila"><span class="lbl">Colección</span> <span>${colLink}${num}</span></div>`);
    }
    return filas.length ? `<div class="fmin-obracol">${filas.join('')}</div>` : '';
  })();
  const fmin = fichaMinima({
    titulo: d.titulo,
    subtitulo: d.subtitulo || subDoc,
    esDigital: !_fisico,
    exlibris: EX_LIBRIS,
    descargaUrl: r.archivo_url ? encUrl(r.archivo_url) : '',
    descargaNombre: r.nombre_archivo || '',
    estrellasHTML: ratingBar('documentos', d._id, d.valoracion, d.nsfw) + ' ' + badgesDoc(d),
    datosHTML: filasFmin,
    obraColHTML: obraColFmin,
    ubicacionHTML: ubicFmin,
    tipoFormatoHTML: badgesTipoFormato(d),
    editable: ROL === 'admin',
    origen,
  });
  // Debajo de la ficha, secciones PLEGABLES y colapsadas por defecto (acciones, imágenes, lectura, datos, sinopsis).
  const botones = `<div class="det-acts">
      <button class="fbtn admin-only" id="actEdit" title="Editar los datos a mano (y bloquear para que el Conformador no los cambie)">✏️ Editar</button>
      <button class="fbtn" id="actArchivos" title="Explorar y descargar TODOS los archivos de este documento / su colección (también los no catalogados: vídeos, extras…)">🗂️ Archivos</button>
      <button class="fbtn admin-only" id="actAdjuntar" title="COMPLETAR el documento con los ficheros que le faltan: el PDF/EPUB de un audiolibro que solo tiene audio, o los audios de un libro que solo tiene texto. Se adjuntan a su carpeta: el audio va a la playlist y el texto al selector del visor.">📎 Adjuntar audio/texto</button>
      <button class="fbtn admin-only" id="actImgs" title="Gestionar las imágenes: reordenar, borrar, añadir, rotar/recortar/corregir perspectiva">🖼️ Imágenes</button>
      <button class="fbtn admin-only" id="actMedir" title="Estimar el tamaño físico del libro (cm) sobre la alfombrilla reglada">📐 Medir</button>
      <button class="fbtn admin-only" id="actConf" title="Ejecuta el Conformador solo sobre este documento (portada, re-clasificar CDU, sidecars…)">🧹 Conformar</button>
      <button class="fbtn admin-only" id="actEnr" title="Re-consulta las APIs/IA para mejorar este documento (rellena huecos)">✨ Enriquecer</button>
      <button class="fbtn admin-only" id="actAFondo" title="Lee las PÁGINAS del propio libro (portadilla/contraportada) con la visión y propone autores/roles reales, sinopsis e identificadores. Muestra un balance antes/después para aplicar lo que elijas.">🎯 Completar a fondo</button>
      <button class="fbtn admin-only" id="actShare" title="Genera un QR/enlace para compartir esta ficha (y su descarga, si es digital)">🔗 Compartir</button>
      <button class="fbtn admin-only" id="actNfc" style="display:none" title="Graba una etiqueta NFC (NTAG215) con esta ficha: al acercar el móvil se abrirá este documento">📶 Grabar NFC</button>
      <button class="fbtn admin-only" id="actTipo" title="Cambiar el tipo a mano: libro / revista / cómic">🔀 Cambiar tipo</button>
      <button class="fbtn bad admin-only" id="actRepr" title="Devuelve el fichero al Inbox y re-cataloga de cero (recicla la carpeta actual)">♻️ Reprocesar</button>
      <button class="fbtn bad admin-only" id="actDel" title="Borra el documento y su carpeta (sidecars/imágenes → Papelera, recuperable)">🗑 Eliminar</button>
    </div>`;
  const lector = _fisico ? '' : previewArchivo(r);
  const secAcc = `<details class="card foldcard admin-only" style="margin-top:14px"><summary>⚙️ Acciones</summary>${botones}</details>`;
  const secImg = `<details class="card foldcard" open style="margin-top:14px"><summary>🖼️ Imágenes</summary><div style="margin-top:10px"><div class="row admin-only" style="margin-bottom:8px"><button class="btn" id="actImgsCar" title="Gestionar las imágenes: reordenar, borrar, añadir, rotar/recortar/corregir perspectiva">✏️ Editar</button></div>${carrusel}</div></details>`;
  const secLect = lector
    ? `<details class="card foldcard" id="lectDet" open style="margin-top:14px"><summary>📖 Leer / archivo</summary><div style="margin-top:10px">${lector}</div></details>`
    : '';
  const secCat = `<details class="card foldcard" style="margin-top:14px"><summary>📚 Datos catalográficos</summary><div style="margin-top:10px"><dl class="dl">${dl}</dl>${clas}${palabras}${alertas}</div></details>`;
  const secSin = d.sinopsis
    ? `<details class="card foldcard" open style="margin-top:14px"><summary>📝 Sinopsis</summary><p class="sinopsis-text" style="margin-top:10px">${esc(d.sinopsis)}</p></details>`
    : '';
  // 🩺 Salud: plegable, admin-only, carga perezosa al abrir (checklist de tareas de mantenimiento).
  const secSalud = `<details class="card foldcard admin-only" id="saludDet" style="margin-top:14px"><summary>🩺 Salud del documento</summary><div id="saludBody" class="muted" style="margin-top:10px">Abre para ver el estado de mantenimiento…</div></details>`;
  // Navegación entre documentos (⏮◀ N/M ▶⏭): recorre TODOS los resultados de la búsqueda del Catálogo
  // (no solo la página). El contenedor #fichaNav se rellena async (los ids se traen y cachean por búsqueda).
  // Imágenes y sinopsis DESPLEGADAS y ANTES de las acciones; el resto (lectura, catalográficos, salud) plegado, después.
  $('#p-detalle').innerHTML =
    `${crumb}<div class="row" style="margin:2px 0 12px;align-items:center;gap:8px"><button class="det-back" title="Volver" onclick="${back}">←</button><div id="fichaNav" class="row" style="margin-left:auto;gap:4px;align-items:center"></div></div>${fmin}${secImg}${secSin}${secAcc}${secLect}${secCat}${secSalud}`;
  pintarNavFicha(d._id, ctx);
  attachClas('#p-detalle');
  attachRating('#p-detalle');
  $$('#p-detalle .copybtn').forEach(
    (b) =>
      (b.onclick = (e) => {
        e.stopPropagation();
        copiar(b.dataset.copy);
      }),
  );
  {
    const cf = $('#actConf'),
      ce = $('#actEnr'),
      cr = $('#actRepr');
    if (cf) cf.onclick = () => fichaAccion('conformar', d._id, cf);
    if (ce) ce.onclick = () => fichaAccion('enriquecer', d._id, ce);
    if (cr) cr.onclick = () => fichaReprocesar(d._id);
    if ($('#actTipo')) $('#actTipo').onclick = () => cambiarTipoDocs([d._id]);
    const caf = $('#actAFondo');
    if (caf) caf.onclick = () => completarAFondo(d._id, caf);
    // 🩺 Salud: carga perezosa del checklist la primera vez que se despliega la sección.
    const saludDet = $('#saludDet');
    if (saludDet)
      saludDet.addEventListener('toggle', () => {
        if (saludDet.open && !saludDet._cargada) {
          saludDet._cargada = true;
          cargarSalud(d._id);
        }
      });
    const cd = $('#actDel');
    if (cd) cd.onclick = () => fichaEliminar(d._id);
    const ce2 = $('#actEdit');
    if (ce2) ce2.onclick = () => fichaEditar(d, r);
    if ($('#fminEdit')) $('#fminEdit').onclick = () => fichaEditar(d, r); // «✏️ Editar» de la cabecera
    if ($('#actArchivos')) $('#actArchivos').onclick = () => explorarArchivos(d._id);
    if ($('#actAdjuntar')) $('#actAdjuntar').onclick = () => adjuntarADoc(d._id, r);
    const editarImgs = () => editarImagenes(d._id, r.imagenes || (r.portada ? [{ ruta: r.portada, tipo: 'portada' }] : []), { url: r.archivo_url, nombre: r.nombre_archivo });
    if ($('#actImgs')) $('#actImgs').onclick = editarImgs;
    if ($('#actImgsCar')) $('#actImgsCar').onclick = editarImgs; // duplicado en el encabezado del carrusel
    const cm2 = $('#actMedir');
    if (cm2)
      cm2.onclick = () =>
        medirDimensiones(d._id, r.imagenes || (r.portada ? [{ ruta: r.portada, tipo: 'portada' }] : []));
    // Grabar NFC: solo para ejemplares EN PAPEL (un medio digital no se etiqueta) y en navegadores con Web
    // NFC (Android + Chrome). En el resto queda oculto.
    const cn = $('#actNfc');
    if (cn && _fisico && 'NDEFReader' in window) {
      cn.style.display = '';
      cn.onclick = () => grabarNFC(d, r);
    }
    const cs = $('#actShare');
    if (cs) cs.onclick = () => compartirDoc(d);
    const uc = $('#ubicChip');
    if (uc && !_fisico) {
      // DIGITAL: estante virtual por CDU. Tap = compañeros de estantería (digitales de esa CDU). No hay
      // edición de ubicación (los digitales no tienen ubicación física). El «ámbito» (CDU superior)
      // también navega, y su descripción se rellena de forma perezosa (el estante ya la trae).
      const cdu = uc.dataset.cdu;
      uc.onclick = () => verEstanteriaDigital(cdu);
      const amb = $('#ubicAmbDig');
      if (amb) {
        const padre = amb.dataset.cdu;
        amb.onclick = () => verEstanteriaDigital(padre, { prefijo: true });
        api('/clasificacion?sistema=cdu&codigo=' + encodeURIComponent(padre))
          .then((res) => {
            if (res && res.ok && res.titulo && document.body.contains(amb)) amb.insertAdjacentHTML('beforeend', ' · ' + esc(res.titulo));
          })
          .catch(() => {});
      }
    } else if (uc) {
      const u = d.ubicacion || {};
      const filtrar = () => {
        if (!u.ambito || u.ambito === 'Sin asignar') { if (ROL === 'admin') editarUbicacionRapida(d); return; }
        verEstanteriaEnCatalogo(u.ambito, u.estanteria && u.estanteria !== 'Sin asignar' ? u.estanteria : '');
      };
      // Clic/toque = ver los libros de la estantería; doble clic / pulsación larga (admin) = cambiar la
      // ubicación. Además, el botón ✏️ contiguo la cambia directamente (acceso rápido y evidente).
      if (ROL === 'admin') attachGesto(uc, filtrar, () => editarUbicacionRapida(d));
      else uc.onclick = filtrar;
    }
    if ($('#ubicEditBtn')) $('#ubicEditBtn').onclick = () => editarUbicacionRapida(d);
  }
  $$('#p-detalle [data-colid]').forEach((a) => (a.onclick = () => verColeccion(a.dataset.colid)));
  $$('#p-detalle [data-q]').forEach((a) => (a.onclick = () => buscarTexto(a.dataset.q)));
  // Autor/contribuyente clicable → abre su ficha (modal) sobre la ficha del libro. (La editorial, en el futuro.)
  $$('#p-detalle [data-autid]').forEach((a) => (a.onclick = () => autorFicha(a.dataset.autid)));
  // ID de Mongo → ver el documento EXACTO de la base (JSON, solo lectura).
  $$('#p-detalle [data-oid]').forEach((a) => (a.onclick = () => verDocumentoCrudo(a.dataset.oid)));
  carIdx = 0;
  const tr = $('#carTrack');
  if (tr && tr.children.length > 1)
    tr.onscroll = () => {
      const i = Math.round(tr.scrollLeft / tr.clientWidth);
      if (i !== carIdx) {
        carIdx = i;
        const dd = $('#carDots');
        if (dd) dd.textContent = i + 1 + ' / ' + tr.children.length;
      }
    };
  // Lector embebido (PDF/EPUB/cómic): se inicializa PEREZOSAMENTE al abrir su sección plegable (evita
  // renderizar en un contenedor oculto de tamaño 0 y no descarga el fichero hasta que se pide leerlo).
  // VARIOS TEXTOS (`textos[]`): al elegir otro en el selector pasa a ser el que abre el visor. Es un cambio de
  // VISTA (solo cliente): el texto PRINCIPAL del documento (`nombre_archivo`) no se toca. Se re-pinta la sección
  // de lectura y se re-inicializa el lector con el texto elegido.
  const cableaSelTextos = () => {
    const s = $('#txtSel');
    if (!s) return;
    s.onchange = () => {
      const t = (r.textos || [])[+s.value];
      if (!t || !t.ruta) return;
      r.archivo_url = t.ruta;
      r.nombre_archivo = t.ruta.split('/').pop();
      const cont = $('#lectDet') && $('#lectDet').querySelector('div');
      if (!cont) return;
      cont.innerHTML = previewArchivo(r);   // re-pinta el visor del texto elegido (y el selector, ya marcado)
      initLector();
    };
  };
  const initLector = () => {
    const nom = (r.nombre_archivo || '').toLowerCase();   // se lee en CADA init: puede cambiar con el selector
    if (r.archivo_url && nom.endsWith('.epub')) iniciarLectorEpub(encUrl(r.archivo_url));
    else if (r.archivo_url && nom.endsWith('.pdf')) iniciarLectorPdf(encUrl(r.archivo_url));
    else if (/\.(cbz|cbr|cb7|djvu)$/.test(nom)) iniciarLectorComic(d._id);
    else if (/\.(mobi|azw3?)$/.test(nom)) iniciarLectorMobi(d._id);
    else if (nom.endsWith('.chm')) iniciarLectorChm(d._id);
    else if (/\.docx?$/.test(nom)) iniciarLectorWord(d._id, r.nombre_archivo);  // `f`: el texto elegido en el selector
    else if (d.tipo_recurso === 'software') iniciarExploradorSoftware(d._id);
    if (r.audios && r.audios.length) iniciarReproductorAudio(r.doc && r.doc._id, r.audios); // audiolibro / lectura con audio: playlist
    cableaSelTextos();
  };
  const ld = $('#lectDet');
  if (ld) {
    let hecho = false;
    const arranca = () => {
      if (!hecho) {
        hecho = true;
        initLector();
      }
    };
    if (ld.open) arranca();
    else
      ld.addEventListener('toggle', () => {
        if (ld.open) arranca();
      });
  }
}

// ── visor PAGINADO (cómic .cbz/.cbr/.cb7 y .djvu): páginas servidas por /documentos/:id/paginas[/:n] bajo demanda ──
let comicState = null;
async function iniciarLectorComic(id) {
  const wrap = $('#comicWrap'),
    msg = $('#comicMsg'),
    img = $('#comicImg');
  if (!wrap || !img) return;
  if (comicState) {
    for (const u of comicState.blobs.values()) URL.revokeObjectURL(u);
  } // liberar el cómic anterior
  comicState = { id, n: 0, total: 0, blobs: new Map() };
  try {
    const r = await api('/documentos/' + encodeURIComponent(id) + '/paginas');
    const total = r.paginas || 0;
    if (!total) {
      if (msg) msg.textContent = 'No se pudieron extraer las páginas de este documento.';
      return;
    }
    comicState.total = total;
    $('#comicTotal').textContent = total;
    $('#comicBar').style.display = '';
    $('#comicFs').style.display = '';
    if (total > 1) {
      $('#comicPrev').style.display = '';
      $('#comicNext').style.display = '';
    }
    $('#comicPrev').onclick = () => comicIr(-1);
    $('#comicNext').onclick = () => comicIr(1);
    $('#comicFs').onclick = () => wrap.classList.toggle('full');
    img.onclick = () => comicIr(1); // clic en la página → siguiente
    await comicMostrar(0);
  } catch (e) {
    if (msg) msg.textContent = e.message;
  }
}
async function comicBlob(n) {
  if (comicState.blobs.has(n)) return comicState.blobs.get(n);
  const res = await fetch('/api/documentos/' + encodeURIComponent(comicState.id) + '/paginas/' + n, {
    headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},
  });
  if (!res.ok) throw new Error('no se pudo cargar la página ' + (n + 1));
  const u = URL.createObjectURL(await res.blob());
  comicState.blobs.set(n, u);
  return u;
}
async function comicMostrar(n) {
  const img = $('#comicImg'),
    msg = $('#comicMsg');
  if (!img || !comicState) return;
  try {
    const u = await comicBlob(n);
    img.src = u;
    comicState.n = n;
    $('#comicCur').textContent = n + 1;
    if (msg) msg.style.display = 'none';
    if (n + 1 < comicState.total) comicBlob(n + 1).catch(() => {}); // prefetch de la siguiente
  } catch (e) {
    if (msg) {
      msg.style.display = '';
      msg.textContent = e.message;
    }
  }
}
function comicIr(d) {
  if (!comicState) return;
  const n = Math.max(0, Math.min(comicState.total - 1, comicState.n + d));
  if (n !== comicState.n) comicMostrar(n);
}

let carIdx = 0;
function carMove(dir) {
  const t = $('#carTrack');
  if (!t) return;
  const n = t.children.length;
  carIdx = Math.max(0, Math.min(n - 1, carIdx + dir));
  t.scrollTo({ left: t.clientWidth * carIdx, behavior: 'smooth' });
  const dd = $('#carDots');
  if (dd) dd.textContent = carIdx + 1 + ' / ' + n;
}

// ── VISOR A PANTALLA COMPLETA (lightbox) del carrusel ──────────────────────────────────────────────
// Se abre con la lupa (🔍) — ya NO al tocar la imagen. Muestra la imagen VISIBLE del carrusel sobre fondo
// oscuro; se cierra con ✕, clic fuera o Esc, y se navega con ‹ › (o ←/→) si hay varias imágenes.
let _lb = null; // { srcs: string[], idx }
function abrirLightbox() {
  const track = $('#carTrack');
  if (!track) return;
  const srcs = [...track.querySelectorAll('img')].map((im) => im.src);
  if (!srcs.length) return;
  const idx = track.clientWidth ? Math.round(track.scrollLeft / track.clientWidth) : 0;
  _lb = { srcs, idx: Math.max(0, Math.min(srcs.length - 1, idx)) };
  let ov = $('#lightbox');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'lightbox';
    ov.onclick = (e) => { if (e.target === ov) cerrarLightbox(); }; // clic en el fondo (no en la imagen) cierra
    document.body.appendChild(ov);
  }
  document.addEventListener('keydown', lbKey);
  ov.style.display = 'flex';
  pintarLightbox();
}
function pintarLightbox() {
  const ov = $('#lightbox');
  if (!ov || !_lb) return;
  const { srcs, idx } = _lb;
  const nav = srcs.length > 1
    ? `<button class="lbnav prev" id="lbPrev" title="Anterior">‹</button><button class="lbnav next" id="lbNext" title="Siguiente">›</button><div class="lbdots">${idx + 1} / ${srcs.length}</div>`
    : '';
  ov.innerHTML = `<img src="${esc(srcs[idx])}" alt=""><button class="lbx" id="lbCerrar" title="Cerrar (Esc)">✕</button>${nav}`;
  $('#lbCerrar').onclick = cerrarLightbox;
  if ($('#lbPrev')) $('#lbPrev').onclick = () => lbMove(-1);
  if ($('#lbNext')) $('#lbNext').onclick = () => lbMove(1);
}
function lbMove(d) {
  if (!_lb) return;
  _lb.idx = (_lb.idx + d + _lb.srcs.length) % _lb.srcs.length;
  pintarLightbox();
}
function lbKey(e) {
  if (e.key === 'Escape') cerrarLightbox();
  else if (e.key === 'ArrowLeft') lbMove(-1);
  else if (e.key === 'ArrowRight') lbMove(1);
}
function cerrarLightbox() {
  const ov = $('#lightbox');
  if (ov) ov.style.display = 'none';
  document.removeEventListener('keydown', lbKey);
  _lb = null;
}

// ── valoración (estrellas, estilo Lightroom) + quitar (⊘) + NSFW (🔞) — para documentos / obras / colecciones ──
// `ent` = 'documentos' | 'obras' | 'colecciones'. La valoración es por nivel (independiente); marcar NSFW en
// una obra/colección oculta a los invitados todos sus miembros (actuales y futuros).
// Barra de valoración (0-5★) de un documento/obra/colección (`ent` = entidad, `id`). El invitado solo la
// VE (solo lectura); el admin puede valorar, quitar la valoración y marcar NSFW. Ver attachRating (eventos).
function ratingBar(ent, id, valoracion, nsfw) {
  valoracion = Number(valoracion) || 0;
  const admin = ROL === 'admin';
  const estrellasHtml = [5, 4, 3, 2, 1]
    .map((n) => `<span class="st${n <= valoracion ? ' on' : ''}" data-v="${n}">★</span>`)
    .join(''); // 5→1 + row-reverse: relleno al pasar el ratón
  // Invitado: solo VE la valoración (estrellas de solo lectura, sin botones de quitar/NSFW ni clic).
  if (!admin)
    return `<span class="ratebar ro"><span class="stars ro" title="Valoración: ${valoracion}/5">${estrellasHtml}</span></span>`;
  return (
    `<span class="ratebar" data-ent="${ent}" data-id="${esc(id)}" data-v="${valoracion}">` +
    `<button class="rbtn rclear" title="Quitar valoración (0★)">⊘</button>` +
    `<span class="stars" title="Valora (clic en una estrella; repite la misma para quitar)">${estrellasHtml}</span>` +
    `<button class="rbtn rnsfw${nsfw ? ' on' : ''}" title="Marcar / quitar NSFW (oculto a invitados)">🔞</button>` +
    `</span>`
  );
}
function attachRating(scope) {
  $$(scope + ' .ratebar:not(.ro)').forEach((bar) => {
    const ent = bar.dataset.ent,
      id = bar.dataset.id;
    const setVal = async (nv) => {
      try {
        await api('/' + ent + '/' + encodeURIComponent(id) + '/valoracion', {
          method: 'POST',
          body: JSON.stringify({ valoracion: nv }),
        });
        bar.dataset.v = nv;
        bar.querySelectorAll('.st').forEach((x) => x.classList.toggle('on', Number(x.dataset.v) <= nv));
        toast(nv ? 'Valorado con ' + nv + '★' : 'Valoración quitada');
      } catch (e) {
        toast(e.message, 'bad');
      }
    };
    bar.querySelectorAll('.st').forEach(
      (s) =>
        (s.onclick = (e) => {
          e.stopPropagation();
          const n = Number(s.dataset.v),
            cur = Number(bar.dataset.v) || 0;
          setVal(n === cur ? 0 : n);
        }),
    );
    const clr = bar.querySelector('.rclear');
    if (clr)
      clr.onclick = (e) => {
        e.stopPropagation();
        setVal(0);
      };
    const nb = bar.querySelector('.rnsfw');
    if (nb)
      nb.onclick = async (e) => {
        e.stopPropagation();
        const nv = !nb.classList.contains('on');
        try {
          const r = await api('/' + ent + '/' + encodeURIComponent(id) + '/nsfw', {
            method: 'POST',
            body: JSON.stringify({ nsfw: nv }),
          });
          nb.classList.toggle('on', nv);
          const ext = r.propagado ? ` (${r.propagado} miembro${r.propagado === 1 ? '' : 's'})` : '';
          toast((nv ? 'Marcado NSFW 🔞' : 'NSFW quitado') + ext);
          if (r.propagado && detalle && (detalle.tipo === 'obra' || detalle.tipo === 'coleccion')) {
            detalle.tipo === 'obra' ? verObra(detalle.id) : verColeccion(detalle.id);
          } // refrescar badges de los miembros
        } catch (err) {
          toast(err.message, 'bad');
        }
      };
  });
}

// ── 🩺 Salud del documento: checklist de tareas de mantenimiento (firma) + forzar conformar/enriquecer ──
// Muestra, por cada tarea, si está HECHA a su versión y si le APLICA. Desmarcar una tarea = pedir que se
// vuelva a ejecutar (des-sellar) y luego Conformar; el diff de cambios se muestra con mostrarCambios().
async function cargarSalud(id) {
  const box = $('#saludBody');
  if (!box) return;
  box.classList.add('muted');
  box.textContent = 'Cargando…';
  let r;
  try {
    r = await api('/documentos/' + encodeURIComponent(id) + '/salud');
  } catch (e) {
    box.textContent = e.message;
    return;
  }
  const s = r.salud || {};
  box.classList.remove('muted');
  const flags = [
    s.conforme ? '<span class="tag ok">conforme</span>' : '<span class="tag warn">pendiente</span>',
    s.locked ? '<span class="tag mut">🔒 bloqueado</span>' : '',
    s.cdu_manual ? '<span class="tag mut">CDU manual</span>' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const filas = (s.tareas || [])
    .map((t) => {
      const estado = !t.aplica
        ? '<span class="tag mut">no aplica</span>'
        : t.hecha
          ? '<span class="tag ok">hecha</span>'
          : '<span class="tag warn">pendiente</span>';
      return `<label class="saludrow"><input type="checkbox" data-tarea="${esc(t.id)}" data-hecha="${t.hecha ? '1' : ''}" ${t.hecha ? 'checked' : ''}>
        <span class="saludid mono">${esc(t.id)}</span><span class="muted saluddesc">${esc(t.descripcion || '')}</span>${estado}</label>`;
    })
    .join('');
  box.innerHTML = `<div style="margin-bottom:8px">${flags}</div>
     <div class="muted" style="font-size:12px;margin-bottom:8px">Desmarca las tareas que quieras volver a ejecutar y pulsa «Forzar lo desmarcado». Verás qué cambió.</div>
     <div class="saludlist">${filas || '<div class="muted">Sin tareas.</div>'}</div>
     <div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap">
       <button class="btn pri" id="saludForzar">🔄 Forzar lo desmarcado</button>
       <button class="btn" id="saludConf">🧹 Conformar pendientes</button>
       <button class="btn" id="saludEnr">✨ Enriquecer</button>
     </div>`;
  if ($('#saludForzar')) $('#saludForzar').onclick = () => saludForzar(id);
  if ($('#saludConf')) $('#saludConf').onclick = () => saludConformar(id, false);
  if ($('#saludEnr')) $('#saludEnr').onclick = () => saludConformar(id, true);
}
// Des-sella las tareas que estaban HECHAS y el usuario ha DESMARCADO, y luego Conforma (las re-ejecuta).
async function saludForzar(id) {
  const desmarcadas = $$('#saludBody [data-tarea]')
    .filter((cb) => cb.dataset.hecha === '1' && !cb.checked)
    .map((cb) => cb.dataset.tarea);
  if (!desmarcadas.length) {
    toast('No has desmarcado ninguna tarea ya hecha', 'warn');
    return;
  }
  try {
    await api('/documentos/' + encodeURIComponent(id) + '/salud/dessellar', {
      method: 'POST',
      body: JSON.stringify({ tareas: desmarcadas }),
    });
    await saludConformar(id, false);
  } catch (e) {
    toast(e.message, 'bad');
  }
}
// Ejecuta Conformar (o Enriquecer) sobre el doc, muestra el diff y refresca el checklist (sin recargar la ficha).
async function saludConformar(id, enriquecer) {
  const tipo = enriquecer ? 'enriquecer' : 'conformar';
  try {
    const r = await api('/documentos/' + encodeURIComponent(id) + '/' + tipo, { method: 'POST', body: '{}' });
    if (!r.ok) {
      toast(r.motivo || 'sin cambios', 'warn');
      cargarSalud(id);
      return;
    }
    mostrarCambios(enriquecer ? 'Enriquecedor' : 'Conformador', r.cambios || []);
    cargarSalud(id);
  } catch (e) {
    toast(e.message, 'bad');
  }
}

// ── acciones de la ficha: Conformar / Enriquecer (con resumen de cambios) y Reprocesar ──
async function fichaAccion(tipo, id, btn) {
  const lbl = btn.innerHTML;
  btn.disabled = true;
  btn.textContent = tipo === 'conformar' ? '⏳ Conformando…' : '⏳ Enriqueciendo…';
  try {
    const r = await api('/documentos/' + encodeURIComponent(id) + '/' + tipo, { method: 'POST', body: '{}' });
    if (!r.ok) {
      toast(r.motivo || 'sin cambios', 'warn');
      return;
    }
    const cambios = r.cambios || [];
    mostrarCambios(tipo === 'conformar' ? 'Conformador' : 'Enriquecedor', cambios);
    if (cambios.length) verDoc(id, detalle && detalle.ctx); // refrescar la ficha con el nuevo estado
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.innerHTML = lbl;
  }
}
function mostrarCambios(titulo, cambios) {
  const fila = (c) =>
    `<tr><td class="k">${esc(c.campo)}</td><td>${c.de != null && c.de !== '' ? `<span class="de">${esc(recortar(String(c.de), 80))}</span><br>` : ''}<span class="a">${esc(recortar(String(c.a), 140)) || '—'}</span></td></tr>`;
  const cuerpo = cambios.length
    ? `<table class="chgtab">${cambios.map(fila).join('')}</table>`
    : '<div class="muted">Sin cambios: el documento ya estaba al día.</div>';
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:540px"><h3 style="margin-top:0">${esc(titulo)} — ${cambios.length} cambio${cambios.length === 1 ? '' : 's'}</h3>${cuerpo}<div style="margin-top:14px;text-align:right"><button class="btn" id="chgClose">Cerrar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#chgClose').onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
}
// ── Completar a fondo (modo SUPERVISADO): previsualiza leyendo el libro y muestra un balance a aplicar ──
async function completarAFondo(id, btn) {
  const prev = btn ? btn.textContent : '';
  if (btn) {
    btn.disabled = true;
    btn.textContent = '🎯 Leyendo el libro…';
  }
  let r;
  try {
    r = await api('/documentos/' + encodeURIComponent(id) + '/a-fondo', { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    toast(e.message, 'bad');
    return;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = prev;
    }
  }
  if (!r.ok) {
    toast(r.motivo || 'no se pudo leer el documento', 'warn');
    return;
  }
  mostrarBalanceAFondo(id, r);
}
// Modal del BALANCE (antes/después + calidad). Casillas para elegir qué aplicar; las «sugerencias» son solo informativas.
function mostrarBalanceAFondo(id, r) {
  const cal = r.calidad || { puntuacion: 0, merecePena: false };
  const aplicables = (r.balance || []).filter((b) => !b.soloSugerencia);
  const sugerencias = (r.balance || []).filter((b) => b.soloSugerencia);
  const veredicto = cal.merecePena
    ? `<span class="tag ok">merece la pena</span>`
    : `<span class="tag warn">aporta poco</span>`;
  const fila = (b) => `<tr>
      <td style="vertical-align:top"><label style="display:flex;gap:6px;align-items:flex-start;cursor:pointer"><input type="checkbox" class="afChk" data-campo="${esc(b.campo)}" checked style="margin-top:3px"> <b>${esc(b.campo)}</b></label></td>
      <td>${b.antes != null && b.antes !== '' ? `<span class="muted" style="font-size:12px">${esc(recortar(String(b.antes), 80))}</span><br>` : ''}<span class="a">${esc(recortar(String(b.despues), 160)) || '—'}</span><div class="muted" style="font-size:10px;margin-top:2px">${esc(b.fuente || '')}</div></td>
    </tr>`;
  const cuerpo = aplicables.length
    ? `<table class="chgtab">${aplicables.map(fila).join('')}</table>`
    : '<div class="muted" style="margin-top:8px">Sin mejoras aplicables (el documento ya tiene esos datos, o la visión no leyó nada nuevo).</div>';
  const sug = sugerencias.length
    ? `<div class="muted" style="font-size:12px;margin-top:10px;border-top:1px solid var(--line);padding-top:8px"><b>Sugerencias</b> (no se aplican solas): ${sugerencias.map((s) => `${esc(s.campo)} → ${esc(s.despues)}`).join(' · ')}</div>`
    : '';
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:600px;max-height:90vh;overflow:auto">
    <h3 style="margin-top:0">🎯 Completar a fondo</h3>
    <div class="muted" style="font-size:12px;margin-bottom:10px">Calidad de la lectura: <b>${cal.puntuacion}/100</b> ${veredicto}${cal.señales && cal.señales.length ? ' · ' + cal.señales.map((s) => esc(s)).join(' · ') : ''}</div>
    ${cuerpo}${sug}
    <div class="row" style="gap:8px;margin-top:14px;justify-content:flex-end">
      ${aplicables.length ? '<button class="btn pri" id="afAplicar">Aplicar seleccionados</button>' : ''}
      <button class="btn" id="afCerrar">Cerrar</button>
    </div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = cerrarCmp;
  $('#afCerrar').onclick = cerrarCmp;
  if ($('#afAplicar'))
    $('#afAplicar').onclick = async () => {
      const campos = $$('#cmpModal .afChk:checked').map((c) => c.dataset.campo);
      if (!campos.length) {
        toast('Marca al menos un campo', 'warn');
        return;
      }
      $('#afAplicar').disabled = true;
      $('#afAplicar').textContent = 'Aplicando…';
      try {
        const r2 = await api('/documentos/' + encodeURIComponent(id) + '/a-fondo/aplicar', {
          method: 'POST',
          body: JSON.stringify({ propuesta: r.propuesta || {}, campos, reclasificar: r.reclasificar === true }),
        });
        cerrarCmp();
        toast(r2.aplicados && r2.aplicados.length ? `✔ Aplicado: ${r2.aplicados.join(', ')}` : 'Nada que aplicar');
        verDoc(id, { volver: 'search', etiqueta: 'Catálogo' }); // recargar la ficha con los cambios
      } catch (e) {
        toast(e.message, 'bad');
        $('#afAplicar').disabled = false;
        $('#afAplicar').textContent = 'Aplicar seleccionados';
      }
    };
}
async function fichaReprocesar(id) {
  const eleccion = await modalReprocesar();
  if (eleccion == null) return; // cancelado
  try {
    const r = await api('/documentos/' + encodeURIComponent(id) + '/reprocesar', {
      method: 'POST',
      body: JSON.stringify({ password: eleccion.password, conservar: eleccion.conservar }),
    });
    if (!r.ok) {
      toast(r.motivo, 'bad');
      return;
    }
    toast(`Reprocesando (${eleccion.conservar ? 'conservador' : 'nuevo desde cero'}): «${r.inbox}» al Inbox`);
    go('search');
  } catch (e) {
    toast(e.message, 'bad');
  }
}
// Modal de reproceso: elige MODO (conservador = con sidecar / nuevo desde cero = sin sidecar) + contraseña.
// `n` = nº de documentos (1 = ficha individual; >1 = lote). Devuelve { password, conservar } o null si cancela.
function modalReprocesar({ n = 1 } = {}) {
  return new Promise((resolver) => {
    $('#cmpModal').innerHTML = `<div class="box card" style="max-width:470px">
      <h3 style="margin-top:0">♻️ Reprocesar ${n > 1 ? n + ' documentos' : 'documento'}</h3>
      <div class="muted" style="margin:-4px 0 12px">${n > 1 ? 'Cada uno vuelve' : 'El fichero vuelve'} al <b>Inbox</b> para re-catalogarse; su carpeta actual (sidecars e imágenes) va a la <b>Papelera</b> (recuperable). El Vigilante debe estar activo.${n > 1 ? ' <b>Acción masiva.</b>' : ''}</div>
      <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;padding:9px 10px;border:1px solid var(--line);border-radius:9px">
        <input type="radio" name="reprocMode" value="cons" checked style="margin-top:3px;flex:0 0 auto;width:16px;height:16px">
        <span><b>Conservador</b> (con sidecar) — mantiene ubicación, colección, obra, ISBN, valoración, NSFW y etiqueta NFC; solo re-deriva los metadatos bibliográficos. <span class="muted">Recomendado.</span></span>
      </label>
      <label style="display:flex;gap:8px;align-items:flex-start;cursor:pointer;padding:9px 10px;border:1px solid var(--line);border-radius:9px;margin-top:6px">
        <input type="radio" name="reprocMode" value="nuevo" style="margin-top:3px;flex:0 0 auto;width:16px;height:16px">
        <span><b>Nuevo desde cero</b> (sin sidecar) — re-identifica TODO (nuevo ID; re-lee el CIP y recalcula ISBN/título/autor/colección…). <span class="muted">Úsalo si el dato guardado es erróneo (p. ej. un ISBN equivocado).</span></span>
      </label>
      <label style="margin-top:12px">Contraseña de administrador</label>
      <input type="password" id="pwInput" autocomplete="current-password">
      <div id="pwErr" style="color:var(--bad);font-size:12px;min-height:15px;margin-top:6px"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px">
        <button class="btn" id="pwCancel">Cancelar</button><button class="btn pri" id="pwOk">♻️ Reprocesar</button>
      </div></div>`;
    $('#cmpScrim').style.display = 'block';
    $('#cmpModal').style.display = 'grid';
    const input = $('#pwInput');
    setTimeout(() => input.focus(), 30);
    const cerrarCon = (valor) => { cerrarCmp(); resolver(valor); };
    $('#pwCancel').onclick = () => cerrarCon(null);
    $('#cmpScrim').onclick = () => cerrarCon(null);
    $('#pwOk').onclick = () => {
      if (!input.value) { $('#pwErr').textContent = 'Escribe la contraseña'; input.focus(); return; }
      const conservar = (($('#cmpModal input[name="reprocMode"]:checked') || {}).value) !== 'nuevo';
      cerrarCon({ password: input.value, conservar });
    };
    input.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); $('#pwOk').click(); } else if (ev.key === 'Escape') cerrarCon(null); };
  });
}
// CAMBIAR TIPO (individual o lote): reclasifica a mano tipo_recurso (libro/revista) o marca cómic.
async function cambiarTipoDocs(ids) {
  if (!ids || !ids.length) return;
  const el = await modalCambiarTipo(ids.length);
  if (el == null) return;
  try {
    const r = await api('/documentos/cambiar-tipo', { method: 'POST', body: JSON.stringify({ ids, tipo: el.tipo, comic: el.comic, password: el.password }) });
    if (!r.ok) { toast(r.motivo, 'bad'); return; }
    toast(`🔀 ${r.modificados} documento(s) → ${el.comic ? 'cómic' : el.tipo}`);
    if (ids.length === 1 && $('#p-detalle') && $('#p-detalle').classList.contains('on')) verDoc(ids[0]);
    else { selDocs.clear(); buscarCatalogo(estadoBusqueda.page || 1); }
  } catch (e) { toast(e.message, 'bad'); }
}
// Modal de cambio de tipo: elige Libro / Revista / Cómic + contraseña. Devuelve { tipo, comic, password } o null.
function modalCambiarTipo(n) {
  const opc = (v, ic, tit, sub) => `<label style="display:flex;gap:8px;align-items:center;cursor:pointer;padding:8px 10px;border:1px solid var(--line);border-radius:9px;margin-top:6px"><input type="radio" name="ctTipo" value="${v}"${v === 'libro' ? ' checked' : ''} style="width:16px;height:16px;flex:0 0 auto"><span>${ic} <b>${tit}</b>${sub ? ` <span class="muted" style="font-size:12px">${sub}</span>` : ''}</span></label>`;
  return new Promise((resolver) => {
    $('#cmpModal').innerHTML = `<div class="box card" style="max-width:440px">
      <h3 style="margin-top:0">🔀 Cambiar tipo${n > 1 ? ` · ${n} documentos` : ''}</h3>
      <div class="muted" style="margin:-4px 0 10px">Reclasifica a mano. NO mueve la carpeta (la Integridad/un reproceso la re-alojan luego en libros/ o revistas/).</div>
      ${opc('libro', '📕', 'Libro')}${opc('revista', '📰', 'Revista')}${opc('comic', '📓', 'Cómic', '(novela gráfica / tebeo)')}${opc('articulo', '📃', 'Artículo', '(científico, de revista…)')}${opc('capitulo', '📑', 'Capítulo', '(fragmento de un libro)')}${opc('apuntes', '🗒️', 'Apuntes')}${opc('software', '💿', 'Software', '(paquete verbatim en bloque)')}
      <label style="margin-top:12px">Contraseña de administrador</label>
      <input type="password" id="pwInput" autocomplete="current-password">
      <div id="pwErr" style="color:var(--bad);font-size:12px;min-height:15px;margin-top:6px"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" id="pwCancel">Cancelar</button><button class="btn pri" id="pwOk">🔀 Cambiar</button></div>
    </div>`;
    $('#cmpScrim').style.display = 'block';
    $('#cmpModal').style.display = 'grid';
    const input = $('#pwInput');
    setTimeout(() => input.focus(), 30);
    const cerrarCon = (v) => { cerrarCmp(); resolver(v); };
    $('#pwCancel').onclick = () => cerrarCon(null);
    $('#cmpScrim').onclick = () => cerrarCon(null);
    $('#pwOk').onclick = () => {
      if (!input.value) { $('#pwErr').textContent = 'Escribe la contraseña'; input.focus(); return; }
      const v = (($('#cmpModal input[name="ctTipo"]:checked') || {}).value) || 'libro';
      // 'comic' es una NATURALEZA sobre 'libro'; el resto son tipo_recurso directos.
      cerrarCon({ tipo: v === 'comic' ? 'libro' : v, comic: v === 'comic', password: input.value });
    };
    input.onkeydown = (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); $('#pwOk').click(); } else if (ev.key === 'Escape') cerrarCon(null); };
  });
}
async function fichaEliminar(id) {
  const pw = await modalPassword({
    titulo: '🗑 Eliminar documento',
    aviso:
      'Se borrará el registro de la base y su carpeta (sidecars e imágenes) se moverá a la <b>Papelera</b> (recuperable). El fichero NO vuelve al Inbox.',
  });
  if (pw == null) return;
  try {
    const r = await api('/documentos/' + encodeURIComponent(id) + '/eliminar', {
      method: 'POST',
      body: JSON.stringify({ password: pw }),
    });
    if (!r.ok) {
      toast(r.motivo, 'bad');
      return;
    }
    toast('Documento eliminado (su carpeta está en la Papelera)');
    go('search');
  } catch (e) {
    toast(e.message, 'bad');
  }
}
// ════════ GESTIÓN DE IMÁGENES DEL CARRUSEL (reordenar/borrar/añadir + editor rotar/recortar/perspectiva) ════════
// Lee un Blob/File y lo devuelve como data URL (base64) — para enviar imágenes al backend en JSON.
const fileADataURL = (blob) =>
  new Promise((resolver, rechazar) => {
    const lector = new FileReader();
    lector.onload = () => resolver(lector.result);
    lector.onerror = rechazar;
    lector.readAsDataURL(blob);
  });
let _imgState = null;
// ¿Aplicar el TAPETE (recorte+enderezado+medida) al adjuntar imágenes a mano? Por defecto sí; el usuario
// puede desactivarlo (adjuntar la imagen tal cual, sin tocarla). Se recuerda entre sesiones.
const tapeteManualOn = () => localStorage.getItem('img_tapete') !== '0';
function editarImagenes(id, imagenes, archivo) {
  _imgState = { id, imgs: (imagenes || []).map((im) => ({ ...im })), archivo: archivo || null };
  pintarGestorImagenes();
}
async function apiImg(op, body) {
  const { id } = _imgState;
  try {
    const r = await api('/documentos/' + encodeURIComponent(id) + '/imagenes/' + op, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      toast(r.motivo || 'error', 'bad');
      return false;
    }
    _imgState.imgs = (r.imagenes || []).map((im) => ({ ...im }));
    _imgState.cambiado = true;
    pintarGestorImagenes();
    return true;
  } catch (e) {
    toast(e.message, 'bad');
    return false;
  }
}
function pintarGestorImagenes() {
  const { id, imgs } = _imgState;
  const filas = imgs
    .map(
      (
        im,
        i,
      ) => `<div style="display:flex;gap:8px;align-items:center;padding:6px 0;border-top:1px solid var(--line)">
    <img src="${esc(encUrl(im.ruta))}?t=${Date.now()}" style="width:50px;height:66px;object-fit:cover;border-radius:6px;border:1px solid var(--line)">
    <span class="muted" style="flex:1;font-size:12px">${i === 0 ? '⭐ portada' : '#' + (i + 1)}</span>
    <button class="btn" data-up="${i}" ${i === 0 ? 'disabled' : ''} title="Subir">↑</button>
    <button class="btn" data-down="${i}" ${i === imgs.length - 1 ? 'disabled' : ''} title="Bajar">↓</button>
    <button class="btn" data-edit="${i}" title="Rotar / recortar / perspectiva">✎</button>
    <button class="btn bad" data-del="${esc(im.ruta)}" title="Borrar (a la Papelera)">🗑</button>
  </div>`,
    )
    .join('');
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:560px;max-height:88vh;overflow:auto"><h3 style="margin-top:0">🖼️ Imágenes (${imgs.length})</h3>
    <p class="muted" style="font-size:12px;margin:0 0 6px">La 1.ª es la PORTADA. Reordena con ↑/↓; ✎ abre el editor (rotar/recortar/corregir perspectiva).</p>
    ${imgs.length ? filas : '<div class="muted">Sin imágenes.</div>'}
    <div style="display:flex;gap:10px;justify-content:space-between;margin-top:12px;flex-wrap:wrap"><div class="row" style="gap:8px;flex-wrap:wrap;align-items:center"><button class="btn" id="imgAdd">➕ Añadir</button><button class="btn" id="imgCam">📷 Cámara</button>${_imgExtraible() ? '<button class="btn" id="imgExtraer" title="Extraer una página/imagen del propio documento (PDF o EPUB) y añadirla — p. ej. la foto del autor del interior">🖹 Del documento</button>' : ''}<label class="muted" title="Si la foto está sobre el TAPETE reglado, la recorta, endereza y mide al añadirla. Desactívalo para adjuntar la imagen TAL CUAL (sin recorte)." style="font-size:12px;display:inline-flex;align-items:center;gap:5px;cursor:pointer;white-space:nowrap"><input type="checkbox" id="imgTapete" ${tapeteManualOn() ? 'checked' : ''}> 📐 Tapete</label></div><button class="btn pri" id="imgCerrar">Cerrar</button></div>
    <input type="file" id="imgAddInput" accept="image/*" style="display:none">
    <input type="file" id="imgCamInput" accept="image/*" capture="environment" style="display:none"></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  const cerrar = () => {
    const id = _imgState.id,
      refrescar = _imgState.cambiado;
    cerrarCmp();
    if (refrescar) verDoc(id, detalle && detalle.ctx);
  };
  $('#imgCerrar').onclick = cerrar;
  $('#cmpScrim').onclick = cerrar;
  $$('#cmpModal [data-up]').forEach((b) => (b.onclick = () => moverImg(+b.dataset.up, -1)));
  $$('#cmpModal [data-down]').forEach((b) => (b.onclick = () => moverImg(+b.dataset.down, 1)));
  $$('#cmpModal [data-del]').forEach(
    (b) =>
      (b.onclick = async () => {
        if (await ubicConfirm('Borrar imagen', 'Irá a la Papelera (recuperable). ¿Seguir?'))
          apiImg('eliminar', { ruta: b.dataset.del });
      }),
  );
  $$('#cmpModal [data-edit]').forEach((b) => (b.onclick = () => abrirEditorImagen(+b.dataset.edit)));
  const anadirDe = async (inp) => {
    if (inp && inp.files[0]) {
      try {
        let file = inp.files[0];
        // Si la foto está sobre el TAPETE: recorta+endereza (misma función que Cámara) y mide; sin tapete, igual.
        // El interruptor «📐 Tapete» del modal permite DESACTIVARLO para adjuntar la imagen tal cual (sin tocarla).
        if (!$('#imgTapete') || $('#imgTapete').checked) try {
          const r = await recortarYMedirTapete([file]);
          file = (r.files && r.files[0]) || file;
          if (r.dims && _imgState && _imgState.id) {
            try {
              await api('/documentos/' + encodeURIComponent(_imgState.id) + '/dimensiones', {
                method: 'POST',
                body: JSON.stringify(r.dims),
              });
              _imgState.cambiado = true;
            } catch (_) {}
            toast(
              `📐 ${String(r.dims.ancho_cm).replace('.', ',')}×${String(r.dims.alto_cm).replace('.', ',')} cm${r.recortadas ? ' · recortado' : ''}`,
            );
          } else if (r.recortadas) toast('✂️ Recortado');
        } catch (_) {}
        const b64 = await fileADataURL(await reducirImagen(file, 2200, 0.88));
        await apiImg('anadir', { base64: b64 });
      } catch (e) {
        toast(e.message, 'bad');
      }
    }
    if (inp) inp.value = '';
  };
  const fi = $('#imgAddInput'),
    fc = $('#imgCamInput');
  $('#imgAdd').onclick = () => fi.click();
  fi.onchange = () => anadirDe(fi);
  if ($('#imgCam')) $('#imgCam').onclick = () => fc.click();
  if (fc) fc.onchange = () => anadirDe(fc);
  if ($('#imgExtraer')) $('#imgExtraer').onclick = extraerImagenDocumento;
  // Recordar la preferencia del tapete (activarlo/desactivarlo persiste entre sesiones).
  if ($('#imgTapete')) $('#imgTapete').onchange = (e) => localStorage.setItem('img_tapete', e.target.checked ? '1' : '0');
}

// ¿El documento tiene un fichero digital del que se pueden extraer imágenes? PDF/EPUB se procesan EN EL
// NAVEGADOR (pdf.js / JSZip); los PAGINABLES (cbz/cbr/cb7/djvu) los sirve el backend página a página.
function _imgExtraible() {
  const a = _imgState && _imgState.archivo;
  if (!a || !a.nombre) return false;
  if (/\.(cbz|cbr|cb7|djvu|mobi|azw|azw3)$/i.test(a.nombre)) return true; // servidos por el backend (no necesitan a.url)
  return !!a.url && /\.(pdf|epub)$/i.test(a.nombre);
}

// EXTRAER una imagen del propio documento (PDF → páginas con pdf.js; EPUB → imágenes embebidas con JSZip)
// y añadirla al carrusel. Pensado para rescatar la foto del autor que suele ir en el interior del libro.
async function extraerImagenDocumento() {
  const a = _imgState && _imgState.archivo;
  if (!a || !a.nombre) { toast('Este documento no tiene fichero digital', 'warn'); return; }
  const ext = (a.nombre.split('.').pop() || '').toLowerCase();
  // pdf/epub se procesan EN EL NAVEGADOR y necesitan el fichero descargable (a.url); los formatos servidos por
  // el BACKEND (cbz/cbr/cb7/djvu/mobi/azw/azw3) NO lo necesitan — se piden por id. Antes se exigía a.url a
  // TODOS, lo que bloqueaba la extracción de imágenes y la «Página de texto» de MOBI/AZW3 (y paginables sin url).
  if (['pdf', 'epub'].includes(ext) && !a.url) { toast('Este documento no tiene fichero digital', 'warn'); return; }
  try {
    const id = _imgState.id;
    const enc = encodeURIComponent(id);
    if (ext === 'pdf') return await extraerDePdf(a);
    if (ext === 'epub') return await extraerDeEpub(a);
    if (['cbz', 'cbr', 'cb7', 'djvu'].includes(ext)) return await extraerLazy(id, {
      titulo: 'Extraer del documento',
      contar: { path: '/documentos/' + enc + '/paginas', key: 'paginas' },
      // DjVu: las miniaturas se piden a baja resolución (?r=72) para que la rejilla no lance rasterizaciones
      // pesadas (ddjvu+pdftoppm) a plena resolución; la imagen a añadir va a 150 DPI (sin ?r). Los cómics
      // (cbz/cbr/cb7) sirven el JPEG almacenado y el ?r no les afecta.
      item: (nn, o) => '/api/documentos/' + enc + '/paginas/' + nn + (o && o.thumb ? '?r=72' : ''),
      vacio: 'Este documento no tiene páginas extraíbles.',
    });
    if (['mobi', 'azw', 'azw3'].includes(ext)) return await extraerLazy(id, {
      titulo: 'Extraer del MOBI/AZW3',
      contar: { path: '/documentos/' + enc + '/imagenes-embebidas', key: 'total' },
      item: (nn) => '/api/documentos/' + enc + '/imagenes-embebidas/' + nn,
      vacio: 'No tiene imágenes embebidas. Usa «📄 Página de texto» para rasterizar el texto.',
      extras: [{ etq: '📄 Página de texto', fn: () => mobiPaginaTexto(id) }],
    });
    toast(`Extracción no disponible para .${ext}`, 'warn');
  } catch (e) { toast('No se pudo leer el documento: ' + e.message, 'bad'); }
}

// Descarga el fichero como Blob (mismo origen /recursos).
async function _descargarArchivo(url) {
  const resp = await fetch(encUrl(url));
  if (!resp.ok) throw new Error('descarga ' + resp.status);
  return await resp.blob();
}

// PDF: renderiza miniaturas de todas las páginas (pdf.js) → el usuario marca las que quiera → cada una se
// re-renderiza a mayor resolución y se añade al carrusel.
// Parsea un rango de páginas de texto libre → lista de nºs (1-indexados) DENTRO de [1, total], ordenada y sin
// repetir. Acepta: «primera», «última»/«últimas N», tramos «2-5», y sueltos «25». Ej.: «1-6, últimas 2».
function parsearRangoPaginas(texto, total) {
  const out = new Set();
  let t = String(texto || '').toLowerCase();
  t = t.replace(/[úu]ltimas?\s*(\d+)/g, (_, n) => { for (let i = Math.max(1, total - (+n) + 1); i <= total; i++) out.add(i); return ' '; });
  t = t.replace(/[úu]ltima/g, String(total)).replace(/primera/g, '1');
  for (const parte of t.split(/[,;]+/)) {
    const p = parte.trim();
    if (!p) continue;
    const m = p.match(/^(\d+)\s*[-–a]\s*(\d+)$/);
    if (m) { let a = +m[1], b = +m[2]; if (a > b) [a, b] = [b, a]; for (let i = a; i <= b; i++) if (i >= 1 && i <= total) out.add(i); }
    else { const n = parseInt(p, 10); if (n >= 1 && n <= total) out.add(n); }
  }
  return [...out].sort((a, b) => a - b);
}
// Rango por defecto para el selector de páginas: «1-6» + las dos últimas (sin solaparse en docs cortos).
function rangoPorDefecto(total) {
  if (!total) return '1-6';
  const frente = `1-${Math.min(6, total)}`;
  return total > 8 ? `${frente}, últimas 2` : frente;
}

async function extraerDePdf(archivo) {
  const cont = $('#cmpModal');
  cont.innerHTML = `<div class="box card" style="max-width:640px;max-height:90vh;overflow:auto"><h3 style="margin-top:0">🖹 Extraer del PDF</h3>
    <div class="row" id="exTop" style="gap:8px;flex-wrap:wrap;align-items:center;margin:4px 0 8px;position:sticky;top:0;background:var(--card);padding:4px 0;z-index:1">
      <span class="muted" id="exTotal" style="font-size:12px">…</span>
      <input id="exRango" placeholder="1-6, última" title="Páginas a extraer. Ej.: primera, 2-5, 25, última" style="font-size:12px;width:150px;padding:2px 6px">
      <button class="btn" id="exAddRango" type="button">➕ Añadir rango</button>
      <span style="flex:1;min-width:8px"></span>
      <button class="btn" id="exCancelTop" type="button">Cerrar</button>
      <button class="btn pri" id="exOkTop" type="button" disabled>Añadir 0</button>
    </div>
    <div class="muted" id="exMsg" style="font-size:12px">Cargando páginas…</div><div id="exGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px;margin-top:10px"></div><div class="row" style="justify-content:space-between;margin-top:12px"><button class="btn" id="exX">Cancelar</button><button class="btn pri" id="exOk" disabled>Añadir 0</button></div></div>`;
  $('#cmpScrim').style.display = 'block'; cont.style.display = 'grid';
  const volver = () => pintarGestorImagenes();
  $('#exX').onclick = volver;
  if ($('#exCancelTop')) $('#exCancelTop').onclick = volver;
  $('#cmpScrim').onclick = cerrarCmp;

  await cargarPdfLib();
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
  const blob = await _descargarArchivo(archivo.url);
  const pdf = await lib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
  const total = pdf.numPages;
  const MAX = 80; // tope de miniaturas (rendimiento en el Atom/móvil)
  const n = Math.min(total, MAX);
  $('#exMsg').textContent = `${total} páginas${total > MAX ? ` (rejilla: primeras ${MAX})` : ''} · toca las que quieras, o usa el rango arriba`;
  if ($('#exTotal')) $('#exTotal').textContent = `${total} pág.`;
  if ($('#exRango')) $('#exRango').value = rangoPorDefecto(total);
  const marcadas = new Set();
  const actualizarBtn = () => { const nn = marcadas.size; ['#exOk', '#exOkTop'].forEach((s) => { const b = $(s); if (b) { b.textContent = `Añadir ${nn}`; b.disabled = nn === 0; } }); };
  // Render de una página a canvas al ancho dado.
  const render = async (num, ancho) => {
    const pagina = await pdf.getPage(num);
    const base = pagina.getViewport({ scale: 1 });
    const vista = pagina.getViewport({ scale: Math.max(0.2, Math.min(3, ancho / base.width)) });
    const c = document.createElement('canvas');
    c.width = Math.round(vista.width); c.height = Math.round(vista.height);
    await pagina.render({ canvasContext: c.getContext('2d'), viewport: vista }).promise;
    return c;
  };
  const grid = $('#exGrid');
  // Miniaturas PEREZOSAS: cada página se rasteriza SOLO cuando su celda entra en pantalla (no las 80 de golpe).
  const io = new IntersectionObserver((entradas) => {
    for (const en of entradas) {
      if (!en.isIntersecting) continue;
      const cel = en.target; io.unobserve(cel);
      render(+cel.dataset.n, 180).then((c) => {
        const im = cel.querySelector('img'); if (im) im.src = c.toDataURL('image/jpeg', 0.7);
        c.width = c.height = 0;
      }).catch(() => {});
    }
  }, { root: grid, rootMargin: '300px' });
  for (let i = 1; i <= n; i++) {
    const cel = document.createElement('div');
    cel.dataset.n = i;
    cel.style.cssText = 'position:relative;cursor:pointer';
    cel.innerHTML = `<img loading="lazy" style="width:100%;min-height:120px;border-radius:6px;border:2px solid transparent;background:var(--card)"><span style="position:absolute;top:2px;left:4px;font-size:10px;background:rgba(0,0,0,.55);color:#fff;border-radius:4px;padding:0 4px">${i}</span>`;
    cel.onclick = () => {
      marcadas.has(i) ? marcadas.delete(i) : marcadas.add(i);
      cel.querySelector('img').style.borderColor = marcadas.has(i) ? 'var(--acc)' : 'transparent';
      actualizarBtn();
    };
    grid.appendChild(cel);
    io.observe(cel);
  }
  // Añade las páginas indicadas (1-based, marcadas o de un rango) rasterizándolas a alta resolución.
  const añadir = async (nums1) => {
    const lista = [...new Set(nums1)].filter((x) => x >= 1 && x <= total).sort((a, b) => a - b);
    if (!lista.length) { toast('Indica alguna página (marca miniaturas o escribe un rango)', 'warn'); return; }
    ['#exOk', '#exOkTop', '#exAddRango'].forEach((s) => { const b = $(s); if (b) { b.disabled = true; if (s !== '#exAddRango') b.textContent = 'Añadiendo…'; } });
    let ok = 0;
    try {
      for (const num of lista) {
        const c = await render(num, 1600); // alta resolución para la imagen definitiva
        const b64 = c.toDataURL('image/jpeg', 0.9);
        c.width = c.height = 0;
        await apiImg('anadir', { base64: b64 }); ok++;
      }
      toast(`🖹 ${ok} imagen(es) añadida(s)`);
    } catch (e) { toast(e.message, 'bad'); }
    try { pdf.destroy(); } catch (_) {}
    pintarGestorImagenes();
  };
  $('#exOk').onclick = () => añadir([...marcadas]);
  if ($('#exOkTop')) $('#exOkTop').onclick = () => añadir([...marcadas]);
  if ($('#exAddRango')) $('#exAddRango').onclick = () => añadir(parsearRangoPaginas($('#exRango') ? $('#exRango').value : '', total));
}

// EPUB: extrae las imágenes embebidas (JSZip) → miniaturas → el usuario marca → se añaden al carrusel.
// Además, «📄 Página de texto» rasteriza el primer contenido con texto (como en MOBI).
async function extraerDeEpub(archivo) {
  const cont = $('#cmpModal');
  cont.innerHTML = `<div class="box card" style="max-width:640px;max-height:90vh;overflow:auto"><h3 style="margin-top:0">🖹 Extraer del EPUB</h3><div class="muted" id="exMsg" style="font-size:12px">Cargando imágenes…</div><div id="exGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px;margin-top:10px"></div><div class="row" style="justify-content:space-between;margin-top:12px;gap:8px;flex-wrap:wrap"><div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn" id="exX">Cancelar</button><button class="btn" id="exTexto">📄 Página de texto</button></div><button class="btn pri" id="exOk" disabled>Añadir 0</button></div></div>`;
  $('#cmpScrim').style.display = 'block'; cont.style.display = 'grid';
  $('#exX').onclick = () => pintarGestorImagenes(); $('#cmpScrim').onclick = cerrarCmp;

  await cargarEpubLib(); // deja JSZip global (epub.js lo requiere)
  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('JSZip no disponible');
  const blob = await _descargarArchivo(archivo.url);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  if ($('#exTexto')) $('#exTexto').onclick = () => epubPaginaTexto(zip); // rasteriza el primer contenido de texto
  const entradas = Object.values(zip.files).filter((f) => !f.dir && /\.(jpe?g|png|webp|gif)$/i.test(f.name));
  if (!entradas.length) { $('#exMsg').textContent = 'Este EPUB no tiene imágenes embebidas. Usa «📄 Página de texto».'; return; }
  $('#exMsg').textContent = `${entradas.length} imágenes · toca las que quieras añadir`;
  const marcadas = new Map(); // idx → dataURL
  const actualizarBtn = () => { const b = $('#exOk'); if (b) { b.textContent = `Añadir ${marcadas.size}`; b.disabled = marcadas.size === 0; } };
  const grid = $('#exGrid');
  const MAX = 120;
  for (let i = 0; i < Math.min(entradas.length, MAX); i++) {
    const ent = entradas[i];
    const b64 = await ent.async('base64');
    const mime = /\.png$/i.test(ent.name) ? 'image/png' : /\.webp$/i.test(ent.name) ? 'image/webp' : /\.gif$/i.test(ent.name) ? 'image/gif' : 'image/jpeg';
    const url = `data:${mime};base64,${b64}`;
    const cel = document.createElement('div');
    cel.style.cssText = 'position:relative;cursor:pointer';
    cel.innerHTML = `<img src="${url}" loading="lazy" style="width:100%;height:110px;object-fit:cover;border-radius:6px;border:2px solid transparent;background:var(--card)">`;
    cel.onclick = () => {
      if (marcadas.has(i)) marcadas.delete(i); else marcadas.set(i, url);
      cel.firstChild.style.borderColor = marcadas.has(i) ? 'var(--acc)' : 'transparent';
      actualizarBtn();
    };
    grid.appendChild(cel);
  }
  $('#exOk').onclick = async () => {
    const b = $('#exOk'); b.disabled = true; b.textContent = 'Añadiendo…';
    try {
      for (const url of marcadas.values()) {
        // Normaliza a JPG/ancho razonable reutilizando reducirImagen (evita PNG enormes).
        const file = new File([await (await fetch(url)).blob()], 'img', { type: url.slice(5, url.indexOf(';')) });
        const b64 = await fileADataURL(await reducirImagen(file, 1600, 0.9));
        await apiImg('anadir', { base64: b64 });
      }
      toast(`🖹 ${marcadas.size} imagen(es) añadida(s)`);
    } catch (e) { toast(e.message, 'bad'); }
    pintarGestorImagenes();
  };
}

// Rejilla PEREZOSA para documentos servidos por el backend (paginables cbz/cbr/cb7/djvu y las imágenes
// EMBEBIDAS de MOBI/AZW3): solo se descarga la miniatura VISIBLE (IntersectionObserver, con auth → blob), NO
// se precargan decenas. Se marcan las que se quieran → se añaden al carrusel a plena resolución.
// cfg: { titulo, contar:{path,key}, item:(n)=>url, vacio, extras:[{etq,fn}] }.
async function extraerLazy(id, cfg) {
  const cont = $('#cmpModal');
  const extraHtml = (cfg.extras || []).map((_, i) => `<button class="btn" id="exExtra${i}"></button>`).join('');
  cont.innerHTML = `<div class="box card" style="max-width:640px;max-height:90vh;overflow:auto"><h3 style="margin-top:0">🖹 ${esc(cfg.titulo || 'Extraer del documento')}</h3>
    <div class="row" id="exTop" style="gap:8px;flex-wrap:wrap;align-items:center;margin:4px 0 8px;position:sticky;top:0;background:var(--card);padding:4px 0;z-index:1">
      <span class="muted" id="exTotal" style="font-size:12px">…</span>
      <input id="exRango" placeholder="1-6, última" title="Páginas a extraer. Ej.: primera, 2-5, 25, última" style="font-size:12px;width:150px;padding:2px 6px">
      <button class="btn" id="exAddRango" type="button">➕ Añadir rango</button>
      <span style="flex:1;min-width:8px"></span>
      <button class="btn" id="exCancelTop" type="button">Cerrar</button>
      <button class="btn pri" id="exOkTop" type="button" disabled>Añadir 0</button>
    </div>
    <div class="muted" id="exMsg" style="font-size:12px">Cargando…</div><div id="exGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:6px;margin-top:10px"></div><div class="row" style="justify-content:space-between;margin-top:12px;gap:8px;flex-wrap:wrap"><div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn" id="exCancel">Cancelar</button>${extraHtml}</div><button class="btn pri" id="exOk" disabled>Añadir 0</button></div></div>`;
  $('#cmpScrim').style.display = 'block'; cont.style.display = 'grid';
  // CANCELACIÓN: las miniaturas pendientes se ABORTAN al cerrar/cancelar/añadir. Así el servidor deja de
  // rasterizar páginas que ya nadie va a ver (clave con DjVu: al elegir una página no sigue con las 82).
  const ctrlMin = new AbortController();
  let ioRef = null;
  const limpiar = () => { try { ctrlMin.abort(); } catch {} if (ioRef) ioRef.disconnect(); };
  const cerrar = () => { limpiar(); pintarGestorImagenes(); };
  $('#exCancel').onclick = cerrar;
  if ($('#exCancelTop')) $('#exCancelTop').onclick = cerrar;
  $('#cmpScrim').onclick = () => { limpiar(); cerrarCmp(); };
  (cfg.extras || []).forEach((e, i) => { const b = $('#exExtra' + i); if (b) { b.textContent = e.etq; b.onclick = e.fn; } });

  // `thumb`=true → miniatura de la rejilla (baja resolución: rápida y ligera, no ahoga al Atom con DjVu);
  // false → imagen definitiva a plena resolución para añadir al carrusel. Las miniaturas llevan `signal` para
  // poder abortarlas; la imagen definitiva (thumb=false) NO se aborta (es la que el usuario quiere).
  const fetchBlob = async (n, thumb) => {
    const res = await fetch(cfg.item(n, { thumb }), {
      headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},
      signal: thumb ? ctrlMin.signal : undefined,
    });
    if (!res.ok) throw new Error('elemento ' + (n + 1));
    return await res.blob();
  };
  let r;
  try { r = await api(cfg.contar.path); } catch (e) { $('#exMsg').textContent = 'No se pudo leer: ' + e.message; return; }
  if (r.drm) { $('#exMsg').textContent = 'Fichero con DRM: no se puede leer el contenido.'; return; }
  const total = r[cfg.contar.key] || 0;
  if (!total) { $('#exMsg').textContent = cfg.vacio || 'No hay imágenes extraíbles.'; return; }
  const MAX = 200, n = Math.min(total, MAX);
  $('#exMsg').textContent = `${total}${total > MAX ? ` (rejilla: primeras ${MAX})` : ''} · toca las que quieras, o usa el rango arriba`;
  if ($('#exTotal')) $('#exTotal').textContent = `${total} pág.`;
  if ($('#exRango')) $('#exRango').value = rangoPorDefecto(total);
  const marcadas = new Set();
  const actualizarBtn = () => { const nn = marcadas.size; ['#exOk', '#exOkTop'].forEach((s) => { const b = $(s); if (b) { b.textContent = `Añadir ${nn}`; b.disabled = nn === 0; } }); };
  const grid = $('#exGrid');
  const io = new IntersectionObserver((entradas) => {
    for (const en of entradas) {
      if (!en.isIntersecting) continue;
      const cel = en.target; io.unobserve(cel);
      fetchBlob(+cel.dataset.n, true).then((b) => { const im = cel.querySelector('img'); if (im) im.src = URL.createObjectURL(b); }).catch(() => {});
    }
  }, { root: grid, rootMargin: '250px' });
  ioRef = io;   // para poder desconectarlo (dejar de pedir miniaturas) al cerrar/cancelar/añadir
  for (let i = 0; i < n; i++) {
    const cel = document.createElement('div');
    cel.dataset.n = i;
    cel.style.cssText = 'position:relative;cursor:pointer';
    cel.innerHTML = `<img loading="lazy" style="width:100%;height:120px;object-fit:cover;border-radius:6px;border:2px solid transparent;background:var(--card)"><span style="position:absolute;top:2px;left:4px;font-size:10px;background:rgba(0,0,0,.55);color:#fff;border-radius:4px;padding:0 4px">${i + 1}</span>`;
    cel.onclick = () => {
      marcadas.has(i) ? marcadas.delete(i) : marcadas.add(i);
      cel.querySelector('img').style.borderColor = marcadas.has(i) ? 'var(--acc)' : 'transparent';
      actualizarBtn();
    };
    grid.appendChild(cel);
    io.observe(cel);
  }
  // Añade al carrusel las páginas indicadas (índices 0-based, sean marcadas o de un rango). Reutilizado por
  // los botones «Añadir» (arriba y abajo) y por «Añadir rango» — así no hay que bajar 200 miniaturas.
  const añadir = async (nums0) => {
    limpiar(); // deja de pedir/rasterizar miniaturas: ya solo importan las páginas elegidas
    const lista = [...new Set(nums0)].filter((x) => x >= 0 && x < total).sort((a, b) => a - b);
    if (!lista.length) { toast('Indica alguna página (marca miniaturas o escribe un rango)', 'warn'); return; }
    ['#exOk', '#exOkTop', '#exAddRango'].forEach((s) => { const b = $(s); if (b) { b.disabled = true; if (s !== '#exAddRango') b.textContent = 'Añadiendo…'; } });
    let ok = 0;
    try {
      for (const num of lista) {
        const blob = await fetchBlob(num);
        const file = new File([blob], `img-${num + 1}.jpg`, { type: blob.type || 'image/jpeg' });
        const b64 = await fileADataURL(await reducirImagen(file, 1600, 0.9));
        await apiImg('anadir', { base64: b64 }); ok++;
      }
      toast(`🖹 ${ok} imagen(es) añadida(s)`);
    } catch (e) { toast(e.message, 'bad'); }
    pintarGestorImagenes();
  };
  $('#exOk').onclick = () => añadir([...marcadas]);
  if ($('#exOkTop')) $('#exOkTop').onclick = () => añadir([...marcadas]);
  if ($('#exAddRango')) $('#exAddRango').onclick = () => añadir(parsearRangoPaginas($('#exRango') ? $('#exRango').value : '', total).map((p) => p - 1));
}

// MOBI/AZW3: PREVISUALIZACIÓN en la ficha (no hay lector nativo en el navegador como para EPUB/PDF). El
// backend extrae el TEXTO best-effort conservando la estructura (títulos, negrita/cursiva) y detecta DRM /
// compresión no soportada (HUFF/CDIC). Se renderiza en un iframe SANDBOX (sin scripts) para AISLAR el HTML
// del libro. Con DRM → aviso + descarga (como pedía el usuario: "siempre que no fueran DRM").
async function iniciarLectorMobi(id) {
  const wrap = $('#mobiWrap'), msg = $('#mobiMsg');
  if (!wrap) return;
  let r;
  try { r = await api('/documentos/' + encodeURIComponent(id) + '/pagina-texto'); }
  catch (e) { if (msg) msg.textContent = 'No se pudo leer el documento: ' + e.message; return; }
  if (r.drm) { if (msg) msg.innerHTML = '🔒 Fichero con DRM: no se puede previsualizar. Descárgalo para abrirlo en tu lector.'; return; }
  if (r.noSoportado) { if (msg) msg.textContent = 'Compresión no soportada (HUFF/CDIC): no se pudo extraer el texto para previsualizar.'; return; }
  if (!r.html) { if (msg) msg.textContent = 'No se pudo extraer texto para previsualizar este documento.'; return; }
  // srcdoc = documento HTML mínimo con el texto del libro. sandbox="" ⇒ sin scripts (aislado y seguro).
  const doc =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>html,body{margin:0}body{font:16px/1.65 Georgia,'Times New Roman',serif;color:#1a1a1a;background:#fff;padding:18px 20px}` +
    `img{max-width:100%;height:auto}h1,h2,h3,h4{line-height:1.25}p{margin:.6em 0}</style>` +
    `<div style="max-width:40em;margin:0 auto">${r.titulo ? '<h2>' + esc(r.titulo) + '</h2>' : ''}${r.html}</div>`;
  const ifr = document.createElement('iframe');
  ifr.setAttribute('sandbox', ''); // sin scripts: el HTML del libro se renderiza aislado
  ifr.srcdoc = doc;
  ifr.style.cssText = 'width:100%;height:62vh;border:0;border-radius:10px;background:#fff';
  wrap.innerHTML = '';
  wrap.appendChild(ifr);
}

// CHM (HTML compilado): visor propio. El backend extrae el CHM (cacheado) y sirve cada tema como HTML
// AUTOCONTENIDO (imágenes/CSS incrustados como data-URI) → se pinta en un iframe SANDBOX (sin scripts),
// mismo patrón seguro que MOBI. Índice lateral (del .hhc) para navegar por los temas.
// WORD (.docx/.doc): el servidor devuelve el documento ya convertido a HTML y se pinta en un iframe SANDBOX
// (sin scripts), igual que el CHM. `f` permite abrir OTRO texto del documento (selector de `textos[]`).
async function iniciarLectorWord(id, f) {
  const wrap = $('#wordWrap'), msg = $('#wordMsg');
  if (!wrap) return;
  let r;
  const q = f ? '?f=' + encodeURIComponent(f) : '';
  try { r = await api('/documentos/' + encodeURIComponent(id) + '/word' + q); }
  catch (e) { if (msg) msg.textContent = 'No se pudo leer el documento: ' + e.message; return; }
  if (!r.ok) { if (msg) msg.textContent = r.motivo || 'No se pudo previsualizar el documento.'; return; }
  const doc =
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>html,body{margin:0}body{font:15px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;background:#fff;padding:18px 22px;max-width:46em;margin:0 auto}` +
    `h1,h2,h3,h4,h5,h6{line-height:1.3;margin:1.2em 0 .5em}p{margin:0 0 .8em}img{max-width:100%;height:auto}` +
    `table{border-collapse:collapse;margin:1em 0;width:100%}td{border:1px solid #ccc;padding:6px 8px;vertical-align:top}td p{margin:0}</style>` +
    (r.html || '<p>(sin contenido)</p>');
  const ifr = document.createElement('iframe');
  ifr.setAttribute('sandbox', '');   // HTML del documento aislado: sin scripts
  ifr.srcdoc = doc;
  ifr.style.cssText = 'width:100%;height:100%;border:0;background:#fff';
  wrap.innerHTML = '';
  wrap.appendChild(ifr);
}

async function iniciarLectorChm(id) {
  const body = $('#chmBody'), toc = $('#chmToc'), msg = $('#chmMsg');
  if (!body) return;
  let r;
  try { r = await api('/documentos/' + encodeURIComponent(id) + '/chm'); }
  catch (e) { if (msg) msg.textContent = 'No se pudo leer el CHM: ' + e.message; return; }
  if (!r.ok) { if (msg) msg.textContent = r.motivo || 'No se pudo previsualizar el CHM.'; return; }
  // Pinta un tema (HTML autocontenido) en un iframe sandbox (sin scripts).
  const pintar = (html, titulo) => {
    const doc =
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
      `<style>html,body{margin:0}body{font:15px/1.6 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a;background:#fff;padding:14px 16px}img{max-width:100%;height:auto}a{color:#06c}</style>` +
      (html || (titulo ? '<h3>' + esc(titulo) + '</h3><p>(sin contenido)</p>' : '<p>(sin contenido)</p>'));
    const ifr = document.createElement('iframe');
    ifr.setAttribute('sandbox', ''); // sin scripts: HTML del CHM aislado
    ifr.srcdoc = doc;
    ifr.style.cssText = 'width:100%;height:100%;border:0;background:#fff';
    body.innerHTML = '';
    body.appendChild(ifr);
  };
  // Navega a un tema por su href (relativo a la raíz del CHM).
  const abrir = async (href, el) => {
    if (el) { $$('#chmToc a').forEach((a) => (a.style.fontWeight = '')); el.style.fontWeight = '700'; }
    body.innerHTML = '<div class="epubmsg" style="color:#555">Cargando…</div>';
    try {
      const p = await api('/documentos/' + encodeURIComponent(id) + '/chm/pagina?href=' + encodeURIComponent(href));
      pintar(p.ok ? p.html : '', href);
    } catch { pintar('', href); }
  };
  // Índice lateral (del .hhc); si no hay, un único enlace a la entrada.
  const items = r.toc && r.toc.length ? r.toc : r.entrada ? [{ titulo: 'Inicio', href: r.entrada }] : [];
  if (toc) {
    toc.innerHTML =
      items
        .map(
          (t, i) =>
            `<a data-i="${i}" style="display:block;padding:4px 8px;color:#06c;cursor:pointer;text-decoration:none;border-radius:6px" title="${esc(t.titulo || t.href)}">${esc(recortar(t.titulo || t.href, 40))}</a>`,
        )
        .join('') || '<span style="color:#888;padding:6px">Sin índice</span>';
    toc.querySelectorAll('a').forEach((a) => (a.onclick = () => abrir(items[+a.dataset.i].href, a)));
  }
  // Pinta la entrada inicial (ya viene en la primera respuesta).
  pintar(r.html, r.titulo);
}

// SOFTWARE (naturaleza:'software'): explorador de ficheros de SOLO LECTURA en la ficha. Muestra el árbol
// del paquete (nombres + tamaño + icono por clase); no sirve ni edita los binarios (se mueven en bloque).
async function iniciarExploradorSoftware(id) {
  const cont = $('#swArbol');
  if (!cont) return;
  let r;
  try { r = await api('/documentos/' + encodeURIComponent(id) + '/arbol'); }
  catch (e) { cont.innerHTML = 'No se pudo leer el paquete: ' + esc(e.message); return; }
  if (!r.arbol || !r.arbol.length) { cont.innerHTML = '<div class="muted">(paquete vacío)</div>'; return; }
  cont.innerHTML = r.arbol.map(nodoArbolRO).join('');
}
function nodoArbolRO(n) {
  if (n.tipo === 'file') {
    const ic = _ICONO_CLASE[n.clase] || '📄';
    return `<div style="padding:1px 0 1px 20px">${ic} ${esc(n.nombre)} <span class="muted" style="font-size:11px">${n.tam ? fmtBytes(n.tam) : ''}</span></div>`;
  }
  const hijos = (n.hijos || []).map(nodoArbolRO).join('') || '<div class="muted" style="padding-left:20px">(vacía)</div>';
  return `<details open style="margin-left:4px"><summary style="cursor:pointer">📁 ${esc(n.nombre)}</summary><div style="margin-left:14px">${hijos}</div></details>`;
}

// Rasteriza UNA página de texto de un MOBI/AZW3 CONSERVANDO la estructura (encabezados, negrita/cursiva,
// párrafos, tamaños relativos): el HTML del libro se pinta con SVG <foreignObject> → canvas. La fuente
// EMBEBIDA del ebook NO se preserva (serif del sistema); las clases CSS del ebook, solo las semánticas.
async function mobiPaginaTexto(id) {
  let r;
  try { r = await api('/documentos/' + encodeURIComponent(id) + '/pagina-texto'); }
  catch (e) { toast(e.message, 'bad'); return; }
  if (r.drm) { toast('Fichero con DRM: no se puede leer el texto', 'warn'); return; }
  if (r.noSoportado) { toast('Compresión no soportada (HUFF/CDIC): no se pudo extraer el texto', 'warn'); return; }
  if (!r.html) { toast('No se pudo extraer texto del documento', 'warn'); return; }
  try {
    const b64 = await htmlAPaginaImagen(r.titulo || '', r.html);
    await apiImg('anadir', { base64: b64 });
    toast('📄 Página de texto añadida');
  } catch (e) { toast('No se pudo rasterizar: ' + e.message, 'bad'); }
}

// EPUB: rasteriza el PRIMER contenido con texto sustancial (salta portada/legal cortos). El EPUB ya está
// abierto (JSZip). Misma decisión que MOBI: se conserva la estructura (encabezados/negrita/cursiva), no la
// hoja de estilos del ebook.
async function epubPaginaTexto(zip) {
  try {
    const htmls = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /\.(x?html)$/i.test(n)).sort();
    let body = '', titulo = '';
    for (const n of htmls) {
      const c = await zip.files[n].async('string');
      if (c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length < 200) continue; // salta páginas casi vacías
      const mb = c.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
      body = (mb ? mb[1] : c).slice(0, 9000); // una página basta; DOMParser cierra lo que quede
      const mt = c.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      titulo = mt ? mt[1].replace(/<[^>]+>/g, '').trim() : '';
      break;
    }
    if (!body) { toast('El EPUB no tiene texto extraíble', 'warn'); return; }
    const b64 = await htmlAPaginaImagen(titulo, body);
    await apiImg('anadir', { base64: b64 });
    toast('📄 Página de texto añadida');
  } catch (e) { toast('No se pudo rasterizar: ' + e.message, 'bad'); }
}

// HTML → imagen de página (SVG foreignObject → canvas). Sanea el fragmento con DOMParser (cierra etiquetas,
// quita lo externo: src/href/style → el canvas NO se «tinta» y se puede exportar). Conserva las etiquetas de
// estructura y mapea las clases semánticas comunes (bold/italic/center) por si el ebook usa CSS.
async function htmlAPaginaImagen(titulo, html) {
  const W = 1000, H = 1414;
  const PERMITIDAS = new Set(['DIV', 'P', 'SPAN', 'BR', 'B', 'I', 'EM', 'STRONG', 'U', 'FONT', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'BLOCKQUOTE', 'SUP', 'SUB', 'SMALL', 'CENTER']);
  const docp = new DOMParser().parseFromString('<!doctype html><body><div id="r">' + html + '</div>', 'text/html');
  const root = docp.getElementById('r');
  const limpiar = (nodo) => {
    for (const hijo of [...nodo.childNodes]) {
      if (hijo.nodeType !== 1) continue;
      if (!PERMITIDAS.has(hijo.tagName)) { while (hijo.firstChild) nodo.insertBefore(hijo.firstChild, hijo); nodo.removeChild(hijo); continue; }
      for (const at of [...hijo.attributes]) if (!['class', 'align', 'size'].includes(at.name)) hijo.removeAttribute(at.name);
      limpiar(hijo);
    }
  };
  limpiar(root);
  const cuerpo = new XMLSerializer().serializeToString(root);
  const escT = (s) => String(s).replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));
  const tit = titulo ? `<div class="_tit">${escT(titulo)}</div>` : '';
  const estilo = `*{box-sizing:border-box;max-width:100%} body{margin:0} .pg{width:${W}px;height:${H}px;padding:80px 90px;background:#faf8f4;color:#1a1a1a;font-family:Georgia,'Times New Roman',serif;font-size:30px;line-height:1.5;overflow:hidden} ._tit{font-size:40px;font-weight:bold;border-bottom:2px solid #ccc;padding-bottom:14px;margin-bottom:24px} h1{font-size:46px}h2{font-size:38px}h3{font-size:33px} h1,h2,h3,h4,h5,h6{font-weight:bold;margin:.4em 0} p{margin:0 0 .7em} blockquote{margin:.6em 1.4em;font-style:italic} .bold{font-weight:bold} .italic{font-style:italic} .center,[align=center]{text-align:center}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><foreignObject width="100%" height="100%"><body xmlns="http://www.w3.org/1999/xhtml"><style>${estilo}</style><div class="pg">${tit}${cuerpo}</div></body></foreignObject></svg>`;
  const img = new Image();
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('render del HTML')); img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg); });
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#faf8f4'; ctx.fillRect(0, 0, W, H);
  ctx.drawImage(img, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.92);
}
async function moverImg(i, dir) {
  const { imgs } = _imgState;
  const j = i + dir;
  if (j < 0 || j >= imgs.length) return;
  [imgs[i], imgs[j]] = [imgs[j], imgs[i]];
  await apiImg('orden', { orden: imgs.map((im) => im.ruta) });
}
// ── Homografía (perspectiva): resolver 4→4 y aplicar (Gauss 8×8) ──
function _gauss(A, b) {
  const n = b.length,
    M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const pv = M[c][c] || 1e-9;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / pv;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, c) => r[n] / (r[c] || 1e-9));
}
function _homografia(src, dst) {
  const A = [],
    b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i],
      [u, v] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = _gauss(A, b);
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}
function _mapH(H, x, y) {
  const d = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
}
const _dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// Auto-detección de los 4 bordes de un libro sobre FONDO VERDE (alfombrilla). 100% local, sin IA.
// Robustez: (1) máscara verde laxa; (2) si hay poco verde → null (no hay alfombrilla); (3) flood-fill del
// NO-verde desde los BORDES → quita la mesa/marco no verde de alrededor; (4) el LIBRO = isla no-verde
// RODEADA de verde (no conectada al borde); (5) esquinas = extremos diagonales (x±y). Devuelve [TL,TR,BR,BL]|null.
// CALIBRACIÓN OPCIONAL del tapete: una foto del tapete VACÍO fija su color de SESIÓN → funciona con
// CUALQUIER tapete (verde, teal, verde oscuro, rojo, negro…) y bajo cualquier luz (nublado/soleado cambian
// el balance de blancos). Se rehace en 2 s cuando cambia la luz. Persistida en localStorage.
let _tapeteCal = null;
// HSV (h en grados, s en 0..1) — el TONO (hue) identifica el color del tapete de forma robusta a la luz y
// distingue p.ej. el ROSA (~343°) del crema/madera CÁLIDOS (~30-45°), que el coseno-RGB confundía.
function _rgb2hs(r, g, b) {
  const mx = Math.max(r, g, b),
    mn = Math.min(r, g, b),
    d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((((g - b) / d) % 6) + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: mx > 0 ? d / mx : 0, mx };
}
function _normCal(c) {
  if (c && c.h === undefined && c.r !== undefined) {
    const o = _rgb2hs(c.r, c.g, c.b);
    c.h = o.h;
    c.s = o.s;
    c.crom = o.s >= 0.12;
    c.sum = c.sum || c.r + c.g + c.b;
  }
  return c;
}
function cargarTapeteCal() {
  try {
    _tapeteCal = _normCal(JSON.parse(localStorage.getItem('tapete_cal') || 'null'));
  } catch (_) {
    _tapeteCal = null;
  }
}
cargarTapeteCal();
function limpiarTapeteCal() {
  localStorage.removeItem('tapete_cal');
  _tapeteCal = null;
}
// ¿El píxel coincide con el tapete calibrado? Tapete CON color → mismo TONO (±30°) y con saturación
// suficiente (excluye el libro/mesa desaturados aunque compartan zona de color); ACROMÁTICO (negro/gris) →
// baja saturación + brillo en banda.
function _coincideTapete(r, g, b, c) {
  const o = _rgb2hs(r, g, b);
  if (c.crom) {
    let dh = Math.abs(o.h - c.h);
    if (dh > 180) dh = 360 - dh;
    return dh <= 30 && o.s >= Math.max(0.12, c.s * 0.5);
  }
  return o.s < 0.18 && Math.abs(r + g + b - c.sum) < c.sum * 0.55 + 60;
}
// Regla ÚNICA de "píxel del tapete". Si hay CALIBRACIÓN, manda (por TONO). Si no, heurística verde/teal:
// verde sobre rojo y azul cercano al verde → distingue del libro CÁLIDO (sepia/crema) y del azul puro.
function _verdeMat(r, g, b) {
  if (_tapeteCal) return _coincideTapete(r, g, b, _tapeteCal);
  const mn = r < b ? r : b;
  return g - r > 10 && g >= b - 25 && !(g > 170 && g - mn < g * 0.18);
}
// Calcula el color del tapete desde una foto del tapete VACÍO (MEDIANAS por canal, robustas a la rejilla) y
// lo guarda como calibración de sesión (tono + saturación). Devuelve la calibración.
async function calibrarTapete(file) {
  const img = await fileAImagen(file);
  const maxD = 600,
    sc = Math.min(1, maxD / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * sc)),
    h = Math.max(1, Math.round(img.naturalHeight * sc)),
    N = w * h;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  cv.getContext('2d').drawImage(img, 0, 0, w, h);
  try {
    URL.revokeObjectURL(img.src);
  } catch (_) {}
  const d = cv.getContext('2d').getImageData(0, 0, w, h).data;
  const hr = new Uint32Array(256),
    hg = new Uint32Array(256),
    hb = new Uint32Array(256);
  for (let i = 0; i < N; i++) {
    hr[d[i * 4]]++;
    hg[d[i * 4 + 1]]++;
    hb[d[i * 4 + 2]]++;
  }
  const med = (hh) => {
    let a = 0;
    for (let v = 0; v < 256; v++) {
      a += hh[v];
      if (a >= N / 2) return v;
    }
    return 128;
  };
  const r = med(hr),
    g = med(hg),
    b = med(hb),
    o = _rgb2hs(r, g, b);
  const cal = { r, g, b, h: o.h, s: o.s, sum: r + g + b, crom: o.s >= 0.12 };
  localStorage.setItem('tapete_cal', JSON.stringify(cal));
  _tapeteCal = cal;
  return cal;
}
// Estado de la calibración bajo el botón: muestra el color fijado + enlace para quitarla (vuelve al auto).
function pintarTapeteCalEstado() {
  const e = document.getElementById('inTapeteCalEstado');
  if (!e) return;
  if (_tapeteCal) {
    const c = _tapeteCal;
    e.innerHTML = `<span style="display:inline-block;width:13px;height:13px;border-radius:3px;border:1px solid var(--line);vertical-align:middle;background:rgb(${c.r},${c.g},${c.b})"></span> calibrado (${c.crom ? 'color' : 'acromático'}) · <a class="rowlink" id="inTapeteCalClr">✕ quitar</a>`;
    const clr = document.getElementById('inTapeteCalClr');
    if (clr)
      clr.onclick = () => {
        limpiarTapeteCal();
        pintarTapeteCalEstado();
        toast('Calibración borrada (vuelve a la detección verde/teal automática)');
      };
  } else e.textContent = 'sin calibrar · detección verde/teal automática';
}
// DIAGNÓSTICO: pinta en ROJO lo que se considera TAPETE sobre una foto (el libro debe quedar SIN teñir y
// rodeado de rojo). Muestra el % de tapete y la calibración activa. Sirve para ver de un vistazo si el color
// del tapete se reconoce y si el libro se separa bien.
async function verMascaraTapete(file) {
  const img = await fileAImagen(file);
  const iw = img.naturalWidth,
    ih = img.naturalHeight;
  // Detección REAL (la misma del recorte) sobre tamaño natural → contorno + medida.
  const work = document.createElement('canvas');
  work.width = iw;
  work.height = ih;
  work.getContext('2d').drawImage(img, 0, 0);
  const quad = detectarBordesVerde(work),
    pxcm = detectarRejillaPxCm(work);
  let dims = null;
  if (quad && pxcm) {
    const W = (_dist(quad[0], quad[1]) + _dist(quad[3], quad[2])) / 2 / pxcm,
      H = (_dist(quad[0], quad[3]) + _dist(quad[1], quad[2])) / 2 / pxcm;
    dims = { W, H };
  }
  const maxD = 680,
    sc = Math.min(1, maxD / Math.max(iw, ih));
  const w = Math.max(1, Math.round(iw * sc)),
    h = Math.max(1, Math.round(ih * sc)),
    N = w * h;
  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  try {
    URL.revokeObjectURL(img.src);
  } catch (_) {}
  const im = ctx.getImageData(0, 0, w, h),
    d = im.data;
  let nv = 0;
  for (let i = 0; i < N; i++) {
    if (_verdeMat(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])) {
      nv++;
      d[i * 4] = 255;
      d[i * 4 + 1] = 40;
      d[i * 4 + 2] = 40;
    }
  }
  ctx.putImageData(im, 0, 0);
  if (quad) {
    ctx.strokeStyle = '#28ff90';
    ctx.lineWidth = 3;
    ctx.beginPath();
    quad.forEach((p, k) => {
      const X = p[0] * sc,
        Y = p[1] * sc;
      k ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    });
    ctx.closePath();
    ctx.stroke();
    quad.forEach((p) => {
      ctx.beginPath();
      ctx.arc(p[0] * sc, p[1] * sc, 5, 0, 7);
      ctx.fillStyle = '#28ff90';
      ctx.fill();
    });
  }
  const pct = Math.round((nv / N) * 100),
    url = cv.toDataURL('image/jpeg', 0.85),
    c = _tapeteCal;
  const medida = dims
    ? `${dims.W.toFixed(1).replace('.', ',')}×${dims.H.toFixed(1).replace('.', ',')} cm`
    : quad
      ? 'libro ✓ (rejilla ✗)'
      : 'libro ✗';
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:520px;max-height:92vh;overflow:auto"><h3 style="margin-top:0">🔍 Probar tapete</h3>
    <p class="muted" style="font-size:12px;margin:4px 0 8px">ROJO = tapete · contorno VERDE = libro detectado (debe ceñirse al libro). Tapete <b>${pct}%</b> · <b>${medida}</b> · ${c ? `tono ${Math.round(c.h)}° sat ${(c.s || 0).toFixed(2)}` : 'sin calibrar'}</p>
    <img src="${url}" style="width:100%;border-radius:8px;border:1px solid var(--line)">
    <div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn" id="vmX">Cerrar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  const x = $('#vmX');
  if (x) x.onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
}
// Fracción de píxeles de tapete (diagnóstico para calibrar): submuestrea y cuenta verdes.
function fraccionVerde(canvas) {
  const maxD = 400,
    sc = Math.min(1, maxD / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * sc)),
    h = Math.max(1, Math.round(canvas.height * sc)),
    N = w * h;
  const t = document.createElement('canvas');
  t.width = w;
  t.height = h;
  t.getContext('2d').drawImage(canvas, 0, 0, w, h);
  const d = t.getContext('2d').getImageData(0, 0, w, h).data;
  let nv = 0;
  for (let i = 0; i < N; i++) if (_verdeMat(d[i * 4], d[i * 4 + 1], d[i * 4 + 2])) nv++;
  return nv / N;
}
// Núcleo COMPARTIDO (puro, testeable en Node): dada una MÁSCARA de "fondo" (1=fondo) de w×h, devuelve las 4
// esquinas [TL,TR,BR,BL] (en coords de la máscara) del mayor OBJETO rodeado por el fondo, o null. `dilatar`
// = radio del cierre morfológico del fondo (traga líneas finas que conectarían el objeto con el exterior;
// 0 = sin dilatación). Lo usan el detector del tapete (fondo=verde) y el genérico por fondo muestreado.
function _quadDeMascara(fondo0, w, h, dilatar) {
  const N = w * h;
  let mat = fondo0;
  if (dilatar > 0) {
    const r = dilatar,
      tmp = new Uint8Array(N);
    mat = new Uint8Array(N);
    for (let y = 0; y < h; y++) {
      const o = y * w;
      for (let x = 0; x < w; x++) {
        let v = 0;
        for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < w && fondo0[o + xx]) { v = 1; break; } }
        tmp[o + x] = v;
      }
    }
    for (let x = 0; x < w; x++)
      for (let y = 0; y < h; y++) {
        let v = 0;
        for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < h && tmp[yy * w + x]) { v = 1; break; } }
        mat[y * w + x] = v;
      }
  }
  // flood-fill del EXTERIOR (fondo alcanzable desde los bordes) sobre el fondo YA SÓLIDO.
  const fuera = new Uint8Array(N),
    pila = [];
  const meter = (i) => { if (!mat[i] && !fuera[i]) { fuera[i] = 1; pila.push(i); } };
  for (let x = 0; x < w; x++) { meter(x); meter((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { meter(y * w); meter(y * w + w - 1); }
  while (pila.length) {
    const i = pila.pop(), x = i % w, y = (i / w) | 0;
    if (x > 0) meter(i - 1);
    if (x < w - 1) meter(i + 1);
    if (y > 0) meter(i - w);
    if (y < h - 1) meter(i + w);
  }
  // ISLA = objeto RODEADO de fondo. Mayor componente conexa (ignora restos sueltos y agujeros internos).
  const comp = new Int32Array(N);
  let id = 0, bestId = 0, bestSz = 0;
  for (let s = 0; s < N; s++) {
    if (mat[s] || fuera[s] || comp[s]) continue;
    id++;
    let sz = 0;
    const st = [s];
    comp[s] = id;
    while (st.length) {
      const i = st.pop();
      sz++;
      const x = i % w, y = (i / w) | 0;
      const push = (j) => { if (!mat[j] && !fuera[j] && !comp[j]) { comp[j] = id; st.push(j); } };
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    if (sz > bestSz) { bestSz = sz; bestId = id; }
  }
  if (bestSz < N * 0.01) return null; // objeto demasiado pequeño / no fiable
  // 4 esquinas de la MAYOR componente (extremos diagonales x±y) — se adapta a giro/trapecio. Erosión: el
  // píxel de esquina debe tener ≥3 vecinos de la misma componente (evita protuberancias finas).
  const dela = (i) => comp[i] === bestId;
  let tl = null, br = null, bl = null, tr = null;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!dela(i)) continue;
      let nb = 0;
      if (dela(i - 1)) nb++;
      if (dela(i + 1)) nb++;
      if (dela(i - w)) nb++;
      if (dela(i + w)) nb++;
      if (nb < 3) continue;
      const s = x + y, df = x - y;
      if (tl === null || s < tl[2]) tl = [x, y, s];
      if (br === null || s > br[2]) br = [x, y, s];
      if (bl === null || df < bl[2]) bl = [x, y, df];
      if (tr === null || df > tr[2]) tr = [x, y, df];
    }
  if (!tl || !tr || !br || !bl) return null;
  return [[tl[0], tl[1]], [tr[0], tr[1]], [br[0], br[1]], [bl[0], bl[1]]];
}
function detectarBordesVerde(canvas) {
  const maxD = 720,
    sc = Math.min(1, maxD / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * sc)),
    h = Math.max(1, Math.round(canvas.height * sc)),
    N = w * h;
  const t = document.createElement('canvas');
  t.width = w;
  t.height = h;
  t.getContext('2d').drawImage(canvas, 0, 0, w, h);
  const d = t.getContext('2d').getImageData(0, 0, w, h).data;
  const verde = new Uint8Array(N);
  let nVerde = 0;
  for (let i = 0; i < N; i++) {
    const v = _verdeMat(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) ? 1 : 0;
    verde[i] = v;
    nVerde += v;
  }
  if (nVerde < N * 0.15) return null; // poco tapete → probablemente NO hay alfombrilla
  // El tapete es el FONDO; se dilata (radio 2) para tragarse las LÍNEAS de la rejilla (que si no conectan el
  // libro con el exterior). El libro = mayor isla rodeada de tapete.
  const dq = _quadDeMascara(verde, w, h, 2);
  return dq ? dq.map((p) => [p[0] / sc, p[1] / sc]) : null;
}
// FASE 2b: detección GENÉRICA por SEGMENTACIÓN DE FONDO (cubierta sobre una superficie relativamente
// UNIFORME — mesa/suelo, foto en ángulo, SIN tapete). Muestrea el color del fondo en las 4 ESQUINAS de la
// foto → máscara de fondo (píxeles parecidos a alguna muestra) → mayor objeto rodeado = la cubierta → 4
// esquinas. Complementa al detector por LÍNEAS (mejor cuando la cubierta va "cargada" de texto/dibujos que
// confunden a Hough). Libre, sin IA. Devuelve [TL,TR,BR,BL] en coords del canvas o null.
function detectarBordesPorFondo(canvas) {
  const maxD = 600,
    sc = Math.min(1, maxD / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * sc)),
    h = Math.max(1, Math.round(canvas.height * sc)),
    N = w * h;
  if (w < 40 || h < 40) return null;
  const t = document.createElement('canvas');
  t.width = w;
  t.height = h;
  t.getContext('2d').drawImage(canvas, 0, 0, w, h);
  const d = t.getContext('2d').getImageData(0, 0, w, h).data;
  // Color medio de un bloque en cada esquina → colores de fondo de referencia.
  const R = Math.max(4, Math.round(Math.min(w, h) * 0.06));
  const bloque = (cx, cy) => {
    let r = 0, g = 0, b = 0, n = 0;
    for (let y = cy - R; y <= cy + R; y++)
      for (let x = cx - R; x <= cx + R; x++) {
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = (y * w + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
    return n ? [r / n, g / n, b / n] : null;
  };
  const refs = [bloque(R, R), bloque(w - 1 - R, R), bloque(R, h - 1 - R), bloque(w - 1 - R, h - 1 - R)].filter(Boolean);
  if (refs.length < 3) return null;
  const tol = 64; // distancia (suma de |ΔR|+|ΔG|+|ΔB|) para considerar un píxel "fondo"
  const fondo = new Uint8Array(N);
  let nf = 0;
  for (let i = 0; i < N; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    let bg = false;
    for (const c of refs) { if (Math.abs(r - c[0]) + Math.abs(g - c[1]) + Math.abs(b - c[2]) < tol) { bg = true; break; } }
    if (bg) { fondo[i] = 1; nf++; }
  }
  if (nf < N * 0.18 || nf > N * 0.94) return null; // fondo insuficiente/no uniforme, o casi todo fondo
  const dq = _quadDeMascara(fondo, w, h, 1);
  return dq ? dq.map((p) => [p[0] / sc, p[1] / sc]) : null;
}
// ── FASE 2: detección GENÉRICA del cuadrilátero de la cubierta (SIN tapete), para fotos en ángulo. Núcleo
//   PURO (ImageData {data,width,height}) → 4 esquinas [TL,TR,BR,BL] o null; testeable en Node. Método: Sobel →
//   votación Hough pendiente-ordenada de líneas casi-horizontales (y=mx+b) y casi-verticales (x=my+b) →
//   toma las 2 extremas de cada eje (arriba/abajo, izq/der) → intersecta → cuadrilátero. Libre, sin IA. ──
function _quadGenericoDeImagen(img) {
  const w = img.width,
    h = img.height,
    d = img.data,
    N = w * h;
  if (w < 40 || h < 40) return null;
  const g = new Float32Array(N);
  for (let i = 0; i < N; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  const gx = new Float32Array(N),
    gy = new Float32Array(N),
    mag = new Float32Array(N);
  let magSum = 0;
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = g[i - w - 1],
        b = g[i - w],
        c = g[i - w + 1],
        dd = g[i - 1],
        f = g[i + 1],
        p = g[i + w - 1],
        q = g[i + w],
        r = g[i + w + 1];
      const sx = c + 2 * f + r - (a + 2 * dd + p),
        sy = p + 2 * q + r - (a + 2 * b + c);
      gx[i] = sx;
      gy[i] = sy;
      const m = Math.abs(sx) + Math.abs(sy);
      mag[i] = m;
      magSum += m;
    }
  const thr = Math.max(40, (magSum / N) * 2.5); // umbral de borde (media·k)
  const SL = 0.6,
    NS = 25,
    ds = (2 * SL) / (NS - 1),
    slope = (k) => -SL + k * ds;
  const accH = [],
    accV = [];
  for (let k = 0; k < NS; k++) {
    accH.push(new Float32Array(h + 2));
    accV.push(new Float32Array(w + 2));
  }
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (mag[i] < thr) continue;
      if (Math.abs(gy[i]) >= Math.abs(gx[i])) {
        for (let k = 0; k < NS; k++) {
          const bb = Math.round(y - slope(k) * x);
          if (bb >= 0 && bb <= h) accH[k][bb] += mag[i];
        }
      } else {
        for (let k = 0; k < NS; k++) {
          const bb = Math.round(x - slope(k) * y);
          if (bb >= 0 && bb <= w) accV[k][bb] += mag[i];
        }
      }
    }
  // Extrae líneas (picos con NMS por coordenada central) y devuelve {m,b,cc(score-centro),s}.
  const lineas = (acc, blen, centro) => {
    let mx = 0;
    for (let k = 0; k < NS; k++) for (let b = 0; b <= blen; b++) if (acc[k][b] > mx) mx = acc[k][b];
    if (mx <= 0) return [];
    const cut = mx * 0.33,
      cand = [];
    for (let k = 0; k < NS; k++)
      for (let b = 0; b <= blen; b++) {
        const s = acc[k][b];
        if (s < cut) continue;
        let lm = true;
        for (let db = -3; db <= 3; db++) {
          const bb = b + db;
          if (bb >= 0 && bb <= blen && acc[k][bb] > s) {
            lm = false;
            break;
          }
        }
        if (!lm) continue;
        cand.push({ m: slope(k), b, s, cc: slope(k) * centro + b });
      }
    cand.sort((a, b) => b.s - a.s);
    const out = [];
    for (const c of cand) {
      if (out.every((o) => Math.abs(o.cc - c.cc) > blen * 0.1)) out.push(c);
    }
    return out;
  };
  const H = lineas(accH, h, w / 2),
    V = lineas(accV, w, h / 2);
  if (H.length < 2 || V.length < 2) return null;
  const top = H.reduce((a, b) => (b.cc < a.cc ? b : a)),
    bot = H.reduce((a, b) => (b.cc > a.cc ? b : a));
  const izq = V.reduce((a, b) => (b.cc < a.cc ? b : a)),
    der = V.reduce((a, b) => (b.cc > a.cc ? b : a));
  if (bot.cc - top.cc < h * 0.35 || der.cc - izq.cc < w * 0.35) return null; // par de bordes demasiado juntos
  const cruce = (hl, vl) => {
    const den = 1 - vl.m * hl.m;
    if (Math.abs(den) < 1e-6) return null;
    const x = (vl.m * hl.b + vl.b) / den;
    return [x, hl.m * x + hl.b];
  };
  const TL = cruce(top, izq),
    TR = cruce(top, der),
    BR = cruce(bot, der),
    BL = cruce(bot, izq);
  if (!TL || !TR || !BR || !BL) return null;
  const pad = 0.18,
    dentro = (p) => p[0] >= -w * pad && p[0] <= w * (1 + pad) && p[1] >= -h * pad && p[1] <= h * (1 + pad);
  if (![TL, TR, BR, BL].every(dentro)) return null;
  const area =
    Math.abs(
      TL[0] * TR[1] -
        TR[0] * TL[1] +
        (TR[0] * BR[1] - BR[0] * TR[1]) +
        (BR[0] * BL[1] - BL[0] * BR[1]) +
        (BL[0] * TL[1] - TL[0] * BL[1]),
    ) / 2;
  if (area < N * 0.15) return null; // cubierta demasiado pequeña → no fiable
  return [TL, TR, BR, BL];
}
function detectarCuadrilateroGenerico(canvas) {
  const maxD = 480,
    sc = Math.min(1, maxD / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * sc)),
    h = Math.max(1, Math.round(canvas.height * sc));
  const t = document.createElement('canvas');
  t.width = w;
  t.height = h;
  t.getContext('2d').drawImage(canvas, 0, 0, w, h);
  const q = _quadGenericoDeImagen(t.getContext('2d').getImageData(0, 0, w, h));
  if (!q) return null;
  return q.map((p) => [p[0] / sc, p[1] / sc]);
}
// AUTO-ESCALA (px por 1 cm), sin IA y ROBUSTA AL GIRO DEL TAPETE. No basta proyectar por filas/columnas:
// si la rejilla está inclinada, una línea se desparrama por muchos píxeles y se pierde la periodicidad. En su
// lugar: (1) histograma de orientación del gradiente sobre el tapete → ángulo APROXIMADO de la rejilla;
// (2) búsqueda fina ±8° proyectando PERPENDICULAR a las líneas (todas las paralelas caen en el mismo bin →
// pico nítido) y exigiendo que los dos ejes ⟂ coincidan (rejilla cuadrada); el periodo = 1 celda = 1 cm.
// Devuelve px/cm en coords de IMAGEN COMPLETA, o null (sin rejilla clara → regla manual). Rejilla de 1 cm.
function detectarRejillaPxCm(canvas) {
  const PI = Math.PI,
    maxD = 1100,
    sc = Math.min(1, maxD / Math.max(canvas.width, canvas.height));
  const w = Math.max(1, Math.round(canvas.width * sc)),
    h = Math.max(1, Math.round(canvas.height * sc)),
    N = w * h;
  const t = document.createElement('canvas');
  t.width = w;
  t.height = h;
  t.getContext('2d').drawImage(canvas, 0, 0, w, h);
  const d = t.getContext('2d').getImageData(0, 0, w, h).data;
  const gris = new Float32Array(N),
    verde = new Uint8Array(N);
  let nVerde = 0;
  for (let i = 0; i < N; i++) {
    const r = d[i * 4],
      g = d[i * 4 + 1],
      b = d[i * 4 + 2];
    gris[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    if (_verdeMat(r, g, b)) {
      verde[i] = 1;
      nVerde++;
    }
  }
  if (nVerde < N * 0.1) return null; // poca alfombrilla a la vista
  // Píxeles de TAPETE con gradiente significativo → arrays compactos (x,y,gx,gy) + histograma de orientación.
  const PX = new Int16Array(N),
    PY = new Int16Array(N),
    GX = new Float32Array(N),
    GY = new Float32Array(N);
  let m = 0;
  const NB = 180,
    hist = new Float32Array(NB);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!verde[i]) continue;
      const gx = gris[i + 1] - gris[i - 1],
        gy = gris[i + w] - gris[i - w];
      if (Math.abs(gx) + Math.abs(gy) < 10) continue;
      PX[m] = x;
      PY[m] = y;
      GX[m] = gx;
      GY[m] = gy;
      m++;
      let an = Math.atan2(gy, gx);
      an = ((an % PI) + PI) % PI;
      hist[Math.min(NB - 1, ((an / PI) * NB) | 0)] += Math.hypot(gx, gy);
    }
  if (m < 200) return null;
  const sm = new Float32Array(NB);
  for (let i = 0; i < NB; i++) {
    let s = 0;
    for (let k = -2; k <= 2; k++) s += hist[(i + k + NB) % NB];
    sm[i] = s;
  }
  let pk = 0;
  for (let i = 0; i < NB; i++) if (sm[i] > sm[pk]) pk = i;
  const phi0 = ((pk + 0.5) / NB) * PI; // ángulo aproximado
  // Periodo dominante = mejor MÁXIMO LOCAL de la autocorrelación (salta el lóbulo central). {L,conf}.
  const periodo = (sig) => {
    const n = sig.length;
    let mn = 0;
    for (let i = 0; i < n; i++) mn += sig[i];
    mn /= n;
    const s = new Float32Array(n);
    let ac0 = 0;
    for (let i = 0; i < n; i++) {
      s[i] = sig[i] - mn;
      ac0 += s[i] * s[i];
    }
    if (ac0 <= 0) return { L: 0, conf: 0 };
    const minL = Math.max(8, Math.round(n * 0.01)),
      maxL = Math.floor(n / 3);
    const ac = new Float32Array(maxL + 2);
    for (let L = minL - 1; L <= maxL + 1 && L < n; L++) {
      let a = 0;
      for (let i = 0; i + L < n; i++) a += s[i] * s[i + L];
      ac[L] = a / ac0;
    }
    let best = 0,
      bestL = 0;
    for (let L = minL; L <= maxL; L++)
      if (ac[L] > ac[L - 1] && ac[L] >= ac[L + 1] && ac[L] > best) {
        best = ac[L];
        bestL = L;
      }
    return { L: bestL, conf: best };
  };
  // Perfil proyectado sobre la dirección dir (normal a una familia de líneas) → periodo del paso de rejilla.
  const periodoDir = (dir) => {
    const cd = Math.cos(dir),
      sd = Math.sin(dir);
    let tmin = Infinity,
      tmax = -Infinity;
    for (let k = 0; k < m; k++) {
      const tt = PX[k] * cd + PY[k] * sd;
      if (tt < tmin) tmin = tt;
      if (tt > tmax) tmax = tt;
    }
    const n = Math.max(8, Math.ceil(tmax - tmin) + 1);
    const P = new Float32Array(n);
    for (let k = 0; k < m; k++) {
      const wgt = Math.abs(GX[k] * cd + GY[k] * sd);
      if (wgt <= 0) continue;
      const bi = (PX[k] * cd + PY[k] * sd - tmin) | 0;
      if (bi >= 0 && bi < n) P[bi] += wgt;
    }
    return periodo(P);
  };
  // Búsqueda fina ±8° alrededor de phi0: ejes ⟂ deben coincidir (rejilla cuadrada); maximiza min(conf).
  let best = { s: -1, a: null, b: null, dir: phi0 };
  for (let dg = -8; dg <= 8; dg += 0.5) {
    const dir = phi0 + (dg * PI) / 180;
    const a = periodoDir(dir),
      b = periodoDir(dir + PI / 2);
    const ok = a.L && b.L && Math.abs(a.L - b.L) / Math.min(a.L, b.L) < 0.15;
    const s = ok ? Math.min(a.conf, b.conf) : 0;
    if (s > best.s) best = { s, a, b, dir };
  }
  const pasoDs = best.a && best.b ? (best.a.L + best.b.L) / 2 : 0;
  const pxcm = pasoDs ? pasoDs / sc : 0;
  const angDeg = ((((best.dir * 180) / PI) % 90) + 90) % 90;
  try {
    window._rejillaDbg = {
      ang: +angDeg.toFixed(1),
      cx: best.a ? best.a.L : 0,
      cc: best.a ? +best.a.conf.toFixed(2) : 0,
      rx: best.b ? best.b.L : 0,
      rc: best.b ? +best.b.conf.toFixed(2) : 0,
      sc: +sc.toFixed(2),
      pxcm: +pxcm.toFixed(1),
    };
  } catch (_) {}
  if (best.s < 0.18) return null; // sin rejilla clara → regla manual
  return pxcm > 3 && isFinite(pxcm) ? pxcm : null;
}
// Editor de UNA imagen (núcleo reutilizable): rotar 90°, recortar (rect) y corregir PERSPECTIVA (4 esquinas
// → rectángulo). opts = { src (URL o dataURL), onSave(dataURLjpeg), onClose() }. No depende de un documento,
// así sirve tanto para la ficha (guarda por API) como para el alta por ISBN (conforma una portada subida).
function _editorImagen(opts) {
  const src = new Image();
  src.crossOrigin = 'anonymous';
  src.onerror = () => toast('No se pudo cargar la imagen para editar', 'bad');
  src.onload = () => {
    let work = document.createElement('canvas');
    work.width = src.naturalWidth;
    work.height = src.naturalHeight;
    work.getContext('2d').drawImage(src, 0, 0);
    let modo = 'none',
      drag = -1,
      crop = null,
      quad = null;
    const TOPE = 2400; // tope del lado mayor al exportar (protege memoria del móvil)
    $('#cmpModal').innerHTML =
      `<div class="box card" style="max-width:560px;max-height:92vh;overflow:auto"><h3 style="margin-top:0">✎ Editar imagen</h3>
      <div style="display:flex;justify-content:center;background:#0a0d12;border-radius:8px;padding:6px"><canvas id="edC" style="max-width:100%;touch-action:none;border-radius:6px"></canvas></div>
      <p class="muted" id="edMsg" style="font-size:12px;margin:8px 0 4px"></p>
      <div class="row" style="gap:6px;margin-top:4px;flex-wrap:wrap">
        <button class="btn" id="edRotL" title="Girar -90°">⟲</button><button class="btn" id="edRotR" title="Girar +90°">⟳</button>
        <button class="btn" id="edCrop">✂ Recortar</button><button class="btn" id="edPersp">▱ Perspectiva</button><button class="btn" id="edAuto" style="display:none">✨ Auto bordes</button>
        <button class="btn pri" id="edApply" style="display:none">Aplicar</button></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px"><button class="btn" id="edX">Cancelar</button><button class="btn pri" id="edSave">Guardar</button></div></div>`;
    $('#cmpScrim').style.display = 'block';
    $('#cmpModal').style.display = 'grid';
    const c = $('#edC'),
      ctx = c.getContext('2d');
    let escala = 1;
    const base = document.createElement('canvas'),
      bctx = base.getContext('2d');
    // base = imagen YA escalada a pantalla; se reconstruye solo al cambiar work/escala (rotar, recortar,
    // perspectiva, reset), NO en cada arrastre → arrastrar solo blitea base + dibuja tiradores (sin freeze).
    const ajustar = () => {
      const maxW = Math.min(520, (window.innerWidth || 520) - 60);
      escala = Math.min(1, maxW / work.width);
      c.width = Math.round(work.width * escala);
      c.height = Math.round(work.height * escala);
      base.width = c.width;
      base.height = c.height;
      bctx.clearRect(0, 0, base.width, base.height);
      bctx.drawImage(work, 0, 0, base.width, base.height);
    };
    const W2V = (p) => [p[0] * escala, p[1] * escala],
      V2W = (x, y) => [x / escala, y / escala];
    let raf = 0;
    const pedir = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        render();
      });
    }; // throttle a 1/frame
    const render = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(base, 0, 0);
      const pts =
        modo === 'crop'
          ? [
              [crop.x0, crop.y0],
              [crop.x1, crop.y0],
              [crop.x1, crop.y1],
              [crop.x0, crop.y1],
            ]
          : modo === 'persp'
            ? quad
            : null;
      if (pts) {
        ctx.save();
        ctx.strokeStyle = '#28d9a8';
        ctx.lineWidth = 2;
        ctx.fillStyle = 'rgba(40,217,168,.12)';
        ctx.beginPath();
        pts.forEach((p, k) => {
          const v = W2V(p);
          k ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1]);
        });
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        pts.forEach((p) => {
          const v = W2V(p);
          ctx.beginPath();
          ctx.arc(v[0], v[1], 13, 0, 7);
          ctx.fillStyle = 'rgba(40,217,168,.92)';
          ctx.fill();
          ctx.lineWidth = 3;
          ctx.strokeStyle = '#fff';
          ctx.stroke();
        });
        ctx.restore();
      }
    };
    const reset = () => {
      ajustar();
      crop = { x0: work.width * 0.08, y0: work.height * 0.08, x1: work.width * 0.92, y1: work.height * 0.92 };
      const mx = work.width * 0.14,
        my = work.height * 0.14;
      quad = [
        [mx, my],
        [work.width - mx, my],
        [work.width - mx, work.height - my],
        [mx, work.height - my],
      ];
      render();
    };
    reset();
    // Auto bordes: 1º el tapete (fondo verde/calibrado); si no hay tapete, el detector GENÉRICO (cubierta
    // sobre fondo claro/oscuro, foto en ángulo). silencioso=true: sin avisos (uso automático al abrir modo).
    const autoBordes = (silencioso) => {
      let q = detectarBordesVerde(work),
        gen = false;
      if (!q) {
        // Sin tapete: 1º segmentación por FONDO (cubierta sobre superficie uniforme), 2º detector por LÍNEAS.
        q = detectarBordesPorFondo(work) || detectarCuadrilateroGenerico(work);
        gen = !!q;
      }
      if (!q) {
        if (!silencioso) toast('No detecté la cubierta automáticamente; colócala a mano', 'warn');
        return;
      }
      const mX = work.width * 0.03,
        mY = work.height * 0.03,
        cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      q = q.map((p) => [cl(p[0], mX, work.width - mX), cl(p[1], mY, work.height - mY)]); // nunca pegadas al borde (agarrables en móvil)
      if (modo === 'crop') {
        const xs = q.map((p) => p[0]),
          ys = q.map((p) => p[1]);
        crop = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
        if (!silencioso) toast('Recuadro ajustado a la cubierta (si está inclinada, mejor Perspectiva)');
      } else if (modo === 'persp') {
        quad = q;
        if (!silencioso)
          toast(
            gen
              ? 'Esquinas detectadas — revísalas antes de enderezar'
              : 'Esquinas detectadas — ajústalas si hace falta',
          );
      }
      render();
    };
    const setModo = (m) => {
      modo = modo === m ? 'none' : m;
      $('#edApply').style.display = modo === 'none' ? 'none' : '';
      if ($('#edAuto')) $('#edAuto').style.display = modo === 'persp' || modo === 'crop' ? '' : 'none';
      $('#edMsg').textContent =
        modo === 'crop'
          ? 'Arrastra el recuadro a recortar (o «Auto bordes»). Si está inclinado, usa Perspectiva.'
          : modo === 'persp'
            ? 'Coloca las 4 esquinas sobre las del libro (↖↗↘↙) — o «Auto bordes» — y desestira un libro INCLINADO a rectángulo.'
            : '';
      render();
      if (modo === 'crop' || modo === 'persp') autoBordes(true);
    }; // auto-detección inmediata al abrir el modo (como Medir)
    $('#edCrop').onclick = () => setModo('crop');
    $('#edPersp').onclick = () => setModo('persp');
    if ($('#edAuto')) $('#edAuto').onclick = () => autoBordes(false);
    const rotar = (horario) => {
      const nc = document.createElement('canvas');
      nc.width = work.height;
      nc.height = work.width;
      const x = nc.getContext('2d');
      x.translate(nc.width / 2, nc.height / 2);
      x.rotate(((horario ? 90 : -90) * Math.PI) / 180);
      x.drawImage(work, -work.width / 2, -work.height / 2);
      work = nc;
      modo = 'none';
      $('#edApply').style.display = 'none';
      reset();
    };
    $('#edRotL').onclick = () => rotar(false);
    $('#edRotR').onclick = () => rotar(true);
    // arrastre de esquinas
    let _rc = null;
    const pos = (ev) => {
      const rc = _rc || c.getBoundingClientRect();
      const t = ev.touches ? ev.touches[0] : ev;
      return V2W(t.clientX - rc.left, t.clientY - rc.top);
    }; // _rc cacheado en pointerdown (evita reflow por evento)
    const handles = () =>
      modo === 'crop'
        ? [
            [crop.x0, crop.y0],
            [crop.x1, crop.y0],
            [crop.x1, crop.y1],
            [crop.x0, crop.y1],
          ]
        : modo === 'persp'
          ? quad
          : [];
    c.addEventListener('pointerdown', (ev) => {
      if (modo === 'none') return;
      ev.preventDefault();
      _rc = c.getBoundingClientRect();
      const p = pos(ev),
        hs = handles();
      let best = -1,
        bd = 34 / escala;
      hs.forEach((h, k) => {
        const dd = _dist(h, p);
        if (dd < bd) {
          bd = dd;
          best = k;
        }
      });
      drag = best;
      if (best >= 0)
        try {
          c.setPointerCapture(ev.pointerId);
        } catch (_) {}
    });
    c.addEventListener('pointermove', (ev) => {
      if (drag < 0) return;
      ev.preventDefault();
      let [x, y] = pos(ev);
      const mX = work.width * 0.03,
        mY = work.height * 0.03;
      x = Math.max(mX, Math.min(work.width - mX, x));
      y = Math.max(mY, Math.min(work.height - mY, y));
      if (modo === 'crop') {
        if (drag === 0) {
          crop.x0 = x;
          crop.y0 = y;
        } else if (drag === 1) {
          crop.x1 = x;
          crop.y0 = y;
        } else if (drag === 2) {
          crop.x1 = x;
          crop.y1 = y;
        } else {
          crop.x0 = x;
          crop.y1 = y;
        }
      } else {
        quad[drag] = [x, y];
      }
      pedir();
    });
    const soltar = () => {
      drag = -1;
    };
    c.addEventListener('pointerup', soltar);
    c.addEventListener('pointercancel', soltar);
    $('#edApply').onclick = () => {
      if (modo === 'crop') {
        const x0 = Math.min(crop.x0, crop.x1),
          y0 = Math.min(crop.y0, crop.y1),
          w = Math.abs(crop.x1 - crop.x0),
          h = Math.abs(crop.y1 - crop.y0);
        if (w < 8 || h < 8) {
          toast('Recorte demasiado pequeño', 'warn');
          return;
        }
        const nc = document.createElement('canvas');
        nc.width = Math.round(w);
        nc.height = Math.round(h);
        nc.getContext('2d').drawImage(work, x0, y0, w, h, 0, 0, nc.width, nc.height);
        work = nc;
      } else if (modo === 'persp') {
        const [TL, TR, BR, BL] = quad;
        let W = Math.round((_dist(TL, TR) + _dist(BL, BR)) / 2),
          H = Math.round((_dist(TL, BL) + _dist(TR, BR)) / 2);
        if (W < 8 || H < 8) {
          toast('Esquinas no válidas', 'warn');
          return;
        }
        const f = Math.min(1, TOPE / Math.max(W, H));
        W = Math.round(W * f);
        H = Math.round(H * f);
        const Hi = _homografia(
          [
            [0, 0],
            [W, 0],
            [W, H],
            [0, H],
          ],
          quad,
        ); // salida-rect → fuente
        const simg = work.getContext('2d').getImageData(0, 0, work.width, work.height),
          sd = simg.data,
          sw = work.width,
          sh = work.height;
        const out = ctx.createImageData(W, H),
          od = out.data;
        for (let y = 0; y < H; y++)
          for (let x = 0; x < W; x++) {
            const [sx, sy] = _mapH(Hi, x + 0.5, y + 0.5);
            const ix = sx | 0,
              iy = sy | 0;
            const o = (y * W + x) * 4;
            if (ix >= 0 && iy >= 0 && ix < sw && iy < sh) {
              const s = (iy * sw + ix) * 4;
              od[o] = sd[s];
              od[o + 1] = sd[s + 1];
              od[o + 2] = sd[s + 2];
              od[o + 3] = 255;
            } else od[o + 3] = 255;
          }
        const nc = document.createElement('canvas');
        nc.width = W;
        nc.height = H;
        nc.getContext('2d').putImageData(out, 0, 0);
        work = nc;
      }
      modo = 'none';
      $('#edApply').style.display = 'none';
      reset();
    };
    $('#edX').onclick = () => {
      if (opts.onClose) opts.onClose();
    };
    $('#edSave').onclick = async () => {
      // exportar (cap del lado mayor) a JPEG
      let cw = work.width,
        ch = work.height;
      const f = Math.min(1, TOPE / Math.max(cw, ch));
      let exp = work;
      if (f < 1) {
        exp = document.createElement('canvas');
        exp.width = Math.round(cw * f);
        exp.height = Math.round(ch * f);
        exp.getContext('2d').drawImage(work, 0, 0, exp.width, exp.height);
      }
      const b64 = exp.toDataURL('image/jpeg', 0.9);
      if (opts.onSave) await opts.onSave(b64);
    };
  };
  src.src = opts.src;
}
// Envoltura para la ficha: edita una imagen del carrusel y guarda por API (re-pinta el gestor).
function abrirEditorImagen(i) {
  const im = _imgState.imgs[i];
  if (!im) return;
  _editorImagen({
    src: encUrl(im.ruta) + '?t=' + Date.now(),
    onClose: pintarGestorImagenes,
    onSave: async (b64) => {
      const ok = await apiImg('reemplazar', { ruta: im.ruta, base64: b64 });
      if (ok) toast('Imagen actualizada');
    },
  });
}
// MEDIR el tamaño físico del libro (opcional, on-demand). Sobre la 1.ª imagen (idealmente en la
// alfombrilla reglada): recuadro VERDE en el libro (auto o manual) + regla AZUL de 2 puntos sobre una
// distancia conocida del eje → px/cm → ancho×alto en cm. Foto cenital ≈ escala uniforme. Sin IA.
function medirDimensiones(id, imagenes) {
  const im = (imagenes || [])[0];
  if (!im) {
    toast('No hay imagen para medir', 'warn');
    return;
  }
  const src = new Image();
  src.crossOrigin = 'anonymous';
  src.onerror = () => toast('No se pudo cargar la imagen', 'bad');
  src.onload = () => {
    const iw = src.naturalWidth,
      ih = src.naturalHeight;
    let quad = [
      [iw * 0.14, ih * 0.14],
      [iw * 0.86, ih * 0.14],
      [iw * 0.86, ih * 0.86],
      [iw * 0.14, ih * 0.86],
    ];
    let regla = [
        [iw * 0.2, ih * 0.95],
        [iw * 0.5, ih * 0.95],
      ],
      cm = 10,
      drag = null,
      pxcmAuto = null;
    $('#cmpModal').innerHTML =
      `<div class="box card" style="max-width:560px;max-height:92vh;overflow:auto"><h3 style="margin-top:0">📐 Medir tamaño</h3>
      <div style="display:flex;justify-content:center;background:#0a0d12;border-radius:8px;padding:6px"><canvas id="mdC" style="max-width:100%;touch-action:none;border-radius:6px"></canvas></div>
      <p class="muted" style="font-size:12px;margin:8px 0 4px">«📐 Auto medir»: detecta libro + rejilla del tapete (1 cm) y calcula solo. Si no, ponlo a mano: recuadro VERDE en el libro («Auto bordes») y regla AZUL sobre una distancia CONOCIDA del eje, indicándola en cm. Foto cenital (de frente).</p>
      <div class="row" style="gap:8px;align-items:center;margin:4px 0">
        <button class="btn pri" id="mdAutoMed" title="Detecta el libro y el paso de la rejilla (1 cm) y mide automáticamente">📐 Auto medir</button>
        <button class="btn" id="mdAuto">✨ Auto bordes</button>
        <label class="muted" style="font-size:12px">Regla =</label><input id="mdCm" type="number" value="10" step="0.5" min="0.5" style="width:74px"><span class="muted">cm</span>
        <b id="mdOut" style="margin-left:auto"></b></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:10px"><button class="btn" id="mdX">Cancelar</button><button class="btn pri" id="mdSave">Guardar</button></div></div>`;
    $('#cmpScrim').style.display = 'block';
    $('#cmpModal').style.display = 'grid';
    const c = $('#mdC'),
      ctx = c.getContext('2d');
    const maxW = Math.min(520, (window.innerWidth || 520) - 60),
      escala = Math.min(1, maxW / iw);
    c.width = Math.round(iw * escala);
    c.height = Math.round(ih * escala);
    const W2V = (p) => [p[0] * escala, p[1] * escala],
      V2W = (x, y) => [x / escala, y / escala];
    // base = imagen ya escalada (una vez); arrastrar solo blitea base + dibuja recuadro/regla (sin freeze).
    const base = document.createElement('canvas');
    base.width = c.width;
    base.height = c.height;
    base.getContext('2d').drawImage(src, 0, 0, base.width, base.height);
    let raf = 0;
    const pedir = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        render();
      });
    }; // throttle a 1/frame
    const calc = () => {
      const pxcm = pxcmAuto || _dist(regla[0], regla[1]) / (cm || 1);
      if (!pxcm || !isFinite(pxcm)) return null;
      return {
        W: (_dist(quad[0], quad[1]) + _dist(quad[3], quad[2])) / 2 / pxcm,
        H: (_dist(quad[0], quad[3]) + _dist(quad[1], quad[2])) / 2 / pxcm,
      };
    };
    const aro = (p, fill) => {
      const v = W2V(p);
      ctx.beginPath();
      ctx.arc(v[0], v[1], 11, 0, 7);
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#fff';
      ctx.stroke();
    };
    const render = () => {
      ctx.clearRect(0, 0, c.width, c.height);
      ctx.drawImage(base, 0, 0);
      ctx.save();
      ctx.strokeStyle = '#28d9a8';
      ctx.lineWidth = 2;
      ctx.fillStyle = 'rgba(40,217,168,.10)';
      ctx.beginPath();
      quad.forEach((p, k) => {
        const v = W2V(p);
        k ? ctx.lineTo(v[0], v[1]) : ctx.moveTo(v[0], v[1]);
      });
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      quad.forEach((p) => aro(p, 'rgba(40,217,168,.92)'));
      ctx.strokeStyle = '#1ba3ff';
      ctx.lineWidth = 3;
      const a = W2V(regla[0]),
        b = W2V(regla[1]);
      ctx.beginPath();
      ctx.moveTo(a[0], a[1]);
      ctx.lineTo(b[0], b[1]);
      ctx.stroke();
      regla.forEach((p) => aro(p, 'rgba(27,163,255,.95)'));
      ctx.restore();
      const r = calc();
      $('#mdOut').textContent = r
        ? `≈ ${r.W.toFixed(1).replace('.', ',')} × ${r.H.toFixed(1).replace('.', ',')} cm${pxcmAuto ? ' · auto' : ''}`
        : '';
    };
    // Auto-detectar (libro + escala de rejilla). Si la escala es plausible (4-50 cm): fija pxcmAuto Y
    // CORRIGE el "Regla = 10" por defecto a la medida REAL que cubre la regla actual. Reutilizado en carga y
    // en el botón. Devuelve {q,pxcm,dims,ok,tmp} para los avisos.
    const intentarAuto = () => {
      const tmp = document.createElement('canvas');
      tmp.width = iw;
      tmp.height = ih;
      tmp.getContext('2d').drawImage(src, 0, 0);
      const mX = iw * 0.03,
        mY = ih * 0.03,
        cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      const q = detectarBordesVerde(tmp);
      if (q) quad = q.map((p) => [cl(p[0], mX, iw - mX), cl(p[1], mY, ih - mY)]);
      const pxcm = detectarRejillaPxCm(tmp);
      let dims = null;
      if (pxcm && q) {
        const W = (_dist(quad[0], quad[1]) + _dist(quad[3], quad[2])) / 2 / pxcm,
          H = (_dist(quad[0], quad[3]) + _dist(quad[1], quad[2])) / 2 / pxcm;
        dims = { W, H };
      }
      const ok = !!dims && dims.W >= 4 && dims.W <= 50 && dims.H >= 4 && dims.H <= 50;
      if (ok) {
        pxcmAuto = pxcm;
        cm = +(_dist(regla[0], regla[1]) / pxcm).toFixed(1);
        const ci = $('#mdCm');
        if (ci) ci.value = String(cm);
      } else pxcmAuto = null;
      render();
      return { q, pxcm, dims, ok, tmp };
    };
    // Al CARGAR: si hay tapete, auto-mide (silencioso si falla). Foto normal sin tapete → no cambia nada.
    {
      const a0 = intentarAuto();
      if (a0.ok)
        toast(
          `Auto: ${a0.dims.W.toFixed(1).replace('.', ',')} × ${a0.dims.H.toFixed(1).replace('.', ',')} cm — ajusta si hace falta`,
        );
    }
    let _rc = null;
    const pos = (ev) => {
      const rc = _rc || c.getBoundingClientRect();
      const t = ev.touches ? ev.touches[0] : ev;
      return V2W(t.clientX - rc.left, t.clientY - rc.top);
    }; // _rc cacheado en pointerdown (evita reflow por evento)
    c.addEventListener('pointerdown', (ev) => {
      ev.preventDefault();
      _rc = c.getBoundingClientRect();
      const p = pos(ev);
      let best = null,
        bd = 34 / escala;
      quad.forEach((h, i) => {
        const dd = _dist(h, p);
        if (dd < bd) {
          bd = dd;
          best = { s: 'q', i };
        }
      });
      regla.forEach((h, i) => {
        const dd = _dist(h, p);
        if (dd < bd) {
          bd = dd;
          best = { s: 'r', i };
        }
      });
      drag = best;
      if (best)
        try {
          c.setPointerCapture(ev.pointerId);
        } catch (_) {}
    });
    c.addEventListener('pointermove', (ev) => {
      if (!drag) return;
      ev.preventDefault();
      let [x, y] = pos(ev);
      const mX = iw * 0.03,
        mY = ih * 0.03;
      x = Math.max(mX, Math.min(iw - mX, x));
      y = Math.max(mY, Math.min(ih - mY, y));
      if (drag.s === 'r') pxcmAuto = null;
      /* tocar la regla → escala manual */ (drag.s === 'q' ? quad : regla)[drag.i] = [x, y];
      pedir();
    });
    const soltar = () => {
      drag = null;
    };
    c.addEventListener('pointerup', soltar);
    c.addEventListener('pointercancel', soltar);
    $('#mdCm').oninput = () => {
      cm = parseFloat($('#mdCm').value) || 0;
      pxcmAuto = null;
      /* la regla manual manda */ render();
    };
    $('#mdAutoMed').onclick = () => {
      const { q, pxcm, dims, ok, tmp } = intentarAuto();
      const dg = window._rejillaDbg;
      const dbg = dg
        ? ` · ${dg.ang}° X[${dg.cx}|${dg.cc}] Y[${dg.rx}|${dg.rc}] sc${dg.sc} ${dg.pxcm}px/cm`
        : '';
      try {
        console.log('AutoMedir', { libro: !!q, pxcm, dims, dbg: dg });
      } catch (_) {}
      if (ok) {
        toast('Auto: rejilla ' + pxcm.toFixed(1).replace('.', ',') + ' px/cm' + dbg);
        return;
      }
      if (pxcm && dims) {
        toast(
          `Rejilla DUDOSA → ${dims.W.toFixed(0)}×${dims.H.toFixed(0)} cm absurdo; mide a mano${dbg}`,
          'warn',
        );
        return;
      }
      const fv = Math.round(fraccionVerde(tmp) * 100); // % de tapete detectado
      toast(`${q ? 'libro ✓' : 'libro ✗'} · rejilla ✗ · tapete ${fv}%${dbg}`, 'warn');
    };
    $('#mdAuto').onclick = () => {
      const tmp = document.createElement('canvas');
      tmp.width = iw;
      tmp.height = ih;
      tmp.getContext('2d').drawImage(src, 0, 0);
      let q = detectarBordesVerde(tmp);
      if (q) {
        const mX = iw * 0.03,
          mY = ih * 0.03,
          cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        quad = q.map((p) => [cl(p[0], mX, iw - mX), cl(p[1], mY, ih - mY)]);
        render();
        toast('Bordes detectados');
      } else toast('No detecté el libro sobre fondo verde', 'warn');
    };
    $('#mdX').onclick = cerrarCmp;
    $('#cmpScrim').onclick = cerrarCmp;
    $('#mdSave').onclick = async () => {
      const r = calc();
      if (!r || !(r.W > 0 && r.H > 0)) {
        toast('Coloca la regla y el recuadro primero', 'warn');
        return;
      }
      try {
        const res = await api('/documentos/' + encodeURIComponent(id) + '/dimensiones', {
          method: 'POST',
          body: JSON.stringify({ ancho_cm: r.W, alto_cm: r.H }),
        });
        if (!res.ok) {
          toast(res.motivo || 'error', 'bad');
          return;
        }
        cerrarCmp();
        toast(
          `Tamaño guardado: ${String(res.ancho_cm).replace('.', ',')} × ${String(res.alto_cm).replace('.', ',')} cm`,
        );
        verDoc(id, detalle && detalle.ctx);
      } catch (e) {
        toast(e.message, 'bad');
      }
    };
  };
  src.src = encUrl(im.ruta) + '?t=' + Date.now();
}
// Opciones <option> de meses (para revistas). `cur` puede ser nº 1-12 o nombre de mes; deja el actual marcado.
function mesesOptions(cur) {
  const nombres = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  let n = parseInt(cur, 10);
  if (!(n >= 1 && n <= 12) && cur) {
    const i = nombres.findIndex((m) => m.toLowerCase() === String(cur).toLowerCase());
    if (i >= 0) n = i + 1;
  }
  return '<option value="">—</option>' + nombres.map((m, i) => `<option value="${i + 1}"${n === i + 1 ? ' selected' : ''}>${m}</option>`).join('');
}
function fichaEditar(d, r, opts) {
  opts = opts || {};
  const sup = !!opts.supervisado;
  const v = (x) => (x == null ? '' : String(x));
  const campo = (id, lab, val, tag = 'input', extra = '') =>
    `<label style="display:block;margin-top:8px">${lab}</label>${tag === 'textarea' ? `<textarea id="${id}" rows="10" ${extra}>${esc(val)}</textarea>` : `<input id="${id}" value="${esc(val)}" ${extra} autocomplete="off">`}`;
  const ub = d.ubicacion || {};
  const btnScanIsbn =
    'BarcodeDetector' in window
      ? '<button class="btn" type="button" id="edScan" title="Escanear código de barras con la cámara">📷</button>'
      : '';
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:560px;max-height:88vh;overflow:auto"><h3 style="margin-top:0">${sup ? '🚥 Revisar alta' : '✏️ Editar documento'}</h3>
    ${sup && d.portada ? `<img src="${encUrl(d.portada)}" alt="" style="float:right;width:84px;border-radius:8px;margin:0 0 8px 12px;border:1px solid var(--line)">` : ''}
    ${sup ? `<p class="muted" style="font-size:12px;margin:0 0 6px">Revisa y corrige si hace falta; «Aceptar» guarda y vuelve al Inbox para el siguiente.</p>` : ''}
    <div style="display:flex;gap:10px;justify-content:flex-end;margin:2px 0 4px"><button class="btn" id="edXTop">Cancelar</button><button class="btn pri" id="edOkTop">${sup ? '✓ Aceptar y siguiente' : 'Guardar'}</button></div>
    ${campo('edTit', 'Título', d.titulo)}
    ${campo('edSub', 'Subtítulo', d.subtitulo)}
    <label style="display:block;margin-top:8px">Tipo</label>
    <select id="edTipo">${['libro', 'revista', 'articulo', 'capitulo', 'apuntes', 'software'].map((t) => `<option value="${t}"${(d.tipo_recurso || 'libro') === t ? ' selected' : ''}>${tipoIcono(t)} ${tipoNombre(t)}</option>`).join('')}</select>
    <div class="row" style="gap:8px;margin-top:8px;align-items:flex-end"><div><label style="display:block">Soporte</label>
      <select id="edSoporte"><option value="digital"${!(d.formatos || []).includes('papel') ? ' selected' : ''}>💾 Digital</option><option value="papel"${(d.formatos || []).includes('papel') ? ' selected' : ''}>📄 Papel</option></select></div>
      <div class="muted" style="font-size:11px;flex:1">Cambiar a «Digital» intenta recuperar el PDF/EPUB original de la carpeta del documento.</div></div>
    <div style="margin-top:8px"><label style="display:block">Autores y colaboradores</label><div id="edAutList"></div><button type="button" class="btn" id="edAutAdd" style="margin-top:6px">➕ Añadir persona</button></div>
    ${campo('edEdi', 'Editorial', r.editorial || '')}
    <div class="row" style="gap:8px">${`<div style="flex:1">${campo('edAno', 'Año', d.año_edicion)}</div><div style="flex:1">${campo('edIdi', 'Idioma', d.idioma)}</div><div style="flex:1">${campo('edPag', 'Páginas', d.paginas)}</div>`}</div>
    <div id="edRevBlk" style="${d.tipo_recurso === 'revista' ? '' : 'display:none'}"><div class="row" style="gap:8px">
      <div style="flex:1"><label style="display:block;margin-top:8px">Mes (ejemplar)</label><select id="edMes">${mesesOptions(d.mes_publicacion)}</select></div>
      <div style="flex:1">${campo('edNum', 'Nº de ejemplar', d.numero_issue)}</div>
    </div><div class="muted" style="font-size:11px;margin-top:2px">El mes/año/nº definen la identidad del ejemplar dentro de su cabecera.</div></div>
    <div class="row" style="gap:8px"><div style="flex:1"><label style="display:block;margin-top:8px">ISBN</label><div style="display:flex;gap:6px"><input id="edIsbn" value="${esc(d.isbn || '')}" autocomplete="off" style="flex:1">${btnScanIsbn}</div></div><div style="flex:1">${campo('edIssn', 'ISSN', d.issn)}</div></div>
    ${campo('edDoi', 'DOI (artículos)', d.doi)}
    <div style="margin-top:8px"><label style="display:block">Otras ediciones (ISBN)</label><div id="edAltList"></div><button type="button" class="btn" id="edAltAdd" style="margin-top:6px">➕ Añadir edición</button></div>
    <div class="row" style="gap:8px">${`<div style="flex:1">${campo('edCdu', 'CDU', d.cdu)}</div><div style="flex:1">${campo('edEd', 'Edición nº', d.numero_edicion)}</div></div>`}
    <!-- Otras clasificaciones: se veían en la ficha (fila con ⓘ) pero no se podían corregir a mano. Solo son
         metadatos: a diferencia de la CDU, NO re-alojan el fichero en el árbol. -->
    <div class="row" style="gap:8px">
      <div style="flex:1">${campo('edDewey', 'Dewey', d.dewey)}</div>
      <div style="flex:1">${campo('edLcc', 'LCC', d.lcc)}</div>
      <div style="flex:1">${campo('edLccn', 'LCCN', d.lccn)}</div>
    </div>
    ${campo('edPal', 'Palabras clave (coma)', (d.palabras_clave || []).join(', '))}
    ${campo('edSin', 'Sinopsis', d.sinopsis, 'textarea')}
    <div class="row" style="gap:8px"><div style="flex:1"><label>Ámbito</label><select id="edAmbSel"></select><input id="edAmb" autocomplete="off" placeholder="nuevo ámbito…" style="display:none;margin-top:6px"></div><div style="flex:1"><label>Estantería</label><select id="edEstSel"></select><input id="edEst" autocomplete="off" placeholder="nueva estantería…" style="display:none;margin-top:6px"></div></div>
    <label style="display:flex;gap:8px;align-items:center;margin-top:12px;cursor:pointer"><input type="checkbox" id="edLock" ${d.locked ? 'checked' : ''}> 🔒 Bloquear (el Conformador no lo tocará)</label>
    <div id="edErr" style="color:var(--bad);font-size:12px;min-height:15px;margin-top:6px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" id="edX">Cancelar</button><button class="btn pri" id="edOk">${sup ? '✓ Aceptar y siguiente' : 'Guardar'}</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = cerrarCmp;
  // Ubicación en edición: <select> FIABLE (despliega sus valores) con opción «➕ Otra…» para texto libre.
  // La estantería va ASOCIADA al ámbito elegido. #edAmb/#edEst (ocultos) son los valores que se guardan.
  const setupUbicEdit = () =>
    montarSelUbic({
      sa: 'edAmbSel',
      ia: 'edAmb',
      se: 'edEstSel',
      ie: 'edEst',
      curA: ub.ambito,
      curE: ub.estanteria,
    });
  if (mapaUbicaciones.length) setupUbicEdit();
  else cargarUbicaciones().then(setupUbicEdit);
  // Los campos de revista (mes/nº) solo se muestran si el tipo es «revista» (se alterna al cambiar el tipo).
  if ($('#edTipo')) $('#edTipo').onchange = () => { const b = $('#edRevBlk'); if (b) b.style.display = $('#edTipo').value === 'revista' ? '' : 'none'; };
  // Editor de OTRAS EDICIONES (ISBN alternativo + rol). Filas añadibles/borrables.
  const rolOpts = (sel) =>
    ROL_ISBN_OPC.map(
      ([val, lab]) => `<option value="${val}"${val === sel ? ' selected' : ''}>${lab}</option>`,
    ).join('');
  const edAltFila = (a) =>
    `<div class="edAltRow" style="display:flex;gap:6px;margin-top:6px;align-items:center"><input class="edAltIsbn" value="${esc((a && a.isbn) || '')}" placeholder="ISBN" autocomplete="off" style="flex:1 1 auto;min-width:0;width:auto"><select class="edAltRol" style="flex:0 0 140px;width:140px">${rolOpts((a && a.rol) || 'otro')}</select><button type="button" class="btn bad edAltDel" title="Quitar" style="flex:none;padding:2px 9px">✕</button></div>`;
  const edAltWire = (b) => {
    b.onclick = () => b.closest('.edAltRow').remove();
  };
  {
    const L = $('#edAltList');
    if (L) {
      L.innerHTML = (d.isbns_alternativos || []).map(edAltFila).join('');
      $$('#edAltList .edAltDel').forEach(edAltWire);
    }
  }
  if ($('#edAltAdd'))
    $('#edAltAdd').onclick = () => {
      const L = $('#edAltList');
      if (!L) return;
      L.insertAdjacentHTML('beforeend', edAltFila(null));
      edAltWire(L.lastElementChild.querySelector('.edAltDel'));
    };
  // Editor de AUTORES + COLABORADORES (nombre + rol). Filas añadibles/borrables. El nombre puede llevar
  // COMAS («Touchard, Jean»): cada fila es una persona (no se parte por comas). El rol 'autor' va a
  // autores[]; los demás (traductor/ilustrador/editor/…) a contribuciones[].
  const ROLES_PERSONA = [['autor', 'Autor'], ['traductor', 'Traductor'], ['ilustrador', 'Ilustrador'], ['editor', 'Editor'], ['prologuista', 'Prologuista'], ['anotador', 'Anotador'], ['compilador', 'Compilador']];
  const rolPersonaOpts = (sel) => ROLES_PERSONA.map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('');
  const edAutFila = (nombre, rol) =>
    `<div class="edAutRow" style="display:flex;gap:6px;margin-top:6px;align-items:center"><input class="edAutNom" value="${esc(nombre || '')}" placeholder="Apellido, Nombre" autocomplete="off" style="flex:1 1 auto;min-width:0;width:auto"><select class="edAutRol" style="flex:0 0 140px;width:140px">${rolPersonaOpts(rol || 'autor')}</select><button type="button" class="btn bad edAutDel" title="Quitar" style="flex:none;padding:2px 9px">✕</button></div>`;
  const edAutWire = (b) => { b.onclick = () => b.closest('.edAutRow').remove(); };
  {
    const L = $('#edAutList');
    if (L) {
      const filas = [
        ...(r.autores || []).map((n) => edAutFila(n, 'autor')),
        ...(r.contribuciones || []).filter((c) => !c.desconocido).map((c) => edAutFila(c.nombre, c.rol)),
      ];
      L.innerHTML = filas.join('') || edAutFila('', 'autor');
      $$('#edAutList .edAutDel').forEach(edAutWire);
    }
  }
  if ($('#edAutAdd'))
    $('#edAutAdd').onclick = () => {
      const L = $('#edAutList');
      if (!L) return;
      L.insertAdjacentHTML('beforeend', edAutFila('', 'autor'));
      edAutWire(L.lastElementChild.querySelector('.edAutDel'));
    };
  if ($('#edScan')) $('#edScan').onclick = () => escanearISBN('edIsbn'); // escanear ISBN en la ficha (supervisado)
  const onGuardar = async () => {
    // Personas: cada fila es una (nombre con comas incluido). rol 'autor' → autores[]; el resto → contribuciones[].
    const personas = [...document.querySelectorAll('#edAutList .edAutRow')]
      .map((row) => ({ nombre: row.querySelector('.edAutNom').value.trim(), rol: row.querySelector('.edAutRol').value }))
      .filter((p) => p.nombre);
    const campos = {
      titulo: $('#edTit').value,
      subtitulo: $('#edSub').value,
      tipo_recurso: $('#edTipo').value,
      soporte: $('#edSoporte') ? $('#edSoporte').value : undefined, // papel↔digital; a digital recupera el fichero
      autores: personas.filter((p) => p.rol === 'autor').map((p) => p.nombre),
      contribuciones: personas.filter((p) => p.rol !== 'autor'),
      editorial: $('#edEdi').value,
      año_edicion: $('#edAno').value,
      mes_publicacion: $('#edMes') ? $('#edMes').value : '',
      numero_issue: $('#edNum') ? $('#edNum').value : '',
      idioma: $('#edIdi').value,
      paginas: $('#edPag').value,
      isbn: $('#edIsbn').value,
      issn: $('#edIssn').value,
      doi: $('#edDoi') ? $('#edDoi').value : undefined,
      cdu: $('#edCdu').value,
      dewey: $('#edDewey') ? $('#edDewey').value : undefined,
      lcc: $('#edLcc') ? $('#edLcc').value : undefined,
      lccn: $('#edLccn') ? $('#edLccn').value : undefined,
      numero_edicion: $('#edEd').value,
      palabras_clave: $('#edPal').value,
      sinopsis: $('#edSin').value,
      ubicacion: { ambito: $('#edAmb').value, estanteria: $('#edEst').value },
      locked: $('#edLock').checked,
      isbns_alternativos: [...document.querySelectorAll('#edAltList .edAltRow')]
        .map((row) => ({
          isbn: row.querySelector('.edAltIsbn').value.trim(),
          rol: row.querySelector('.edAltRol').value,
        }))
        .filter((a) => a.isbn),
    };
    try {
      const res = await api('/documentos/' + encodeURIComponent(d._id) + '/editar', {
        method: 'POST',
        body: JSON.stringify(campos),
      });
      if (!res.ok) {
        $('#edErr').textContent = res.motivo;
        toast(res.motivo, 'bad');
        return;
      }
      cerrarCmp();
      toast('Guardado' + ((res.avisos || []).length ? ' · ' + res.avisos.join('; ') : ''));
      if (sup) go('inbox');
      else verDoc(d._id, detalle && detalle.ctx);
    } catch (e) {
      $('#edErr').textContent = e.message;
      toast(e.message, 'bad');
    }
  };
  // Cancelar: en modo NORMAL solo cierra; en SUPERVISADO el alta acaba de insertarse, así que «Cancelar»
  // la DESCARTA (la borra de la base; su carpeta va a la Papelera, recuperable) — sin contraseña por ser
  // un alta reciente. Confirma para no descartar por error.
  const onCancelar = sup
    ? async () => {
        if (
          !confirm('¿Descartar este alta? Se borra de la base y su carpeta va a la Papelera (recuperable).')
        )
          return;
        try {
          const res = await api('/documentos/' + encodeURIComponent(d._id) + '/descartar', {
            method: 'POST',
            body: JSON.stringify({}),
          });
          if (!res.ok) {
            toast(res.motivo || 'No se pudo descartar', 'bad');
            return;
          }
          cerrarCmp();
          toast('Alta descartada (en la Papelera)');
          go('inbox');
        } catch (e) {
          toast(e.message, 'bad');
        }
      }
    : cerrarCmp;
  // Botones duplicados arriba y abajo (no hace falta hacer scroll para Aceptar/Cancelar).
  ['edX', 'edXTop'].forEach((id) => {
    const b = $('#' + id);
    if (b) b.onclick = onCancelar;
  });
  ['edOk', 'edOkTop'].forEach((id) => {
    const b = $('#' + id);
    if (b) b.onclick = onGuardar;
  });
  // En supervisado, clic fuera NO deja el alta en limbo: no cerramos por el scrim (usa Aceptar/Cancelar).
  if (sup) $('#cmpScrim').onclick = null;
}

// Reproductor de AUDIO con playlist (audiolibros / lecturas con audio de un transmedia). Los mp3 se sirven
// desde /recursos (estático). Se inicializa tras pintar con iniciarReproductorAudio.
// Duración en mm:ss (o h:mm:ss). '' si no hay.
function fmtDur(s) {
  if (!s) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(sec).padStart(2, '0');
}
// Etiqueta de disco (CD1/CD2…) del lado cliente: usa `grupo` si viene del servidor; si no, la deriva de la
// carpeta padre de la ruta (para audiolibros catalogados antes de guardar `grupo`).
const RE_DISCO_CLI = new RegExp('[\\s._-]*(?:cd|dis[ck]o?|disque|parte?|vol(?:umen)?)\\s*\\.?\\s*\\d+\\s*$', 'i');
function etiquetaDiscoCli(nombre) {
  const m = String(nombre || '').match(RE_DISCO_CLI);
  return m ? m[0].replace(/^[\s._-]+/, '').replace(/\s+/g, ' ').trim() : String(nombre || '');
}
function grupoDeAudio(a) {
  if (a.grupo) return a.grupo;
  const segs = decodeURIComponent(String(a.ruta || '')).split('/').filter(Boolean);
  return segs.length >= 2 ? etiquetaDiscoCli(segs[segs.length - 2]) : '';
}

function reproductorAudioHtml(audios, id) {
  const lista = (audios || []).slice().sort((a, b) => (a.orden || 0) - (b.orden || 0));
  if (!lista.length) return '';
  // Selector de DISCO (Todo / CD1 / CD2…): solo si las pistas se reparten en ≥2 grupos (multi-CD).
  const grupos = [...new Set(lista.map(grupoDeAudio).filter(Boolean))];
  const multi = grupos.length >= 2;
  const pistas = lista.map((a, i) =>
    `<button type="button" class="audiotrack" data-src="${esc(encUrl(a.ruta))}" data-grupo="${esc(grupoDeAudio(a))}" title="${esc(a.titulo || '')}" style="display:flex;gap:10px;align-items:center;width:100%;text-align:left;padding:8px 10px;border:none;border-top:1px solid var(--line);background:none;color:inherit;cursor:pointer;font-size:13px">`
    + `<span style="opacity:.55;min-width:22px;text-align:right">${i + 1}</span>`
    + `<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.titulo || 'Pista ' + (i + 1))}</span>`
    + (a.duracion ? `<span class="muted" style="font-size:11px;flex-shrink:0">${fmtDur(a.duracion)}</span>` : '')
    + `</button>`).join('');
  // Descargas (streaming ZIP por bsdtar, público como /recursos): la playlist completa (solo audio) y la
  // carpeta entera (audio + imágenes + lo que haya). Enlaces normales <a download> → sin token.
  const descargas = id
    ? `<a class="btn" href="/api/descargar/${esc(id)}?que=audio" download title="Descargar todas las pistas en un ZIP" style="padding:4px 10px;font-size:12px">⬇ Playlist</a>
       <a class="btn" href="/api/descargar/${esc(id)}?que=todo" download title="Descargar TODO el contenido (audio + imágenes + extras) en un ZIP" style="padding:4px 10px;font-size:12px">⬇ Todo (ZIP)</a>`
    : '';
  // «Reordenar» (admin): ordenar por pista/título/duración y/o mover a mano; se persiste.
  const reord = (id && ROL === 'admin')
    ? `<button class="btn admin-only" id="audioReord" title="Ordenar / reordenar las pistas" style="padding:4px 10px;font-size:12px">🎚️ Reordenar</button>`
    : '';
  // Selector de disco (chips). Filtra la lista visible; la reproducción sigue el orden completo.
  const selector = multi
    ? `<div class="row" id="cdSel" style="flex-wrap:wrap;gap:6px;margin-bottom:8px">
         <button class="btn filtCD active" data-cd="">Todo</button>${grupos.map((g) => `<button class="btn filtCD" data-cd="${esc(g)}">${esc(g)}</button>`).join('')}
       </div>`
    : '';
  // Controles de reproducción (solo con ≥2 pistas): navegación (primera/anterior/siguiente/última) y modos
  // (continuo, repetición ninguna/pista/lista, aleatorio). Su estado se cablea y persiste en iniciarReproductorAudio.
  const controles = lista.length >= 2
    ? `<div class="row" id="audioCtrl" style="gap:5px;flex-wrap:wrap;align-items:center;margin-bottom:8px">
         <button class="btn" id="apFirst" title="Primera pista" style="padding:6px 10px">⏮</button>
         <button class="btn" id="apPrev" title="Pista anterior" style="padding:6px 10px">⏪</button>
         <button class="btn" id="apNext" title="Pista siguiente" style="padding:6px 10px">⏩</button>
         <button class="btn" id="apLast" title="Última pista" style="padding:6px 10px">⏭</button>
         <span style="width:1px;height:22px;background:var(--line);margin:0 3px"></span>
         <button class="btn" id="apCont" style="padding:6px 10px;font-size:12px" title="Modo continuo: al terminar una pista pasa a la siguiente. Si lo desactivas, se detiene al final de cada pista.">▶️ Continuo</button>
         <button class="btn" id="apRep" style="padding:6px 10px;font-size:12px" title="Repetición: ninguna → repetir la pista → repetir toda la lista">🔁 Repetir</button>
         <button class="btn" id="apShuf" style="padding:6px 10px;font-size:12px" title="Reproducción en orden aleatorio">🔀 Aleatorio</button>
       </div>`
    : '';
  return `<div class="fileprev">
      <div class="row" style="align-items:center;justify-content:space-between;gap:8px;margin:16px 0 8px">
        <h3 style="margin:0;color:var(--mut);font-size:13px">🔊 Audio · ${lista.length} pista${lista.length > 1 ? 's' : ''}</h3>
        <div class="row" style="gap:6px;flex-wrap:wrap">${reord}${descargas}</div>
      </div>${selector}`
    + `<audio id="audioPlayer" controls preload="none" style="width:100%;margin-bottom:8px"></audio>`
    + controles
    + `<div id="audioLista" style="border-bottom:1px solid var(--line);border-radius:8px;overflow:hidden">${pistas}</div></div>`;
}

// Carga la 1ª pista, resalta la activa y gestiona la playlist: navegación (primera/anterior/siguiente/última)
// y modos CONTINUO (auto-avance), REPETICIÓN (ninguna/pista/lista) y ALEATORIO — persistidos en localStorage.
// El selector de disco filtra la lista visible; el botón «Reordenar» (admin) abre el reordenador.
function iniciarReproductorAudio(id, audios) {
  const player = $('#audioPlayer'), lista = $('#audioLista');
  if (!player || !lista) return;
  const tracks = [...lista.querySelectorAll('.audiotrack')];
  if (!tracks.length) return;
  // Filtro por disco (Todo / CD1 / CD2…): muestra/oculta pistas; NO altera el orden de reproducción.
  const filtros = [...document.querySelectorAll('#cdSel .filtCD')];
  filtros.forEach((b) => (b.onclick = () => {
    filtros.forEach((x) => x.classList.toggle('active', x === b));
    const cd = b.dataset.cd;
    tracks.forEach((t) => (t.style.display = (!cd || t.dataset.grupo === cd) ? 'flex' : 'none'));
  }));

  // ── Preferencias de reproducción (persisten entre fichas) ──
  let continuo = localStorage.getItem('audio_continuo') !== '0';   // por defecto ON: continúa la lista
  let repetir = localStorage.getItem('audio_repetir') || 'no';     // 'no' | 'una' | 'lista'
  let aleatorio = localStorage.getItem('audio_aleatorio') === '1'; // por defecto OFF
  if (!['no', 'una', 'lista'].includes(repetir)) repetir = 'no';

  // `orden` = secuencia de índices de `tracks` en el orden de reproducción (barajada si aleatorio);
  // `pos` = posición en `orden` de la pista que suena; `actual` = índice de esa pista en `tracks`.
  let orden = tracks.map((_, i) => i), pos = 0, actual = -1;
  const barajar = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // Reconstruye `orden`: en aleatorio deja `fijo` (la pista en curso) la 1.ª y baraja el resto; si no, orden natural.
  const reconstruirOrden = (fijo) => {
    if (aleatorio) {
      const resto = barajar(tracks.map((_, i) => i).filter((i) => i !== fijo));
      orden = fijo >= 0 ? [fijo, ...resto] : resto;
    } else orden = tracks.map((_, i) => i);
    pos = fijo >= 0 ? Math.max(0, orden.indexOf(fijo)) : 0;
  };

  const cargar = (i, reproducir) => {
    if (i < 0 || i >= tracks.length) return;
    actual = i; pos = orden.indexOf(i);
    player.src = tracks[i].dataset.src;
    tracks.forEach((t, j) => { t.style.background = j === i ? 'rgba(40,217,168,.14)' : 'none'; });
    if (reproducir) player.play().catch(() => {});
  };

  // Avanza (dir=+1) o retrocede (dir=−1) en `orden`. En un extremo, «repetir lista» cicla; si no, se queda.
  const mover = (dir) => {
    const np = pos + dir;
    if (np >= 0 && np < orden.length) { cargar(orden[np], true); return; }
    if (repetir === 'lista') {
      if (aleatorio) reconstruirOrden(-1);                 // nueva baraja en cada vuelta
      cargar(orden[dir > 0 ? 0 : orden.length - 1], true);
    }
  };

  tracks.forEach((t, i) => (t.onclick = () => cargar(i, true)));
  player.onended = () => {
    if (repetir === 'una') { player.currentTime = 0; player.play().catch(() => {}); return; }
    // «Continuo» (o «repetir lista», que implica seguir) auto-avanza; si no, se detiene al final de la pista.
    if (continuo || repetir === 'lista') mover(1);
  };

  // ── Controles (presentes solo con ≥2 pistas) ──
  const bFirst = $('#apFirst'), bPrev = $('#apPrev'), bNext = $('#apNext'), bLast = $('#apLast'),
        bCont = $('#apCont'), bRep = $('#apRep'), bShuf = $('#apShuf');
  const pintarCtrl = () => {
    if (bCont) bCont.classList.toggle('pri', continuo);
    if (bShuf) bShuf.classList.toggle('pri', aleatorio);
    if (bRep) {
      bRep.classList.toggle('pri', repetir !== 'no');
      bRep.textContent = repetir === 'una' ? '🔂 Repetir pista' : repetir === 'lista' ? '🔁 Repetir lista' : '🔁 Repetir';
    }
  };
  if (bFirst) bFirst.onclick = () => cargar(orden[0], true);
  if (bLast) bLast.onclick = () => cargar(orden[orden.length - 1], true);
  if (bPrev) bPrev.onclick = () => mover(-1);
  if (bNext) bNext.onclick = () => mover(1);
  if (bCont) bCont.onclick = () => { continuo = !continuo; localStorage.setItem('audio_continuo', continuo ? '1' : '0'); pintarCtrl(); };
  if (bRep) bRep.onclick = () => { repetir = repetir === 'no' ? 'una' : repetir === 'una' ? 'lista' : 'no'; localStorage.setItem('audio_repetir', repetir); pintarCtrl(); };
  if (bShuf) bShuf.onclick = () => {
    aleatorio = !aleatorio; localStorage.setItem('audio_aleatorio', aleatorio ? '1' : '0');
    reconstruirOrden(actual); // conserva la pista en curso y (re)baraja el resto
    pintarCtrl();
  };
  pintarCtrl();

  reconstruirOrden(0); // orden inicial (si aleatorio: pista 0 primero, resto barajado)
  cargar(0, false);    // deja la 1.ª cargada, sin reproducir
  const rb = $('#audioReord');
  if (rb) rb.onclick = () => reordenarPistas(id, audios);
}

// ════════ REORDENAR PISTAS (admin): ordenar por pista/título/duración asc/desc + mover a mano (↑↓/arrastrar) ════════
let _plR = null; // { id, items: [audio…] }
function reordenarPistas(id, audios) {
  _plR = { id, items: (audios || []).slice().sort((a, b) => (a.orden || 0) - (b.orden || 0)) };
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:600px;width:94vw;max-height:90vh;overflow:auto">
    <h3 style="margin-top:0">🎚️ Reordenar pistas</h3>
    <div class="row" style="gap:6px;flex-wrap:wrap;align-items:center;margin-bottom:10px">
      <span class="muted" style="font-size:12px">Ordenar por:</span>
      <button class="btn plsort" data-k="pista" style="padding:4px 10px;font-size:12px">Nº de pista</button>
      <button class="btn plsort" data-k="titulo" style="padding:4px 10px;font-size:12px">Título</button>
      <button class="btn plsort" data-k="duracion" style="padding:4px 10px;font-size:12px">Duración</button>
      <button class="btn" id="plDir" data-dir="asc" title="Ascendente / descendente" style="padding:4px 10px;font-size:12px">▲ Asc</button>
      <span class="muted" style="font-size:11px;margin-left:auto">o arrastra / usa ↑↓</span>
    </div>
    <div id="plList"></div>
    <div class="row" style="gap:8px;margin-top:12px;justify-content:flex-end">
      <button class="btn" id="plCancel">Cancelar</button>
      <button class="btn pri" id="plSave">Guardar orden</button>
    </div></div>`;
  $('#cmpModal').style.display = 'grid';
  pintarPlList();
  $('#plDir').onclick = () => {
    const d = $('#plDir').dataset.dir === 'asc' ? 'desc' : 'asc';
    $('#plDir').dataset.dir = d;
    $('#plDir').textContent = d === 'asc' ? '▲ Asc' : '▼ Desc';
  };
  $$('#cmpModal .plsort').forEach((b) => (b.onclick = () => ordenarPl(b.dataset.k, $('#plDir').dataset.dir)));
  $('#plCancel').onclick = cerrarCmp;
  $('#plSave').onclick = guardarPl;
}
function pintarPlList() {
  const box = $('#plList'); if (!box || !_plR) return;
  box.innerHTML = _plR.items.map((a, i) => {
    const sub = [a.grupo || '', a.duracion ? fmtDur(a.duracion) : ''].filter(Boolean).join(' · ');
    return `<div class="ordrow" draggable="true" data-ruta="${esc(a.ruta)}" style="display:flex;gap:10px;align-items:center;padding:7px 8px;border-top:1px solid var(--line)">`
      + `<span class="ordnum" style="opacity:.5;min-width:26px;text-align:right">${i + 1}</span>`
      + `<div style="flex:1;min-width:0"><div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(a.titulo || 'Pista ' + (i + 1))}</div>${sub ? `<div class="muted" style="font-size:11px">${esc(sub)}</div>` : ''}</div>`
      + `<span class="ordmove" style="display:flex;flex-direction:column;gap:2px"><button type="button" class="btn" data-up="${i}" title="Subir" style="padding:0 8px;line-height:1.5">↑</button><button type="button" class="btn" data-dn="${i}" title="Bajar" style="padding:0 8px;line-height:1.5">↓</button></span></div>`;
  }).join('');
  wirePlList();
}
function moverPl(from, to) {
  const it = _plR && _plR.items;
  if (!it || to < 0 || to >= it.length || from < 0 || from >= it.length) return;
  const [x] = it.splice(from, 1);
  it.splice(to, 0, x);
  pintarPlList();
}
function ordenarPl(k, dir) {
  const s = dir === 'desc' ? -1 : 1;
  _plR.items.sort((a, b) => {
    if (k === 'titulo') { const va = normalizar(a.titulo || ''), vb = normalizar(b.titulo || ''); return (va < vb ? -1 : va > vb ? 1 : 0) * s; }
    if (k === 'duracion') return ((a.duracion || 0) - (b.duracion || 0)) * s;
    return ((a.orden || 0) - (b.orden || 0)) * s; // «pista» = orden original
  });
  pintarPlList();
}
function wirePlList() {
  $$('#plList [data-up]').forEach((b) => (b.onclick = () => moverPl(+b.dataset.up, +b.dataset.up - 1)));
  $$('#plList [data-dn]').forEach((b) => (b.onclick = () => moverPl(+b.dataset.dn, +b.dataset.dn + 1)));
  let src = null;
  $$('#plList .ordrow').forEach((row) => {
    row.addEventListener('dragstart', (ev) => { src = row.dataset.ruta; row.classList.add('dragging'); try { ev.dataTransfer.effectAllowed = 'move'; ev.dataTransfer.setData('text/plain', src); } catch (_) {} });
    row.addEventListener('dragend', () => { row.classList.remove('dragging'); $$('#plList .ordrow.dragover').forEach((x) => x.classList.remove('dragover')); src = null; });
    row.addEventListener('dragover', (ev) => { if (src && src !== row.dataset.ruta) { ev.preventDefault(); row.classList.add('dragover'); } });
    row.addEventListener('dragleave', () => row.classList.remove('dragover'));
    row.addEventListener('drop', (ev) => {
      ev.preventDefault(); row.classList.remove('dragover');
      if (!src || src === row.dataset.ruta) return;
      moverPl(_plR.items.findIndex((x) => x.ruta === src), _plR.items.findIndex((x) => x.ruta === row.dataset.ruta));
    });
  });
}
async function guardarPl() {
  try {
    const orden = _plR.items.map((a) => a.ruta);
    const res = await api('/documentos/' + encodeURIComponent(_plR.id) + '/audios/orden', { method: 'POST', body: JSON.stringify({ orden }) });
    if (!res.ok) { toast(res.motivo || 'No se pudo guardar', 'bad'); return; }
    cerrarCmp();
    toast('Orden de pistas guardado');
    verDoc(_plR.id); // recargar la ficha con el nuevo orden
  } catch (e) { toast(e.message, 'bad'); }
}

// ════════ DOCUMENTO CRUDO (el registro EXACTO de Mongo, en JSON) ════════
// Se abre al pulsar el «ID (Mongo)» de los datos catalográficos. SOLO LECTURA (de momento): muestra el JSON tal
// cual lo guarda la base —sin resolver autores/editorial ni ocultar los campos de mantenimiento, a diferencia de
// la ficha— y permite copiarlo entero al portapapeles. El endpoint es solo de admin.
async function verDocumentoCrudo(id) {
  let r;
  try {
    r = await api('/documentos/' + encodeURIComponent(id) + '/crudo');
  } catch (e) {
    toast(e.message, 'bad');
    return;
  }
  if (!r || r.ok === false) {
    toast((r && r.motivo) || 'No se pudo leer el documento', 'bad');
    return;
  }
  const json = JSON.stringify(r.doc, null, 2);
  const bytes = new Blob([json]).size;
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:760px;width:96vw;max-height:92vh;overflow:auto">
    <div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
      <h3 style="margin:0">🗄️ Documento en la base</h3>
      <div class="row" style="gap:6px">
        <button class="btn" id="crudoCopiar" title="Copiar todo el JSON al portapapeles" style="padding:4px 10px;font-size:12px">📋 Copiar JSON</button>
        <button class="btn pri" id="crudoX" style="padding:4px 10px;font-size:12px">Cerrar</button>
      </div>
    </div>
    <div class="muted" style="font-size:11px;margin:6px 0 8px">Registro EXACTO de MongoDB · ${fmtBytes(bytes)} · solo lectura · los ObjectId son clicables (abren su ficha) y copiables (📋)</div>
    <pre id="crudoJson" class="mono" style="margin:0;padding:10px;border-radius:8px;background:var(--card2);border:1px solid var(--line);font-size:12px;line-height:1.45;overflow:auto;max-height:66vh;white-space:pre">${resaltarOids(json)}</pre>
  </div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#crudoX').onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
  $('#crudoCopiar').onclick = () => copiar(json);
  // Cada ObjectId: 📋 copia; si sabemos a qué colección apunta, el propio id ABRE su ficha.
  $$('#cmpModal .copybtn').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); copiar(b.dataset.copy); }));
  $$('#cmpModal .joid').forEach((a) => (a.onclick = () => abrirOid(a.dataset.jtipo, a.dataset.joid)));
}

// A qué colección apunta un ObjectId según la CLAVE que lo contiene (en `contribuciones[]` la clave es `persona`).
const OID_DESTINO = {
  autores: 'autor',
  persona: 'autor',
  editorial: 'editorial',
  coleccion: 'coleccion',
  obra: 'obra',
};
function abrirOid(tipo, id) {
  if (tipo === 'autor') return autorFicha(id); // reutiliza el mismo #cmpModal
  if (tipo === 'editorial') return editorialFicha(id);
  cerrarCmp(); // colección/obra navegan a su página: hay que cerrar el visor antes
  if (tipo === 'coleccion') return verColeccion(id);
  if (tipo === 'obra') return verObra(id);
}
// Convierte el JSON (ya escapado) en HTML resaltando cada ObjectId de 24 hex: siempre COPIABLE (📋) y, cuando la
// clave de su línea dice a qué colección apunta, también DRILLABLE. Se procesa línea a línea porque la clave da
// el destino; en un array (`"autores": [ ... ]`) la clave se recuerda de la línea de apertura.
function resaltarOids(json) {
  const RE_CLAVE = new RegExp('^\\s*&quot;([^&]+)&quot;\\s*:');
  const RE_OID = new RegExp('&quot;([a-f0-9]{24})&quot;', 'g');
  let claveActual = '';
  return esc(json)
    .split('\n')
    .map((linea) => {
      const mk = linea.match(RE_CLAVE);
      if (mk) claveActual = mk[1];
      const tipo = OID_DESTINO[claveActual] || '';
      return linea.replace(RE_OID, (_, hex) => {
        const copia = `<button class="rbtn copybtn" data-copy="${hex}" title="Copiar este ObjectId">📋</button>`;
        return tipo
          ? `&quot;<a class="rowlink joid" data-joid="${hex}" data-jtipo="${tipo}" title="Abrir la ficha de ${tipo}">${hex}</a>&quot;${copia}`
          : `&quot;<span class="mono">${hex}</span>&quot;${copia}`;
      });
    })
    .join('\n');
}

// ════════ EXPLORADOR DE ARCHIVOS (ver/descargar TODO el árbol del documento o su colección) ════════
let _expR = null; // { id, sub }
async function explorarArchivos(id, sub = '') {
  _expR = { id, sub };
  try {
    const r = await api(`/documentos/${encodeURIComponent(id)}/archivos?sub=${encodeURIComponent(sub)}`);
    if (!r.ok) { toast(r.motivo || 'No se pudo explorar', 'bad'); return; }
    pintarExplorador(r);
  } catch (e) { toast(e.message, 'bad'); }
}
function iconoArchivo(e) {
  if (e.dir) return '📁';
  const n = e.nombre;
  if (/\.(mp3|m4a|m4b|flac|wav|ogg|oga|aac|opus|wma)$/i.test(n)) return '🎵';
  if (/\.(mp4|avi|mkv|mov|webm|wmv|flv|m4v|mpe?g|ogv)$/i.test(n)) return '🎬';
  if (/\.pdf$/i.test(n)) return '📄';
  if (/\.(jpe?g|png|webp|gif|bmp|tiff?)$/i.test(n)) return '🖼️';
  if (/\.(epub|mobi|azw3?|djvu|cbz|cbr|cb7)$/i.test(n)) return '📚';
  return '📎';
}
function pintarExplorador(r) {
  const rowSt = 'display:flex;gap:10px;align-items:center;padding:8px 6px;border-top:1px solid var(--line)';
  const segs = r.sub ? r.sub.split('/') : [];
  const migas = [`<a onclick="explorarArchivos('${esc(_expR.id)}','')" style="cursor:pointer">🗂️ ${esc(r.raiz)}</a>`]
    .concat(segs.map((s, i) => `<a onclick="explorarArchivos('${esc(_expR.id)}','${esc(segs.slice(0, i + 1).join('/'))}')" style="cursor:pointer">${esc(s)}</a>`))
    .join(' <span class="muted">/</span> ');
  const filas = r.entradas.length
    ? r.entradas.map((e) => {
        const sub2 = (r.sub ? r.sub + '/' : '') + e.nombre;
        return e.dir
          ? `<div style="${rowSt};cursor:pointer" onclick="explorarArchivos('${esc(_expR.id)}','${esc(sub2)}')">${iconoArchivo(e)} <span style="flex:1">${esc(e.nombre)}</span> <span class="muted">›</span></div>`
          : `<div style="${rowSt}"><span>${iconoArchivo(e)}</span> <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.nombre)}</span> <span class="muted" style="font-size:11px">${fmtBytes(e.bytes)}</span> <a class="btn" href="${esc(encUrl(e.web))}" download title="Descargar" style="padding:2px 9px;font-size:12px">⬇</a></div>`;
      }).join('')
    : '<div class="muted" style="padding:12px">(carpeta vacía)</div>';
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:640px;width:94vw;max-height:90vh;overflow:auto">
    <div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">🗂️ Archivos</h3><button class="btn" id="expX">✕</button></div>
    <div class="row" style="margin:8px 0;font-size:13px;flex-wrap:wrap;gap:4px">${migas}</div>
    <div>${filas}</div></div>`;
  $('#cmpModal').style.display = 'grid';
  $('#expX').onclick = cerrarCmp;
}

// COMPLETAR un documento con los ficheros que le faltan: el PDF/EPUB de un audiolibro que solo tiene audio, o
// los audios de un libro que solo tiene texto. Sube a POST /api/documentos/:id/completar → el audio entra en la
// playlist (`audios[]`), el texto en el selector del visor (`textos[]`) y el resto queda como material en su
// carpeta. Solo AÑADE: nunca pisa ni borra lo que ya había.
async function adjuntarADoc(id, r) {
  const esAudiolibro = (r.naturaleza || (r.doc && r.doc.naturaleza)) === 'audiolibro';
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:560px;width:94vw;max-height:90vh;overflow:auto">
    <div class="row" style="justify-content:space-between;align-items:center"><h3 style="margin:0">📎 Adjuntar audio/texto</h3><button class="btn" id="adjX">✕</button></div>
    <p class="muted" style="font-size:13px;margin:8px 0">
      Completa este documento con lo que le falte: el <b>PDF/EPUB</b> de un audiolibro, o los <b>audios</b> de un libro.
      El audio se añade a la playlist y el texto al selector del visor. Solo se AÑADE: nada se pisa ni se borra.
    </p>
    <label class="btn" style="display:inline-block">📂 Elegir ficheros<input type="file" id="adjFiles" multiple hidden></label>
    <div id="adjLista" class="muted" style="font-size:13px;margin:8px 0">(ninguno elegido)</div>
    <div style="margin:10px 0">
      <label style="font-size:13px">Si añades audio, ¿en qué se convierte el documento?</label>
      <select id="adjNat" style="width:100%;margin-top:4px">
        <option value="">Dejarlo como está</option>
        <option value="libro"${!esAudiolibro ? ' selected' : ''}>📕 Libro con audio (el texto manda)</option>
        <option value="audiolibro"${esAudiolibro ? ' selected' : ''}>📀 Audiolibro (el audio manda)</option>
      </select>
    </div>
    <div class="row" style="justify-content:flex-end;gap:8px;margin-top:12px">
      <button class="btn" id="adjCancel">Cancelar</button>
      <button class="btn ok" id="adjOk" disabled>Adjuntar</button>
    </div>
    <div id="adjMsg" class="muted" style="font-size:13px;margin-top:8px"></div></div>`;
  $('#cmpModal').style.display = 'grid';
  $('#adjX').onclick = cerrarCmp;
  $('#adjCancel').onclick = cerrarCmp;

  let elegidos = [];
  $('#adjFiles').onchange = (e) => {
    elegidos = [...(e.target.files || [])];
    $('#adjLista').textContent = elegidos.length ? elegidos.map((f) => f.name).join(' · ') : '(ninguno elegido)';
    $('#adjOk').disabled = !elegidos.length;
  };
  $('#adjOk').onclick = async () => {
    $('#adjOk').disabled = true;
    $('#adjMsg').textContent = 'Subiendo…';
    const fd = new FormData();
    for (const f of elegidos) fd.append('files', f);
    const nat = $('#adjNat').value;
    if (nat) fd.append('naturaleza', nat);
    try {
      const res = await fetch(`/api/documentos/${encodeURIComponent(id)}/completar`, {
        method: 'POST',
        headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},   // FormData: NO fijar Content-Type (lo pone el navegador con su boundary)
        body: fd,
      });
      const j = await res.json();
      if (!j.ok) { $('#adjMsg').textContent = '✗ ' + (j.motivo || 'no se pudo adjuntar'); $('#adjOk').disabled = false; return; }
      $('#adjMsg').textContent = `✔ adjuntado: ${j.anadidos.audio} audio · ${j.anadidos.texto} texto · ${j.anadidos.material} material`;
      setTimeout(() => { cerrarCmp(); verDoc(id); }, 900);   // recargar la ficha con la playlist/selector nuevos
    } catch (err) {
      $('#adjMsg').textContent = '✗ ' + err.message;
      $('#adjOk').disabled = false;
    }
  };
}

// SELECTOR de TEXTOS: un documento puede llevar VARIOS (el PDF + el EPUB + un anexo) — `textos[]` es simétrico
// a la playlist de `audios[]`. Se ofrece cuando hay 2+; el elegido pasa a abrirse en el visor. Los formatos con
// lector servido por el servidor (cómic/mobi/chm) solo saben abrir el fichero PRINCIPAL del doc, así que para
// esos el cambio se nota en la descarga, no en el visor embebido.
function selectorTextosHtml(r) {
  const textos = (r.textos || []).filter((t) => t && t.ruta);
  if (textos.length < 2) return '';
  const actual = r.archivo_url || '';
  return `<div class="row" style="gap:8px;align-items:center;margin:0 0 8px">
      <span class="muted" style="font-size:12px">📄 Texto:</span>
      <select id="txtSel" style="flex:1" title="Este documento tiene varios textos: elige cuál abrir">${textos
        .map((t, i) => `<option value="${i}"${t.ruta === actual ? ' selected' : ''}>${esc(t.titulo || t.ruta.split('/').pop())}${t.formato ? ' · ' + esc(t.formato) : ''}</option>`)
        .join('')}</select>
    </div>`;
}

function previewArchivo(r) {
  return selectorTextosHtml(r) + previewArchivoBase(r);
}

function previewArchivoBase(r) {
  const id = r.doc && r.doc._id;
  const audio = reproductorAudioHtml(r.audios, id); // audiolibro (con o sin PDF): reproductor + descargas arriba
  // SOFTWARE (paquete verbatim en bloque): no hay un fichero único → EXPLORADOR de ficheros de SOLO LECTURA.
  const esSoftware = r.tipo_recurso === 'software' || (r.doc && r.doc.tipo_recurso === 'software') || r.naturaleza === 'software';
  if (esSoftware && id) {
    const zip = `<a class="btn" href="/api/descargar/${esc(id)}?que=todo" download title="Descargar todo el paquete en un ZIP">⬇ Paquete (ZIP)</a>`;
    return (
      audio +
      `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">💿 Paquete de software</h3>
      <div class="muted" style="font-size:12px;margin-bottom:8px">Explorador de SOLO LECTURA · los ficheros se conservan y se mueven en bloque.</div>
      <div id="swArbol" style="max-height:62vh;overflow:auto;border:1px solid rgba(128,128,128,.3);border-radius:10px;padding:8px;font-size:13px">Cargando…</div>
      <div class="row" style="margin-top:12px">${zip}</div></div>`
    );
  }
  if (!r.archivo_url) return audio;                 // audio-only: solo el reproductor
  const nombre = r.nombre_archivo || 'archivo',
    url = encUrl(r.archivo_url),
    ext = (nombre.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return audio; // set de imágenes: ya se ve en el carrusel
  // Solo "Descargar": PDF y EPUB se LEEN EMBEBIDOS aquí (visores propios). Ya no se ofrece "Abrir en
  // pestaña" (en PC, según la config del navegador, descargaba el PDF en vez de previsualizarlo).
  // «Carpeta (ZIP)» descarga TODA la carpeta ruta_base (el fichero + portadas + extras) en streaming.
  const zip = id ? `<a class="btn" href="/api/descargar/${esc(id)}?que=todo" download title="Descargar toda la carpeta en un ZIP">⬇ Carpeta (ZIP)</a>` : '';
  const acc = `<div class="row" style="margin-top:12px;gap:8px"><a class="btn pri" href="${esc(url)}" download="${esc(nombre)}">⬇ Descargar</a>${zip}</div>`;
  // VÍDEO: reproductor nativo <video> para los formatos que el navegador SÍ decodifica (mp4/webm/ogv/m4v/
  // mov-H.264). Para .avi/.mkv/.wmv/.flv/.mpg (sin códec en el navegador) → aviso + descarga (o el ZIP).
  const VIDEO_NATIVO = ['mp4', 'webm', 'ogv', 'm4v', 'mov'];
  const VIDEO_OTROS = ['avi', 'mkv', 'wmv', 'flv', 'mpg', 'mpeg', 'm2ts', 'ts', 'vob', 'divx', '3gp'];
  if (VIDEO_NATIVO.includes(ext))
    return audio + `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">🎬 ${esc(nombre)}</h3>
      <video controls preload="metadata" playsinline style="width:100%;max-height:72vh;background:#000;border-radius:10px"><source src="${esc(url)}">Tu navegador no puede reproducir este vídeo.</video>${acc}</div>`;
  if (VIDEO_OTROS.includes(ext))
    return audio + `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">🎬 ${esc(nombre)}</h3>
      <div style="aspect-ratio:16/9;display:flex;align-items:center;justify-content:center;background:#000;border-radius:10px;color:var(--mut);text-align:center;padding:16px"><div>🎬<br><span style="font-size:12px">El navegador no reproduce «.${esc(ext)}» de forma nativa.<br>Descárgalo para verlo en tu reproductor (VLC, etc.).</span></div></div>${acc}</div>`;
  // PDF: visor PDF.js embebido (vendored) — render propio en canvas → previsualiza IGUAL en PC y móvil,
  // sin depender de la config de PDF del navegador. Se inicializa tras pintar (iniciarLectorPdf).
  if (ext === 'pdf')
    return audio + `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">📄 ${esc(nombre)}</h3>
    <div class="pdfwrap" id="pdfWrap"><div class="pdfscroll" id="pdfScroll"></div>
      <button class="epubfs" id="pdfFs" title="Pantalla completa" style="display:none">⛶</button>
      <div class="epubbar" id="pdfBar" style="display:none"><span class="epubpct" style="text-align:left;min-width:0"><span id="pdfCur">1</span> / <span id="pdfTotal">?</span></span></div>
      <div class="epubmsg" id="pdfMsg">Cargando PDF…</div></div>${acc}</div>`;
  // EPUB: lector epub.js (vendored en /vendor) — se inicializa tras pintar (iniciarLectorEpub).
  if (ext === 'epub')
    return audio + `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">📗 ${esc(nombre)}</h3>
    <div class="epubwrap" id="epubWrap"><div id="epubArea"></div>
      <button class="cnav prev" id="epubPrev" style="display:none">‹</button><button class="cnav next" id="epubNext" style="display:none">›</button>
      <button class="epubfs" id="epubFs" title="Pantalla completa" style="display:none">⛶</button>
      <nav class="epubtoc" id="epubToc"></nav>
      <div class="epubbar" id="epubBar" style="display:none">
        <button id="epubTocBtn" title="Índice">☰</button>
        <button id="epubFontDown" title="Reducir letra" style="font-size:13px">A−</button>
        <button id="epubFontUp" title="Aumentar letra" style="font-size:17px">A+</button>
        <div class="epubprog" id="epubProg" title="Ir a una posición"><i></i></div>
        <span class="epubpct" id="epubPct">—</span>
      </div>
      <div class="epubmsg" id="epubMsg">Cargando lector…</div></div>${acc}</div>`;
  // PAGINADO (cómic .cbz/.cbr/.cb7 y .djvu): visor de páginas servidas BAJO DEMANDA por el backend
  // (cómic→del comprimido; DjVu→rasterizando esa página). Se inicializa tras pintar (iniciarLectorComic).
  if (['cbz', 'cbr', 'cb7', 'djvu'].includes(ext))
    return audio + `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">${ext === 'djvu' ? '📘' : '🗂️'} ${esc(nombre)}</h3>
    <div class="pdfwrap" id="comicWrap"><img id="comicImg" class="comicpg" alt="">
      <button class="cnav prev" id="comicPrev" style="display:none">‹</button><button class="cnav next" id="comicNext" style="display:none">›</button>
      <button class="epubfs" id="comicFs" title="Pantalla completa" style="display:none">⛶</button>
      <div class="epubbar" id="comicBar" style="display:none"><span class="epubpct" style="text-align:left;min-width:0"><span id="comicCur">1</span> / <span id="comicTotal">?</span></span></div>
      <div class="epubmsg" id="comicMsg">${ext === 'djvu' ? 'Cargando documento…' : 'Cargando cómic…'}</div></div>${acc}</div>`;
  // MOBI/AZW3: previsualización PROPIA (no hay lector nativo en el navegador). El backend extrae el TEXTO
  // best-effort conservando la estructura y detecta DRM/compresión no soportada. Se inicializa tras pintar
  // (iniciarLectorMobi) renderizándolo en un iframe SANDBOX (sin scripts). La portada/imágenes embebidas ya
  // viajan al carrusel de la ficha.
  if (['mobi', 'azw', 'azw3'].includes(ext))
    return audio + `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">📙 ${esc(nombre)}</h3>
    <div class="epubwrap" id="mobiWrap"><div class="epubmsg" id="mobiMsg">Cargando previsualización…</div></div>${acc}</div>`;
  // CHM (HTML compilado): visor propio. El backend extrae el CHM (cacheado) y sirve cada tema como HTML
  // AUTOCONTENIDO (imágenes/CSS incrustados) → iframe SANDBOX (sin scripts) + índice lateral (del .hhc) para
  // navegar. Se inicializa tras pintar (iniciarLectorChm).
  if (ext === 'chm')
    return audio + `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">📗 ${esc(nombre)}</h3>
    <div id="chmWrap" style="display:flex;gap:8px;height:62vh;border:1px solid rgba(128,128,128,.3);border-radius:10px;overflow:hidden;background:#fff">
      <nav id="chmToc" style="flex:0 0 38%;max-width:250px;overflow:auto;border-right:1px solid rgba(0,0,0,.12);padding:6px 2px;font-size:13px;background:#fafafa"></nav>
      <div id="chmBody" style="flex:1;min-width:0;position:relative"><div class="epubmsg" id="chmMsg" style="color:#555">Cargando previsualización…</div></div>
    </div>${acc}</div>`;
  // WORD (.docx/.doc): el servidor lo convierte a HTML (.docx = ZIP OOXML, sin dependencias; .doc necesita
  // antiword/catdoc) y se pinta en un iframe sandbox, igual que el CHM.
  if (ext === 'docx' || ext === 'doc')
    return audio + `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">📝 ${esc(nombre)}</h3>
    <div id="wordWrap" style="height:62vh;border:1px solid rgba(128,128,128,.3);border-radius:10px;overflow:hidden;background:#fff;position:relative">
      <div class="epubmsg" id="wordMsg" style="color:#555">Cargando previsualización…</div>
    </div>${acc}</div>`;
  // Resto de formatos: sin vista previa integrada — solo descarga.
  const ic = { djvu: '📘', mobi: '📙', azw3: '📙' }[ext] || '📦';
  return audio + `<div class="fileprev"><div class="filebox"><div class="ic">${ic}</div><div style="font-weight:600;word-break:break-word">${esc(nombre)}</div>
    <div class="muted" style="font-size:12px;margin-top:4px">Formato ${esc((ext || '—').toUpperCase())} — el navegador no lo previsualiza de forma integrada.</div>${acc}</div></div>`;
}

// Carga perezosa de epub.js (+ JSZip) vendored en /vendor. JSZip primero (epub.js lo requiere global).
let epubLibPromise = null;
function cargarEpubLib() {
  if (window.ePub) return Promise.resolve();
  if (epubLibPromise) return epubLibPromise;
  const cargar = (src) =>
    new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = res;
      s.onerror = () => rej(new Error('no se pudo cargar ' + src));
      document.head.appendChild(s);
    });
  epubLibPromise = cargar('/vendor/jszip.min.js').then(() => cargar('/vendor/epub.min.js'));
  return epubLibPromise;
}
let epubRendition = null,
  epubResize = null;
async function iniciarLectorEpub(url) {
  const wrap = $('#epubWrap'),
    area = $('#epubArea'),
    msg = $('#epubMsg');
  if (!area) return;
  try {
    await cargarEpubLib();
    if (!$('#epubArea')) return; // el usuario navegó fuera mientras cargaba la librería
    const book = ePub(url);
    // Dimensiones EN PÍXELES (no '100%'): así el marco queda FIJO y epub.js no lo redimensiona
    // según el contenido de cada sección (lo que hacía que "saltara" de página a página).
    const dims = () => ({ w: area.clientWidth || 320, h: area.clientHeight || 420 });
    let d0 = dims();
    epubRendition = book.renderTo(area, { width: d0.w, height: d0.h, spread: 'none', flow: 'paginated' });
    // Constreñir el contenido al marco: sin márgenes del body e imágenes contenidas (no desbordan).
    epubRendition.themes.default({
      html: { height: '100% !important' },
      body: { margin: '0 !important', padding: '0 !important' },
      'img,image,svg': {
        'max-width': '100% !important',
        'max-height': '100% !important',
        'object-fit': 'contain',
      },
    });
    // Clavar la altura del iframe al marco (epub.js a veces la reajusta al contenido); tras dos rAF.
    const fijar = () => {
      const h = area.clientHeight;
      if (!h) return;
      const ifr = area.querySelector('iframe');
      if (ifr) ifr.style.height = h + 'px';
    };
    const pin = () => requestAnimationFrame(() => requestAnimationFrame(fijar));
    epubRendition.on('rendered', pin);
    await epubRendition.display();
    pin();
    if (msg) msg.style.display = 'none';
    const prev = $('#epubPrev'),
      next = $('#epubNext'),
      fs = $('#epubFs'),
      bar = $('#epubBar');
    [prev, next, fs].forEach((b) => (b.style.display = 'grid'));
    bar.style.display = 'flex';
    prev.onclick = () => epubRendition.prev();
    next.onclick = () => epubRendition.next();

    // Índice (tabla de contenidos).
    book.loaded.navigation
      .then((nav) => {
        const toc = $('#epubToc');
        if (!toc) return;
        const items = [];
        const rec = (arr, sub) =>
          arr.forEach((it) => {
            items.push(
              `<a href="#" data-href="${esc(it.href)}"${sub ? ' class="sub"' : ''}>${esc((it.label || '').trim() || '—')}</a>`,
            );
            if (it.subitems && it.subitems.length) rec(it.subitems, true);
          });
        rec(nav.toc || [], false);
        toc.innerHTML = items.join('') || '<div class="muted" style="padding:14px">Sin índice</div>';
        $$('#epubToc a[data-href]').forEach(
          (a) =>
            (a.onclick = (e) => {
              e.preventDefault();
              epubRendition.display(a.dataset.href);
              toc.classList.remove('open');
            }),
        );
      })
      .catch(() => {});
    $('#epubTocBtn').onclick = () => $('#epubToc').classList.toggle('open');

    // Tamaño de letra (A− / A+). epub.js reflowa al cambiarlo → 'relocated' re-clava la altura.
    let epubFont = 100;
    const aplicarFuente = () => {
      try {
        epubRendition.themes.fontSize(epubFont + '%');
      } catch {}
    };
    $('#epubFontDown').onclick = () => {
      epubFont = Math.max(60, epubFont - 10);
      aplicarFuente();
    };
    $('#epubFontUp').onclick = () => {
      epubFont = Math.min(250, epubFont + 10);
      aplicarFuente();
    };

    // Progreso (%). Las localizaciones se generan en segundo plano; hasta entonces, página/total.
    let locsReady = false;
    const progreso = (loc) => {
      if (!loc) {
        try {
          loc = epubRendition.currentLocation();
        } catch {
          return;
        }
      }
      if (!loc || !loc.start) return;
      const bi = $('#epubProg>i'),
        pc = $('#epubPct');
      let pct = null, idx = null, total = 0;
      if (locsReady) {
        try {
          pct = book.locations.percentageFromCfi(loc.start.cfi);
          idx = book.locations.locationFromCfi(loc.start.cfi); // "página" global (0-based) de las locations
          total = book.locations.total || 0;
        } catch {}
      }
      if (pct != null) {
        if (bi) bi.style.width = Math.round(pct * 100) + '%';
        // Nº de página GLOBAL (de las locations de epub.js) + %. Antes de generarse, cae a página/total del capítulo.
        if (pc) pc.textContent = (total ? `pág. ${idx + 1}/${total} · ` : '') + Math.round(pct * 100) + '%';
      } else if (pc && loc.start.displayed)
        pc.textContent = `pág. ${loc.start.displayed.page}/${loc.start.displayed.total}`;
    };
    epubRendition.on('relocated', (loc) => {
      pin();
      progreso(loc);
    });
    book.ready
      .then(() => book.locations.generate(1600))
      .then(() => {
        locsReady = true;
        progreso();
      })
      .catch(() => {});
    $('#epubProg').onclick = (e) => {
      if (!locsReady) return;
      const rc = e.currentTarget.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (e.clientX - rc.left) / rc.width));
      try {
        epubRendition.display(book.locations.cfiFromPercentage(p));
      } catch {}
    };

    // Re-encajar tras resize / pantalla completa: re-medir, redimensionar Y re-mostrar la posición
    // actual (un display(cfi) fuerza un re-layout LIMPIO al nuevo tamaño — clave para que no quede
    // "errático" al restaurar). Todo tras dos rAF, cuando el navegador ya recompuso el marco.
    const refit = () =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          if (!epubRendition) return;
          const dd = dims();
          let cfi = null;
          try {
            const l = epubRendition.currentLocation();
            cfi = l && l.start && l.start.cfi;
          } catch {}
          try {
            epubRendition.resize(dd.w, dd.h);
          } catch {}
          if (cfi) {
            try {
              epubRendition.display(cfi);
            } catch {}
          }
          pin();
        }),
      );
    // Pantalla completa: overlay por CSS (NO la Fullscreen API — iOS Safari no la soporta en <div>).
    fs.onclick = () => {
      const f = wrap.classList.toggle('full');
      fs.textContent = f ? '✕' : '⛶';
      fs.title = f ? 'Salir de pantalla completa' : 'Pantalla completa';
      refit();
    };
    if (epubResize) window.removeEventListener('resize', epubResize);
    epubResize = () => {
      clearTimeout(epubResize._t);
      epubResize._t = setTimeout(refit, 150);
    };
    window.addEventListener('resize', epubResize);
    document.onkeydown = (e) => {
      if (!$('#epubArea')) return;
      if (e.key === 'ArrowLeft') epubRendition.prev();
      else if (e.key === 'ArrowRight') epubRendition.next();
      else if (e.key === 'Escape' && wrap.classList.contains('full')) {
        wrap.classList.remove('full');
        fs.textContent = '⛶';
        fs.title = 'Pantalla completa';
        refit();
      }
    };
  } catch (e) {
    if (msg)
      msg.innerHTML = `No se pudo abrir el EPUB en el navegador (${esc(e.message)}).<br>Usa las opciones de descarga de abajo.`;
  }
}

// ── lector PDF (PDF.js vendored) — render propio en canvas: previsualiza IGUAL en PC y móvil ──
let pdfLibPromise = null,
  pdfDoc = null,
  pdfObs = null;
function cargarPdfLib() {
  if (window.pdfjsLib) return Promise.resolve();
  if (pdfLibPromise) return pdfLibPromise;
  pdfLibPromise = new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = '/vendor/pdf.min.js';
    s.onload = res;
    s.onerror = () => rej(new Error('no se pudo cargar pdf.js'));
    document.head.appendChild(s);
  });
  return pdfLibPromise;
}
async function iniciarLectorPdf(url) {
  const wrap = $('#pdfWrap'),
    scroll = $('#pdfScroll'),
    msg = $('#pdfMsg');
  if (!scroll) return;
  try {
    await cargarPdfLib();
    if (!$('#pdfScroll')) return; // el usuario navegó fuera mientras cargaba la librería
    const lib = window.pdfjsLib;
    lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
    pdfDoc = await lib.getDocument(url).promise;
    if (!$('#pdfScroll')) return;
    if (msg) msg.style.display = 'none';
    $('#pdfBar').style.display = 'flex';
    $('#pdfFs').style.display = 'grid';
    $('#pdfTotal').textContent = pdfDoc.numPages;
    scroll.innerHTML = '';
    if (pdfObs) pdfObs.disconnect();
    // Render perezoso: cada página se dibuja al acercarse y se libera al alejarse (acota memoria).
    pdfObs = new IntersectionObserver(
      (ents) =>
        ents.forEach((en) => {
          en.isIntersecting ? renderPdfPage(en.target) : liberarPdfPage(en.target);
        }),
      { root: scroll, rootMargin: '300px' },
    );
    for (let n = 1; n <= pdfDoc.numPages; n++) {
      const ph = document.createElement('div');
      ph.className = 'pdfpage';
      ph.dataset.n = n;
      ph.style.aspectRatio = '1/1.414';
      scroll.appendChild(ph);
      pdfObs.observe(ph);
    }
    // Indicador de página: la más alta cuyo borde superior ya pasó el del visor.
    scroll.onscroll = () => {
      const y = scroll.scrollTop + 80;
      let cur = 1;
      for (const p of scroll.children) {
        if (p.offsetTop <= y) cur = Number(p.dataset.n);
        else break;
      }
      const e = $('#pdfCur');
      if (e) e.textContent = cur;
    };
    // Pantalla completa: overlay por CSS (igual que el epub).
    const fs = $('#pdfFs');
    fs.onclick = () => {
      const f = wrap.classList.toggle('full');
      fs.textContent = f ? '✕' : '⛶';
      fs.title = f ? 'Salir de pantalla completa' : 'Pantalla completa';
    };
    document.onkeydown = (e) => {
      if (!$('#pdfScroll')) return;
      if (e.key === 'Escape' && wrap.classList.contains('full')) {
        wrap.classList.remove('full');
        fs.textContent = '⛶';
        fs.title = 'Pantalla completa';
      }
    };
  } catch (e) {
    if (msg) msg.innerHTML = `No se pudo abrir el PDF en el navegador (${esc(e.message)}).<br>Usa Descargar.`;
  }
}
async function renderPdfPage(el) {
  if (!pdfDoc || el.dataset.done) return;
  el.dataset.done = '1';
  try {
    const page = await pdfDoc.getPage(Number(el.dataset.n));
    if (!el.isConnected || el.dataset.done !== '1') return;
    const vp1 = page.getViewport({ scale: 1 });
    const objetivo = 1300; // ancho de render (px): nítido hasta pantalla completa; se muestra a 100%
    const vp = page.getViewport({ scale: objetivo / vp1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    el.style.aspectRatio = '';
    el.innerHTML = '';
    el.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
  } catch (e) {
    if (el)
      el.innerHTML = `<div class="muted" style="padding:10px;font-size:12px">Página ${esc(el.dataset.n)}: ${esc(e.message)}</div>`;
  }
}
function liberarPdfPage(el) {
  if (!el.dataset.done) return;
  el.dataset.done = '';
  el.innerHTML = '';
  el.style.aspectRatio = '1/1.414';
}

// ── búsqueda + catálogo ──
let estadoBusqueda = { page: 1 },
  busqTimer = null;
// ── selección múltiple + agrupado (añadir a colección / obra) ──
// Patrón de selección ERGONÓMICO y móvil (mismo que la ficha de autor): en «Modo selección» tocar una
// portada la marca (tick ✓ + recuadro) en vez de abrir su ficha; fuera de modo, tocar abre la ficha.
// La selección PERSISTE al apagar el modo (para inspeccionar un libro y volver a seleccionar).
let selDocs = new Set(),
  paginaIds = [];
let modoSeleccion = false; // Catálogo: ¿tocar una tarjeta selecciona (true) o abre su ficha (false)?
// Vista del Catálogo: 'iconos' (rejilla con portadas, 24/pág) | 'detalles' (filas de texto, 100/pág).
let vistaCatalogo = (() => {
  try {
    return localStorage.getItem('cat_vista') === 'detalles' ? 'detalles' : 'iconos';
  } catch {
    return 'iconos';
  }
})();
// «Mostrar selección»: cuando está activo, el Catálogo muestra SOLO los documentos seleccionados (para
// revisar la selección y quitar los no deseados). Bimodal (activo/inactivo).
let soloSeleccion = false;
function toggleSel(id, on) {
  if (on === undefined) on = !selDocs.has(id); // sin argumento: alterna
  if (on) selDocs.add(id);
  else selDocs.delete(id);
  const c = $('#searchResults [data-doc="' + id + '"]');
  if (c) c.classList.toggle('sel', on);
  renderBulk();
}
// Refleja el modo selección en la rejilla (cursor/realce) — CSS .selmode — y en el indicador de modo.
function aplicarModoSelUI() {
  const r = $('#searchResults');
  if (r) r.classList.toggle('selmode', modoSeleccion && ROL === 'admin');
  setModoVisual(modoSeleccion && ROL === 'admin');
}
// Conmuta el modo selección del Catálogo (sin perder la selección). Lo llaman el botón «Modo selección»
// y el gesto doble-clic/pulsación-larga sobre una tarjeta.
function alternarModoSel() {
  if (ROL !== 'admin') return;
  modoSeleccion = !modoSeleccion;
  aplicarModoSelUI();
  renderBulk();
}
// Envía una lista de libros al Catálogo YA SELECCIONADOS (en modo selección), filtrando por esos ids.
// Reutilizable desde cualquier origen (ficha de autor, colección, editorial, obra…).
function mostrarEnCatalogo(ids, etiqueta, orden) {
  selDocs = new Set(ids);
  modoSeleccion = ROL === 'admin';
  estadoBusqueda.extra = { ids: ids.join(','), etiqueta };
  estadoBusqueda.page = 1;
  go('search');
  if (!$('#sqQ')) construirSearch();
  if ($('#sqQ')) $('#sqQ').value = '';
  if ($('#sqCdu')) $('#sqCdu').value = '';
  // Orden pedido (p. ej. por Nº de colección/obra al venir de la ficha de una serie): lo reflejamos en el
  // selector (numérico y ascendente), como hace verEstanteriaEnCatalogo con «posición».
  if (orden && $('#sqOrden')) {
    $('#sqOrden').value = orden;
    const b = $('#sqDir'); if (b) { b.dataset.dir = 'asc'; b.textContent = '↑ Asc'; }
    const w = $('#sqDirWrap'); if (w) w.style.display = '';
  }
  buscarCatalogo(1);
}
// ¿El panel colapsable de acciones de la selección arranca desplegado? Se recuerda la última preferencia; sin
// preferencia previa, desplegado en pantalla ancha y plegado en móvil (mismo criterio que «Buscar y filtrar»).
function accPanelAbierto() {
  const sav = localStorage.getItem('sq_acciones');
  return sav === null ? matchMedia('(min-width:860px)').matches : sav === '1';
}
function renderBulk() {
  const el = $('#searchBulk');
  if (!el) return;
  if (!paginaIds.length || ROL !== 'admin') {
    el.innerHTML = '';
    return;
  }
  const enPag = paginaIds.filter((id) => selDocs.has(id)).length;
  const todaLaPag = enPag > 0 && enPag === paginaIds.length;
  // Botón que alterna Modo selección (tocar la portada la marca) ↔ Modo previsualización (tocar abre la
  // ficha). El texto refleja el modo ACTUAL; la selección se conserva al cambiar de modo.
  const modoBtn = `<button class="btn${modoSeleccion ? ' pri' : ''}" id="bkModo" title="Modo selección: tocar una portada la marca. Modo previsualización: tocar abre su ficha. Doble clic / pulsación larga en una portada también conmuta. La selección se conserva.">${modoSeleccion ? '🖱 Modo selección' : '👁 Modo previsualización'}</button>`;
  // MODO respecto a las obras multivolumen, junto a los otros modos de la barra (aquí se ve y se usa; como
  // casilla diminuta entre los filtros pasaba desapercibida). Colapsado = una tarjeta por obra; expandido =
  // un tomo por tarjeta (teñidos y seleccionables, para elegir tomos sueltos y moverlos en lote).
  const expandido = modoTomosExpandido();
  const tomosBtn = `<button class="btn${expandido ? ' pri' : ''}" id="bkTomos" title="${expandido
    ? 'Viendo los TOMOS uno a uno (seleccionables). Pulsa para colapsar cada obra en una sola tarjeta.'
    : 'Las obras multivolumen se ven COLAPSADAS (una tarjeta por obra). Pulsa para desplegar sus tomos y poder seleccionarlos.'}">${expandido ? '📖 Tomos sueltos' : '📚 Obras colapsadas'}</button>`;
  // Herramientas de selección masiva (solo tienen sentido en modo selección).
  const selNfc =
    'NDEFReader' in window
      ? `<button class="btn" id="bkSelNfc" title="Acumula en la selección los libros que vayas tocando con etiquetas NFC">📶 Por NFC</button>`
      : '';
  const herramientas = modoSeleccion
    ? `<button class="btn" id="bkAllPag">${todaLaPag ? 'Quitar' : 'Todos'} (página)</button>
       <button class="btn" id="bkAllRes" title="Selecciona TODOS los resultados de esta búsqueda (todas las páginas)">🗂 Todos los resultados</button>
       ${selNfc}`
    : '';
  // Acciones sobre la selección (aparecen cuando hay algo seleccionado). Los botones se PLIEGAN en un panel
  // colapsable (como «🔎 Buscar y filtrar») para no saturar la barra: la CUENTA queda siempre visible.
  const accBtns = selDocs.size
    ? `<button class="btn pri" id="bkCol">📚 Colección</button>
    <button class="btn pri" id="bkObra">📖 Obra</button>
    <button class="btn pri" id="bkUbic">📍 Estantería</button>
    <button class="btn" id="bkQuitUbic" title="Quitar de su estantería/ámbito (pasan a «Sin asignar»)">🚫 Quitar de estantería</button>
    ${'NDEFReader' in window ? '<button class="btn pri" id="bkNfc">📶 Etiquetar</button>' : ''}
    <button class="btn" id="bkConformar" title="Conformar (perfeccionar registro) cada documento seleccionado">🧹 Conformar</button>
    <button class="btn" id="bkEnriquecer" title="Enriquecer (rellenar huecos con APIs) cada documento seleccionado">✨ Enriquecer</button>
    <button class="btn" id="bkAFondo" title="Completar a fondo: lee cada libro con la VISIÓN (IA, más lento) y aplica lo que aporte (autores/roles, sinopsis, identificadores). Va uno a uno.">🎯 A fondo</button>
    <button class="btn" id="bkTipo" title="Cambiar el tipo (libro/revista/cómic) de los documentos seleccionados">🔀 Cambiar tipo</button>
    <button class="btn" id="bkReclasEd" title="Reclasificar la EDITORIAL de los seleccionados buscándola en cascada (fichero → OpenLibrary → Google → IA opcional). Muestra un informe por transición antes de aplicar.">🏢 Reclasificar editorial</button>
    <button class="btn" id="bkPortada" title="Asignar la MISMA imagen de portada a todos los seleccionados. Se añade como portada; las imágenes que ya tengan se conservan en el carrusel.">🖼️ Portada común</button>
    <button class="btn" id="bkReproc" title="Reprocesar: devolver cada documento al Inbox para re-catalogarlo de cero (recicla el registro actual)">♻️ Reprocesar</button>
    <button class="btn bad" id="bkDel">🗑 Eliminar</button>`
    : '';
  // GESTIÓN de la selección, SIEMPRE VISIBLE en la barra: contar · aislar · vaciar. Es lo que se hace CON la
  // selección, y va aquí a propósito — el panel plegable «⚙️ Acciones» es para lo que se hace A los documentos
  // (colección, obra, estantería, borrar…). Antes «Mostrar selección» y «Limpiar» vivían dentro del panel: si
  // la selección arrastraba documentos ya borrados no se veía nada y no había forma VISIBLE de vaciarla —
  // contador zombi y sin salida.
  const cuenta = selDocs.size
    ? `<span style="margin-left:auto"></span><b>${selDocs.size}</b> sel.
       <button class="btn${soloSeleccion ? ' pri' : ''}" id="bkMostrarSel" title="Muestra SOLO los seleccionados (para revisar la selección y, en Modo selección, quitar los que no quieras). Vuelve a pulsar para mostrar todo.">${soloSeleccion ? '🗂 Mostrar todo' : '👁 Mostrar selección'}</button>
       <button class="btn bad" id="bkClearTop" title="Vaciar la selección. NO borra nada: solo desmarca.">✕ Limpiar selección</button>`
    : '';
  const g = colaEtqGuardada();
  const resume =
    g && 'NDEFReader' in window && !selDocs.size
      ? `<button class="btn pri" id="bkResumeNfc" style="margin-left:auto">📶 Reanudar etiquetado (${g.ids.length})</button>`
      : '';
  // Panel colapsable de acciones (recuerda su estado; en móvil arranca plegado, como los filtros).
  const acciones = selDocs.size
    ? `<details class="bulkacts" id="bulkActs"${accPanelAbierto() ? ' open' : ''}>
         <summary>⚙️ Acciones (${selDocs.size})</summary>
         <div class="bulkacts-body">${accBtns}</div>
       </details>`
    : '';
  el.innerHTML = `<div class="bulkbar">${modoBtn}${tomosBtn}${herramientas}${resume}${cuenta}</div>${acciones}`;
  // Recordar si el panel de acciones queda plegado o desplegado.
  if ($('#bulkActs'))
    $('#bulkActs').addEventListener('toggle', (e) => localStorage.setItem('sq_acciones', e.target.open ? '1' : '0'));
  // Activar/desactivar Modo selección (la selección NO se pierde al apagarlo). Mismo efecto que el gesto
  // doble-clic / pulsación-larga sobre una tarjeta.
  $('#bkModo').onclick = alternarModoSel;
  // Colapsar/desplegar obras: es un MODO (se recuerda) → se repinta la búsqueda desde la página 1.
  if ($('#bkTomos')) $('#bkTomos').onclick = () => { modoTomos(!modoTomosExpandido()); buscarCatalogo(1); };
  if ($('#bkResumeNfc'))
    $('#bkResumeNfc').onclick = () => {
      const s = colaEtqGuardada();
      if (s) iniciarEtiquetadoLote(s.ids, s.auto);
    };
  if ($('#bkSelNfc')) $('#bkSelNfc').onclick = seleccionarPorNFC;
  // Seleccionar/quitar toda la página visible.
  if ($('#bkAllPag'))
    $('#bkAllPag').onclick = () => {
      const on = !todaLaPag;
      paginaIds.forEach((id) => (on ? selDocs.add(id) : selDocs.delete(id)));
      $$('#searchResults [data-doc]').forEach((c) => c.classList.toggle('sel', selDocs.has(c.dataset.doc)));
      renderBulk();
    };
  if ($('#bkAllRes')) $('#bkAllRes').onclick = selTodosResultados;
  if (selDocs.size) {
    $('#bkCol').onclick = () => pickerGrupo('coleccion');
    $('#bkObra').onclick = () => pickerGrupo('obra');
    $('#bkUbic').onclick = () => pickerUbic();
    if ($('#bkQuitUbic')) $('#bkQuitUbic').onclick = quitarSeleccionDeUbic;
    if ($('#bkNfc')) $('#bkNfc').onclick = () => iniciarEtiquetadoLote([...selDocs], false);
    if ($('#bkConformar')) $('#bkConformar').onclick = () => accionLoteFicha('conformar', { verbo: 'Conformar' });
    if ($('#bkEnriquecer')) $('#bkEnriquecer').onclick = () => accionLoteFicha('enriquecer', { verbo: 'Enriquecer' });
    if ($('#bkAFondo')) $('#bkAFondo').onclick = aFondoLote;
    if ($('#bkTipo')) $('#bkTipo').onclick = () => cambiarTipoDocs([...selDocs]);
    if ($('#bkReclasEd')) $('#bkReclasEd').onclick = () => reclasificarEditorialLote([...selDocs], `${selDocs.size} seleccionado(s)`);
    if ($('#bkPortada')) $('#bkPortada').onclick = portadaComunLote;
    if ($('#bkReproc')) $('#bkReproc').onclick = () => accionLoteFicha('reprocesar', { verbo: 'Reprocesar', password: true });
    $('#bkDel').onclick = eliminarSeleccionados;
  }
  // GESTIÓN de la selección (aislar / vaciar): viven en la BARRA, no en el panel de acciones → se cablean
  // FUERA del bloque de arriba, que solo corre si el panel está montado.
  //   · Mostrar selección: alterna la vista restringida a lo seleccionado (y re-busca).
  if ($('#bkMostrarSel'))
    $('#bkMostrarSel').onclick = () => {
      soloSeleccion = !soloSeleccion;
      buscarCatalogo(1);
    };
  if ($('#bkClearTop')) $('#bkClearTop').onclick = limpiarSeleccion;
}
// Vacía la selección del catálogo. NO borra documentos: solo desmarca. Sale de «Mostrar selección» y, si la
// vista estaba filtrada por la selección, la recarga (si no, quedaría mostrando un filtro ya vacío).
function limpiarSeleccion() {
  selDocs.clear();
  soloSeleccion = false;
  $$('#searchResults .sel').forEach((c) => c.classList.remove('sel'));
  const estabaFiltrado = $('#searchResults').dataset.solo === '1';
  renderBulk();
  if (estabaFiltrado) buscarCatalogo(1);
}
// Selecciona TODOS los resultados de la búsqueda actual (todas las páginas, respeta filtros incl. con/sin NFC).
async function selTodosResultados() {
  const params = _paramsBusqueda();
  params.set('soloIds', '1');
  let r;
  try {
    r = await api('/catalogo?' + params.toString());
  } catch (e) {
    toast(e.message, 'bad');
    return;
  }
  (r.ids || []).forEach((id) => selDocs.add(id));
  $$('#searchResults [data-doc]').forEach((v) => {
    if (selDocs.has(v.dataset.doc)) v.classList.add('sel');
  });
  renderBulk();
  toast(`${(r.ids || []).length} resultado(s) seleccionados · total ${selDocs.size}`);
}
// («Ver selección» como popup se sustituyó por «Mostrar selección», que restringe el propio Catálogo a los
//  documentos seleccionados — más funcional para selecciones grandes; ver renderBulk · bkMostrarSel.)

// Quitar los SELECCIONADOS de su estantería/ámbito → ubicación «Sin asignar» (NO crea registro de movimiento,
// NO borra nada; es reversible reasignándolos). Acción en lote de la barra de selección.
async function quitarSeleccionDeUbic() {
  const n = selDocs.size;
  if (!n) return;
  if (
    !(await ubicConfirm(
      `🚫 Quitar ${n} de su estantería`,
      `Sus libros quedarán en «Sin asignar» (no se borra nada; puedes reasignarlos cuando quieras). ¿Seguir?`,
    ))
  )
    return;
  try {
    const r = await api('/ubicaciones/quitar', {
      method: 'POST',
      body: JSON.stringify({ ids: [...selDocs] }),
    });
    if (!r.ok) {
      toast(r.motivo || 'No se pudo', 'bad');
      return;
    }
    toast(`${r.n} doc(s) → Sin asignar`);
    selDocs.clear();
    buscarCatalogo(estadoBusqueda.page || 1);
  } catch (e) {
    toast(e.message, 'bad');
  }
}
// Selección por NFC: escaneo CONTINUO; cada libro que toques (su etiqueta lleva ?doc=<id>) se ACUMULA en la
// selección (selDocs) sin borrar lo ya elegido. Ideal para juntar libros dispersos físicamente por el estante.
async function seleccionarPorNFC() {
  if (!('NDEFReader' in window)) {
    toast('Este dispositivo no puede leer NFC (Android + Chrome)', 'warn');
    return;
  }
  let n = 0;
  const vistos = new Set();
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:420px;text-align:center"><h3 style="margin-top:0">📶 Seleccionar por NFC</h3>
    <p class="muted" id="snMsg">Ve tocando las etiquetas de los libros…</p>
    <p style="font-size:15px"><b id="snN">0</b> añadido(s) · <b id="snTot">${selDocs.size}</b> en la selección</p>
    <div style="margin-top:8px"><button class="btn pri" id="snX">Terminar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  const ctrl = new AbortController();
  const cerrar = () => {
    try {
      ctrl.abort();
    } catch (_) {}
    cerrarCmp();
    renderBulk();
    if (n) buscarCatalogo(estadoBusqueda.page || 1);
  };
  $('#snX').onclick = cerrar;
  $('#cmpScrim').onclick = cerrar;
  try {
    const reader = new NDEFReader();
    await reader.scan({ signal: ctrl.signal });
    reader.onreading = (ev) => {
      sonidoNfcLectura();
      let url = '';
      for (const rec of ev.message.records) {
        try {
          if (rec.recordType === 'url') {
            url = new TextDecoder(rec.encoding || 'utf-8').decode(rec.data);
            if (url) break;
          }
        } catch (_) {}
      }
      const id = docIdDeURL(url);
      const m = $('#snMsg');
      if (!id) {
        if (m) m.textContent = 'Etiqueta sin libro (¿es de estantería?).';
        return;
      }
      if (vistos.has(id)) {
        if (m) m.textContent = 'Ese libro ya estaba en la selección.';
        return;
      }
      vistos.add(id);
      selDocs.add(id);
      n++;
      const eN = $('#snN'),
        eT = $('#snTot');
      if (eN) eN.textContent = n;
      if (eT) eT.textContent = selDocs.size;
      if (m) {
        m.textContent = '✅ Añadido';
        m.style.color = 'var(--acc)';
      }
      const c = $(`#searchResults [data-doc="${id}"]`);
      if (c) c.classList.add('sel');
      try {
        navigator.vibrate && navigator.vibrate(40);
      } catch (_) {}
    };
    reader.onreadingerror = () => {
      const m = $('#snMsg');
      if (m) m.textContent = 'No se pudo leer esa etiqueta, reinténtalo.';
    };
  } catch (e) {
    const m = $('#snMsg');
    if (m) {
      m.textContent = 'NFC: ' + e.message;
      m.style.color = 'var(--bad)';
    }
  }
}
// Borrado MASIVO de los seleccionados (solo admin; renderBulk ya gatea ROL). Pide contraseña. Las
// carpetas van a la Papelera (recuperable), como el borrado individual.
// Sigue el BORRADO MASIVO en curso: barra de progreso + botón de CANCELAR. Sin esto, borrar 500 documentos
// dejaba al usuario a ciegas varios minutos y sin salida (y el navegador acababa cortando la petición).
// Cancelar detiene ANTES del siguiente documento; lo ya borrado está en la Papelera (recuperable).
async function seguirBorradoLote(total) {
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:520px;width:94vw">
    <h3 style="margin:0 0 10px">🗑 Eliminando documentos…</h3>
    <div style="height:10px;border-radius:6px;background:rgba(128,128,128,.25);overflow:hidden">
      <div id="delBar" style="height:100%;width:0%;background:var(--acc);transition:width .3s"></div>
    </div>
    <div id="delTxt" class="muted" style="font-size:13px;margin-top:8px">0 / ${total}</div>
    <div id="delTit" class="muted" style="font-size:12px;margin-top:2px;min-height:1.2em"></div>
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn bad" id="delCancel">✕ Cancelar</button></div>
  </div>`;
  $('#cmpModal').style.display = 'grid';
  $('#delCancel').onclick = async () => {
    $('#delCancel').disabled = true;
    $('#delCancel').textContent = 'Cancelando…';
    try { await api('/documentos/eliminar-lote/cancelar', { method: 'POST' }); } catch { /* ya habrá acabado */ }
  };
  let e = {};
  for (;;) {
    await new Promise((r) => setTimeout(r, 700));
    try { e = await api('/documentos/eliminar-lote/estado'); } catch { break; }
    const pct = e.total ? Math.round((e.hechos / e.total) * 100) : 0;
    if ($('#delBar')) $('#delBar').style.width = pct + '%';
    if ($('#delTxt')) $('#delTxt').textContent = `${e.hechos} / ${e.total}${e.fallidos ? ` · ${e.fallidos} fallido(s)` : ''}${e.cancelar ? ' · cancelando…' : ''}`;
    if ($('#delTit')) $('#delTit').textContent = e.titulo ? recortar(e.titulo, 60) : '';
    if (!e.en_curso) break;
  }
  cerrarCmp();
  const cancelado = e.cancelar && e.hechos < e.total;
  toast(
    `Eliminado(s) ${e.eliminados || 0} libro(s)${e.fallidos ? ` · ${e.fallidos} fallido(s)` : ''}${cancelado ? ` · CANCELADO (${e.total - e.hechos} sin tocar)` : ''} → Papelera`,
    cancelado || e.fallidos ? 'warn' : 'ok',
  );
}

async function eliminarSeleccionados() {
  const n = selDocs.size;
  if (!n) return;
  const pw = await modalPassword({
    titulo: `🗑 Eliminar ${n} libro(s)`,
    aviso: `Se borrarán <b>${n}</b> documento(s); sus carpetas (sidecars e imágenes) irán a la <b>Papelera</b> (recuperable). Acción MASIVA. Confirma con tu contraseña de administrador.`,
  });
  if (pw == null) return;
  try {
    // El borrado es un TRABAJO DE FONDO (cada documento mueve su carpeta a la Papelera: 500 tardan minutos).
    // El POST solo lo LANZA; el progreso se sigue con /estado y se puede CANCELAR.
    const r = await api('/documentos/eliminar-lote', {
      method: 'POST',
      body: JSON.stringify({ ids: [...selDocs], password: pw }),
    });
    if (!r.ok) {
      toast(r.motivo || 'No se pudo eliminar', 'bad');
      return;
    }
    selDocs.clear();
    await seguirBorradoLote(r.total || n);
    buscarCatalogo(estadoBusqueda.page || 1);
  } catch (e) {
    toast(e.message, 'bad');
  }
}
// Asigna la MISMA imagen de portada a toda la selección: se elige un fichero (o foto), se reduce en el
// cliente y se envía a /documentos/portada-lote. En cada documento pasa a ser la PORTADA; las imágenes que ya
// tuviera se CONSERVAN en el carrusel (la portada anterior queda como una más). Solo admin (renderBulk ya gatea).
async function portadaComunLote() {
  const ids = [...selDocs];
  if (!ids.length) return;
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*';
  inp.onchange = async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    if (!window.confirm(`¿Asignar esta imagen como portada de ${ids.length} documento(s)? Las imágenes que ya tengan se conservan en el carrusel.`)) return;
    const bar = $('#searchBulk');
    try {
      if (bar) bar.innerHTML = `<div class="bulkbar"><b>Asignando portada…</b> ${ids.length} doc(s)</div>`;
      const b64 = await fileADataURL(await reducirImagen(file, 2200, 0.88));
      const r = await api('/documentos/portada-lote', { method: 'POST', body: JSON.stringify({ ids, base64: b64 }) });
      if (!r.ok) { toast(r.motivo || 'No se pudo asignar la portada', 'bad'); renderBulk(); return; }
      toast(`Portada asignada a ${r.aplicados} doc(s)${r.fallidos ? ` · ${r.fallidos} fallido(s)` : ''}`, r.fallidos ? 'warn' : 'ok');
      buscarCatalogo(estadoBusqueda.page || 1); // refresca las portadas de la rejilla
    } catch (e) { toast(e.message, 'bad'); renderBulk(); }
  };
  inp.click();
}
// Aplica EN LOTE una acción de la ficha (conformar/enriquecer/reprocesar) a la selección del Catálogo.
// Secuencial (una a una, para no saturar el servidor ni las APIs/IA), con progreso en la barra. Reutiliza
// los MISMOS endpoints por-documento que la ficha individual. «Medir» y las que necesitan interacción
// (editar/imágenes) NO se ofrecen aquí.
async function accionLoteFicha(tipo, { verbo = 'Procesar', password = false } = {}) {
  const ids = [...selDocs];
  if (!ids.length) return;
  // Reprocesar: MISMO modal que la ficha individual (elige modo CONSERVADOR / NUEVO DESDE CERO + contraseña
  // de admin). La contraseña se pide UNA vez y viaja en cada petición (si falta → 403). Conformar/Enriquecer
  // no la necesitan (solo un aviso de confirmación).
  let pw = null, conservar = true;
  if (tipo === 'reprocesar') {
    const el = await modalReprocesar({ n: ids.length });
    if (el == null) return; // cancelado
    pw = el.password; conservar = el.conservar;
  } else if (password) {
    pw = await modalPassword({
      titulo: `♻️ ${verbo} ${ids.length} documento(s)`,
      aviso: `Acción MASIVA. Confirma con tu contraseña de administrador.`,
    });
    if (pw == null) return; // cancelado
  } else if (!window.confirm(`¿${verbo} ${ids.length} documento(s) seleccionado(s)?`)) return;
  const body = JSON.stringify(tipo === 'reprocesar' ? { password: pw, conservar } : (password ? { password: pw } : {}));
  const bar = $('#searchBulk');
  let ok = 0, err = 0, cambios = 0, ultErr = '';
  for (let i = 0; i < ids.length; i++) {
    if (bar) bar.innerHTML = `<div class="bulkbar"><b>${esc(verbo)}…</b> ${i + 1}/${ids.length} · ✓${ok} ✕${err}</div>`;
    try {
      const r = await api('/documentos/' + encodeURIComponent(ids[i]) + '/' + tipo, { method: 'POST', body });
      if (r && r.ok !== false) { ok++; cambios += (r.cambios ? r.cambios.length : 0); }
      else { err++; ultErr = (r && r.motivo) || ultErr; }
    } catch (e) { err++; ultErr = e.message || ultErr; }
  }
  toast(`${verbo}: ${ok} ok${err ? ` · ${err} con error${ultErr ? ' (' + recortar(ultErr, 50) + ')' : ''}` : ''}${tipo !== 'reprocesar' ? ` · ${cambios} cambio(s)` : ''}`, err ? 'warn' : 'ok');
  if (tipo === 'reprocesar') { selDocs.clear(); soloSeleccion = false; } // reciclados: la selección ya no aplica
  buscarCatalogo(estadoBusqueda.page || 1);
}
// «Completar a fondo» EN LOTE: por cada documento, ANALIZA (lee el libro con la visión) y APLICA
// automáticamente todo lo aplicable (lo que en la ficha individual elegirías en el balance). Secuencial
// (usa visión/IA, más lento y con límites); progreso en la barra. Reutiliza los MISMOS endpoints a-fondo.
async function aFondoLote() {
  const ids = [...selDocs];
  if (!ids.length) return;
  if (!window.confirm(`¿Completar a fondo ${ids.length} documento(s)? Lee cada libro con la VISIÓN (IA, más lento) y aplica automáticamente lo que aporte. Va uno a uno.`)) return;
  const bar = $('#searchBulk');
  let ok = 0, err = 0, aplicados = 0, sinCambios = 0, ultErr = '';
  for (let i = 0; i < ids.length; i++) {
    if (bar) bar.innerHTML = `<div class="bulkbar"><b>Completar a fondo…</b> ${i + 1}/${ids.length} · ✓${ok} ✕${err} · ${aplicados} campos</div>`;
    try {
      const r = await api('/documentos/' + encodeURIComponent(ids[i]) + '/a-fondo', { method: 'POST', body: '{}' });
      if (!r || r.ok === false) { err++; ultErr = (r && r.motivo) || ultErr; continue; }
      const campos = (r.balance || []).filter((b) => !b.soloSugerencia).map((b) => b.campo);
      if (!campos.length) { ok++; sinCambios++; continue; } // leído pero sin mejoras aplicables
      const r2 = await api('/documentos/' + encodeURIComponent(ids[i]) + '/a-fondo/aplicar', {
        method: 'POST',
        body: JSON.stringify({ propuesta: r.propuesta || {}, campos, reclasificar: r.reclasificar === true }),
      });
      ok++; aplicados += (r2 && r2.aplicados ? r2.aplicados.length : 0);
    } catch (e) { err++; ultErr = e.message || ultErr; }
  }
  toast(`A fondo: ${ok} ok${err ? ` · ${err} con error${ultErr ? ' (' + recortar(ultErr, 40) + ')' : ''}` : ''} · ${aplicados} campo(s) aplicados${sinCambios ? ` · ${sinCambios} sin mejoras` : ''}`, err ? 'warn' : 'ok');
  buscarCatalogo(estadoBusqueda.page || 1);
}
// Selector con FILTRO + PREVISUALIZACIÓN (en vez de un desplegable largo): clic en una tarjeta → añade
// los seleccionados a esa colección/obra; o crear una nueva abajo. kind: 'coleccion' | 'obra'.
// Repinta la vista de obra/colección abierta (tras mover o expulsar tomos). `detalle` guarda qué se está
// viendo; si no hay nada abierto, no hace nada.
function recargarVistaActual() {
  if (detalle && detalle.tipo === 'obra') verObra(detalle.id);
  else if (detalle && detalle.tipo === 'coleccion') verColeccion(detalle.id);
}

// EXPULSAR de su obra/colección los documentos seleccionados. NO los borra: quedan sueltos en el catálogo. Se
// avisa de lo que implica (se pierden nº de tomo y pertenencia) porque no es deshacible con un clic.
async function expulsarDeGrupoUI(tipo, ids) {
  const esObra = tipo === 'obra';
  const nom = esObra ? 'la obra' : 'la colección';
  // Mismo patrón de confirmación que «Explotar» (confirm nativo): no es destructivo —los documentos y sus
  // ficheros se conservan— pero sí pierde datos de pertenencia, así que se avisa de qué implica exactamente.
  if (!confirm(
    `Expulsar ${ids.length} documento(s) de ${nom}: quedarán SUELTOS en el catálogo. No se borra nada (conservan sus ficheros), pero ` +
    `${esObra ? 'pierden su nº de tomo y la pertenencia a la obra' : 'pierden su pertenencia a la colección'}. ` +
    `Si ${nom} se queda vacía, se elimina. ¿Seguir?`,
  )) return;
  try {
    const r = await api('/documentos/expulsar', { method: 'POST', body: JSON.stringify({ ids, tipo }) });
    if (!r.ok) return toast(r.motivo || 'No se pudo expulsar', 'bad');
    toast(`⏏ ${r.n} documento(s) fuera de ${nom}${r.vaciados ? ` · ${nom} vacía eliminada` : ''}`);
    if (r.vaciados) go(esObra ? 'obras' : 'colecciones');   // la vista abierta ya no existe
    else recargarVistaActual();
  } catch (e) { toast(e.message, 'bad'); }
}

// Selector de obra/colección con BUSCADOR + «crear nueva». `ids` permite usarlo desde la vista de una obra o
// colección (donde la selección es local, no `selDocs`) para MOVER tomos a otro grupo; sin `ids` opera sobre la
// selección del Catálogo, como siempre.
async function pickerGrupo(kind, ids = null) {
  const objetivo = ids && ids.length ? ids : [...selDocs];
  const esCol = kind === 'coleccion';
  let items = [];
  try {
    items = await api(esCol ? '/colecciones' : '/obras');
  } catch {}
  const ico = esCol ? '📚' : '📖';
  const nom = (o) => (esCol ? o.nombre : o.titulo);
  const sub = (o) =>
    esCol
      ? `${o.tipo === 'revista' ? '📰 revista' : '📚 libro'} · ${o.miembros || 0} miembro(s)`
      : `${o.volumenes_presentes || 0}/${o.total_volumenes || '?'} tomos`;
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:560px"><h3 style="margin-top:0">${ico} Añadir <b>${objetivo.length}</b> doc(s) a una ${esCol ? 'colección' : 'obra'}</h3>
    <input id="pkFiltro" placeholder="🔍 filtrar por nombre…" autocomplete="off">
    <div id="pkLista" class="pklist"></div>
    <div style="margin:10px 0;text-align:center;color:var(--mut)">— o crear nueva —</div>
    <div class="row" style="gap:8px;align-items:center"><input id="pkNom" placeholder="${esCol ? 'Nombre de la colección' : 'Título de la obra'}" autocomplete="off" style="flex:1 1 180px">
      ${esCol ? `<select id="pkTipo" style="flex:0 0 auto"><option value="libro">Serie de libros</option><option value="revista">Revista</option></select>` : ''}
      <button class="btn pri" id="pkCrear">Crear y añadir</button></div>
    <div id="pkErr" style="color:var(--bad);font-size:12px;min-height:15px;margin-top:6px"></div>
    <div style="text-align:right;margin-top:6px"><button class="btn" id="pkX">Cancelar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#pkX').onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
  const pintar = (q) => {
    q = (q || '').toLowerCase().trim();
    const fil = items.filter((o) => (nom(o) || '').toLowerCase().includes(q));
    $('#pkLista').innerHTML = fil.length
      ? fil
          .map(
            (o) =>
              `<div class="pkitem" data-id="${esc(o._id)}"><div class="pkcov">${o.portada ? `<img src="${esc(encUrl(o.portada))}" loading="lazy" onerror="this.parentNode.textContent='${ico}'">` : ico}</div><div class="pkmeta"><div class="pkn">${esc(nom(o) || '—')}</div><div class="pks muted">${esc(sub(o))}</div></div></div>`,
          )
          .join('')
      : '<div class="muted" style="padding:14px">Sin resultados</div>';
    $$('#pkLista .pkitem').forEach((el) => (el.onclick = () => aplicarGrupo(kind, { id: el.dataset.id, ids: objetivo })));
  };
  pintar('');
  $('#pkFiltro').oninput = () => pintar($('#pkFiltro').value);
  setTimeout(() => $('#pkFiltro').focus(), 30);
  $('#pkCrear').onclick = () => {
    const nombre = $('#pkNom').value.trim();
    if (!nombre) {
      $('#pkErr').textContent = 'Escribe un nombre';
      return;
    }
    aplicarGrupo(kind, { nombre, tipo: esCol ? $('#pkTipo').value : undefined, ids: objetivo });
  };
}
async function aplicarGrupo(kind, { id, nombre, tipo, ids = null }) {
  const esCol = kind === 'coleccion';
  const objetivo = ids && ids.length ? ids : [...selDocs];
  const body = esCol
    ? { ids: objetivo, coleccionId: id || null, nombre: nombre || null, tipo }
    : { ids: objetivo, obraId: id || null, titulo: nombre || null };
  try {
    const r = await api(esCol ? '/documentos/agrupar/coleccion' : '/documentos/agrupar/obra', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const e = $('#pkErr');
      if (e) e.textContent = r.motivo;
      else toast(r.motivo, 'bad');
      return;
    }
    cerrarCmp();
    const vaciadas = r.vaciadas ? ` · ${r.vaciadas} ${esCol ? 'colección(es)' : 'obra(s)'} vacía(s) eliminada(s)` : '';
    toast(`${r.n} doc(s) → ${esCol ? 'colección «' + r.coleccion.nombre : 'obra «' + r.obra.titulo}»${vaciadas}`);
    // Si nos llamaron con ids EXPLÍCITOS venimos de la ficha de una obra/colección (selección local, no
    // `selDocs`): allí hay que repintar ESA vista, no el Catálogo — y no tocar la selección del Catálogo.
    if (ids && ids.length) recargarVistaActual();
    else {
      selDocs.clear();
      buscarCatalogo(estadoBusqueda.page || 1);
    }
  } catch (e) {
    const el = $('#pkErr');
    if (el) el.textContent = e.message;
    else toast(e.message, 'bad');
  }
}
function construirSearch() {
  $('#p-search').innerHTML = `
    <div class="sec-h"><h2>Catálogo</h2><span class="muted" id="searchCount" style="margin-left:auto"></span><button class="btn" id="sqVista" title="Cambiar entre vista de iconos y vista de detalles" style="margin-left:10px"></button><button class="btn" id="sqClear" title="Limpiar la búsqueda y todos los filtros" style="margin-left:8px">✕ Limpiar</button></div>
    <details class="card foldcard" id="sqFiltros" style="margin-bottom:16px">
      <summary>🔎 Buscar y filtrar</summary>
      <div class="row">
        <div style="flex:2 1 220px"><label>Buscar</label><input id="sqQ" placeholder="título, autor, editorial, ISBN, ISSN, archivo…" autocomplete="off" enterkeyhint="search">
          <label class="muted" title="Búsqueda estricta: solo resultados con la FRASE EXACTA tecleada (p. ej. «history of philosophy» adyacente y en ese orden), en vez de casar cada palabra suelta." style="font-size:11px;display:inline-flex;align-items:center;gap:5px;margin-top:5px;cursor:pointer;white-space:nowrap"><input type="checkbox" id="sqEstricto"> 🎯 Frase exacta</label></div>
        <div><label>Tipo</label><select id="sqTipo"><option value="">Todos</option><option value="libro">Libros</option><option value="revista">Revistas</option><option value="comic">Cómics</option><option value="articulo">Artículos</option><option value="capitulo">Capítulos</option><option value="apuntes">Apuntes</option><option value="software">Software</option></select></div>
        <div><label>Soporte</label><select id="sqSoporte"><option value="">Ambos</option><option value="papel">Papel</option><option value="digital">Digital</option></select></div>
        <div><label>Formato</label><select id="sqFormato"><option value="">Todos</option><option value="pdf">PDF</option><option value="epub">EPUB</option><option value="mobi">MOBI/AZW</option><option value="cbz">CBZ</option><option value="cbr">CBR</option><option value="cb7">CB7</option><option value="djvu">DjVu</option><option value="audio">🔊 Audio</option><option value="video">🎬 Vídeo</option><option value="papel">Papel</option></select></div>
        <div><label>Ámbito</label><select id="sqAmbito"><option value="">Todos</option></select></div>
        <div><label>Estantería</label><select id="sqEstanteria" disabled><option value="">Todas</option></select></div>
        <div class="admin-only" style="display:flex;align-items:flex-end"><button class="btn" id="sqGoUbic" title="Gestionar ubicaciones (o ver esta estantería)">📍 Gestionar</button></div>
        <div><label>CDU (prefijo)</label><input id="sqCdu" placeholder="ej. 82" autocomplete="off" enterkeyhint="search"></div>
        <div><label>Estrellas${ROL === 'admin' ? ' / NSFW' : ''}</label><details class="ddown" id="sqStarsDD"><summary id="sqStarsSum">Todas</summary>
          <div class="pop">${[5, 4, 3, 2, 1].map((n) => `<label><input type="checkbox" class="sqStar" value="${n}">${'★'.repeat(n)}</label>`).join('')}<label><input type="checkbox" class="sqStar" value="0">Sin valorar</label>${ROL === 'admin' ? '<label style="border-top:1px solid var(--line);margin-top:4px;padding-top:6px" title="Sin marcar: OCULTA lo NSFW · Marcada con otros filtros: lo INCLUYE también · Marcada y sola: SOLO NSFW"><input type="checkbox" id="sqNsfw"> 🔞 NSFW</label>' : ''}</div>
        </details></div>
        <div class="admin-only"><label>Etiqueta NFC</label><select id="sqNfc"><option value="">Todas</option><option value="con">📶 Con etiqueta</option><option value="sin">Sin etiqueta</option></select></div>
        <div class="admin-only"><label>Descubrir</label><div style="display:flex;align-items:center;gap:6px;height:36px"><label class="switch" style="flex:0 0 auto"><input type="checkbox" id="sqDescubrir"><span class="slider"></span></label><span class="muted" title="Busca en el Fichero (58,7 M) libros que NO tienes, con enlaces para conseguirlos">🔭 Fichero</span></div></div>
      </div>
    </details>
    <details class="card foldcard" id="sqOrdenar" style="margin-bottom:16px">
      <summary>↕️ Ordenar</summary>
      <div class="row" style="align-items:flex-end">
        <div style="flex:1 1 240px"><label>Ordenar por</label>
          <select id="sqOrden">
            <option value="reciente">Relevancia / recientes</option>
            <option value="fecha">Fecha de ingreso</option>
            <option value="titulo">Título (alfabético)</option>
            <option value="autor">Autor</option>
            <option value="posicion">Posición en la estantería</option>
            <option value="obra">Posición en la obra</option>
            <option value="coleccion">Posición en la colección</option>
            <option value="paginas">Nº de páginas</option>
          </select></div>
        <div id="sqDirWrap" style="display:none"><label>Sentido</label><button class="btn" id="sqDir" data-dir="desc" title="Cambiar entre ascendente y descendente">↓ Desc</button></div>
      </div>
    </details>
    <div id="searchChip" style="margin-bottom:12px"></div>
    <div id="searchBulk"></div>
    <div id="searchPagerTop" style="margin:0 0 12px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap"></div>
    <div id="searchResults"></div>
    <div id="searchPager" style="margin-top:16px;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap"></div>
    <div id="searchExternal" style="margin-top:20px"></div>`;
  // Filtros plegables: en PC desplegados, en móvil colapsados (recordando la última preferencia del usuario).
  {
    const fl = $('#sqFiltros');
    if (fl) {
      const sav = localStorage.getItem('sq_filtros');
      fl.open = sav === null ? matchMedia('(min-width:860px)').matches : sav === '1';
      fl.addEventListener('toggle', () => localStorage.setItem('sq_filtros', fl.open ? '1' : '0'));
    }
  }
  // Al confirmar una búsqueda (Enter / «Ir» del teclado móvil) contrae el panel de filtros para VER los
  // resultados sin hacer scroll (el panel se hizo grande). Se reabre tocando «🔎 Buscar y filtrar».
  const colapsarFiltros = () => {
    const fl = $('#sqFiltros');
    if (fl) fl.open = false;
    // Móvil: el input de búsqueda vive DENTRO del panel; al plegarlo hay que soltar el foco para que se
    // cierre el teclado y los resultados queden a la vista.
    if (document.activeElement && typeof document.activeElement.blur === 'function') document.activeElement.blur();
  };
  $('#sqQ').oninput = () => {
    clearTimeout(busqTimer);
    busqTimer = setTimeout(() => buscarCatalogo(1), 350);
  };
  $('#sqQ').onkeydown = (e) => {
    if (e.key === 'Enter') {
      clearTimeout(busqTimer);
      buscarCatalogo(1);
      if ($('#sqDescubrir') && $('#sqDescubrir').checked) lanzarDescubrir();
      colapsarFiltros();
    }
  };
  $('#sqCdu').oninput = () => {
    clearTimeout(busqTimer);
    busqTimer = setTimeout(() => buscarCatalogo(1), 350);
  };
  $('#sqCdu').onkeydown = (e) => {
    if (e.key === 'Enter') {
      clearTimeout(busqTimer);
      buscarCatalogo(1);
      colapsarFiltros();
    }
  };
  $('#sqTipo').onchange = () => buscarCatalogo(1);
  if ($('#sqEstricto')) $('#sqEstricto').onchange = () => buscarCatalogo(1); // frase exacta ↔ laxa
  if ($('#sqSoporte')) $('#sqSoporte').onchange = () => buscarCatalogo(1);
  if ($('#sqFormato')) $('#sqFormato').onchange = () => buscarCatalogo(1);
  // Ubicación: al cambiar el ámbito, refrescar la estantería (asociada a ese ámbito) y buscar.
  if ($('#sqAmbito'))
    $('#sqAmbito').onchange = () => {
      pintarEstanteriaSearch();
      buscarCatalogo(1);
    };
  if ($('#sqEstanteria')) $('#sqEstanteria').onchange = () => buscarCatalogo(1);
  // Ir a la página de Ubicaciones (si hay ámbito elegido, abre directamente sus libros allí).
  if ($('#sqGoUbic'))
    $('#sqGoUbic').onclick = () => {
      const a = ($('#sqAmbito') && $('#sqAmbito').value) || '';
      ubicPendiente = a ? { a, e: ($('#sqEstanteria') && $('#sqEstanteria').value) || null } : null;
      go('ubic');
    };
  // Ordenación: colapsable propio + toggle de sentido (asc/desc) con valor por defecto según el campo.
  {
    const fo = $('#sqOrdenar');
    if (fo) {
      fo.open = localStorage.getItem('sq_ordenar') === '1'; // por defecto colapsado
      fo.addEventListener('toggle', () => localStorage.setItem('sq_ordenar', fo.open ? '1' : '0'));
    }
  }
  const DIR_DEF = { reciente: 'desc', fecha: 'desc', titulo: 'asc', autor: 'asc', posicion: 'asc', obra: 'asc', coleccion: 'asc', paginas: 'desc' };
  const setOrdenDir = (d) => {
    const b = $('#sqDir');
    if (b) { b.dataset.dir = d; b.textContent = d === 'asc' ? '↑ Asc' : '↓ Desc'; }
    const w = $('#sqDirWrap');
    if (w) w.style.display = $('#sqOrden').value === 'reciente' ? 'none' : ''; // relevancia no lleva sentido
  };
  setOrdenDir($('#sqDir') && $('#sqDir').dataset.dir || 'desc');
  $('#sqOrden').onchange = () => { setOrdenDir(DIR_DEF[$('#sqOrden').value] || 'asc'); buscarCatalogo(1); };
  if ($('#sqDir')) $('#sqDir').onclick = () => { setOrdenDir($('#sqDir').dataset.dir === 'asc' ? 'desc' : 'asc'); buscarCatalogo(1); };
  if ($('#sqNfc')) $('#sqNfc').onchange = () => buscarCatalogo(1);
  if ($('#sqDescubrir')) $('#sqDescubrir').onchange = () => buscarCatalogo(1);
  $$('#p-search .sqStar').forEach(
    (c) =>
      (c.onchange = () => {
        actualizarSumEstrellas();
        buscarCatalogo(1);
      }),
  );
  if ($('#sqNsfw'))
    $('#sqNsfw').onchange = () => {
      actualizarSumEstrellas();
      buscarCatalogo(1);
    };
  $('#sqClear').onclick = () => {
    $('#sqQ').value = '';
    $('#sqCdu').value = '';
    $('#sqTipo').value = '';
    if ($('#sqSoporte')) $('#sqSoporte').value = '';
    if ($('#sqFormato')) $('#sqFormato').value = '';
    $('#sqOrden').value = 'reciente';
    setOrdenDir('desc');
    if ($('#sqAmbito')) $('#sqAmbito').value = '';
    if ($('#sqEstanteria')) {
      $('#sqEstanteria').value = '';
      pintarEstanteriaSearch();
    }
    if ($('#sqDescubrir')) $('#sqDescubrir').checked = false;
    if ($('#searchExternal')) $('#searchExternal').innerHTML = '';
    if ($('#sqNsfw')) $('#sqNsfw').checked = false;
    if ($('#sqNfc')) $('#sqNfc').value = '';
    $$('#p-search .sqStar').forEach((c) => (c.checked = false));
    estadoBusqueda.extra = null;
    soloSeleccion = false; // «Limpiar» también sale de «Mostrar selección»
    actualizarSumEstrellas();
    buscarCatalogo(1);
  };
  // Toggle de vista iconos/detalles (el botón muestra la vista a la que se cambiaría).
  actualizarBotonVista();
  if ($('#sqVista'))
    $('#sqVista').onclick = () => {
      vistaCatalogo = vistaCatalogo === 'detalles' ? 'iconos' : 'detalles';
      try {
        localStorage.setItem('cat_vista', vistaCatalogo);
      } catch {}
      actualizarBotonVista();
      buscarCatalogo(1); // cambia el tamaño de página (24/100) y re-renderiza
    };
}
// Etiqueta del botón de vista: muestra a qué vista se cambia (el contrario de la actual).
function actualizarBotonVista() {
  const b = $('#sqVista');
  if (b) b.textContent = vistaCatalogo === 'detalles' ? '▦ Iconos' : '☰ Detalles';
}
function estrellasSel() {
  return $$('#p-search .sqStar:checked').map((c) => c.value);
}
// ¿Hay ALGÚN criterio de búsqueda además del 🔞? (para decidir incluir-NSFW vs solo-NSFW)
function hayOtrosCriteriosBusqueda() {
  const v = (id) => (($('#' + id) && $('#' + id).value) || '').trim();
  if (
    v('sqQ') ||
    v('sqTipo') ||
    v('sqSoporte') ||
    v('sqFormato') ||
    v('sqCdu') ||
    v('sqAmbito') ||
    v('sqEstanteria') ||
    v('sqNfc')
  )
    return true;
  const e = estrellasSel();
  if (e.length && e.length < 6) return true; // subconjunto de estrellas (no "Todas")
  if (estadoBusqueda && estadoBusqueda.extra) return true; // viene de un chip/enlace (ubicación, clasificación…)
  return false;
}
function actualizarSumEstrellas() {
  const s = $('#sqStarsSum');
  if (!s) return;
  const sel = estrellasSel();
  const base =
    !sel.length || sel.length === 6
      ? 'Todas'
      : sel
          .map((n) => (n === '0' ? '0★' : n + '★'))
          .sort()
          .reverse()
          .join(' ');
  s.textContent = base + ($('#sqNsfw') && $('#sqNsfw').checked ? ' · 🔞' : '');
}
function loadSearch() {
  if (!$('#sqQ')) construirSearch();
  cargarUbicaciones();
  buscarCatalogo(estadoBusqueda.page || 1);
}
// Parámetros de la búsqueda actual (SIN page): reutilizados por buscarCatalogo y por «seleccionar todos».
// Tamaño de página según la vista: 24 (iconos) / 100 (detalles).
function _porPaginaVista() {
  return vistaCatalogo === 'detalles' ? 100 : 24;
}
function _paramsBusqueda() {
  // «Mostrar selección» activo: la vista se restringe a los documentos seleccionados (ignora los demás
  // filtros; solo ids + orden). Si la selección se vació, sale del modo y busca normal.
  if (soloSeleccion && selDocs.size) {
    const p = new URLSearchParams({ ids: [...selDocs].join(','), orden: $('#sqOrden') ? $('#sqOrden').value : 'reciente' });
    p.set('porPagina', _porPaginaVista());
    return p;
  }
  soloSeleccion = soloSeleccion && selDocs.size > 0;
  const params = new URLSearchParams({
    q: $('#sqQ').value.trim(),
    tipo: $('#sqTipo').value,
    soporte: $('#sqSoporte') ? $('#sqSoporte').value : '',
    formato: $('#sqFormato') ? $('#sqFormato').value : '',
    cdu: $('#sqCdu').value.trim(),
    orden: $('#sqOrden').value,
    porPagina: _porPaginaVista(),
  });
  // Búsqueda ESTRICTA (frase exacta) en vez de laxa (todas las palabras sueltas).
  if ($('#sqEstricto') && $('#sqEstricto').checked) params.set('estricto', '1');
  // Obras multivolumen COLAPSADAS en una tarjeta (por defecto). El MODO vive en localStorage y se conmuta con
  // el botón «📚 Obras colapsadas / 📖 Tomos sueltos» de la barra de modos (junto a selección/previsualización).
  if (modoTomosExpandido()) params.set('agrupar', '0');
  // Sentido asc/desc (salvo en «Relevancia / recientes», que no lo usa).
  if ($('#sqOrden').value !== 'reciente') params.set('dir', ($('#sqDir') && $('#sqDir').dataset.dir) || 'desc');
  const est = estrellasSel();
  if (est.length && est.length < 6) params.set('estrellas', est.join(','));
  const ambS = ($('#sqAmbito') && $('#sqAmbito').value) || '';
  if (ambS) params.set('ambito', ambS);
  const estS = ($('#sqEstanteria') && $('#sqEstanteria').value) || '';
  if (ambS && estS) params.set('estanteria', estS);
  if ($('#sqNfc') && $('#sqNfc').value) params.set('nfc', $('#sqNfc').value); // etiqueta NFC: con/sin
  // 🔞 NSFW: sin marcar = excluir; marcada + otros criterios = incluir (también); marcada y sola = solo NSFW.
  if ($('#sqNsfw'))
    params.set('nsfw', !$('#sqNsfw').checked ? 'excluir' : hayOtrosCriteriosBusqueda() ? 'incluir' : 'solo');
  if (estadoBusqueda.extra)
    for (const [k, v] of Object.entries(estadoBusqueda.extra)) {
      if (k !== 'etiqueta' && v != null && v !== '') params.set(k, v);
    }
  // Ver UNA estantería: por defecto ordena por POSICIÓN física (a menos que el usuario elija otro orden).
  if (
    estadoBusqueda.extra &&
    estadoBusqueda.extra.ambito &&
    estadoBusqueda.extra.estanteria &&
    $('#sqOrden').value === 'reciente'
  )
    params.set('orden', 'posicion');
  return params;
}
async function buscarCatalogo(page) {
  estadoBusqueda.page = page;
  const params = _paramsBusqueda();
  params.set('page', page);
  pintarChipClas();
  $('#searchResults').innerHTML = '<div class="muted" style="padding:22px 6px">Buscando…</div>';
  $('#searchPager').innerHTML = '';
  try {
    const r = await api('/catalogo?' + params.toString());
    pintarBusqueda(r);
  } catch (e) {
    $('#searchResults').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    if ($('#searchCount')) $('#searchCount').textContent = '—';
  }
  // Descubrir (Fichero) es BAJO DEMANDA y corre en un WORKER: NUNCA bloquea la búsqueda de tu biblioteca
  // (que es la prioritaria). Al teclear solo se muestra el botón; la consulta al Fichero se lanza con él/Enter.
  const ext = $('#searchExternal');
  if (ext) {
    if ($('#sqDescubrir') && $('#sqDescubrir').checked) pintarDescubrirBoton();
    else ext.innerHTML = '';
  }
}
// ── Descubrir: candidatos del Fichero (OL+BNE) BAJO DEMANDA (worker) + paginación en cliente ──
let descResultados = [],
  descPagina = 1,
  descQ = '';
const DESC_POR_PAG = 25;
const descCaja = (html) => `<div class="card" style="border-color:rgba(120,160,255,.35)">${html}</div>`;
function pintarDescubrirBoton() {
  const ext = $('#searchExternal');
  if (!ext) return;
  const q = $('#sqQ').value.trim();
  ext.innerHTML =
    descCaja(`<div class="row" style="align-items:center"><b>🔭 Fuera de tu biblioteca</b><span class="muted">Fichero · Open Library + BNE (58,7 M)</span><div style="flex:1"></div>
    <button class="btn" id="descBtn"${q.length < 2 ? ' disabled' : ''}>🔭 Buscar en el Fichero${q ? ` «${esc(recortar(q, 36))}»` : ''}</button></div>
    <div class="muted" style="font-size:11px;margin-top:8px">Bajo demanda (no ralentiza tu biblioteca). Busca por título/autor.</div>`);
  if ($('#descBtn')) $('#descBtn').onclick = lanzarDescubrir;
}
async function lanzarDescubrir() {
  const ext = $('#searchExternal');
  if (!ext) return;
  const q = $('#sqQ').value.trim();
  if (q.length < 2) return;
  descQ = q;
  descResultados = [];
  descPagina = 1;
  ext.innerHTML = descCaja(
    '<div class="muted" style="padding:4px">🔭 Buscando en el Fichero (58,7 M)…</div>',
  );
  try {
    const r = await api('/descubrir?q=' + encodeURIComponent(q));
    if (!r.disponible) {
      ext.innerHTML = descCaja(
        `<b>🔭 Fuera de tu biblioteca</b><div class="muted" style="margin-top:6px">No disponible: ${esc(r.motivo || 'el Fichero no tiene índice de texto en este equipo')}.</div>`,
      );
      return;
    }
    descResultados = r.candidatos || [];
    pintarDescubrir();
  } catch (e) {
    ext.innerHTML = descCaja(
      `<div class="empty">${esc(e.message)}</div><div style="margin-top:8px"><button class="btn" id="descRetry">↻ Reintentar</button></div>`,
    );
    if ($('#descRetry')) $('#descRetry').onclick = lanzarDescubrir;
  }
}
function pintarDescubrir() {
  const ext = $('#searchExternal');
  if (!ext) return;
  const tot = descResultados.length,
    tp = Math.max(1, Math.ceil(tot / DESC_POR_PAG));
  descPagina = Math.min(Math.max(1, descPagina), tp);
  const slice = descResultados.slice((descPagina - 1) * DESC_POR_PAG, descPagina * DESC_POR_PAG);
  const pager = tp > 1
    ? `<div class="row" id="descPager" style="gap:10px;align-items:center;justify-content:center;margin-top:12px;flex-wrap:wrap">${pagerControles(descPagina, tp)}</div>`
    : '';
  ext.innerHTML =
    descCaja(`<div class="row" style="align-items:center;margin-bottom:6px"><b>🔭 Fuera de tu biblioteca</b><span class="muted">${tot}${tot >= 100 ? '+' : ''} candidato${tot === 1 ? '' : 's'} del Fichero · «${esc(recortar(descQ, 36))}»</span><div style="flex:1"></div><button class="btn" id="descAgain" title="Buscar de nuevo">↻</button></div>
    ${tot ? slice.map(descRow).join('') : '<div class="muted" style="padding:6px 0">Sin candidatos en el Fichero para esa búsqueda (busca por título/autor).</div>'}
    ${pager}
    ${tot ? '<div class="muted" style="font-size:11px;margin-top:10px">No están en tu biblioteca. Los enlaces buscan una copia descargable; al obtenerla, déjala en el Inbox para catalogarla.</div>' : ''}`);
  wirePager($('#descPager'), descPagina, tp, (np) => { descPagina = np; pintarDescubrir(); });
  if ($('#descAgain')) $('#descAgain').onclick = lanzarDescubrir;
}
function descRow(c) {
  const aut =
    (c.autores && c.autores.length ? c.autores.join(', ') : '') || c.editorial || 'autor desconocido';
  const bits = [
    c.anio,
    c.idioma ? String(c.idioma).toUpperCase() : '',
    c.cdu ? 'CDU ' + c.cdu : c.dewey ? 'Dewey ' + c.dewey : '',
    c.isbn ? 'ISBN ' + c.isbn : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const badge = c.enBiblioteca
    ? ' <span class="fmt" style="background:rgba(74,222,128,.18);color:var(--ok)" title="Ya está en tu biblioteca">✓ la tienes</span>'
    : '';
  const chip =
    'display:inline-block;padding:4px 9px;border-radius:7px;background:rgba(120,160,255,.16);color:var(--accent,#9ab8ff);text-decoration:none;font-size:12px;white-space:nowrap';
  const links = (c.enlaces || [])
    .map(
      (l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener" style="${chip}">${esc(l.nombre)} ↗</a>`,
    )
    .join('');
  return `<div style="display:flex;justify-content:space-between;gap:14px;align-items:center;padding:9px 2px;border-top:1px solid rgba(255,255,255,.08);flex-wrap:wrap">
    <div style="flex:1 1 280px;min-width:0"><div class="n" style="font-weight:600">${esc(recortar(c.titulo || '(sin título)', 95))}${badge}</div>
      <div class="muted" style="font-size:12px">${esc(aut)}</div><div class="muted" style="font-size:11px">${esc(bits)}</div></div>
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${links}</div></div>`;
}
function pintarChipClas() {
  const el = $('#searchChip');
  if (!el) return;
  const ex = estadoBusqueda.extra;
  if (ex && ex.etiqueta) {
    // Si el filtro es una ESTANTERÍA/ámbito, ofrecer «Añadir libros aquí» → Inbox con la ubicación puesta.
    const addAqui =
      ROL === 'admin' && ex.ambito
        ? ` <button class="btn" id="chipAdd" style="padding:2px 9px;font-size:12px" title="Ir al Inbox con esta ubicación ya rellena para añadir libros">➕ Añadir libros aquí</button>`
        : '';
    // Al ver UNA estantería: ordenar sus libros por posición física (localizar / inventario).
    const ordenar =
      ROL === 'admin' && ex.ambito && ex.estanteria
        ? ` <button class="btn" id="chipOrd" style="padding:2px 9px;font-size:12px" title="Colocar los libros en su orden físico dentro de la estantería">📋 Ordenar estantería</button>`
        : '';
    el.innerHTML = `<span class="clasfilt">Filtro: <b>${esc(ex.etiqueta)}</b> <span class="x" id="clasX" title="Quitar filtro">✕</span></span>${ordenar}${addAqui}`;
    $('#clasX').onclick = () => {
      estadoBusqueda.extra = null;
      buscarCatalogo(1);
    };
    if ($('#chipAdd')) $('#chipAdd').onclick = () => irAInboxConUbic(ex.ambito, ex.estanteria);
    if ($('#chipOrd')) $('#chipOrd').onclick = () => ordenarLibrosEstanteria(ex.ambito, ex.estanteria);
  } else el.innerHTML = '';
}
// Va al Inbox con el ámbito/estantería ya puestos en «Datos de esta alta» (para el bucle escanear estantería
// → añadir libros → etiquetar). Deja abierta la tarjeta de datos para que se vean.
function irAInboxConUbic(ambito, estanteria) {
  go('inbox');
  setTimeout(() => {
    if ($('#inAmbito')) $('#inAmbito').value = ambito || '';
    if ($('#inEstanteria'))
      $('#inEstanteria').value = estanteria && estanteria !== 'Sin asignar' ? estanteria : '';
    if (typeof refrescarInboxUbic === 'function') refrescarInboxUbic();
    const da = $('#datosAltaCard');
    if (da) da.open = true;
    toast(
      `Ubicación puesta: ${ambito || '—'}${estanteria && estanteria !== 'Sin asignar' ? ' · ' + estanteria : ''}. Añade los libros.`,
    );
  }, 60);
}
// ── Ordenar los LIBROS de una estantería por su posición física (localizar un libro / inventario) ──
// Modal con la estantería como LISTA vertical arrastrable (+ ↑/↓ para móvil). Guarda el índice de cada libro.
let _ordEst = null; // { ambito, estanteria, items:[{_id,titulo,portada,autores,…}] }
let _ordScan = null; // mientras se ordena ESCANEANDO por NFC: { ctrl:AbortController, hechos:Set<id> }
async function ordenarLibrosEstanteria(ambito, estanteria) {
  const btnScan =
    'NDEFReader' in window
      ? `<button class="btn" id="ordScan" title="Toca los libros con NFC en su orden físico; se numeran solos 1,2,3…">📶 Ordenar escaneando</button>`
      : '';
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:560px;max-height:90vh;overflow:auto"><h3 style="margin-top:0">📋 Ordenar «${esc(estanteria)}»</h3>
    <p class="muted" style="margin:-4px 0 8px;font-size:12px">Coloca los libros en su ORDEN FÍSICO (izquierda→derecha). Arrastra, usa ↑/↓ o <b>escanea los NFC en orden</b>. El nº es la posición.</p>
    <div id="ordScanMsg" style="display:none;font-size:12px;margin-bottom:8px;padding:8px 10px;border:1px solid var(--acc);border-radius:9px;background:rgba(40,217,168,.08)"></div>
    <div id="ordList" class="muted">Cargando…</div>
    <div style="display:flex;gap:10px;align-items:center;margin-top:12px;flex-wrap:wrap">${btnScan}<div style="flex:1"></div><button class="btn" id="ordX">Cancelar</button><button class="btn pri" id="ordSave">Guardar orden</button></div></div>`;
  const cerrar = () => {
    pararOrdenPorNFC();
    cerrarCmp();
  };
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = cerrar;
  $('#ordX').onclick = cerrar;
  let items = [];
  try {
    const r = await api('/ubicaciones/libros?' + new URLSearchParams({ ambito, estanteria }).toString());
    items = r.docs || [];
  } catch (e) {
    $('#ordList').innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  _ordEst = { ambito, estanteria, items };
  _ordScan = null;
  pintarOrdList();
  if ($('#ordScan'))
    $('#ordScan').onclick = () => {
      _ordScan ? pararOrdenPorNFC() : iniciarOrdenPorNFC();
    };
  $('#ordSave').onclick = async () => {
    pararOrdenPorNFC();
    try {
      const r = await api('/ubicaciones/orden-libros', {
        method: 'POST',
        body: JSON.stringify({ ambito, estanteria, ids: _ordEst.items.map((x) => x._id) }),
      });
      if (!r.ok) {
        toast(r.motivo || 'No se pudo guardar', 'bad');
        return;
      }
      toast(`Orden guardado (${r.n} libro(s))`);
      cerrarCmp();
      if ($('#p-search') && $('#p-search').classList.contains('on')) buscarCatalogo(estadoBusqueda.page || 1);
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
}
// Ordenar ESCANEANDO: escaneo NFC continuo; cada libro que tocas (su etiqueta lleva ?doc=<id>) se coloca en el
// SIGUIENTE hueco (1,2,3…) según el orden físico en que los vas tocando. Ideal para inventariar baldas largas.
async function iniciarOrdenPorNFC() {
  if (!_ordEst || !('NDEFReader' in window)) {
    toast('Este dispositivo no puede leer NFC (Android + Chrome)', 'warn');
    return;
  }
  const msg = $('#ordScanMsg');
  let rd;
  try {
    rd = new NDEFReader();
    const ctrl = new AbortController();
    await rd.scan({ signal: ctrl.signal });
    _ordScan = { ctrl, hechos: new Set(), ultimoId: null, ultimoT: 0 };
  } catch (e) {
    if (msg) {
      msg.style.display = '';
      msg.textContent = 'NFC: ' + e.message;
    }
    return;
  }
  rd.onreading = (ev) => {
    sonidoNfcLectura();
    let url = '';
    for (const rec of ev.message.records) {
      try {
        if (rec.recordType === 'url') {
          url = new TextDecoder(rec.encoding || 'utf-8').decode(rec.data);
          if (url) break;
        }
      } catch (_) {}
    }
    const res = colocarEscaneado(docIdDeURL(url));
    ordScanEstado(res);
    // Vibración DISTINTA para «ojo»: un toque corto al colocar bien; doble toque si hay problema (repetido
    // deliberado o libro ajeno a la balda). El doble accidental (<5s) no vibra: es ruido del lector.
    try {
      if (navigator.vibrate) {
        if (res.estado === 'ok') navigator.vibrate(40);
        else if (res.estado === 'dup' || res.estado === 'fuera') navigator.vibrate([70, 55, 70]);
      }
    } catch (_) {}
  };
  rd.onreadingerror = () => {
    if (msg) msg.textContent = 'No se pudo leer esa etiqueta, reinténtalo.';
  };
  const btn = $('#ordScan');
  if (btn) {
    btn.textContent = '⏹ Parar escaneo';
    btn.classList.add('pri');
  }
  if (msg) msg.style.display = '';
  ordScanEstado(null);
}
function pararOrdenPorNFC() {
  if (_ordScan) {
    try {
      _ordScan.ctrl.abort();
    } catch (_) {}
  }
  _ordScan = null;
  const btn = $('#ordScan');
  if (btn) {
    btn.textContent = '📶 Ordenar escaneando';
    btn.classList.remove('pri');
  }
}
// Coloca el libro escaneado en el siguiente hueco. Detecta:
//  · doble ACCIDENTAL: la MISMA etiqueta releída en <5 s (el lector NFC repite lecturas por un toque, o el tag
//    sigue apoyado) → se IGNORA (ni coloca ni avisa, solo un apunte discreto);
//  · repetido DELIBERADO: un libro ya escaneado se vuelve a tocar pasados ≥5 s → AVISO (posible copia doble o
//    despiste) y NO se recoloca;
//  · libro AJENO: su etiqueta no corresponde a ningún libro catalogado en esta estantería → AVISO (mal colocado).
const ORD_DOBLE_MS = 5000;
function colocarEscaneado(id) {
  if (!id) return { estado: 'sinid' };
  if (!_ordEst || !_ordScan) return { estado: 'off' };
  const now = Date.now();
  if (id === _ordScan.ultimoId && now - _ordScan.ultimoT < ORD_DOBLE_MS) {
    _ordScan.ultimoT = now;
    return { estado: 'accidental' };
  }
  _ordScan.ultimoId = id;
  _ordScan.ultimoT = now;
  const it = _ordEst.items,
    idx = it.findIndex((x) => x._id === id);
  if (idx < 0) return { estado: 'fuera' }; // no está catalogado en esta estantería (¿mal colocado?)
  if (_ordScan.hechos.has(id)) return { estado: 'dup', titulo: it[idx].titulo };
  _ordScan.hechos.add(id);
  const destino = _ordScan.hechos.size - 1; // 0,1,2… a medida que escaneas
  const [x] = it.splice(idx, 1);
  it.splice(destino, 0, x);
  pintarOrdList();
  const row = $(`#ordList .ordrow[data-id="${id}"]`);
  if (row) {
    row.classList.add('justscan');
    row.scrollIntoView({ block: 'nearest' });
    setTimeout(() => row.classList.remove('justscan'), 700);
  }
  return { estado: 'ok', pos: destino + 1, titulo: x.titulo };
}
function ordScanEstado(res) {
  const msg = $('#ordScanMsg');
  if (!msg || !_ordScan) return;
  const hechos = _ordScan.hechos.size,
    total = _ordEst.items.length,
    faltan = Math.max(0, total - hechos);
  // Color del recuadro según la gravedad: verde OK · naranja repetido · rojo ajeno/etiqueta rara.
  let col = 'var(--acc)',
    bg = 'rgba(40,217,168,.08)',
    linea = '';
  if (res) {
    if (res.estado === 'ok') linea = `✅ #${res.pos} · ${esc(recortar(res.titulo || '', 44))}`;
    else if (res.estado === 'accidental') linea = '↩︎ doble accidental ignorado (mismo tag < 5 s)';
    else if (res.estado === 'dup') {
      col = 'var(--warn)';
      bg = 'rgba(255,180,84,.10)';
      linea = `⚠️ YA lo habías escaneado — no se recoloca. ¿Copia duplicada o repetido por error? · ${esc(recortar(res.titulo || '', 36))}`;
    } else if (res.estado === 'fuera') {
      col = 'var(--bad)';
      bg = 'rgba(255,92,122,.10)';
      linea = '⛔ Ese libro NO está catalogado en esta estantería (¿mal colocado o de otra balda?)';
    } else if (res.estado === 'sinid') {
      col = 'var(--warn)';
      bg = 'rgba(255,180,84,.10)';
      linea = '⚠️ Etiqueta sin libro (¿es una etiqueta de estantería?)';
    }
  }
  msg.style.borderColor = col;
  msg.style.background = bg;
  msg.innerHTML = `<b>Escaneando…</b> ${hechos}/${total} colocados · faltan ${faltan}. Toca los libros en su orden físico.${linea ? `<br>${linea}` : ''}`;
}
function pintarOrdList() {
  const box = $('#ordList');
  if (!box || !_ordEst) return;
  box.classList.remove('muted');
  box.innerHTML = _ordEst.items.length
    ? _ordEst.items.map(ordRow).join('')
    : '<div class="muted">La estantería no tiene libros.</div>';
  wireOrdList();
}
function ordRow(d, i) {
  const por = d.portada
    ? `<img src="${esc(encUrl(d.portada))}" loading="lazy" onerror="this.style.visibility='hidden'">`
    : '<div class="ordph">📕</div>';
  const aut = d.autores && d.autores.length ? d.autores.filter(Boolean).join(', ') : '';
  return (
    `<div class="ordrow" draggable="true" data-id="${esc(d._id)}"><span class="ordnum">${i + 1}</span><div class="ordcov">${por}</div>` +
    `<div style="flex:1;min-width:0"><div style="font-size:13px;line-height:1.25">${esc(recortar(d.titulo || '(sin título)', 72))}</div>${aut ? `<div class="muted" style="font-size:11px">${esc(recortar(aut, 62))}</div>` : ''}</div>` +
    `<span class="ordmove"><button type="button" class="btn" data-up="${i}" title="Subir">↑</button><button type="button" class="btn" data-dn="${i}" title="Bajar">↓</button></span></div>`
  );
}
function moverOrd(from, to) {
  const it = _ordEst && _ordEst.items;
  if (!it || to < 0 || to >= it.length || from < 0 || from >= it.length) return;
  const [x] = it.splice(from, 1);
  it.splice(to, 0, x);
  pintarOrdList();
}
function wireOrdList() {
  $$('#ordList [data-up]').forEach((b) => (b.onclick = () => moverOrd(+b.dataset.up, +b.dataset.up - 1)));
  $$('#ordList [data-dn]').forEach((b) => (b.onclick = () => moverOrd(+b.dataset.dn, +b.dataset.dn + 1)));
  let src = null;
  $$('#ordList .ordrow').forEach((row) => {
    row.addEventListener('dragstart', (ev) => {
      src = row.dataset.id;
      row.classList.add('dragging');
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', src);
      } catch (_) {}
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      $$('#ordList .ordrow.dragover').forEach((x) => x.classList.remove('dragover'));
      src = null;
    });
    row.addEventListener('dragover', (ev) => {
      if (src && src !== row.dataset.id) {
        ev.preventDefault();
        row.classList.add('dragover');
      }
    });
    row.addEventListener('dragleave', () => row.classList.remove('dragover'));
    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      row.classList.remove('dragover');
      if (!src || src === row.dataset.id) return;
      const from = _ordEst.items.findIndex((x) => x._id === src),
        to = _ordEst.items.findIndex((x) => x._id === row.dataset.id);
      moverOrd(from, to);
    });
  });
}
// Distintivo «pertenece a una COLECCIÓN». Solo se pinta si la colección AGRUPA de verdad (más de un documento:
// `coleccion_n` solo llega del servidor en ese caso — una colección de uno no agrupa nada y sería ruido).
// Es clicable: lleva a la ficha de la colección, como el resto de enlaces del panel.
const badgeColeccion = (d) =>
  d.coleccion_n
    ? ` <span class="fmt" onclick="event.stopPropagation();verColeccion('${esc(d.coleccion)}')" style="background:rgba(27,163,255,.18);color:var(--acc2);cursor:pointer" title="Pertenece a la colección «${esc(d.coleccion_nombre || '')}» (${d.coleccion_n} documentos) — pulsa para verla">📚 ${d.coleccion_n}</span>`
    : '';
// Distintivos de admin: 🔞 NSFW (oculto a invitados) y 🔒 bloqueado (el Conformador no lo altera).
const badgesDoc = (d) =>
  `${badgeColeccion(d)}${d.nsfw ? ' <span class="fmt" style="background:rgba(255,92,122,.18);color:var(--bad)" title="NSFW: oculto a invitados">🔞</span>' : ''}${d.locked ? ' <span class="fmt" style="background:rgba(255,180,84,.18);color:var(--warn)" title="Bloqueado: el Conformador no lo altera">🔒</span>' : ''}${d.nfc && (d.nfc.fecha_vinculacion || d.nfc.uid) ? ' <span class="fmt" style="background:rgba(40,217,168,.18);color:var(--acc)" title="Tiene etiqueta NFC vinculada">📶</span>' : ''}`;
// Píldoras GRANDES y legibles de TIPO (libro/revista/cómic) + FORMATO(S) (papel/pdf/epub/mobi/cbr…) para la
// CABECERA de la ficha, donde el usuario quiere ver de un vistazo qué es y en qué soporte está.
// Icono y nombre del TIPO de documento (para badges/tarjetas/placeholders). El cómic (por `naturaleza`)
// manda sobre el tipo_recurso. Los tipos nuevos (artículo/apuntes) tienen su propio icono/nombre.
function tipoIcono(tr, esComic) { return esComic ? '📓' : ({ revista: '📰', articulo: '📃', apuntes: '🗒️', capitulo: '📑', software: '💿' }[tr] || '📕'); }
function tipoNombre(tr, esComic) { return esComic ? 'Cómic' : ({ revista: 'Revista', articulo: 'Artículo', apuntes: 'Apuntes', capitulo: 'Capítulo', software: 'Software' }[tr] || 'Libro'); }
function badgesTipoFormato(d) {
  const nat = String(d.naturaleza || '').toLowerCase();
  const esComic = ['comic', 'novela-grafica', 'tebeo', 'historieta', 'manga'].includes(nat);
  const chip = (txt, bg, col) => `<span style="display:inline-flex;align-items:center;gap:3px;font-size:12px;font-weight:700;padding:3px 11px;border-radius:999px;background:${bg};color:${col}">${txt}</span>`;
  const tipo = esComic
    ? chip('📓 Cómic', 'rgba(180,120,255,.20)', '#c79cff')
    : chip(`${tipoIcono(d.tipo_recurso)} ${tipoNombre(d.tipo_recurso)}`, 'rgba(120,160,255,.20)', '#9db8ff');
  // Iconos por formato: papel/audio/vídeo tienen el suyo; el resto (pdf/epub/mobi/cbz…) el genérico 💾.
  const ICONO_FMT = { papel: '📄', audio: '🔊', video: '🎬' };
  const fmts = (d.formatos || [])
    .map((f) => {
      const k = String(f).toLowerCase();
      return f === 'papel'
        ? chip('📄 Papel', 'rgba(200,160,90,.22)', '#d8b878')
        : chip(`${ICONO_FMT[k] || '💾'} ${esc(String(f).toUpperCase())}`, 'rgba(40,217,168,.18)', 'var(--acc)');
    })
    .join('');
  return `<div style="display:flex;gap:6px;justify-content:center;flex-wrap:wrap;margin-top:10px">${tipo}${fmts}</div>`;
}
// Etiqueta COMPACTA «tipo · formato» para las tarjetas/filas del Catálogo (p. ej. «📕 Libro · papel»,
// «📰 Revista · pdf»): el usuario quiere ver de un vistazo QUÉ es y en qué soporte, no solo el formato.
function tipoFmtCompacto(d) {
  const nat = String(d.naturaleza || '').toLowerCase();
  const esComic = ['comic', 'novela-grafica', 'tebeo', 'historieta', 'manga'].includes(nat);
  const ic = tipoIcono(d.tipo_recurso, esComic);
  const tipo = tipoNombre(d.tipo_recurso, esComic);
  const fmts = (d.formatos || []).slice(0, 2).map((f) => esc(String(f))).join('·');
  const pag = Number(d.paginas) > 0 ? ` · ${Number(d.paginas)}p` : ''; // nº de páginas (si se conoce)
  return `<span class="fmt" style="background:rgba(120,160,255,.16);color:#9db8ff">${ic} ${tipo}${fmts ? ' · ' + fmts : ''}${pag}</span>`;
}
// ¿La última página del catálogo vino colapsada por obras? La fija pintarResultados desde la respuesta.
let _catAgrupado = true;

function docCard(d) {
  const ph = tipoIcono(d.tipo_recurso);
  // OBRA MULTIVOLUMEN COLAPSADA: sus N tomos son UNA tarjeta, visualmente distinta (cubierta APILADA, la misma
  // que la Estantería) y con el nº de tomos. Abre la ficha de la OBRA —donde ya se listan los tomos— en vez de
  // la de un tomo suelto. Solo llega colapsada si agrupa de verdad (obra_n > 1): una obra de un tomo se pinta
  // como un documento normal.
  if (_catAgrupado && d.obra_n > 1) {
    const cov = stackCover(d.obra_portadas && d.obra_portadas.length ? d.obra_portadas : d.portada ? [d.portada] : [], ph);
    const titulo = d.obra_titulo || d.titulo || '(obra)';
    const sub = (d.autores && d.autores.length ? d.autores.slice(0, 2).join(', ') : '') || (d.año_edicion ? String(d.año_edicion) : '') || '—';
    // La COLECCIÓN es de jerarquía SUPERIOR a la obra (una colección puede contener obras; una obra no
    // contiene colecciones), así que la obra colapsada muestra su colección igual que un documento suelto:
    // `badgeColeccion` sobre el tomo representante — si la obra está en una colección, sus tomos lo están.
    return `<div class="vol obracard" data-obra="${esc(d.obra)}" onclick="verObra('${esc(d.obra)}')" style="cursor:pointer" title="Obra en ${d.obra_n} tomos — pulsa para ver la obra y sus tomos">
      <div class="cov">${cov}</div>
      <div class="meta">
        <div class="n">${esc(recortar(titulo, 64))} <span class="fmt" style="background:rgba(40,217,168,.18);color:var(--acc)">📚 ${d.obra_n} tomos</span>${badgeColeccion(d)}</div>
        <div class="t">${esc(sub)}</div>
      </div></div>`;
  }
  const cov = d.portada
    ? `<img src="${esc(encUrl(d.portada))}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=ph>${ph}</div>'">`
    : `<div class="ph">${ph}</div>`;
  const fmt = tipoFmtCompacto(d);
  const sub =
    (d.autores && d.autores.length ? d.autores.slice(0, 2).join(', ') : '') ||
    (d.año_edicion ? String(d.año_edicion) : '') ||
    d.isbn ||
    '—';
  const nfcTag = nfcBadge(d);
  // TOMO de una obra mayor (modo expandido): fondo más claro para distinguirlo de un libro de un solo volumen,
  // tanto en gris como en burdeos (selección). La marca «📚 N» dice de cuántos tomos es y abre la obra.
  const esVol = d.obra_n > 1 ? ' esvol' : '';
  const volTag = d.obra_n > 1
    ? ` <span class="fmt" onclick="event.stopPropagation();verObra('${esc(d.obra)}')" style="background:rgba(40,217,168,.18);color:var(--acc);cursor:pointer" title="Tomo de «${esc(d.obra_titulo || '')}» (${d.obra_n} tomos) — pulsa para ver la obra">📚 ${d.obra_n}</span>`
    : '';
  return `<div class="vol${esVol}${selDocs.has(d._id) ? ' sel' : ''}" data-doc="${esc(d._id)}"><span class="selmark">✓</span><div class="cov">${cov}${nfcTag}${posBadge(d)}</div><div class="meta"><div class="n">${esc(recortar(d.titulo || '(sin título)', 64))} ${fmt}${volTag}${badgesDoc(d)}</div><div class="t">${esc(sub)}</div><div style="margin-top:5px">${ratingBar('documentos', d._id, d.valoracion, d.nsfw)}</div></div></div>`;
}
// Vista DETALLES: una FILA por documento, solo texto (título · autor · año · identificador · CDU + formatos).
// Comparte data-doc, .selmark y .sel con la vista iconos (misma mecánica de selección).
function docRow(d) {
  const partes = [
    d.autores && d.autores.length ? d.autores.slice(0, 3).join(', ') : '',
    d.año_edicion ? String(d.año_edicion) : '',
    d.isbn || d.issn || '',
    d.cdu ? 'CDU ' + d.cdu : '',
  ].filter(Boolean);
  // Obra colapsada: también en Detalles (consistencia de patrones) — una fila por OBRA, no por tomo.
  if (_catAgrupado && d.obra_n > 1) {
    return `<div class="drow" data-obra="${esc(d.obra)}" onclick="verObra('${esc(d.obra)}')" style="cursor:pointer" title="Obra en ${d.obra_n} tomos — pulsa para ver la obra y sus tomos"><span class="dtit">${esc(recortar(d.obra_titulo || d.titulo || '(obra)', 90))} <span class="fmt" style="background:rgba(40,217,168,.18);color:var(--acc)">📚 ${d.obra_n} tomos</span>${badgeColeccion(d)}</span><span class="dmeta">${esc(partes.join(' · '))}</span><span class="dfmt">${tipoFmtCompacto(d)}</span></div>`;
  }
  const fmt = tipoFmtCompacto(d);
  const esVol = d.obra_n > 1 ? ' esvol' : '';   // tomo de una obra mayor (expandido) → fondo más claro
  const volTag = d.obra_n > 1 ? ` <span class="fmt" style="background:rgba(40,217,168,.18);color:var(--acc)" title="Tomo de «${esc(d.obra_titulo || '')}» (${d.obra_n} tomos)">📚 ${d.obra_n}</span>` : '';
  return `<div class="drow${esVol}${selDocs.has(d._id) ? ' sel' : ''}" data-doc="${esc(d._id)}"><span class="selmark">✓</span><span class="dtit">${esc(recortar(d.titulo || '(sin título)', 90))}${volTag}${badgesDoc(d)}</span><span class="dmeta">${esc(partes.join(' · '))}</span><span class="dfmt">${fmt}</span></div>`;
}
// Nº de POSICIÓN física en la estantería — solo al ver UNA estantería (ayuda a localizar el libro / inventario).
function posBadge(d) {
  const ex = estadoBusqueda.extra;
  if (!(ex && ex.ambito && ex.estanteria) || !Number.isFinite(d.orden_estanteria)) return '';
  return `<span class="posbadge" title="Posición física en la estantería">#${d.orden_estanteria + 1}</span>`;
}
function pintarBusqueda(r) {
  paginaIds = r.docs.map((d) => d._id); // ids de la página actual (para «seleccionar todos»)
  // ¿La página vino COLAPSADA por obras? Lo decide el servidor (es quien agrupa); las tarjetas lo consultan:
  // colapsado → tarjeta única de obra · expandido → tomo normal TEÑIDO (pertenece a una obra mayor).
  _catAgrupado = r.agrupado !== false;
  $('#searchCount').textContent = `${r.total.toLocaleString('es-ES')} ${_catAgrupado ? 'resultado' : 'documento'}${r.total === 1 ? '' : 's'}`;
  $('#searchResults').dataset.solo = soloSeleccion ? '1' : ''; // marca si la vista está restringida a la selección
  // Vista según el modo elegido: iconos (rejilla de portadas) o detalles (filas de texto).
  const cuerpo =
    vistaCatalogo === 'detalles'
      ? `<div class="dlist">${r.docs.map(docRow).join('')}</div>`
      : `<div class="vol-grid">${r.docs.map(docCard).join('')}</div>`;
  $('#searchResults').innerHTML = r.docs.length ? cuerpo : '<div class="empty">Sin resultados</div>';
  // Interacción unificada: clic/toque = abrir ficha (o marcar si estamos en Modo selección); doble clic /
  // pulsación larga = conmutar el Modo selección (conservando la selección).
  $$('#searchResults [data-doc]').forEach((el) =>
    attachGesto(
      el,
      () => {
        if (modoSeleccion && ROL === 'admin') toggleSel(el.dataset.doc);
        else verDoc(el.dataset.doc, { volver: 'search', etiqueta: 'Catálogo', catalogo: true });
      },
      () => {
        // Doble clic / pulsación larga: conmuta el modo y, si ENTRAMOS en selección, deja YA marcada
        // esta tarjeta (el gesto nació sobre ella).
        if (ROL !== 'admin') return;
        const entrando = !modoSeleccion;
        alternarModoSel();
        if (entrando && modoSeleccion) toggleSel(el.dataset.doc, true);
      },
    ),
  );
  aplicarModoSelUI();
  attachRating('#searchResults');
  renderBulk();
  const p = r.page,
    tp = r.paginas;
  // Paginación ARRIBA y ABAJO de los thumbnails (primera/anterior/salto/siguiente/última). Al cambiar de
  // página, desliza hasta el primer resultado.
  const pagerHtml = pagerControles(p, tp);
  $('#searchPager').innerHTML = pagerHtml;
  if ($('#searchPagerTop')) $('#searchPagerTop').innerHTML = pagerHtml;
  const irA = async (np) => {
    await buscarCatalogo(np);
    const sb = $('#searchBulk');
    const a = sb && sb.textContent.trim() ? sb : $('#searchPagerTop') || $('#searchResults');
    if (a) a.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }; // muestra la barra «seleccionar todos» (y la nav fija)
  ['#searchPagerTop', '#searchPager'].forEach((sel) => wirePager($(sel), p, tp, irA));
}

// ── logs ──
function pintarLogs(lineas) {
  const v = $('#logView');
  const cerca = v.scrollTop + v.clientHeight >= v.scrollHeight - 50;
  v.innerHTML = lineas
    .map((l) => {
      const c = /❌|⛔|🚫|error|falló|inalcanzable/i.test(l)
        ? 'e'
        : /⚠/i.test(l)
          ? 'w'
          : /✅|🎛|👁|🧹|📥|♻/i.test(l)
            ? 'k'
            : '';
      return `<div class="${c}">${esc(l)}</div>`;
    })
    .join('');
  if (cerca) v.scrollTop = v.scrollHeight;
}
async function loadLogs() {
  try {
    const [g, info] = await Promise.all([api('/logs?n=500'), api('/logs/info')]);
    pintarLogs(g.lineas);
    $('#logInfo').textContent = `${fmtBytes(info.bytes)} en disco · ${info.lineas_buffer} líneas en vivo`;
    if ($('#logVerbose') && typeof info.verbose === 'boolean' && document.activeElement !== $('#logVerbose'))
      $('#logVerbose').checked = info.verbose;
  } catch (e) {}
}
function logAuto() {
  if (logTimer) {
    clearInterval(logTimer);
    logTimer = null;
  }
  loadLogs();
  if ($('#logAuto').checked) logTimer = setInterval(loadLogs, 4000);
}
$('#logAuto').onchange = logAuto;
if ($('#logVerbose'))
  $('#logVerbose').onchange = async () => {
    try {
      const r = await api('/logs/verbose', {
        method: 'POST',
        body: JSON.stringify({ verbose: $('#logVerbose').checked }),
      });
      toast(r.verbose ? 'Log detallado (verboso)' : 'Log simple');
      loadLogs();
    } catch (e) {
      toast(e.message, 'bad');
    }
  };
async function purgaLog(body, msg) {
  try {
    await api('/logs/purgar', { method: 'POST', body: JSON.stringify(body) });
    toast(msg);
    loadLogs();
  } catch (e) {
    toast(e.message, 'bad');
  }
}
$('#logPurge7').onclick = () => purgaLog({ dias: 7 }, 'Logs: conservados los últimos 7 días');
$('#logPurge30').onclick = () => purgaLog({ dias: 30 }, 'Logs: conservados los últimos 30 días');
$('#logClear').onclick = () => {
  if (confirm('¿Vaciar TODO el log?')) purgaLog({ todo: true }, 'Log vaciado');
};

// ── integridad ──
function loadInteg() {
  $('#integDiag').onclick = () => correrIntegridad(false);
  if ($('#integFix')) $('#integFix').onclick = () => correrIntegridad(true);
  if ($('#sanDiag')) {
    $('#sanDiag').onclick = sanearDiag;
    $('#sanRun').onclick = sanearRun;
  }
  if ($('#visRefresh')) {
    $('#visRefresh').onclick = loadVision;
    loadVision();
  }
  if ($('#reindexBtn')) {
    $('#reindexBtn').onclick = reindexar;
    loadIndice();
  }
  if ($('#campRefresh') && ROL === 'admin') {
    $('#campRefresh').onclick = loadCampanas;
    loadCampanas();
  }
  if ($('#guestNsfw')) {
    loadGuestNsfw();
    $('#guestNsfw').onchange = async () => {
      const cb = $('#guestNsfw');
      try {
        const r = await api('/ajustes/guest-nsfw', {
          method: 'POST',
          body: JSON.stringify({ enabled: cb.checked }),
        });
        toast(r.enabled ? 'Invitados: NSFW permitido' : 'Invitados: NSFW restringido');
      } catch (e) {
        toast(e.message, 'bad');
        cb.checked = !cb.checked;
      }
    };
  }
}
async function loadGuestNsfw() {
  try {
    const r = await api('/ajustes/guest-nsfw');
    if ($('#guestNsfw')) $('#guestNsfw').checked = !!r.enabled;
  } catch (e) {}
}

// ── Campañas de fondo (backfill autorreparable al reposo): estado + ajuste (activa/lote/cada-N-min) + «Ahora» ──
// Coste de cada campaña: 🆓 sin IA · 🌐 APIs gratis (con límite de llamadas) · 🤖 IA de pago.
const CAMP_BADGE = { gratis: '🆓', apis: '🌐', ia: '🤖' };
const CAMP_BADGE_TIT = {
  gratis: 'Sin IA (local / Fichero)',
  apis: 'APIs gratuitas, pero con LÍMITE de llamadas',
  ia: 'Consume IA de pago (Gemini)',
};
// Barra/estado de la tanda de una campaña (en curso o la última terminada).
function barraCampana(c) {
  const p = c.progreso;
  if (!p) return '';
  const obj = p.objetivo || 0;
  const pct = obj ? Math.min(100, Math.round((100 * p.procesados) / obj)) : p.enCurso ? 100 : 0;
  if (p.enCurso) {
    return `<div style="margin-top:8px">
      <div class="campbar"><div class="campbar-fill" style="width:${pct}%"></div></div>
      <span class="muted" style="font-size:11px">⏳ En curso… ${p.procesados}/${obj || '?'} · ${p.cambios} con datos</span>
    </div>`;
  }
  return `<div class="muted" style="font-size:11px;margin-top:6px">Última tanda: ${p.procesados} procesados · ${p.cambios} con datos</div>`;
}
let campTimer = null; // auto-refresco mientras alguna campaña esté en curso
async function loadCampanas(silencioso) {
  const cont = $('#campanasBody');
  if (!cont) return;
  if (!silencioso && !cont.querySelector('.camprow')) cont.innerHTML = '<span class="muted" style="font-size:12px">Cargando…</span>';
  let r;
  try {
    r = await api('/campanas');
  } catch (e) {
    cont.innerHTML = `<span class="muted" style="font-size:12px">${esc(e.message)}</span>`;
    return;
  }
  const drenaje = r.drenaje || {}; // { id, etiqueta } de un backfill completo en curso (o vacío)
  cont.innerHTML = (r.campanas || [])
    .map((c) => {
      const drenando = drenaje.id === c.id;
      // Botón «Completar» (vaciar la campaña) o «Detener» si esta campaña se está drenando.
      const btnCompletar = drenando
        ? `<button class="btn bad campParar" style="padding:3px 9px;font-size:12px">⏹ Detener</button>`
        : `<button class="btn campFull" style="padding:3px 9px;font-size:12px" title="Vacía la campaña ENTERA: encadena tandas hasta 0 (en 2º plano, cediendo a la ingesta)"${drenaje.id ? ' disabled' : ''}>⏩ Completar</button>`;
      return `<div class="camprow" data-id="${esc(c.id)}" style="border-top:1px solid var(--line);padding:10px 0">
        <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
          <div style="flex:1;min-width:180px">
            <div style="font-weight:600"><span title="${CAMP_BADGE_TIT[c.coste] || ''}">${CAMP_BADGE[c.coste] || ''}</span> ${esc(c.etiqueta)}${drenando ? ' <span class="tag warn" style="font-size:10px">backfill…</span>' : ''}</div>
            <div class="muted" style="font-size:11px;line-height:1.3;margin-top:2px">${esc(c.descripcion)}</div>
          </div>
          <label class="switch" style="flex:0 0 auto"><input type="checkbox" class="campActiva" ${c.activa ? 'checked' : ''}><span class="slider"></span></label>
        </div>
        <div class="row" style="gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap">
          <span class="muted" style="font-size:12px">Pendientes: <b class="campPend">${c.pendientes == null ? '—' : c.pendientes}</b></span>
          <label style="font-size:12px">Lote <input class="campLote" type="number" min="1" value="${c.lote}" style="width:66px"></label>
          <label style="font-size:12px">cada <input class="campCada" type="number" min="1" value="${c.cadenciaMin}" style="width:56px"> min</label>
          <button class="btn campGuardar" style="padding:3px 9px;font-size:12px">Guardar</button>
          <button class="btn campRun" style="padding:3px 9px;font-size:12px" title="Lanza una tanda ahora (en segundo plano)"${drenaje.id ? ' disabled' : ''}>▶ Ahora</button>
          ${btnCompletar}
        </div>
        ${barraCampana(c)}
      </div>`;
    })
    .join('');
  // Refresca solo cada 2 s mientras haya una tanda en curso o un backfill completo activo.
  const corriendo = (r.campanas || []).some((c) => c.progreso && c.progreso.enCurso) || !!drenaje.id;
  clearTimeout(campTimer);
  if (corriendo) campTimer = setTimeout(() => loadCampanas(true), 2000);
  // Cablear cada fila: el interruptor guarda al instante; «Guardar» persiste lote/cadencia; «Ahora» lanza una tanda.
  cont.querySelectorAll('.camprow').forEach((row) => {
    const id = row.dataset.id;
    const leer = () => ({
      activa: row.querySelector('.campActiva').checked,
      lote: +row.querySelector('.campLote').value,
      cadenciaMin: +row.querySelector('.campCada').value,
    });
    const guardar = async (silencioso) => {
      try {
        await api('/campanas/' + encodeURIComponent(id), { method: 'POST', body: JSON.stringify(leer()) });
        if (!silencioso) toast('✔ Campaña guardada');
      } catch (e) {
        toast(e.message, 'bad');
      }
    };
    row.querySelector('.campActiva').onchange = () => guardar(true);
    row.querySelector('.campGuardar').onclick = () => guardar(false);
    row.querySelector('.campRun').onclick = async () => {
      await guardar(true); // asegura que lote/cadencia estén persistidos antes de lanzar
      try {
        const r2 = await api('/campanas/' + encodeURIComponent(id) + '/ejecutar', { method: 'POST', body: JSON.stringify({}) });
        toast(r2.mensaje || 'Campaña lanzada', r2.ok === false ? 'warn' : 'ok');
      } catch (e) {
        toast(e.message, 'bad');
        return;
      }
      setTimeout(() => loadCampanas(true), 800); // aparece la barra de progreso enseguida
    };
    // «⏩ Completar»: vacía la campaña entera (backfill completo) en segundo plano.
    const full = row.querySelector('.campFull');
    if (full)
      full.onclick = async () => {
        await guardar(true); // fija lote antes de drenar
        try {
          const r2 = await api('/campanas/' + encodeURIComponent(id) + '/completar', { method: 'POST', body: JSON.stringify({}) });
          toast(r2.mensaje || 'Backfill en marcha');
        } catch (e) {
          toast(e.message, 'bad');
          return;
        }
        setTimeout(() => loadCampanas(true), 800);
      };
    // «⏹ Detener»: detiene el backfill completo en curso.
    const parar = row.querySelector('.campParar');
    if (parar)
      parar.onclick = async () => {
        try {
          const r2 = await api('/campanas/completar/detener', { method: 'POST', body: JSON.stringify({}) });
          toast(r2.mensaje || 'Deteniendo…', 'warn');
        } catch (e) {
          toast(e.message, 'bad');
        }
        setTimeout(() => loadCampanas(true), 800);
      };
  });
}
// ── Búsqueda: índice FTS local (estado + reindexar en 2º plano con progreso) ──
let reindexTimer = null;
async function loadIndice() {
  const el = $('#indiceEstado');
  if (!el) return;
  try {
    const r = await api('/busqueda/estado');
    const i = r.indice || {},
      t = r.trabajo || {};
    if (t.en_curso) {
      const p = t.progreso || {};
      el.innerHTML = `<span class="tag warn">reindexando</span> ${p.hechos || 0}/${p.total || '?'}`;
      if (!reindexTimer) reindexTimer = setInterval(loadIndice, 1200);
      return;
    }
    if (reindexTimer) {
      clearInterval(reindexTimer);
      reindexTimer = null;
    }
    if (t.error) {
      el.innerHTML = `<span class="tag bad">error</span> ${esc(t.error)}`;
      return;
    }
    el.innerHTML = i.disponible
      ? `<span class="tag ok">activo</span> ${i.total} documento(s) indexados`
      : '<span class="tag warn">sin índice</span> · búsqueda por Mongo — pulsa Reindexar';
  } catch (e) {
    el.innerHTML = '';
  }
}
async function reindexar() {
  const b = $('#reindexBtn');
  if (!b) return;
  b.disabled = true;
  try {
    const r = await api('/busqueda/reindexar', { method: 'POST', body: JSON.stringify({}) });
    if (!r.ok) {
      toast(r.motivo || 'no se pudo reindexar', 'bad');
      b.disabled = false;
      return;
    }
    toast('Reindexando…');
    loadIndice();
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    setTimeout(() => {
      b.disabled = false;
    }, 800);
  }
}
async function loadVision() {
  const el = $('#visOut');
  if (!el) return;
  el.innerHTML = '<div class="muted">Cargando…</div>';
  try {
    const r = await api('/vision/proveedores');
    const ps = r.proveedores || [];
    if (!ps.length) {
      el.innerHTML =
        '<div class="muted">Sin claves de visión en .env. Añade p. ej. GROQ_API_KEY_1=… y reinicia.</div>';
      return;
    }
    el.innerHTML = `<table><tr><th>Proveedor</th><th>Clave</th><th>Estado</th><th></th></tr>${ps
      .map(
        (p) => `<tr data-id="${esc(p.id)}">
      <td>${esc(p.etiqueta)} <span class="tag ${p.tier === 'free' ? 'ok' : 'warn'}">${esc(p.tier)}</span><br><span class="muted mono" style="font-size:10px">${esc(p.id)} · ${esc(p.modelo)}</span></td>
      <td class="mono muted">${esc(p.masked)}</td>
      <td style="font-size:12px">${p.ultimoOk ? '<span class="tag ok">último OK</span> ' : ''}${p.cooldown ? '<span class="tag bad">cooldown</span> ' : ''}${p.errores ? `<span class="muted">${p.errores} err</span>` : ''}${p.ultimoError ? `<br><span class="muted" style="font-size:10px">${esc(String(p.ultimoError).slice(0, 90))}</span>` : ''}</td>
      <td style="text-align:right;white-space:nowrap"><button class="btn vprobar" data-id="${esc(p.id)}">Probar</button> <label class="switch" style="vertical-align:middle;margin-left:6px"><input type="checkbox" class="vena" data-id="${esc(p.id)}" ${p.enabled ? 'checked' : ''}><span class="slider"></span></label></td></tr>`,
      )
      .join('')}</table>`;
    $$('#visOut .vena').forEach(
      (cb) =>
        (cb.onchange = async () => {
          try {
            await api('/vision/proveedor', {
              method: 'POST',
              body: JSON.stringify({ id: cb.dataset.id, enabled: cb.checked }),
            });
            toast(cb.checked ? 'Activado' : 'Desactivado');
          } catch (e) {
            toast(e.message, 'bad');
            cb.checked = !cb.checked;
          }
        }),
    );
    $$('#visOut .vprobar').forEach(
      (b) =>
        (b.onclick = async () => {
          b.disabled = true;
          const t = b.textContent;
          b.textContent = '…';
          try {
            const r = await api('/vision/probar', {
              method: 'POST',
              body: JSON.stringify({ id: b.dataset.id }),
            });
            toast(r.ok ? `✓ OK (${r.ms} ms)` : `✗ ${r.motivo}`, r.ok ? 'ok' : 'bad');
            loadVision();
          } catch (e) {
            toast(e.message, 'bad');
            b.disabled = false;
            b.textContent = t;
          }
        }),
    );
  } catch (e) {
    el.innerHTML = '';
    toast(e.message, 'bad');
  }
}
// ── Sanear catálogo (re-home #, portadas, re-clasificar) ──
function sanResumen(inf) {
  const d = inf.diagnostico || {},
    h = inf.hecho;
  const fila = (lab, v) =>
    `<tr><td>${esc(lab)}</td><td style="text-align:right"><b ${(typeof v === 'number' ? v > 0 : true) ? 'style="color:var(--warn)"' : ''}>${v}</b></td></tr>`;
  let html = `<table><tr><th>Tarea</th><th style="text-align:right">${h ? 'hecho / candidatos' : 'candidatos'}</th></tr>
    ${fila('Re-alojar carpeta (#/%)', h ? `${h.rehome} / ${d.rehome}` : d.rehome || 0)}
    ${fila('Recuperar portada', h ? `${h.portada} / ${d.portada}` : d.portada || 0)}
    ${fila('Re-clasificar (cómic↔obra)', h ? `${h.reclasificar} / ${d.reclasificar}` : d.reclasificar || 0)}
    ${h && h.errores ? fila('Errores', h.errores) : ''}</table>${inf.reclasificar ? '' : '<div class="muted" style="font-size:11px;margin-top:4px">La re-clasificación solo corre con la opción «incluir re-clasificación» marcada.</div>'}`;
  const m = inf.muestras || {};
  for (const [k, lab] of [
    ['rehome', 'Carpetas a re-alojar'],
    ['portada', 'Portadas a recuperar'],
    ['reclasificar', 'Cómics mal archivados'],
  ]) {
    if (m[k]?.length)
      html += `<details style="margin-top:8px"><summary class="muted" style="cursor:pointer;font-size:12px">${lab} (${m[k].length}${m[k].length >= 12 ? '+' : ''})</summary>${m[k].map((x) => `<div class="mono" style="font-size:11px"><a class="rowlink" data-doc="${esc(x.id)}">${esc(x.titulo || x.id)}</a>${x.ruta ? ' → ' + esc(x.ruta) : ''}</div>`).join('')}</details>`;
  }
  return html;
}
function sanWire() {
  $$('#sanOut [data-doc]').forEach(
    (a) => (a.onclick = () => verDoc(a.dataset.doc, { volver: 'activity', etiqueta: 'Sanear' })),
  );
}
async function sanearDiag() {
  const b = $('#sanDiag');
  b.disabled = true;
  $('#sanOut').innerHTML = '<div class="muted">Diagnosticando…</div>';
  try {
    const r = await api('/sanear', { method: 'POST', body: '{}' });
    $('#sanOut').innerHTML = sanResumen(r);
    sanWire();
  } catch (e) {
    $('#sanOut').innerHTML = '';
    toast(e.message, 'bad');
  } finally {
    b.disabled = false;
  }
}
let sanTimer = null;
async function sanearRun() {
  const reclas = $('#sanReclas').checked;
  if (
    !confirm(
      'Sanear el catálogo' +
        (reclas ? ' (incluye re-clasificación con IA, más lenta)' : '') +
        '. Lo retirado va a la Papelera (recuperable). ¿Seguir?',
    )
  )
    return;
  $('#sanRun').disabled = true;
  $('#sanDiag').disabled = true;
  try {
    const r = await api('/sanear/ejecutar', {
      method: 'POST',
      body: JSON.stringify({ reclasificar: reclas }),
    });
    if (!r.ok) {
      toast(r.motivo, 'warn');
      $('#sanRun').disabled = false;
      $('#sanDiag').disabled = false;
      return;
    }
    if (sanTimer) clearInterval(sanTimer);
    sanTimer = setInterval(async () => {
      try {
        const s = await api('/sanear/estado');
        if (s.en_curso)
          $('#sanOut').innerHTML = `<div class="muted">Saneando… ${s.hechos}/${s.total || '?'}</div>`;
        else {
          clearInterval(sanTimer);
          sanTimer = null;
          $('#sanRun').disabled = false;
          $('#sanDiag').disabled = false;
          if (s.error) toast('Saneo: ' + s.error, 'bad');
          else if (s.informe) {
            $('#sanOut').innerHTML = sanResumen(s.informe);
            sanWire();
            toast('Saneo terminado');
          }
        }
      } catch (e) {}
    }, 1500);
  } catch (e) {
    toast(e.message, 'bad');
    $('#sanRun').disabled = false;
    $('#sanDiag').disabled = false;
  }
}
// Página "Actividad": vigilante + conformador + mantenimiento + integridad + logs (al final).
function loadActivity() {
  refrescarEstado();
  loadInteg();
  logAuto();
  aplicarPliegueActividad();
}
// Pliegue de las fichas de Actividad: data-fold="open" siempre desplegada; data-fold="pc" desplegada en
// PC y colapsada en móvil. Se recuerda la última preferencia por ficha (localStorage).
function aplicarPliegueActividad() {
  const pc = matchMedia('(min-width:860px)').matches;
  $$('#p-activity details.foldcard[data-fold]').forEach((d) => {
    const id = d.id,
      sav = id ? localStorage.getItem('fold_' + id) : null;
    d.open =
      sav !== null ? sav === '1' : d.dataset.fold === 'open' ? true : d.dataset.fold === 'pc' ? pc : false;
    if (id && !d._foldWired) {
      d._foldWired = 1;
      d.addEventListener('toggle', () => localStorage.setItem('fold_' + id, d.open ? '1' : '0'));
    }
  });
}
const INTEG_FASES = {
  cargando: 'Cargando documentos…',
  'docs-sin-carpeta': 'Comprobando carpetas',
  'docs-sin-fichero': 'Comprobando ficheros',
  'recorrido-arbol': 'Recorriendo el árbol CDU',
  'duplicados-hash': 'Buscando duplicados por hash',
  cuarentena: 'Revisando Cuarentena',
  reparando: 'Reparando (a la Papelera)…',
  hecho: 'Terminado',
};
let integTimer = null;
async function correrIntegridad(reparar) {
  if (
    reparar &&
    !confirm(
      'Reparará la integridad: poda ramas vacías, deduplica por hash, resuelve Cuarentena/duplicados y ajusta ruta_base. Todo lo retirado va a la Papelera. ¿Seguir?',
    )
  )
    return;
  const dB = $('#integDiag'),
    fB = $('#integFix');
  dB.disabled = true;
  if (fB) fB.disabled = true;
  $('#integOut').innerHTML = '<div class="card"><div class="muted">Iniciando…</div></div>';
  try {
    const r = await api('/integridad', { method: 'POST', body: JSON.stringify({ reparar }) });
    if (!r.ok) {
      toast(r.motivo || 'no se pudo iniciar', 'warn');
      dB.disabled = false;
      if (fB) fB.disabled = false;
      return;
    }
    if (integTimer) clearInterval(integTimer);
    integTimer = setInterval(async () => {
      try {
        const s = await api('/integridad/estado');
        if (s.en_curso) {
          const p = s.progreso || {};
          const det = p.total ? ` (${p.i || 0}/${p.total})` : p.carpetas ? ` (${p.carpetas} carpetas)` : '';
          $('#integOut').innerHTML =
            `<div class="card"><div class="muted">⏳ ${esc(INTEG_FASES[s.fase] || s.fase || 'Procesando')}${det}…</div></div>`;
        } else {
          clearInterval(integTimer);
          integTimer = null;
          dB.disabled = false;
          if (fB) fB.disabled = false;
          if (s.error) {
            $('#integOut').innerHTML = '';
            toast('Integridad: ' + s.error, 'bad');
          } else if (s.informe) {
            pintarInteg(s.informe);
            toast(reparar ? 'Integridad: diagnóstico + reparación' : 'Integridad: diagnóstico completado');
          }
        }
      } catch (e) {}
    }, 1500);
  } catch (e) {
    $('#integOut').innerHTML = '';
    toast(e.message, 'bad');
    dB.disabled = false;
    if (fB) fB.disabled = false;
  }
}
// ¿qué fila se AUTO-repara con el botón? (las demás son solo diagnóstico → acción manual en la ficha)
const INTEG_AUTOREPARA = new Set([
  'ramasMuertas',
  'carpetasHuerfanas',
  'rutaBaseDesajustada',
  'hashDuplicadosGrupos',
  'hashDuplicadosDocs',
  'cuarentenaDuplicados',
]);
function pintarInteg(r) {
  const d = r.diagnostico || {},
    m = r.muestras || {};
  const et = {
    docsSinCarpeta: 'Docs sin carpeta',
    docsSinFicheroOriginal: 'Docs sin fichero original',
    docsConAudiosRotos: 'Audiolibros con pistas que faltan',
    rutaBaseCompartida: 'Varios docs en la misma carpeta',
    ramasMuertas: 'Ramas vacías / muertas',
    registroSinDocumento: 'Registro sin documento',
    carpetasHuerfanas: 'Carpetas huérfanas',
    rutaBaseDesajustada: 'ruta_base desajustada',
    hashDuplicadosGrupos: 'Duplicados por hash (grupos)',
    hashDuplicadosDocs: 'Duplicados por hash (sobrantes)',
    cuarentenaDuplicados: 'Cuarentena/duplicados',
  };
  // clave de muestras por fila (las dos de hash comparten muestra)
  const mDe = {
    docsSinCarpeta: 'docsSinCarpeta',
    docsSinFicheroOriginal: 'docsSinFicheroOriginal',
    docsConAudiosRotos: 'docsConAudiosRotos',
    rutaBaseCompartida: 'rutaBaseCompartida',
    ramasMuertas: 'ramasMuertas',
    registroSinDocumento: 'registroSinDocumento',
    carpetasHuerfanas: 'carpetasHuerfanas',
    rutaBaseDesajustada: 'rutaBaseDesajustada',
    hashDuplicadosGrupos: 'hashDuplicados',
    hashDuplicadosDocs: 'hashDuplicados',
    cuarentenaDuplicados: 'cuarentenaDuplicados',
  };
  const fila = (k) => {
    const v = d[k] ?? 0,
      mk = mDe[k],
      tiene = v > 0 && m[mk] && m[mk].length;
    const sello =
      v > 0
        ? INTEG_AUTOREPARA.has(k)
          ? '<span class="tag ok" title="Se arregla con «Diagnosticar y reparar»">auto</span>'
          : '<span class="tag warn" title="Acción manual: abre la ficha y usa Reprocesar/Eliminar">manual</span>'
        : '';
    return `<tr ${tiene ? `class="integrow" data-k="${esc(mk)}" title="Ver qué documentos"` : ''}><td>${esc(et[k])}${tiene ? ' <span class="muted">▸</span>' : ''}</td><td style="text-align:center">${sello}</td><td style="text-align:right"><b ${v > 0 ? 'style="color:var(--warn)"' : ''}>${v}</b></td></tr>`;
  };
  // El .txt lo sirve un endpoint solo-admin (es un volcado de la estructura entera del archivo), así que a un
  // invitado ni se le enseña el botón: nada de ofrecer algo que va a devolver un 403.
  const btnTxt =
    ROL === 'admin'
      ? `<button class="btn" id="integTxt" title="Descargar el informe COMPLETO en .txt (todos los casos, no solo la muestra)" style="padding:4px 10px;font-size:12px">⬇ Informe (.txt)</button>`
      : '';
  let h = `<div class="card" style="margin-bottom:14px">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
      <h3 style="margin:0">Diagnóstico · ${esc(new Date(r.ts).toLocaleString('es-ES'))} · ${r.totalDocs} docs</h3>${btnTxt}
    </div>
    <table style="margin-top:10px">${Object.keys(et).map(fila).join('')}</table>
    <div class="muted" style="font-size:11px;margin-top:8px"><span class="tag ok">auto</span> lo arregla el botón «Reparar» · <span class="tag warn">manual</span> requiere abrir la ficha (Reprocesar/Eliminar). Pincha una fila para ver qué documentos.</div>
    <div id="integDetalle" style="margin-top:12px"></div></div>`;
  if (r.reparado) {
    const rp = r.reparado,
      er = {
        ramasPodadas: 'Ramas podadas',
        rutasReparadas: 'ruta_base reparadas',
        carpetasHuerfanasRecicladas: 'Huérfanas recicladas',
        hashDuplicadosEliminados: 'Hash-duplicados eliminados',
        cuarentenaResueltos: 'Cuarentena resueltos',
      };
    h +=
      `<div class="card" style="margin-bottom:14px"><h3>🛠 Reparado (a la Papelera)</h3><table>` +
      Object.keys(er)
        .map((k) => `<tr><td>${esc(er[k])}</td><td style="text-align:right"><b>${rp[k] ?? 0}</b></td></tr>`)
        .join('') +
      '</table></div>';
  }
  $('#integOut').innerHTML = h;
  $$('#integOut tr.integrow').forEach((tr) => (tr.onclick = () => drillInteg(tr.dataset.k, m)));
  if ($('#integTxt')) $('#integTxt').onclick = () => descargarInformeInteg();
}
// Descarga el informe DETALLADO (.txt) del diagnóstico que YA se ha corrido: el servidor lo rinde de memoria,
// no lo repite. Va por fetch con el token en la CABECERA (no en la URL: acabaría en el historial) y se entrega
// como blob, el mismo patrón que las páginas del visor de cómic.
async function descargarInformeInteg() {
  const b = $('#integTxt');
  if (b) b.disabled = true;
  try {
    const res = await fetch('/api/integridad/informe.txt', {
      headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},
    });
    if (!res.ok) throw new Error((await res.text()) || 'no se pudo generar el informe');
    // El nombre lo pone el servidor (lleva la fecha del diagnóstico); si no llega, uno razonable.
    const cd = res.headers.get('Content-Disposition') || '';
    const nombre = (cd.match(/filename="([^"]+)"/) || [])[1] || 'integridad.txt';
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = nombre;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast('Informe descargado: ' + nombre);
  } catch (e) {
    toast(e.message, 'bad');
  } finally {
    if (b) b.disabled = false;
  }
}
// Detalle drillable de una fila del diagnóstico: lista los documentos/carpetas afectados (docs → ficha).
function drillInteg(mk, m) {
  const el = $('#integDetalle');
  if (!el) return;
  const arr = m[mk] || [];
  if (!arr.length) {
    el.innerHTML = '';
    return;
  }
  const dl = (x) =>
    `<a class="rowlink" data-doc="${esc(x.id)}">${esc(x.titulo || x.id)}</a>${x.archivo ? ` <span class="muted mono">(${esc(x.archivo)})</span>` : ''}${x.isbn ? ` <span class="muted mono">ISBN ${esc(x.isbn)}</span>` : ''}`;
  let h = '';
  if (mk === 'hashDuplicados')
    h = arr.map((g) => `<div class="intgrp">${g.docs.map(dl).join(' · ')}</div>`).join('');
  else if (mk === 'rutaBaseCompartida')
    h = arr
      .map(
        (g) =>
          `<div class="intgrp"><span class="mono">${esc(g.ruta || '')}</span><br>${g.docs.map(dl).join('<br>')}</div>`,
      )
      .join('');
  else if (mk === 'rutaBaseDesajustada')
    h = arr
      .map(
        (x) =>
          `<div class="intgrp">${dl(x)}<br><span class="muted">disco</span> <span class="mono">${esc(x.enDisco || '')}</span></div>`,
      )
      .join('');
  else if (mk === 'docsSinCarpeta' || mk === 'docsSinFicheroOriginal')
    h = arr
      .map(
        (x) =>
          `<div class="intgrp">${dl(x)}${x.ruta ? ` → <span class="mono">${esc(x.ruta)}</span>` : ''}</div>`,
      )
      .join('');
  else
    h = arr
      .map((x) => `<div class="intgrp mono">${esc(typeof x === 'string' ? x : JSON.stringify(x))}</div>`)
      .join('');
  el.innerHTML = `<div class="card" style="background:var(--card2);margin:0"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><b>Detalle (${arr.length})</b><button class="btn" id="intX">✕</button></div><div style="margin-top:8px;font-size:13px;line-height:1.6">${h}</div></div>`;
  $('#intX').onclick = () => {
    el.innerHTML = '';
  };
  $$('#integDetalle [data-doc]').forEach(
    (a) => (a.onclick = () => verDoc(a.dataset.doc, { volver: 'activity', etiqueta: 'Integridad' })),
  );
}
// ── Inbox OPERATIVO: subir ficheros/fotos con METADATOS que VIAJAN (ISBN/colección/obra/ubicación) ──
let inboxWired = false,
  camFotos = [];
let colaInbox = [],
  jobsHechos = [],
  colaCorriendo = false,
  jobSeq = 0; // cola de subida (autopiloto, no bloquea)
function loadInbox() {
  if (!inboxWired) {
    inboxWired = true;
    wireInbox();
  }
  if ('NDEFReader' in window && $('#nfcCard')) $('#nfcCard').style.display = '';
  if ($('#inboxHint')) $('#inboxHint').textContent = '';
  cargarDatalistColecciones();
  refrescarInboxUbic(); // monta los <select> al instante con el mapa en caché
  cargarUbicaciones(); // y lo refresca desde el servidor
}
// Escanear el código de barras (EAN-13) con la cámara y rellenar el ISBN. Usa el lector NATIVO del
// navegador (BarcodeDetector, en Chrome Android); si no está, avisa de escribirlo a mano. El ISBN así
// capturado viaja como autoridad → identificación por Fichero local (fast-path, sin visión IA).
async function escanearISBN(targetId = 'inIsbn') {
  if (!('BarcodeDetector' in window)) {
    toast('Este navegador no trae lector de códigos (usa Chrome en Android). Escribe el ISBN.', 'warn');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } } });
  } catch (e) {
    toast('No se pudo abrir la cámara: ' + e.message, 'bad');
    return;
  }
  let formatos = ['ean_13', 'ean_8', 'upc_a', 'upc_e'];
  try {
    const soportados = await BarcodeDetector.getSupportedFormats();
    formatos = formatos.filter((f) => soportados.includes(f));
    if (!formatos.length) formatos = ['ean_13'];
  } catch (_) {}
  const detector = new BarcodeDetector({ formats: formatos });
  // Overlay PROPIO (no usa #cmpModal) para poder escanear TAMBIÉN sobre el formulario de edición.
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.85);display:grid;place-items:center;padding:16px';
  overlay.innerHTML = `<div class="box card" style="max-width:480px;width:100%"><h3 style="margin-top:0">📷 Escanear ISBN</h3>
    <video id="scVid" playsinline muted style="width:100%;border-radius:10px;background:#000;max-height:60vh"></video>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Enfoca el código de barras de la contraportada…</p>
    <div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn" id="scX">Cancelar</button></div></div>`;
  document.body.appendChild(overlay);
  const video = overlay.querySelector('#scVid');
  video.srcObject = stream;
  try {
    await video.play();
  } catch (_) {}
  let activo = true;
  const parar = () => {
    activo = false;
    try {
      stream.getTracks().forEach((track) => track.stop());
    } catch (_) {}
  };
  const cerrar = () => {
    parar();
    overlay.remove();
  };
  overlay.querySelector('#scX').onclick = cerrar;
  overlay.onclick = (e) => {
    if (e.target === overlay) cerrar();
  };
  // Bucle de lectura: cada 300 ms busca un EAN-13 978/979 (ISBN) en el vídeo; al leerlo, lo pone en el campo.
  const loop = async () => {
    if (!activo) return;
    try {
      const codigos = await detector.detect(video);
      const isbn = (codigos || [])
        .map((c) => String(c.rawValue || '').replace(/\D/g, ''))
        .find((v) => /^97[89]\d{10}$/.test(v));
      if (isbn) {
        parar();
        const campo = $('#' + targetId);
        if (campo) campo.value = isbn;
        overlay.remove();
        toast('ISBN leído: ' + isbn);
        return;
      }
    } catch (_) {}
    setTimeout(loop, 300);
  };
  loop();
}

// ── CÁMARA EN VIVO (multidisparo) para escanear libros/obras sin salir de la app ──────────────
// Modo RÁPIDO opcional (la cámara nativa «📷 Hacer foto» sigue disponible para máxima resolución).
// Overlay del TAPETE en vivo (cuadrilátero del libro detectado) para encuadrar antes de disparar; cada
// disparo captura el frame a la mayor resolución que dé getUserMedia y lo añade a la cola `camFotos`
// (la misma que «✅ Catalogar», que ya recorta con el tapete y envía).
async function camaraEnVivo() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    toast('Este navegador no permite cámara en vivo. Usa «📷 Hacer foto».', 'warn');
    return;
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
    });
  } catch (e) {
    toast('No se pudo abrir la cámara: ' + e.message, 'bad');
    return;
  }
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#000;display:flex;flex-direction:column';
  overlay.innerHTML = `
    <div id="cvWrap" style="position:relative;flex:1;min-height:0;display:grid;place-items:center;overflow:hidden">
      <div style="position:relative;max-width:100%;max-height:100%">
        <video id="cvVid" playsinline muted style="display:block;max-width:100%;max-height:78vh"></video>
        <canvas id="cvOvl" style="position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none"></canvas>
        <div id="cvInfo" style="position:absolute;top:8px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.62);color:#fff;font-size:13px;font-weight:600;padding:5px 12px;border-radius:14px;pointer-events:none;white-space:nowrap;max-width:92%;overflow:hidden;text-overflow:ellipsis">Encuadra el libro sobre el tapete</div>
        <div id="cvZoomWrap" style="display:none;position:absolute;right:10px;top:50%;transform:translateY(-50%);flex-direction:column;align-items:center;gap:6px;background:rgba(0,0,0,.42);border-radius:16px;padding:8px 6px"></div>
        <button id="cvFloat" title="Toca para CAPTURAR · mantén pulsado para MOVER el botón" style="display:none;position:absolute;z-index:20;width:66px;height:66px;border-radius:50%;border:4px solid rgba(255,255,255,.92);background:rgba(255,255,255,.26);box-shadow:0 4px 16px rgba(0,0,0,.5);place-items:center;font-size:26px;touch-action:none;cursor:grab;color:#fff;transition:transform .12s">📸</button>
        <button id="cvFloatDone" title="Catalogar las fotos tomadas y seguir en la cámara para el siguiente libro · mantén pulsado para MOVER el botón" style="display:none;position:absolute;z-index:21;width:66px;height:66px;border-radius:50%;border:4px solid rgba(40,217,168,.95);background:rgba(40,217,168,.9);box-shadow:0 4px 16px rgba(0,0,0,.5);place-items:center;touch-action:none;cursor:grab;transition:transform .12s"><svg viewBox="0 0 24 24" width="30" height="30" style="pointer-events:none"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" fill="#04231b"></polygon></svg><span id="cvDoneN" style="position:absolute;top:-4px;right:-4px;min-width:20px;height:20px;padding:0 5px;border-radius:11px;background:#04231b;color:#28d9a8;font-size:12px;font-weight:800;display:grid;place-items:center;pointer-events:none">0</span></button>
      </div>
    </div>
    <div id="cvStrip" style="display:none;gap:8px;padding:8px 12px;background:#0a0a0a;overflow-x:auto;white-space:nowrap"></div>
    <div style="display:flex;gap:10px;align-items:center;justify-content:center;padding:12px;background:#111;flex-wrap:wrap">
      <button class="btn" id="cvX">✕ Cerrar</button>
      <button class="btn" id="cvTorch" style="display:none">🔦</button>
      <button class="btn pri" id="cvRect" title="Muestra u oculta el recuadro y la medida del tapete (desactívalo para fotos que no sean de portada/contraportada)">📐 Recuadro</button>
      <button class="btn pri" id="cvShot" style="font-size:18px;padding:10px 24px">📸 Capturar</button>
      <span id="cvN" style="color:#fff;font-size:13px">0 fotos</span>
      <button class="btn pri" id="cvDone">✅ Catalogar</button>
    </div>`;
  document.body.appendChild(overlay);
  const video = overlay.querySelector('#cvVid');
  const ovl = overlay.querySelector('#cvOvl');
  video.srcObject = stream;
  try { await video.play(); } catch (_) {}

  const track = stream.getVideoTracks()[0];
  // Linterna (torch), si el dispositivo la soporta.
  let torchOn = false;
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps && caps.torch) {
      const bt = overlay.querySelector('#cvTorch');
      bt.style.display = '';
      bt.onclick = async () => {
        torchOn = !torchOn;
        try { await track.applyConstraints({ advanced: [{ torch: torchOn }] }); bt.classList.toggle('pri', torchOn); } catch (_) {}
      };
    }
  } catch (_) {}

  // ZOOM por FACTORES NATIVOS (evita la interpolación digital): en vez de un slider continuo, botones
  // fijos a los factores ópticos típicos (mín · 2 · 3 · 5 · 10 · máx dentro del rango del dispositivo).
  // Persistente: recuerda el último y lo re-aplica al abrir; ajusta el guardado al factor más cercano.
  try {
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    if (caps && caps.zoom && (caps.zoom.max || 0) > (caps.zoom.min || 1)) {
      const wrap = overlay.querySelector('#cvZoomWrap');
      const zmin = caps.zoom.min || 1, zmax = caps.zoom.max;
      const factores = [...new Set([zmin, 2, 3, 5, 10, zmax].filter((z) => z >= zmin && z <= zmax))].sort((a, b) => a - b);
      if (factores.length > 1) {
        wrap.style.display = 'flex';
        let z = parseFloat(localStorage.getItem('cam_zoom') || '');
        if (!Number.isFinite(z)) z = zmin;
        z = factores.reduce((best, f) => (Math.abs(f - z) < Math.abs(best - z) ? f : best), factores[0]);
        const etiqueta = (f) => (Number.isInteger(f) ? f : Math.round(f * 10) / 10) + '×';
        const cercano = (v) => factores.reduce((best, f) => (Math.abs(f - v) < Math.abs(best - v) ? f : best), factores[0]);
        // Marca el botón que coincide con el zoom REAL de la cámara (getSettings), no con el pedido: si el
        // dispositivo redondea o ignora el valor, el botón activo refleja lo que de verdad se ve.
        const sincronizar = () => {
          let real = z; try { const s = track.getSettings ? track.getSettings() : {}; if (Number.isFinite(s.zoom)) real = s.zoom; } catch (_) {}
          const act = cercano(real);
          wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('pri', parseFloat(b.dataset.z) === act));
        };
        const aplicar = async (val) => {
          try { await track.applyConstraints({ advanced: [{ zoom: val }] }); } catch (_) {}
          localStorage.setItem('cam_zoom', String(val));
          sincronizar();
        };
        for (const f of factores) {
          const b = document.createElement('button');
          b.className = 'btn';
          b.dataset.z = f;
          b.textContent = etiqueta(f);
          b.style.cssText = 'padding:5px 0;min-width:48px;font-size:13px';
          b.onclick = () => aplicar(f);
          wrap.appendChild(b);
        }
        await aplicar(z);              // aplica el zoom guardado y SINCRONIZA el botón con el zoom real
        setTimeout(sincronizar, 500);  // re-sincroniza por si la cámara tarda en asentar el zoom
      }
    }
  } catch (_) {}

  let vivo = true;
  // Recuadro/medida del tapete: ON por defecto (persistente). Para fotos que NO son de portada/
  // contraportada (ISBN, interior…) el usuario puede desactivarlo → ni se detecta ni se mide.
  let overlayOn = localStorage.getItem('cam_recuadro') !== '0';
  // Tira de miniaturas DENTRO de la cámara: revisar y BORRAR fotos antes de procesar (sin salir).
  const strip = overlay.querySelector('#cvStrip');
  const renderCamStrip = () => {
    strip.style.display = camFotos.length ? 'flex' : 'none';
    strip.innerHTML = camFotos
      .map((foto, i) => `<span style="position:relative;display:inline-block;flex:none"><img src="${URL.createObjectURL(foto)}" style="width:54px;height:72px;object-fit:cover;border-radius:6px;border:1px solid #333"><button class="btn bad" type="button" data-rm="${i}" title="Quitar" style="position:absolute;top:-6px;right:-6px;padding:0 6px;border-radius:50%;line-height:18px">✕</button></span>`)
      .join('');
    strip.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { camFotos.splice(+b.dataset.rm, 1); renderCamStrip(); actualizarN(); renderCamThumbs(); }));
  };
  const capCanvas = document.createElement('canvas');
  const work = document.createElement('canvas');
  const mcan = document.createElement('canvas'); // canvas de MEDICIÓN (mayor resolución, throttled)
  const actualizarN = () => {
    const n = camFotos.length;
    overlay.querySelector('#cvN').textContent = `${n} foto(s)`;
    overlay.querySelector('#cvDone').textContent = `✅ Catalogar (${n})`;
    // Botón flotante «embudo» de catalogar: aparece con la 1.ª foto; la insignia muestra cuántas hay.
    const fd = overlay.querySelector('#cvFloatDone');
    if (fd) {
      fd.style.display = n ? 'grid' : 'none';
      const b = fd.querySelector('#cvDoneN');
      if (b) b.textContent = n;
    }
  };
  actualizarN();

  // MEDIR SIN DISPARAR: sobre un frame a ~1024 px, detecta el libro y la rejilla del tapete y devuelve
  // {ancho_cm,alto_cm} — misma fórmula que el recorte al enviar (distancia de esquinas ÷ px/cm). Más
  // caro que el overlay, así que se llama throttled (~1 s). El tapete debe verse (rejilla) para medir.
  const medir = () => {
    try {
      const vw = video.videoWidth, vh = video.videoHeight;
      if (!vw) return null;
      const ancho = Math.min(vw, 1024);
      mcan.width = ancho; mcan.height = Math.max(1, Math.round((vh / vw) * ancho));
      mcan.getContext('2d').drawImage(video, 0, 0, mcan.width, mcan.height);
      const q = detectarBordesVerde(mcan);
      if (!q) return null;
      const pxcm = detectarRejillaPxCm(mcan);
      if (!pxcm) return null;
      const W = (_dist(q[0], q[1]) + _dist(q[3], q[2])) / 2 / pxcm,
        H = (_dist(q[0], q[3]) + _dist(q[1], q[2])) / 2 / pxcm;
      if (W >= 4 && W <= 50 && H >= 4 && H <= 50) return { ancho_cm: +W.toFixed(1), alto_cm: +H.toFixed(1) };
    } catch (_) {}
    return null;
  };

  // Overlay del TAPETE en vivo: cada ~250 ms detecta el cuadrilátero del libro y lo dibuja sobre el
  // vídeo; en verde si además hay medida fresca, ámbar si aún se está midiendo.
  let iter = 0, ultDims = null, fallosMedida = 0;
  const loopTapete = () => {
    if (!vivo) return;
    let hayQuad = false;
    if (overlayOn) try {
      const vw = video.videoWidth, vh = video.videoHeight, cw = video.clientWidth, ch = video.clientHeight;
      if (vw && vh && cw) {
        // 720 px = MISMA resolución de detección que la foto fija («🔍 Probar» / recorte al subir). A 480 px el
        // tapete se lava (baja la saturación) y una calibración algo desajustada dejaba de reconocerse aunque
        // en foto sí funcionara → el recuadro «desaparecía». Igualarla lo hace tan robusto como en foto.
        work.width = 720; work.height = Math.max(1, Math.round((vh / vw) * 720));
        work.getContext('2d').drawImage(video, 0, 0, work.width, work.height);
        const q = detectarBordesVerde(work);
        ovl.width = cw; ovl.height = ch;
        const ctx = ovl.getContext('2d');
        ctx.clearRect(0, 0, cw, ch);
        if (q) {
          hayQuad = true;
          const sx = cw / work.width, sy = ch / work.height;
          ctx.strokeStyle = ultDims ? '#28d9a8' : '#f5b301'; ctx.lineWidth = 3; ctx.shadowColor = 'rgba(0,0,0,.6)'; ctx.shadowBlur = 3;
          ctx.beginPath();
          q.forEach((p, i) => { const x = p[0] * sx, y = p[1] * sy; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
          ctx.closePath(); ctx.stroke();
        }
      }
    } catch (_) {}
    // Medición (más cara) throttled: ~cada segundo; caduca la última medida tras 2 fallos seguidos.
    if (overlayOn && ++iter % 4 === 0) {
      const d = medir();
      if (d) { ultDims = d; fallosMedida = 0; }
      else if (++fallosMedida >= 2) ultDims = null;
    }
    const info = overlay.querySelector('#cvInfo');
    if (info) {
      info.style.display = overlayOn ? '' : 'none';
      info.textContent = ultDims
        ? `📐 ${String(ultDims.ancho_cm).replace('.', ',')} × ${String(ultDims.alto_cm).replace('.', ',')} cm`
        : hayQuad ? 'Midiendo…' : 'Encuadra el libro sobre el tapete';
    }
    setTimeout(loopTapete, 250);
  };
  loopTapete();
  renderCamStrip();
  // Botón activar/desactivar el recuadro/medida (persistente). Al apagarlo se limpia el overlay.
  const btnRect = overlay.querySelector('#cvRect');
  const pintarRectBtn = () => btnRect.classList.toggle('pri', overlayOn);
  pintarRectBtn();
  btnRect.onclick = () => {
    overlayOn = !overlayOn;
    localStorage.setItem('cam_recuadro', overlayOn ? '1' : '0');
    if (!overlayOn) { try { ovl.getContext('2d').clearRect(0, 0, ovl.width, ovl.height); } catch (_) {} ultDims = null; }
    pintarRectBtn();
  };

  const cerrar = () => {
    vivo = false;
    try { stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    overlay.remove();
  };
  overlay.querySelector('#cvX').onclick = cerrar;
  // Píldora efímera centrada DENTRO del overlay: el toast global va en z-index 100 y quedaría TAPADO por la
  // cámara (z-index 99999), así que los avisos de la cámara en vivo se muestran así (captura, envío…).
  const pillOverlay = (txt, ms = 850) => {
    const wrap = overlay.querySelector('#cvWrap');
    if (!wrap) return;
    const pill = document.createElement('div');
    pill.textContent = txt;
    pill.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%) scale(.9);background:rgba(40,217,168,.95);color:#04231b;font-weight:800;font-size:16px;padding:9px 18px;border-radius:14px;box-shadow:0 4px 18px rgba(0,0,0,.5);z-index:30;pointer-events:none;opacity:0;transition:opacity .12s,transform .12s';
    wrap.appendChild(pill);
    requestAnimationFrame(() => { pill.style.opacity = '1'; pill.style.transform = 'translate(-50%,-50%) scale(1)'; });
    setTimeout(() => { pill.style.opacity = '0'; setTimeout(() => pill.remove(), 220); }, ms);
  };
  // FEEDBACK visible de captura: breve FLASH blanco (efecto obturador) + píldora «📸 Foto N». Complementa el
  // sonido (sonidoCaptura) y la vibración.
  const feedbackCaptura = (n) => {
    const wrap = overlay.querySelector('#cvWrap');
    if (wrap) {
      const flash = document.createElement('div');
      flash.style.cssText = 'position:absolute;inset:0;background:#fff;opacity:.55;z-index:29;pointer-events:none;transition:opacity .28s';
      wrap.appendChild(flash);
      requestAnimationFrame(() => (flash.style.opacity = '0'));
      setTimeout(() => flash.remove(), 320);
    }
    pillOverlay(`📸 Foto ${n}`);
  };
  // Capturar el frame actual a máxima resolución → File → cola camFotos (multidisparo). Reutilizable por
  // el botón de la barra y por el botón FLOTANTE.
  const capturar = async () => {
    try {
      capCanvas.width = video.videoWidth; capCanvas.height = video.videoHeight;
      capCanvas.getContext('2d').drawImage(video, 0, 0);
      const blob = await new Promise((res) => capCanvas.toBlob(res, 'image/jpeg', 0.92));
      if (blob) {
        camFotos.push(new File([blob], `camara-${Date.now()}.jpg`, { type: 'image/jpeg' }));
        renderCamThumbs();
        renderCamStrip();
        actualizarN();
        sonidoCaptura();                                   // «click» de obturador
        feedbackCaptura(camFotos.length);                  // flash + píldora «📸 Foto N» (toast visible sobre la cámara)
        try { navigator.vibrate && navigator.vibrate(30); } catch (_) {}
      }
    } catch (e) { toast('No se pudo capturar: ' + e.message, 'bad'); }
  };
  overlay.querySelector('#cvShot').onclick = capturar;

  // BOTONES FLOTANTES (caen a mano, sin estirar el pulgar hasta la barra): el de DISPARO (📸) y el de
  // CATALOGAR (embudo). Un TOQUE ejecuta la acción; si se MANTIENE pulsado se arrastra a otra posición
  // (persistente por localStorage). Comparten la mecánica en fabArrastrable.
  const wrapEl = overlay.querySelector('#cvWrap');
  const fab = overlay.querySelector('#cvFloat');
  fab.style.display = 'grid';
  fabArrastrable(fab, wrapEl, 'cam_fab', (rw, fw, fh) => ({
    x: (rw.width - fw) / 2, // por defecto: abajo-centro (cómodo para el pulgar)
    y: rw.height - fh - 18,
  }), capturar);

  // Catalogar SIN salir de la cámara: envía las fotos actuales como un libro y sigue filmando (encadenar
  // libros). Si «Elegir portada» está activo, el selector sale AQUÍ MISMO (sobre la cámara) y se ESPERA antes
  // de pasar a la siguiente tanda; una vez elegida, el envío va en segundo plano y la cola se vacía. El flag
  // `enviando` impide solapar tandas (si no, dos selectores de portada colisionarían en el mismo #cmpModal —
  // era el bug: al fotografiar varios libros seguidos solo se catalogaba el último). «✕ Cerrar» sale.
  let enviando = false;
  const catalogarYSeguir = async () => {
    if (enviando) return;
    if (!camFotos.length) { toast('Haz al menos una foto', 'warn'); return; }
    enviando = true;
    try {
      let files = camFotos.slice();
      // ¿Toca elegir portada? (switch activo + varias imágenes de un mismo libro, como en la subida normal).
      const imgs = files.filter(_esImg);
      const pedirPortada =
        $('#inPortada') && $('#inPortada').checked && imgs.length >= 2 && imgs.length <= 12 && imgs.length === files.length;
      if (pedirPortada) {
        // El selector (#cmpModal, z-206) quedaría por DEBAJO de la cámara (z-99999): bajamos la cámara
        // temporalmente para que el selector se vea, y la restauramos al terminar.
        const zPrev = overlay.style.zIndex;
        overlay.style.zIndex = '150';
        let r;
        try { r = await elegirPortada(files); }
        finally { overlay.style.zIndex = zPrev || '99999'; }
        if (!r) return; // cancelado: no se envía, se CONSERVAN las fotos para reintentar (finally libera `enviando`)
        files = r;
      }
      // Tanda aceptada: vaciar la cola para seguir con el siguiente libro y enviar en segundo plano. La portada
      // ya está elegida → subirInbox NO la vuelve a pedir (saltarPortada).
      camFotos = [];
      renderCamStrip();
      renderCamThumbs();
      actualizarN();
      pillOverlay(`📚 ${files.length} foto(s) enviadas`, 1100);
      subirInbox(files, { saltarPortada: true }).catch((e) => toast('Error al enviar: ' + (e.message || e), 'bad'));
    } finally {
      enviando = false;
    }
  };
  overlay.querySelector('#cvDone').onclick = catalogarYSeguir;
  // El botón flotante «embudo» de catalogar: mismo comportamiento arrastrable que el de disparo (por defecto
  // arriba-derecha; su visibilidad la gobierna actualizarN según haya fotos).
  fabArrastrable(overlay.querySelector('#cvFloatDone'), wrapEl, 'cam_fab_done', (rw, fw) => ({
    x: rw.width - fw - 12,
    y: 12,
  }), catalogarYSeguir);
}

// Convierte un botón en un FLOTANTE ARRASTRABLE dentro de `wrapEl`: un TOQUE corto ejecuta `onTap`; MANTENER
// pulsado (~280 ms) entra en «modo mover» (se agranda + vibra) y se arrastra, con la posición persistida en
// localStorage[clave]. `posPorDefecto(rw, fw, fh)` da la posición inicial si aún no hay una guardada. Lo
// comparten los dos flotantes de la cámara en vivo (disparo 📸 y catalogar «embudo»).
function fabArrastrable(fab, wrapEl, clave, posPorDefecto, onTap) {
  const colocar = () => {
    const rw = wrapEl.getBoundingClientRect(), fw = fab.offsetWidth || 66, fh = fab.offsetHeight || 66;
    let p = null; try { p = JSON.parse(localStorage.getItem(clave) || 'null'); } catch (_) {}
    const def = posPorDefecto(rw, fw, fh);
    let x = p ? p.x : def.x, y = p ? p.y : def.y;
    x = Math.max(6, Math.min(rw.width - fw - 6, x));
    y = Math.max(6, Math.min(rw.height - fh - 6, y));
    fab.style.left = x + 'px'; fab.style.top = y + 'px';
  };
  setTimeout(colocar, 60); // tras el layout del vídeo
  let fdrag = false, fmoved = false, fhold = null, fsx = 0, fsy = 0, foffx = 0, foffy = 0;
  const finMover = () => { fab.style.transform = ''; fab.style.cursor = 'grab'; };
  fab.addEventListener('pointerdown', (e) => {
    fdrag = false; fmoved = false; fsx = e.clientX; fsy = e.clientY;
    const rct = fab.getBoundingClientRect(); foffx = e.clientX - rct.left; foffy = e.clientY - rct.top;
    clearTimeout(fhold);
    fhold = setTimeout(() => {                       // mantener pulsado → modo mover
      fdrag = true;
      try { fab.setPointerCapture(e.pointerId); } catch (_) {}
      fab.style.transform = 'scale(1.18)'; fab.style.cursor = 'grabbing';
      try { navigator.vibrate && navigator.vibrate(20); } catch (_) {}
    }, 280);
  });
  fab.addEventListener('pointermove', (e) => {
    if (!fdrag) {
      if (Math.hypot(e.clientX - fsx, e.clientY - fsy) > 12) { clearTimeout(fhold); fmoved = true; } // swipe: ni tap ni mover
      return;
    }
    const rw = wrapEl.getBoundingClientRect(), fw = fab.offsetWidth, fh = fab.offsetHeight;
    let x = e.clientX - rw.left - foffx, y = e.clientY - rw.top - foffy;
    x = Math.max(6, Math.min(rw.width - fw - 6, x));
    y = Math.max(6, Math.min(rw.height - fh - 6, y));
    fab.style.left = x + 'px'; fab.style.top = y + 'px';
  });
  fab.addEventListener('pointerup', () => {
    clearTimeout(fhold);
    if (fdrag) { fdrag = false; finMover(); localStorage.setItem(clave, JSON.stringify({ x: parseFloat(fab.style.left), y: parseFloat(fab.style.top) })); return; }
    if (fmoved) { fmoved = false; return; }           // fue un swipe: ni acción ni mover
    onTap();                                           // toque corto → la acción del botón
  });
  fab.addEventListener('pointercancel', () => { clearTimeout(fhold); fdrag = false; fmoved = false; finMover(); });
  fab.addEventListener('contextmenu', (e) => e.preventDefault());
}

// Detecta un ISBN (EAN-13 978/979) en las IMÁGENES (sin tocar el DOM): lo lee EN EL MÓVIL con
// BarcodeDetector. Devuelve el ISBN o null. Lo usan la subida (autopiloto y supervisado) para que el
// ISBN viaje como autoridad → fast-path por Fichero (sin visión IA). Un PDF lo lee el servidor.
async function detectarISBNenFiles(files) {
  if (!('BarcodeDetector' in window)) return null;
  const imagenes = (files || []).filter((f) => /^image\//.test(f.type || ''));
  if (!imagenes.length) return null;
  let detector;
  try {
    detector = new BarcodeDetector({ formats: ['ean_13'] });
  } catch (_) {
    return null;
  }
  for (const imagen of imagenes) {
    try {
      const bitmap = await createImageBitmap(imagen);
      const codigos = await detector.detect(bitmap);
      if (bitmap.close) bitmap.close();
      // EAN-13 que empieza por 978/979 = ISBN (Bookland). Solo dígitos.
      const isbn = (codigos || [])
        .map((c) => String(c.rawValue || '').replace(/\D/g, ''))
        .find((v) => /^97[89]\d{10}$/.test(v));
      if (isbn) return isbn;
    } catch (_) {}
  }
  return null;
}
// Índice de la imagen que lleva el CÓDIGO DE BARRAS EAN-13 (suele ser la CONTRAPORTADA), o -1.
async function indiceConBarcode(files) {
  if (!('BarcodeDetector' in window)) return -1;
  let detector;
  try {
    detector = new BarcodeDetector({ formats: ['ean_13'] });
  } catch (_) {
    return -1;
  }
  for (let i = 0; i < files.length; i++) {
    const imagen = files[i];
    if (!/^image\//.test(imagen.type || '')) continue;
    try {
      const bitmap = await createImageBitmap(imagen);
      const codigos = await detector.detect(bitmap);
      if (bitmap.close) bitmap.close();
      if ((codigos || []).some((c) => /^97[89]\d{10}$/.test(String(c.rawValue || '').replace(/\D/g, ''))))
        return i;
    } catch (_) {}
  }
  return -1;
}
// Selector de PORTADA antes de enviar: thumbnails + default inteligente (si la 1.ª lleva el código de barras
// —contraportada— se adelanta una imagen SIN barcode). Tocar una la pone de portada. Devuelve el array
// reordenado (portada 1.ª) o null si se cancela.
function elegirPortada(files) {
  return new Promise(async (resolve) => {
    let orden = files.slice();
    const urlMap = new Map(orden.map((f) => [f, URL.createObjectURL(f)]));
    let bcFile = null;
    const bi = await indiceConBarcode(orden).catch(() => -1);
    if (bi >= 0) bcFile = orden[bi];
    if (bi === 0) {
      const alt = orden.find((f, i) => i !== 0 && /^image\//.test(f.type || ''));
      if (alt) orden = [alt, ...orden.filter((f) => f !== alt)];
    }
    const cerrar = () => {
      for (const u of urlMap.values())
        try {
          URL.revokeObjectURL(u);
        } catch (_) {}
      $('#cmpScrim').style.display = 'none';
      $('#cmpModal').style.display = 'none';
      $('#cmpModal').innerHTML = '';
    };
    const pintar = () => {
      $('#cpGrid').innerHTML = orden
        .map(
          (f, i) =>
            `<button type="button" class="cpThumb${i === 0 ? ' port' : ''}" data-i="${i}"><img src="${esc(urlMap.get(f))}" loading="lazy">${i === 0 ? '<span class="cpBadge">PORTADA</span>' : ''}${f === bcFile ? '<span class="cpBC">código</span>' : ''}</button>`,
        )
        .join('');
      $$('#cpGrid .cpThumb').forEach(
        (el) =>
          (el.onclick = () => {
            const i = +el.dataset.i;
            if (i > 0) {
              const f = orden[i];
              orden = [f, ...orden.filter((x) => x !== f)];
              pintar();
            }
          }),
      );
    };
    $('#cmpModal').innerHTML =
      `<div class="box card" style="max-width:560px;max-height:92vh;overflow:auto"><h3 style="margin-top:0">🖼️ Elegir portada</h3>
      <p class="muted" style="font-size:12px;margin:6px 0 10px">Toca la imagen que sea la PORTADA (pasará a la 1.ª). El resto mantiene su orden. La marcada «código» es la contraportada.</p>
      <div id="cpGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px"></div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn" id="cpX">Cancelar</button><button class="btn pri" id="cpOk">Enviar</button></div></div>`;
    $('#cmpScrim').style.display = 'block';
    $('#cmpModal').style.display = 'grid';
    pintar();
    $('#cpX').onclick = () => {
      cerrar();
      resolve(null);
    };
    $('#cpOk').onclick = () => {
      cerrar();
      resolve(orden);
    };
  });
}
function wireInbox() {
  const dz = $('#dropZone'),
    fi = $('#fileInput');
  if ($('#pickBtn')) $('#pickBtn').onclick = () => fi && fi.click();
  if (fi)
    fi.onchange = () => {
      if (fi.files.length) subirInbox([...fi.files]);
      fi.value = '';
    };
  // Importar de otra app (Drive, Adobe Scan, Files…) vía el selector del sistema.
  const fa = $('#fileInputApp');
  if ($('#pickApp')) $('#pickApp').onclick = () => fa && fa.click();
  if (fa)
    fa.onchange = () => {
      if (fa.files.length) subirInbox([...fa.files]);
      fa.value = '';
    };
  // Escanear el ISBN con la cámara (código de barras EAN-13 → rellena el campo ISBN).
  if ($('#inScan')) $('#inScan').onclick = escanearISBN;
  // Interruptor «procesar lo compartido al instante» (persistente en este navegador).
  const ac = $('#inAutoCompartir');
  if (ac) {
    ac.checked = localStorage.getItem('auto_compartir') !== '0';
    ac.onchange = () => localStorage.setItem('auto_compartir', ac.checked ? '1' : '0');
  }
  // Modo Supervisado PERSISTENTE (no se reinicia al volver de Adobe Scan / recargar la PWA).
  const sv = $('#inSupervisar');
  if (sv) {
    sv.checked = localStorage.getItem('inbox_supervisar') === '1';
    sv.onchange = () => localStorage.setItem('inbox_supervisar', sv.checked ? '1' : '0');
  }
  // Modo Tapete PERSISTENTE: medir + recortar el libro sobre la alfombrilla al subir.
  const tp = $('#inTapete');
  if (tp) {
    tp.checked = localStorage.getItem('inbox_tapete') === '1';
    tp.onchange = () => localStorage.setItem('inbox_tapete', tp.checked ? '1' : '0');
  }
  // Elegir portada PERSISTENTE (por defecto activado).
  const inP = $('#inPortada');
  if (inP) {
    inP.checked = localStorage.getItem('inbox_portada') !== '0';
    inP.onchange = () => localStorage.setItem('inbox_portada', inP.checked ? '1' : '0');
  }
  // Calibración del tapete (foto del tapete vacío): fija su color de sesión (cualquier color / luz). Se puede
  // ELEGIR una foto de la galería (🎨 Calibrar tapete) o TOMARLA al momento con la cámara (📷 Foto, en móvil).
  const tcb = $('#inTapeteCal'),
    tcf = $('#inTapeteCalFile'),
    tccb = $('#inTapeteCalCam'),
    tccf = $('#inTapeteCalCamFile');
  const calibrarDesde = async (inp) => {
    if (inp && inp.files[0]) {
      try {
        const c = await calibrarTapete(inp.files[0]);
        toast(`Tapete calibrado: rgb(${c.r},${c.g},${c.b})${c.crom ? '' : ' · acromático'}`);
      } catch (e) {
        toast('No se pudo calibrar: ' + e.message, 'bad');
      }
    }
    if (inp) inp.value = '';
    pintarTapeteCalEstado();
  };
  if (tcb && tcf) {
    tcb.onclick = () => tcf.click();
    tcf.onchange = () => calibrarDesde(tcf);
  }
  if (tccb && tccf) {
    tccb.onclick = () => tccf.click();
    tccf.onchange = () => calibrarDesde(tccf);
  }
  if (tcf || tccf) pintarTapeteCalEstado();
  const ttb = $('#inTapeteTest'),
    ttf = $('#inTapeteTestFile');
  if (ttb && ttf) {
    ttb.onclick = () => ttf.click();
    ttf.onchange = async () => {
      if (ttf.files[0]) {
        try {
          await verMascaraTapete(ttf.files[0]);
        } catch (e) {
          toast('No se pudo: ' + e.message, 'bad');
        }
      }
      ttf.value = '';
    };
  }
  // Abrir Adobe Scan (Android): intent → la app, o su página en Google Play si no se puede lanzar (one-way;
  // luego se vuelve con «Compartir → Bibliotheca»). El lanzamiento web→app no es fiable desde una PWA.
  if (/Android/i.test(navigator.userAgent)) {
    const aa = $('#appAdobe');
    if (aa) aa.style.display = '';
    if ($('#openScan'))
      $('#openScan').onclick = () => {
        location.href =
          'intent:#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=com.adobe.scan.android;S.browser_fallback_url=https%3A%2F%2Fplay.google.com%2Fstore%2Fapps%2Fdetails%3Fid%3Dcom.adobe.scan.android;end';
      };
  }
  if (dz) {
    ['dragenter', 'dragover'].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.add('drag');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) =>
      dz.addEventListener(ev, (e) => {
        e.preventDefault();
        dz.classList.remove('drag');
      }),
    );
    dz.addEventListener('drop', (e) => {
      const f = [...((e.dataTransfer && e.dataTransfer.files) || [])];
      if (f.length) subirInbox(f);
    });
  }
  if ($('#inClear'))
    $('#inClear').onclick = () => {
      ['inIsbn', 'inColeccion', 'inObra', 'inAmbito', 'inEstanteria'].forEach((id) => {
        const el = $('#' + id);
        if (el) el.value = '';
      });
      refrescarInboxUbic();
    };
  const ci = $('#camInput');
  if ($('#camShot')) $('#camShot').onclick = () => ci && ci.click();
  if ($('#camLive')) $('#camLive').onclick = camaraEnVivo; // cámara en vivo (multidisparo + overlay tapete)
  if (ci)
    ci.onchange = async () => {
      for (const f of ci.files) {
        try {
          camFotos.push(await reducirImagen(f));
        } catch {
          camFotos.push(f);
        }
      }
      ci.value = '';
      renderCamThumbs();
    };
  if ($('#camDone')) $('#camDone').onclick = camCatalogar;
  if ($('#camClear'))
    $('#camClear').onclick = () => {
      camFotos = [];
      renderCamThumbs();
    };
  if ($('#nfcRead')) $('#nfcRead').onclick = leerNFC;
  // «Cámara del móvil» (en «Subir desde otra app»): input capture (fiable) → foto directa al Inbox.
  const oci = $('#openCamInput');
  if ($('#openCam')) $('#openCam').onclick = () => oci && oci.click();
  if (oci)
    oci.onchange = () => {
      const f = [...oci.files];
      oci.value = '';
      if (f.length) subirInbox(f);
    };
  // Ingreso por ISBN: Buscar (botón) o Enter en el campo (los lectores de código de barras envían Enter).
  if ($('#isbnGo')) $('#isbnGo').onclick = isbnBuscar;
  if ($('#isbnIn')) {
    $('#isbnIn').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        isbnBuscar();
      }
    });
    // Escribir/escanear un ISBN nuevo invalida el auto-alta del anterior: se cancela hasta que lleguen datos.
    $('#isbnIn').addEventListener('input', isbnAutoCancelar);
  }
  // Botón ✕: limpia el ISBN y devuelve el foco (para encadenar escaneos sin tocar el ratón).
  if ($('#isbnClear')) $('#isbnClear').onclick = isbnLimpiarEntrada;
  // Auto-alta (switch + slider 1–10 s), persistidos en localStorage.
  const auto = $('#isbnAuto'),
    seg = $('#isbnAutoSeg'),
    segVal = $('#isbnAutoSegVal');
  if (auto) {
    auto.checked = localStorage.getItem('isbn_auto') === '1';
    auto.onchange = () => {
      localStorage.setItem('isbn_auto', auto.checked ? '1' : '0');
      auto.checked ? isbnAutoReset() : isbnAutoCancelar();
    };
  }
  if (seg) {
    seg.value = localStorage.getItem('isbn_auto_seg') || '5';
    if (segVal) segVal.textContent = seg.value;
    seg.oninput = () => {
      if (segVal) segVal.textContent = seg.value;
      localStorage.setItem('isbn_auto_seg', seg.value);
      if (_isbnAutoTimer) isbnAutoReset(); // recuenta con el nuevo intervalo si ya estaba corriendo
    };
  }
  loteWire();
}

// ── Auto-alta por inactividad (lectura por lotes con escáner) ─────────────────────────────────────────
// Cuando el switch «Auto-alta» está activo, tras N s SIN interacción (desde que llegan los datos del ISBN)
// se da de alta el libro con la portada elegida, se limpia el ISBN y se mantiene el foco para el siguiente
// escaneo. Cualquier interacción (teclear el ISBN, tocar una portada o un botón de la tarjeta) REINICIA la
// cuenta; así solo salta con inactividad real. Ver isbnCrear(completar, auto).
let _isbnAutoTimer = null; // intervalo de la cuenta atrás en curso
// El estado de la cuenta atrás se muestra tanto en la tarjeta (#isbnAutoEstado) como dentro del modal de
// resultados (#isbnAutoEstadoModal, que es el que el usuario está mirando): se actualizan ambos si existen.
function _isbnAutoEstadoSet(txt) {
  ['#isbnAutoEstado', '#isbnAutoEstadoModal'].forEach((sel) => {
    const el = $(sel);
    if (el) el.textContent = txt;
  });
}
function isbnAutoCancelar() {
  if (_isbnAutoTimer) {
    clearInterval(_isbnAutoTimer);
    _isbnAutoTimer = null;
  }
  _isbnAutoEstadoSet('');
}
function isbnAutoReset() {
  isbnAutoCancelar();
  const auto = $('#isbnAuto');
  if (!auto || !auto.checked || !_isbnEstado) return; // solo con switch activo y datos ya cargados
  // Sin TÍTULO no se puede dar de alta rápida (fallaría con «Falta el título»). En modo AUTO eso pasaría
  // desapercibido (fallo silencioso). Así que NO se auto-crea: se avisa en voz alta y se deja al usuario
  // rellenar a mano o pulsar «Completar y crear» (que tira de APIs/IA).
  if (!_isbnEstado.meta || !String(_isbnEstado.meta.titulo || '').trim()) {
    _isbnAutoEstadoSet('⚠ sin título: no se auto-crea; rellénalo o pulsa «Completar y crear».');
    toast('Sin datos para este ISBN: escribe el título o usa «Completar y crear»', 'warn');
    return;
  }
  const seg = Math.min(
    10,
    Math.max(1, parseInt(($('#isbnAutoSeg') && $('#isbnAutoSeg').value) || '5', 10) || 5),
  );
  let restante = seg * 1000;
  const pintar = () => _isbnAutoEstadoSet(`⏳ alta automática en ${Math.ceil(restante / 1000)} s…`);
  pintar();
  _isbnAutoTimer = setInterval(() => {
    restante -= 250;
    if (restante > 0) {
      pintar();
      return;
    }
    isbnAutoCancelar();
    isbnCrear(false, true); // alta rápida, modo auto (no navega; refresca foco)
  }, 250);
}
// ── INGRESO POR ISBN: valida, recupera del Fichero + candidatas de portada; el usuario valida antes de crear.
let _isbnEstado = null; // { isbn, meta, portadas:[{url,fuente,ancho,alto,sel}], extra:[{url|base64,previa,tipo,sel,nombre}] }
async function isbnBuscar() {
  const inp = $('#isbnIn'),
    msg = $('#isbnMsg');
  const raw = ((inp && inp.value) || '').replace(/[^0-9Xx]/g, '').toUpperCase();
  if (!raw) {
    if (msg) msg.textContent = 'Escribe o escanea un ISBN.';
    return;
  }
  // Validación de LONGITUD en el cliente (10 o 13): un ISBN mal formado se avisa por Toast y se LIMPIA el
  // input al momento, para que no colisione con la siguiente lectura del escáner. El dígito de control lo
  // valida el servidor (y su 400 se trata igual, abajo).
  if (raw.length !== 10 && raw.length !== 13) {
    toast('❌ ISBN no válido (debe tener 10 o 13 dígitos): ' + raw, 'bad');
    isbnLimpiarEntrada();
    return;
  }
  // «Modo modal» del input mientras se busca: se BLOQUEA para que las pulsaciones del escáner (que envía
  // Enter al final) no se encadenen sobre una búsqueda en curso ni contaminen la siguiente lectura.
  if (inp) inp.disabled = true;
  if (msg) msg.textContent = 'Buscando…';
  let r;
  try {
    r = await api('/isbn/' + encodeURIComponent(raw));
  } catch (e) {
    // Fallo (ISBN inválido por checksum, red, etc.): NO puede pasar desapercibido → Toast + limpiar input.
    toast('❌ ' + e.message, 'bad');
    if (msg) msg.textContent = e.message;
    isbnLimpiarEntrada();
    return;
  } finally {
    if (inp) inp.disabled = false;
  }
  const meta = r.meta || {};
  _isbnEstado = {
    isbn: r.isbn,
    meta: { ...meta },
    procedencia: r.procedencia || {}, // { campo: 'fichero'|'online'|'ia' } — para colorear los datos
    portadas: (r.portadas || []).map((p, i) => ({ ...p, sel: i === 0 })),
    extra: [],
    cduDesc: r.cdu_desc || null,
    portadaId: r.portadas && r.portadas.length ? 'c0' : null,
    dims: null,
    fuente: r.fuente || null,
    encontrado: !!r.encontrado,
  };
  // Mensaje según el origen (r.fuente): Fichero local, online (fallback OL/Google Books) o nada (rellenar a mano).
  if (msg) {
    if (!r.encontrado) {
      msg.textContent =
        '⚠ No está ni en el Fichero ni online. Escribe el título (y lo que sepas) a mano y pulsa Crear.';
    } else if (r.fuente === 'online') {
      msg.textContent = '✔ Encontrado ONLINE (OpenLibrary / Google Books). Revisa los datos antes de crear.';
    } else if (r.fuente === 'fichero+online') {
      msg.textContent = '✔ Encontrado en el Fichero local + huecos rellenados online.';
    } else {
      msg.textContent = '✔ Encontrado en el Fichero local.';
    }
  }
  isbnRender();
  // Con auto-alta activo (escaneo en cadena con lector Bluetooth): se limpia y RE-ENFOCA el campo ISBN para
  // poder leer el siguiente mientras corre la cuenta atrás, sin tocar el ratón. Sin auto-alta se deja el foco
  // libre para editar los datos en el modal.
  const autoSw = $('#isbnAuto');
  if (autoSw && autoSw.checked && $('#isbnIn')) {
    $('#isbnIn').value = '';
    $('#isbnIn').focus();
  }
}
// Limpia el campo ISBN y le devuelve el foco (para encadenar lecturas del escáner sin tocar el ratón).
function isbnLimpiarEntrada() {
  isbnAutoCancelar();
  const inp = $('#isbnIn');
  if (inp) {
    inp.disabled = false;
    inp.value = '';
    inp.focus();
  }
}
// Miniatura de portada: casilla «incluir» (arriba-izq), ✎ conformar (arriba-der), y clic en la imagen para
// marcarla como PORTADA (borde dorado + ⭐). incluida = va al archivo; esPortada = es la cubierta principal.
// grande=true → tamaño ampliado (para el modal de resultados: se ven mejor las cubiertas encontradas).
function isbnThumb(id, src, cap, incluida, esPortada, hires, editable, grande = false) {
  const bord = esPortada ? '#ffcf5a' : incluida ? 'var(--acc)' : 'transparent';
  const anchoCaja = grande ? 150 : 100;
  const altoImg = grande ? 210 : 118;
  return `<div style="position:relative;width:${anchoCaja}px">
    <div data-portada="${id}" title="Pulsa para marcarla como PORTADA" style="cursor:pointer;text-align:center;border:2px solid ${bord};border-radius:8px;padding:3px;background:var(--card)">
      <img src="${esc(src)}" style="width:100%;height:${altoImg}px;object-fit:contain;border-radius:5px" loading="lazy">
      <div class="muted" style="font-size:10px;margin-top:2px;line-height:1.2">${esPortada ? '<span style="color:#ffcf5a;font-weight:700">⭐ PORTADA</span> ' : incluida ? '✓ ' : ''}${hires ? '✔ ' : ''}${esc(cap)}</div>
    </div>
    <label title="Incluir esta imagen al archivar" style="position:absolute;top:5px;left:5px;display:inline-flex;align-items:center;background:rgba(0,0,0,.65);border-radius:6px;padding:2px 4px;cursor:pointer;z-index:2"><input type="checkbox" data-chk="${id}" ${incluida ? 'checked' : ''} style="margin:0;width:15px;height:15px"></label>
    ${editable ? `<button type="button" data-edit="${id}" title="Conformar: recortar / enderezar perspectiva" style="position:absolute;top:4px;right:4px;width:26px;height:26px;border-radius:6px;border:1px solid var(--line);background:rgba(0,0,0,.6);color:#fff;cursor:pointer;font-size:13px;line-height:1;padding:0">✎</button>` : ''}
  </div>`;
}
// Campos del alta por ISBN cuyo valor es una LISTA (se muestran unidos por "; " y al editarlos se parten).
const CAMPOS_LISTA = ['autores', 'palabras_clave'];
// Clase de color según la PROCEDENCIA de un campo (leyenda del modal/carrusel): Fichero/a mano = neutro
// (proc-fichero), APIs gratuitas = azul (proc-online), IA = rojo (proc-ia). Sin dato se asume autoritativo.
function procClase(proc, campo) {
  const p = proc && proc[campo];
  return p === 'online' ? 'proc-online' : p === 'ia' ? 'proc-ia' : 'proc-fichero';
}
function isbnProcClase(campo) {
  return procClase(_isbnEstado && _isbnEstado.procedencia, campo);
}
// Cierra el modal de resultados del ISBN y descarta el estado en curso. Si se estaba editando una fila del
// lote, ésta se queda tal cual (ni creada ni tocada). No borra el campo ISBN (lo gestiona quien llama).
function isbnCerrarModal() {
  isbnAutoCancelar();
  _isbnEstado = null;
  _loteEditItem = null;
  $('#isbnScrim').style.display = 'none';
  $('#isbnModal').style.display = 'none';
  $('#isbnModal').innerHTML = '';
}
// Elemento donde escribir mensajes/errores del alta: el del MODAL si está abierto (es lo que el usuario mira),
// si no el de la tarjeta. Así un fallo nunca queda oculto detrás del modal (los fallos «pasaban desapercibidos»).
function isbnMsgEl() {
  return $('#isbnModalMsg') || $('#isbnMsg');
}
function isbnRender() {
  const cont = $('#isbnModal');
  if (!cont || !_isbnEstado) return;
  const m = _isbnEstado.meta;
  // Valor mostrable: las listas (autores, palabras_clave) se unen con "; ".
  const val = (k) => esc(Array.isArray(m[k]) ? m[k].join('; ') : m[k] != null ? String(m[k]) : '');
  // Campo editable con etiqueta+valor coloreados por procedencia (negro=fichero/mano, azul=APIs, rojo=IA).
  const campo = (k, etiqueta, notaExtra = '') => {
    const cls = isbnProcClase(k);
    return `<div><label class="${cls}">${etiqueta}${notaExtra}</label><input data-mk="${k}" class="${cls}" value="${val(k)}" autocomplete="off"></div>`;
  };
  const notaCdu = m.cdu
    ? ` <span class="muted" style="font-weight:400;font-size:11px">(${_isbnEstado.procedencia?.cdu === 'ia' ? 'IA' : _isbnEstado.procedencia?.cdu === 'online' ? 'online' : 'Fichero'})</span>`
    : '';
  const datos = `<div class="row">
      ${campo('titulo', 'Título')}
      ${campo('autores', 'Autores (separa con ;)')}
      ${campo('editorial', 'Editorial')}
    </div>
    <div class="row" style="margin-top:8px">
      ${campo('año_edicion', 'Año')}
      ${campo('idioma', 'Idioma')}
      <div><label class="${isbnProcClase('cdu')}">CDU${notaCdu}</label><input data-mk="cdu" class="${isbnProcClase('cdu')}" value="${val('cdu')}" autocomplete="off">${_isbnEstado.cduDesc && _isbnEstado.cduDesc.titulo_es ? `<div class="muted" style="font-size:11px;margin-top:3px">ⓘ ${esc(_isbnEstado.cduDesc.titulo_es)}</div>` : ''}</div>
    </div>
    <div class="row" style="margin-top:8px">
      ${campo('coleccion_nombre', 'Colección')}
      ${campo('palabras_clave', 'Palabras clave (separa con ;)')}
    </div>`;
  const leyenda = `<div class="muted" style="font-size:11px;margin:2px 0 12px">
      Procedencia del dato: <b class="proc-fichero">■ Fichero / a mano</b> ·
      <b class="proc-online">■ APIs gratuitas</b> · <b class="proc-ia">■ IA / de pago</b></div>`;
  // Miniaturas: las candidatas «web» (resultados de Google) se muestran VÍA PROXY same-origin (evita bloqueo
  // de hotlink y contenido mixto en HTTPS). Las keyless y las subidas, directas.
  const dispSrc = (p) =>
    p.web
      ? '/api/proxy-imagen?url=' +
        encodeURIComponent(p.url) +
        (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '')
      : p.url;
  _isbnNormalizaPortada();
  const cand = _isbnEstado.portadas
    .map((p, i) =>
      isbnThumb(
        'c' + i,
        dispSrc(p),
        `${p.fuente} · ${p.ancho}×${p.alto}`,
        p.sel,
        _isbnEstado.portadaId === 'c' + i,
        p.ancho >= 800,
        true,
        true,
      ),
    )
    .join('');
  const extra = _isbnEstado.extra
    .map((p, i) =>
      isbnThumb(
        'e' + i,
        p.previa || p.url,
        p.nombre || 'añadida',
        p.sel,
        _isbnEstado.portadaId === 'e' + i,
        true,
        true,
        true,
      ),
    )
    .join('');
  const galeria =
    cand || extra
      ? `<div class="row" style="gap:12px;flex-wrap:wrap;margin-top:6px">${cand}${extra}</div>`
      : '<div class="muted" style="font-size:12px;margin-top:4px">Sin portadas automáticas. Pulsa «Buscar más portadas», haz una foto o sube una.</div>';
  const cabeceraFuente = !_isbnEstado.encontrado
    ? '<span class="proc-ia">⚠ Sin datos: rellena a mano</span>'
    : _isbnEstado.fuente === 'online'
      ? '<span class="proc-online">Datos ONLINE (APIs gratuitas)</span>'
      : _isbnEstado.fuente === 'fichero+online'
        ? '<span class="proc-fichero">Fichero</span> + <span class="proc-online">huecos online</span>'
        : '<span class="proc-fichero">Fichero local</span>';
  cont.innerHTML = `<div class="box card">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <h3 style="margin:0;flex:1">📖 ISBN ${esc(_isbnEstado.isbn || '')}</h3>
      <span class="muted" style="font-size:12px">${cabeceraFuente}</span>
      <button class="btn" type="button" id="isbnModalX" title="Cerrar">✕</button>
    </div>
    ${leyenda}
    ${datos}
    <div style="margin-top:12px"><div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Portadas — ✓ marca las que archivar; pulsa una para elegir la ⭐ PORTADA (✔ = ≥800 px)</div>${galeria}</div>
    <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
      <button class="btn pri" type="button" id="isbnBuscarWeb" title="Busca más portadas por título+autor en OpenLibrary y Apple Books (sin clave) y las trae aquí para elegir">🔎 Buscar más portadas</button>
      <button class="btn" type="button" id="isbnCam" title="Fotografía el libro AHORA (sobre el tapete: recorta y mide automáticamente). El alta sigue usando los datos del ISBN.">📷 Cámara</button>
      <button class="btn" type="button" id="isbnAddFile">⬆️ Subir imagen</button>
      <button class="btn" type="button" id="isbnAddUrl">➕ Añadir por URL</button>
      <span class="muted" id="isbnWebMsg" style="font-size:12px"></span>
      <input type="file" id="isbnFile" accept="image/*" multiple style="display:none">
      <input type="file" id="isbnCamFile" accept="image/*" capture="environment" style="display:none">
    </div>
    <div id="isbnModalMsg" class="muted" style="font-size:12px;margin-top:10px;min-height:16px"></div>
    <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap;align-items:center">
      <button class="btn pri" type="button" id="isbnCrear">✅ Crear</button>
      <button class="btn" type="button" id="isbnCompletar" title="Enriquecer con las APIs y resolver la CDU antes de crear">✨ Completar y crear</button>
      <button class="btn" type="button" id="isbnCancel">Cancelar</button>
      <span id="isbnAutoEstadoModal" class="muted" style="font-size:12px;margin-left:auto"></span>
    </div></div>`;
  $('#isbnScrim').style.display = 'block';
  cont.style.display = 'grid';
  cont
    .querySelectorAll('[data-portada]')
    .forEach((el) => (el.onclick = () => isbnSetPortada(el.dataset.portada)));
  cont.querySelectorAll('[data-chk]').forEach(
    (el) =>
      (el.onchange = (e) => {
        e.stopPropagation();
        isbnToggleInc(el.dataset.chk);
      }),
  );
  cont.querySelectorAll('[data-edit]').forEach(
    (el) =>
      (el.onclick = (e) => {
        e.stopPropagation();
        isbnConformar(el.dataset.edit);
      }),
  );
  cont.querySelectorAll('[data-mk]').forEach(
    (el) =>
      (el.oninput = () => {
        const k = el.dataset.mk;
        _isbnEstado.meta[k] = CAMPOS_LISTA.includes(k)
          ? el.value
              .split(';')
              .map((s) => s.trim())
              .filter(Boolean)
          : el.value;
        // Editar a mano vuelve el dato AUTORITATIVO (neutro): se recolorea el campo y su etiqueta.
        _isbnEstado.procedencia[k] = 'manual';
        el.classList.remove('proc-online', 'proc-ia');
        el.classList.add('proc-fichero');
        const lab = el.previousElementSibling;
        if (lab && lab.tagName === 'LABEL') {
          lab.classList.remove('proc-online', 'proc-ia');
          lab.classList.add('proc-fichero');
        }
        isbnAutoReset(); // teclear = interacción → reinicia la cuenta atrás del auto-alta
      }),
  );
  $('#isbnAddUrl').onclick = isbnAddUrl;
  $('#isbnAddFile').onclick = () => $('#isbnFile').click();
  $('#isbnFile').onchange = () => _isbnAnadirArchivos($('#isbnFile'));
  if ($('#isbnCam')) $('#isbnCam').onclick = () => $('#isbnCamFile').click();
  if ($('#isbnCamFile')) $('#isbnCamFile').onchange = () => _isbnAnadirArchivos($('#isbnCamFile'));
  if ($('#isbnBuscarWeb')) $('#isbnBuscarWeb').onclick = isbnBuscarPortadasWeb;
  $('#isbnCrear').onclick = () => isbnCrear(false);
  $('#isbnCompletar').onclick = () => isbnCrear(true);
  const cerrar = () => {
    isbnCerrarModal();
    if ($('#isbnMsg')) $('#isbnMsg').textContent = '';
  };
  $('#isbnCancel').onclick = cerrar;
  $('#isbnModalX').onclick = cerrar;
  $('#isbnScrim').onclick = cerrar;
  cont.onkeydown = (e) => {
    if (e.key === 'Escape') cerrar();
  };
  // Datos cargados / re-render (elegir portada, incluir imagen, etc.) = interacción → reinicia la cuenta atrás
  // del auto-alta (solo salta con inactividad real). No hace nada si el switch está apagado.
  isbnAutoReset();
}
function _isbnItem(id) {
  const l = id[0] === 'c' ? _isbnEstado.portadas : _isbnEstado.extra;
  return l[+id.slice(1)];
}
function _isbnIncluidos() {
  const inc = [];
  _isbnEstado.portadas.forEach((p, i) => {
    if (p.sel) inc.push('c' + i);
  });
  _isbnEstado.extra.forEach((p, i) => {
    if (p.sel) inc.push('e' + i);
  });
  return inc;
}
// La portada siempre apunta a una imagen INCLUIDA; si deja de estarlo, pasa a la primera incluida (o ninguna).
function _isbnNormalizaPortada() {
  const inc = _isbnIncluidos();
  if (!inc.includes(_isbnEstado.portadaId)) _isbnEstado.portadaId = inc[0] || null;
}
function isbnToggleInc(id) {
  const it = _isbnItem(id);
  if (it) {
    it.sel = !it.sel;
    isbnRender();
  }
}
function isbnSetPortada(id) {
  const it = _isbnItem(id);
  if (it) {
    it.sel = true;
    _isbnEstado.portadaId = id;
    isbnRender();
  }
}
// Conformar (recortar/enderezar perspectiva) una portada antes de crear. Local (base64) → directo; remota
// (URL) → vía proxy same-origin para esquivar el CORS del canvas. El resultado depurado se añade como imagen.
function isbnConformar(id) {
  const remoto = id[0] === 'c';
  const i = +id.slice(1);
  const item = remoto ? _isbnEstado.portadas[i] : _isbnEstado.extra[i];
  if (!item) return;
  const src =
    !remoto && item.base64
      ? item.previa || item.base64
      : '/api/proxy-imagen?url=' +
        encodeURIComponent(item.url) +
        (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '');
  _editorImagen({
    src,
    onSave: (b64) => {
      if (remoto || !item.base64) {
        if (remoto) item.sel = false;
        _isbnEstado.extra.push({ base64: b64, previa: b64, tipo: 'imagen', sel: true, nombre: 'conformada' });
        _isbnEstado.portadaId = 'e' + (_isbnEstado.extra.length - 1);
      } else {
        item.base64 = b64;
        item.previa = b64;
        item.sel = true;
        _isbnEstado.portadaId = id;
      }
      cerrarCmp();
      isbnRender();
    },
    onClose: () => {
      cerrarCmp();
    },
  });
}
function isbnAddUrl() {
  const u = prompt('URL de la imagen (https://…):');
  if (!u) return;
  _isbnEstado.extra.push({ url: u.trim(), tipo: 'imagen', sel: true });
  isbnRender();
}
// Busca más portadas por título+autor (OpenLibrary Search + Apple Books, sin clave) y las añade como candidatas.
async function isbnBuscarPortadasWeb() {
  if (!_isbnEstado) return;
  const msg = $('#isbnWebMsg');
  if (msg) msg.textContent = 'Buscando portadas…';
  const a = _isbnEstado.meta.autores,
    autor = Array.isArray(a) ? a[0] || '' : a || '';
  let r;
  try {
    r = await api(
      '/buscar-portadas?isbn=' +
        encodeURIComponent(_isbnEstado.isbn || '') +
        '&titulo=' +
        encodeURIComponent(_isbnEstado.meta.titulo || '') +
        '&autor=' +
        encodeURIComponent(autor),
    );
  } catch (e) {
    if (msg) msg.textContent = e.message;
    return;
  }
  const nuevas = (r.portadas || []).filter((p) => !_isbnEstado.portadas.some((q) => q.url === p.url));
  nuevas.forEach((p) =>
    _isbnEstado.portadas.push({
      url: p.url,
      fuente: p.fuente || 'web',
      ancho: p.ancho || 0,
      alto: p.alto || 0,
      sel: false,
      web: true,
    }),
  );
  isbnRender();
  const m2 = $('#isbnWebMsg');
  if (m2)
    m2.textContent = nuevas.length
      ? `${nuevas.length} portada(s) encontradas (OpenLibrary/Apple). Marca la buena y ✎ para conformar.`
      : 'Sin resultados nuevos.';
}
// Añade imágenes desde un <input type=file> (galería o cámara con capture) como candidatas incluidas.
// Si la foto está sobre el TAPETE, se recorta+endereza y MIDE (reutiliza recortarYMedirTapete de la Cámara);
// las dimensiones viajan al alta por ISBN (que es autoritativa y SIN visión). Sin tapete, la imagen pasa igual.
async function _isbnAnadirArchivos(inp) {
  if (!inp) return;
  let files = [...inp.files];
  inp.value = '';
  if (!files.length) return;
  try {
    const r = await recortarYMedirTapete(files);
    files = r.files;
    if (r.dims) {
      _isbnEstado.dims = r.dims;
      toast(
        `📐 ${String(r.dims.ancho_cm).replace('.', ',')}×${String(r.dims.alto_cm).replace('.', ',')} cm${r.recortadas ? ' · recortado' : ''}`,
      );
    } else if (r.recortadas) toast('✂️ Recortado (sin medida fiable)');
  } catch (e) {
    /* sin tapete → imagen tal cual */
  }
  for (const f of files) {
    try {
      const red = await reducirImagen(f);
      const durl = await fileADataURL(red);
      _isbnEstado.extra.push({
        base64: durl,
        previa: durl,
        tipo: 'imagen',
        sel: true,
        nombre: f.name || 'foto',
      });
    } catch (e) {
      toast('Imagen no añadida: ' + e.message, 'bad');
    }
  }
  isbnRender();
}
async function isbnCrear(completar, auto = false) {
  if (!_isbnEstado) return;
  isbnAutoCancelar(); // el alta en curso detiene cualquier cuenta atrás pendiente
  _isbnNormalizaPortada();
  // Todas las imágenes INCLUIDAS (✓); la marcada como ⭐ portada va como tipo:'portada', el resto 'imagen'.
  const items = [];
  _isbnEstado.portadas.forEach((p, i) => {
    if (p.sel) items.push({ id: 'c' + i, url: p.url });
  });
  _isbnEstado.extra.forEach((p, i) => {
    if (p.sel) items.push(p.base64 ? { id: 'e' + i, base64: p.base64 } : { id: 'e' + i, url: p.url });
  });
  items.forEach((it) => (it.tipo = it.id === _isbnEstado.portadaId ? 'portada' : 'imagen'));
  if (items.length && !items.some((it) => it.tipo === 'portada')) items[0].tipo = 'portada';
  const imagenes = items.filter((s) => s.url).map((s) => ({ url: s.url, tipo: s.tipo }));
  const subidas = items.filter((s) => s.base64).map((s) => ({ base64: s.base64, tipo: s.tipo }));
  const ubic = {
    ambito: ($('#inAmbito') && $('#inAmbito').value) || undefined,
    estanteria: ($('#inEstanteria') && $('#inEstanteria').value) || undefined,
  };
  const body = {
    isbn: _isbnEstado.isbn,
    meta: { ..._isbnEstado.meta },
    imagenes,
    subidas,
    ubicacion: ubic,
    dimensiones: _isbnEstado.dims || undefined,
    coleccion: ($('#inColeccion') && $('#inColeccion').value) || undefined,
    obra: ($('#inObra') && $('#inObra').value) || undefined,
    completar,
  };
  const isbnActual = _isbnEstado.isbn;
  const msg = isbnMsgEl();
  if (msg) msg.textContent = completar ? 'Completando y creando…' : 'Creando…';
  let r;
  try {
    r = await api('/isbn/alta', { method: 'POST', body: JSON.stringify(body) });
  } catch (e) {
    // Un fallo del alta NUNCA puede pasar desapercibido (era la queja: «los fallos pasan desapercibidos»):
    // Toast en voz alta SIEMPRE + se DEJA el modal abierto con el mensaje para corregir. En modo AUTO además
    // se devuelve el foco al campo ISBN para que veas cuál falló y no se «pierda» el libro.
    if (msg) msg.textContent = 'Error: ' + e.message;
    toast('❌ No se pudo crear el ISBN ' + (isbnActual || '') + ': ' + e.message, 'bad');
    if (auto) {
      const inp = $('#isbnIn');
      if (inp) inp.focus();
    }
    return;
  }
  const loteItem = _loteEditItem; // capturar antes de que isbnCerrarModal lo ponga a null
  isbnCerrarModal();
  if ($('#isbnIn')) $('#isbnIn').value = '';
  const cardMsg = $('#isbnMsg');
  if (r.ya_existia) {
    toast('Este libro ya estaba en la biblioteca', 'warn');
    if (cardMsg) cardMsg.innerHTML = avisoYaIngresado(r);
  } else {
    toast('📗 Documento creado');
    // NO se navega a la ficha (interrumpía el flujo de escaneo): se deja un enlace por si quieres abrirla,
    // y el foco vuelve al campo ISBN para leer el siguiente. Ver ficha = clic voluntario, sin interrumpir.
    if (cardMsg) {
      cardMsg.innerHTML = r._id
        ? `✔ Creado: <a href="#" data-verdoc="${r._id}">${esc(r.titulo || 'ver ficha')}</a>`
        : '✔ Creado.';
      const a = cardMsg.querySelector('[data-verdoc]');
      if (a)
        a.onclick = (e) => {
          e.preventDefault();
          verDoc(r._id, { volver: 'inbox', etiqueta: 'Inbox' });
        };
    }
  }
  if (loteItem) {
    loteItem.estado = 'ok';
    loteRenderStack();
  }
  // SIEMPRE devolver el foco al campo ISBN para encadenar la siguiente lectura sin interrumpir el flujo.
  if ($('#isbnIn')) $('#isbnIn').focus();
}
// ── Alta por LOTE de ISBNs ──────────────────────────────────────────────────────────────────────────
// Pega/sube una lista de ISBN → se buscan TODOS en segundo plano (Fichero + huecos rellenados online,
// vía GET /isbn/lote/*) → se revisan en un CARRUSEL (un libro por diapositiva) con la portada grande y los
// datos EDITABLES a mano; se deseleccionan los que no interesen y «Enviar seleccionados» los crea en bloque
// (reutilizando el YA EXISTENTE POST /isbn/alta, uno a uno). Los que fallen quedan en la lista para reintentar.
let _lote = null; // { items: [ {entrada, ok, motivo, isbn, encontrado, fuente, meta, procedencia, portadas, portadaSel, sel, estado, error} ] }
let _lotePollTimer = null;
let _lotePos = 0; // índice del libro visible en el carrusel de revisión
let _loteEditItem = null; // (reservado) referencia a un ítem del lote abierto en el modal individual, si lo hubiera

// Extrae ISBN de un texto libre (portapapeles o .txt): un token por línea/coma/espacio; conserva la
// entrada TAL CUAL la escribió el usuario (para señalar cuál falló) pero deduplica por su forma limpia.
function loteParseISBNs(texto) {
  const tokens = String(texto || '')
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const vistos = new Set(),
    out = [];
  for (const t of tokens) {
    const limpio = t.replace(/[^0-9Xx]/g, '').toUpperCase();
    if (limpio.length !== 10 && limpio.length !== 13) continue;
    if (vistos.has(limpio)) continue;
    vistos.add(limpio);
    out.push(t);
  }
  return out;
}

function loteWire() {
  if ($('#lotePegar'))
    $('#lotePegar').onclick = async () => {
      try {
        const texto = await navigator.clipboard.readText();
        const ta = $('#loteTxt');
        if (ta) ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + texto;
      } catch (e) {
        toast('No se pudo leer el portapapeles: ' + e.message, 'bad');
      }
    };
  if ($('#loteSubirBtn')) $('#loteSubirBtn').onclick = () => $('#loteFile').click();
  if ($('#loteFile'))
    $('#loteFile').onchange = async () => {
      const f = $('#loteFile').files[0];
      $('#loteFile').value = '';
      if (!f) return;
      const texto = await f.text();
      const ta = $('#loteTxt');
      if (ta) ta.value = (ta.value.trim() ? ta.value.trim() + '\n' : '') + texto;
    };
  if ($('#loteBuscar')) $('#loteBuscar').onclick = loteBuscar;
}

async function loteBuscar() {
  const isbns = loteParseISBNs($('#loteTxt') && $('#loteTxt').value);
  const prog = $('#loteProg');
  // No se pisa en silencio una revisión anterior con ítems aún sin enviar (deseleccionados/fallidos que
  // el usuario dejó «a disposición» para completar a mano): hay que enviarlos o descartar el lote primero.
  if (_lote && _lote.items.some((it) => it.estado !== 'ok')) {
    if (prog) prog.textContent = '⚠ Hay ISBN del lote anterior sin enviar. Envíalos o pulsa «🗑 Descartar lote» antes de buscar uno nuevo.';
    return;
  }
  if (!isbns.length) {
    if (prog) prog.textContent = '⚠ No se ha reconocido ningún ISBN (10 o 13 dígitos) en el texto.';
    return;
  }
  $('#loteStack').innerHTML = '';
  _lote = null;
  if (prog) prog.textContent = `Buscando 0/${isbns.length}…`;
  let r;
  try {
    r = await api('/isbn/lote/iniciar', { method: 'POST', body: JSON.stringify({ isbns }) });
  } catch (e) {
    if (prog) prog.textContent = 'Error: ' + e.message;
    return;
  }
  if (!r.ok) {
    if (prog) prog.textContent = '⚠ ' + (r.motivo || 'no se pudo iniciar la búsqueda');
    return;
  }
  if (_lotePollTimer) clearInterval(_lotePollTimer);
  _lotePollTimer = setInterval(lotePoll, 1200);
  lotePoll();
}

async function lotePoll() {
  let r;
  try {
    r = await api('/isbn/lote/estado');
  } catch (e) {
    return; // fallo de red puntual del sondeo: se reintenta en el siguiente tick
  }
  const prog = $('#loteProg');
  if (prog) prog.textContent = `Buscando ${r.hechos}/${r.total}…`;
  if (r.enCurso) return;
  clearInterval(_lotePollTimer);
  _lotePollTimer = null;
  if (prog) prog.textContent = `✔ Búsqueda completa: ${r.total} ISBN.`;
  _lote = {
    items: (r.resultados || []).map((res) => ({
      ...res,
      sel: !!(res.ok && res.encontrado && res.meta && res.meta.titulo),
      portadaSel: 0, // índice de la portada elegida entre las candidatas
      estado: null, // null | 'ok' | 'error'
      error: null,
    })),
  };
  _lotePos = 0;
  loteRenderStack();
}

function loteSeleccionados() {
  return _lote ? _lote.items.filter((it) => it.sel && it.estado !== 'ok') : [];
}
// URL mostrable de una candidata de portada (las «web» de Google van por el proxy same-origin; el resto directo).
function portadaSrc(p) {
  return p.web
    ? '/api/proxy-imagen?url=' + encodeURIComponent(p.url) + (TOKEN ? '&token=' + encodeURIComponent(TOKEN) : '')
    : p.url;
}

// El lote se revisa en un CARRUSEL: un libro por «diapositiva» con su portada grande (elige entre las
// candidatas), sus datos EDITABLES a mano (coloreados por procedencia) y la casilla «Incluir». Debajo, una
// tira de puntos para saltar y ver de un vistazo cuáles están seleccionados/creados/con error. «Enviar
// seleccionados» los crea en bloque. (Sustituye al antiguo botón ✎ por-fila, que confundía: parecía editar
// pero abría el alta.)
function loteRenderStack() {
  const cont = $('#loteStack');
  if (!cont || !_lote) return;
  const items = _lote.items;
  const total = items.length;
  if (!total) {
    cont.innerHTML = '<div class="muted" style="font-size:12px">Lote vacío.</div>';
    return;
  }
  _lotePos = Math.max(0, Math.min(_lotePos, total - 1));
  const creados = items.filter((it) => it.estado === 'ok').length;
  const nSel = loteSeleccionados().length;
  const it = items[_lotePos];
  // Tira de puntos: color según estado (creado/error/seleccionado/pendiente) y borde en el actual.
  const puntos = items
    .map((x, i) => {
      const color =
        x.estado === 'ok'
          ? '#7cd992'
          : x.estado === 'error'
            ? 'var(--bad)'
            : x.sel
              ? 'var(--acc)'
              : 'var(--line)';
      const actual = i === _lotePos ? 'box-shadow:0 0 0 2px var(--txt)' : '';
      return `<button type="button" data-lote-ir="${i}" title="${esc((x.meta && x.meta.titulo) || x.entrada)}" style="width:14px;height:14px;border-radius:50%;border:none;cursor:pointer;background:${color};${actual}"></button>`;
    })
    .join('');
  cont.innerHTML = `
    <div class="row" style="align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
      <b>${nSel}</b><span class="muted" style="font-size:12px">seleccionados de ${total}${creados ? ` · ${creados} creados` : ''}</span>
      <button class="btn pri" type="button" id="loteEnviar" ${nSel ? '' : 'disabled'}>✅ Enviar seleccionados (${nSel})</button>
      <button class="btn" type="button" id="loteLimpiar">🗑 Descartar lote</button>
    </div>
    <div class="muted" style="font-size:11px;margin-bottom:8px">
      Procedencia del dato: <b class="proc-fichero">■ Fichero / a mano</b> ·
      <b class="proc-online">■ APIs gratuitas</b> · <b class="proc-ia">■ IA / de pago</b></div>
    <div class="row" style="align-items:center;gap:8px;justify-content:space-between;margin-bottom:6px">
      <button class="btn" type="button" id="lotePrev" ${_lotePos === 0 ? 'disabled' : ''}>‹ Anterior</button>
      <span class="muted" style="font-size:12px">Libro ${_lotePos + 1} / ${total}</span>
      <button class="btn" type="button" id="loteNext" ${_lotePos === total - 1 ? 'disabled' : ''}>Siguiente ›</button>
    </div>
    ${loteSlideHTML(it, _lotePos)}
    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin-top:12px">${puntos}</div>`;
  // Navegación
  cont.querySelectorAll('[data-lote-ir]').forEach((el) => (el.onclick = () => loteIr(+el.dataset.loteIr)));
  if ($('#lotePrev')) $('#lotePrev').onclick = () => loteIr(_lotePos - 1);
  if ($('#loteNext')) $('#loteNext').onclick = () => loteIr(_lotePos + 1);
  // Elegir portada entre las candidatas
  cont.querySelectorAll('[data-lote-port]').forEach(
    (el) =>
      (el.onclick = () => {
        it.portadaSel = +el.dataset.lotePort;
        loteRenderStack();
      }),
  );
  // Casilla incluir / quitar del lote
  cont.querySelectorAll('[data-lote-chk]').forEach((el) => (el.onchange = () => loteToggleSel(+el.dataset.loteChk)));
  cont.querySelectorAll('[data-lote-quitar]').forEach((el) => (el.onclick = () => loteQuitar(+el.dataset.loteQuitar)));
  // Edición a mano de los campos: actualiza el dato y lo vuelve AUTORITATIVO (negro), sin re-render (para no
  // perder el foco mientras se escribe).
  cont.querySelectorAll('[data-lm]').forEach(
    (el) =>
      (el.oninput = () => {
        const k = el.dataset.lm;
        it.meta = it.meta || {};
        it.meta[k] = CAMPOS_LISTA.includes(k)
          ? el.value
              .split(';')
              .map((s) => s.trim())
              .filter(Boolean)
          : el.value;
        it.procedencia = it.procedencia || {};
        it.procedencia[k] = 'manual';
        el.classList.remove('proc-online', 'proc-ia');
        el.classList.add('proc-fichero');
        const lab = el.previousElementSibling;
        if (lab && lab.tagName === 'LABEL') {
          lab.classList.remove('proc-online', 'proc-ia');
          lab.classList.add('proc-fichero');
        }
      }),
  );
  if ($('#loteEnviar')) $('#loteEnviar').onclick = loteEnviarSeleccionados;
  if ($('#loteLimpiar'))
    $('#loteLimpiar').onclick = () => {
      _lote = null;
      cont.innerHTML = '';
      if ($('#loteProg')) $('#loteProg').textContent = '';
      if ($('#loteTxt')) $('#loteTxt').value = '';
    };
}

// Una diapositiva del carrusel = un libro: portada grande + tira de candidatas + datos editables + estado.
function loteSlideHTML(it, idx) {
  const creado = it.estado === 'ok';
  const m = it.meta || {};
  const portadas = it.portadas || [];
  const sel = it.portadaSel || 0;
  const cover = portadas[sel]
    ? `<img src="${esc(portadaSrc(portadas[sel]))}" style="width:160px;height:224px;object-fit:contain;border-radius:8px;background:var(--card)" loading="lazy">`
    : `<div style="width:160px;height:224px;border-radius:8px;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:30px">🚫</div>`;
  const tira = portadas
    .map(
      (p, i) =>
        `<img data-lote-port="${i}" src="${esc(portadaSrc(p))}" title="${esc(p.fuente)} ${p.ancho}×${p.alto}" style="width:38px;height:54px;object-fit:contain;border-radius:4px;cursor:pointer;background:var(--card);border:2px solid ${i === sel ? '#ffcf5a' : 'transparent'}" loading="lazy">`,
    )
    .join('');
  const badge = creado
    ? '<span style="color:#7cd992;font-size:12px">✓ creado</span>'
    : it.estado === 'error'
      ? `<span class="proc-ia" style="font-size:12px" title="${esc(it.error || '')}">✗ ${esc(it.error || 'error')}</span>`
      : !it.ok
        ? `<span class="proc-ia" style="font-size:12px">⚠ ${esc(it.motivo || 'ISBN inválido')}</span>`
        : !it.encontrado
          ? '<span style="color:var(--warn);font-size:12px">⚠ sin datos: complétalos a mano</span>'
          : `<span class="muted" style="font-size:12px">${esc(it.fuente || '')}</span>`;
  const dis = creado ? 'disabled' : '';
  const campo = (k, etiqueta) => {
    const cls = procClase(it.procedencia, k);
    const v = m[k] != null ? (Array.isArray(m[k]) ? m[k].join('; ') : String(m[k])) : '';
    return `<div><label class="${cls}">${etiqueta}</label><input data-lm="${k}" class="${cls}" value="${esc(v)}" ${dis} autocomplete="off"></div>`;
  };
  return `<div class="card" style="background:var(--card2)">
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      <div style="text-align:center">
        ${cover}
        <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:center;margin-top:6px;max-width:160px">${tira}</div>
      </div>
      <div style="flex:1;min-width:230px">
        <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
          <label style="margin:0;display:inline-flex;align-items:center;gap:5px;font-weight:600"><input type="checkbox" data-lote-chk="${idx}" ${it.sel ? 'checked' : ''} ${dis} style="width:16px;height:16px"> Incluir</label>
          <span style="margin-left:auto">${badge}</span>
          <button class="btn" type="button" data-lote-quitar="${idx}" ${dis} title="Quitar del lote (no se crea)">🗑</button>
        </div>
        <div class="muted" style="font-size:11px;margin-bottom:8px">ISBN ${esc(it.isbn || it.entrada)}</div>
        <div class="row">${campo('titulo', 'Título')}${campo('autores', 'Autores (separa con ;)')}</div>
        <div class="row" style="margin-top:6px">${campo('editorial', 'Editorial')}${campo('año_edicion', 'Año')}</div>
        <div class="row" style="margin-top:6px">${campo('idioma', 'Idioma')}${campo('cdu', 'CDU')}</div>
        <div class="row" style="margin-top:6px">${campo('coleccion_nombre', 'Colección')}${campo('palabras_clave', 'Palabras clave (;)')}</div>
      </div>
    </div>
  </div>`;
}

function loteIr(pos) {
  if (!_lote) return;
  _lotePos = Math.max(0, Math.min(pos, _lote.items.length - 1));
  loteRenderStack();
}

function loteToggleSel(idx) {
  const it = _lote && _lote.items[idx];
  if (!it || it.estado === 'ok') return;
  it.sel = !it.sel;
  loteRenderStack();
}

function loteQuitar(idx) {
  if (!_lote) return;
  _lote.items.splice(idx, 1);
  if (_lotePos >= _lote.items.length) _lotePos = _lote.items.length - 1;
  loteRenderStack();
}

// Envío en bloque: uno a uno (no en paralelo, para no saturar el servidor ni dar rodeos al usuario sobre
// qué falló), reutilizando el mismo POST /isbn/alta que el alta individual — alta RÁPIDA (sin reenriquecer:
// el lote ya buscó los datos). Ubicación = los campos compartidos de «Datos de esta alta»; Colección = la
// propia del ISBN si la trae, o si no la del campo del lote (relleno de hueco, nunca pisa una ya detectada).
// Portada = la elegida en el carrusel (it.portadaSel).
async function loteEnviarSeleccionados() {
  const items = loteSeleccionados();
  if (!items.length) return;
  const btn = $('#loteEnviar');
  if (btn) btn.disabled = true;
  const ubic = {
    ambito: ($('#inAmbito') && $('#inAmbito').value) || undefined,
    estanteria: ($('#inEstanteria') && $('#inEstanteria').value) || undefined,
  };
  const coleccionLote = ($('#loteColeccion') && $('#loteColeccion').value.trim()) || '';
  let ok = 0,
    fallo = 0;
  for (const it of items) {
    const m = it.meta || {};
    if (!m.titulo) {
      it.estado = 'error';
      it.error = 'Falta el título';
      fallo++;
      loteRenderStack();
      continue;
    }
    const prog = $('#loteProg');
    if (prog) prog.textContent = `Creando ${ok + fallo + 1}/${items.length}: «${m.titulo}»…`;
    const portadaElegida = it.portadas && it.portadas[it.portadaSel || 0] ? it.portadas[it.portadaSel || 0].url : null;
    const body = {
      isbn: it.isbn,
      meta: { ...m },
      imagenes: portadaElegida ? [{ url: portadaElegida, tipo: 'portada' }] : [],
      subidas: [],
      ubicacion: ubic,
      coleccion: m.coleccion_nombre ? undefined : coleccionLote || undefined,
      completar: false,
    };
    try {
      await api('/isbn/alta', { method: 'POST', body: JSON.stringify(body) });
      it.estado = 'ok';
      ok++;
    } catch (e) {
      it.estado = 'error';
      it.error = e.message;
      fallo++;
    }
    loteRenderStack();
  }
  if (btn) btn.disabled = false;
  const prog = $('#loteProg');
  if (prog) prog.textContent = `Lote enviado: ${ok} creado(s)${fallo ? ` · ${fallo} con error (quedan en la lista)` : ''}.`;
  toast(`📚 Lote: ${ok} creado(s)${fallo ? ` · ${fallo} con error` : ''}`, fallo ? 'warn' : 'ok');
}

// Autocompletado del campo Colección con las colecciones existentes.
async function cargarDatalistColecciones() {
  const dl = $('#dlColecciones');
  if (!dl) return;
  try {
    const r = await api('/colecciones');
    const cols = r.colecciones || r.items || (Array.isArray(r) ? r : []);
    dl.innerHTML = (Array.isArray(cols) ? cols : [])
      .map((c) => `<option value="${esc(c.nombre || '')}">`)
      .join('');
  } catch (e) {}
}
// ── Ubicaciones (ámbito → estanterías): se acumulan según se cataloga, así puedes elegirlas de un
// desplegable. La estantería va ASOCIADA al ámbito (un «Estante 1» en «Comedor» ≠ otro en «Biblioteca»).
let mapaUbicaciones = [];
function llenarDatalist(id, valores) {
  const dl = $('#' + id);
  if (!dl) return;
  dl.innerHTML = (valores || []).map((v) => `<option value="${esc(v)}">`).join('');
}
// Estanterías de un ámbito (según el mapa de ubicaciones), comparando el nombre sin distinguir may/min.
function estanteriasDe(ambito) {
  const buscado = (ambito || '').trim().toLowerCase();
  const entrada = mapaUbicaciones.find((u) => (u.ambito || '').trim().toLowerCase() === buscado);
  return entrada ? entrada.estanterias : [];
}
// <select> de ámbito/estantería FIABLE (en móvil el datalist sale en la barra del teclado, no como
// desplegable). Despliega SIEMPRE sus valores; la estantería va asociada al ámbito (al cambiarlo se
// vacía/recalcula); «➕ Otra…» revela un campo de texto para crear una nueva. Los inputs OCULTOS
// (#<ia>/#<ie>) guardan el valor final que se envía/guarda.
function montarSelUbic(o) {
  const SIN = 'Sin asignar';
  const sa = $('#' + o.sa),
    ia = $('#' + o.ia),
    se = $('#' + o.se),
    ie = $('#' + o.ie);
  if (!sa || !ia || !se || !ie) return;
  const curA = o.curA && o.curA !== SIN ? o.curA : '',
    curE = o.curE && o.curE !== SIN ? o.curE : '';
  const mk = (arr, cur) => {
    const set = [...new Set((arr || []).filter(Boolean))];
    if (cur && !set.includes(cur)) set.unshift(cur);
    return [
      '<option value="">— sin asignar —</option>',
      ...set.map((v) => `<option${v === cur ? ' selected' : ''}>${esc(v)}</option>`),
      '<option value="__new__">➕ Otra…</option>',
    ].join('');
  };
  sa.innerHTML = mk(
    mapaUbicaciones.map((x) => x.ambito),
    curA,
  );
  se.innerHTML = mk(estanteriasDe(curA), curE);
  ia.value = curA;
  ie.value = curE;
  ia.style.display = 'none';
  ie.style.display = 'none';
  sa.onchange = () => {
    if (sa.value === '__new__') {
      ia.style.display = '';
      ia.value = '';
      ia.focus();
    } else {
      ia.style.display = 'none';
      ia.value = sa.value;
    }
    se.innerHTML = mk(estanteriasDe(ia.value), '');
    ie.value = se.value === '__new__' ? '' : se.value;
    ie.style.display = se.value === '__new__' ? '' : 'none';
  };
  se.onchange = () => {
    if (se.value === '__new__') {
      ie.style.display = '';
      ie.value = '';
      ie.focus();
    } else {
      ie.style.display = 'none';
      ie.value = se.value;
    }
  };
}
function refrescarInboxUbic() {
  if (!$('#inAmbSel')) return;
  montarSelUbic({
    sa: 'inAmbSel',
    ia: 'inAmbito',
    se: 'inEstSel',
    ie: 'inEstanteria',
    curA: ($('#inAmbito') && $('#inAmbito').value) || '',
    curE: ($('#inEstanteria') && $('#inEstanteria').value) || '',
  });
}
async function cargarUbicaciones() {
  try {
    const r = await api('/ubicaciones');
    mapaUbicaciones = r.ambitos || [];
  } catch (e) {
    return;
  }
  refrescarInboxUbic(); // desplegables del Inbox
  pintarUbicSearch(); // y los del filtro de Búsqueda
}
// Filtro de Búsqueda por ubicación: el <select> de ámbitos y, dependiente, el de estanterías (las del
// ámbito elegido). Conservan la selección actual al repintar.
function pintarUbicSearch() {
  const selAmbito = $('#sqAmbito');
  if (selAmbito) {
    const previo = selAmbito.value;
    selAmbito.innerHTML =
      '<option value="">Todos</option>' +
      mapaUbicaciones.map((u) => `<option value="${esc(u.ambito)}">${esc(u.ambito)}</option>`).join('');
    selAmbito.value = previo;
  }
  pintarEstanteriaSearch();
}
function pintarEstanteriaSearch() {
  const selEstanteria = $('#sqEstanteria');
  if (!selEstanteria) return;
  const ambito = ($('#sqAmbito') && $('#sqAmbito').value) || '';
  const previo = selEstanteria.value;
  const estanterias = estanteriasDe(ambito);
  selEstanteria.innerHTML =
    '<option value="">Todas</option>' +
    estanterias.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  selEstanteria.disabled = !ambito;
  // Conserva la estantería previa solo si sigue existiendo en el ámbito elegido.
  selEstanteria.value = [...selEstanteria.options].some((o) => o.value === previo) ? previo : '';
}
// Nombre de fichero LIMPIO y CORTO para una imagen (evita '.jpg.jpg', rutas y basura numérica larga que
// estresa el sistema de ficheros). Conserva un nombre original razonable; si es vacío/largo/numérico-basura
// lo sustituye por 'foto-xxxxxx'. El servidor ya antepone un sello único, así que aquí basta con ser breve.
function nombreImagen(nombre, ext = 'jpg') {
  let base = String(nombre || '')
    .replace(/^.*[\\/]/, '')          // sin ruta
    .replace(/\.[a-z0-9]{2,5}$/i, '') // sin extensión (una sola vez → mata el '.jpg.jpg')
    .replace(/[^\w.-]+/g, '_')        // saneado sistema de ficheros
    .replace(/_+/g, '_').replace(/^[._-]+|[._-]+$/g, '');
  if (!base || base.length > 32 || /^\d{9,}$/.test(base)) base = 'foto-' + Math.random().toString(36).slice(2, 8);
  return base + '.' + ext;
}
// Extensión de imagen de un File (por su nombre o su MIME), en minúsculas y sin punto.
function extImagen(file) {
  const m = String(file && file.name || '').match(/\.([a-z0-9]{2,5})$/i);
  return (m ? m[1] : ((file && file.type || '').split('/')[1] || 'jpg')).toLowerCase().replace('jpeg', 'jpg');
}

// Reduce una foto a máx. `ladoMax` px (por el lado mayor) reescalándola en un canvas antes de subir →
// menos datos y más rápido en el Atom. `calidad` = calidad JPEG (0..1). Si ya es más pequeña, devuelve el
// fichero original tal cual. Devuelve una Promise con un File JPEG (o el original si algo falla).
function reducirImagen(file, ladoMax = 2000, calidad = 0.85) {
  return new Promise((resolver, rechazar) => {
    const imagen = new Image();
    const urlObjeto = URL.createObjectURL(file);
    imagen.onload = () => {
      URL.revokeObjectURL(urlObjeto);
      const anchoOrig = imagen.naturalWidth;
      const altoOrig = imagen.naturalHeight;
      const escala = Math.min(1, ladoMax / Math.max(anchoOrig, altoOrig));
      if (escala >= 1) {
        // Ya cabe: no reescalar, pero renombrar limpio (conserva bytes/tipo) para no arrastrar nombres largos.
        resolver(new File([file], nombreImagen(file.name, extImagen(file)), { type: file.type || 'image/jpeg' }));
        return;
      }
      const lienzo = document.createElement('canvas');
      lienzo.width = Math.round(anchoOrig * escala);
      lienzo.height = Math.round(altoOrig * escala);
      lienzo.getContext('2d').drawImage(imagen, 0, 0, lienzo.width, lienzo.height);
      lienzo.toBlob(
        (blob) => resolver(blob ? new File([blob], nombreImagen(file.name, 'jpg'), { type: 'image/jpeg' }) : file),
        'image/jpeg',
        calidad,
      );
    };
    imagen.onerror = () => {
      URL.revokeObjectURL(urlObjeto);
      rechazar(new Error('img'));
    };
    imagen.src = urlObjeto;
  });
}
// Pinta las miniaturas de las fotos tomadas con la cámara (cola `camFotos`), cada una con su ✕ para
// quitarla, y actualiza el botón «Catalogar (N)» y el de limpiar según cuántas haya.
function renderCamThumbs() {
  const cont = $('#camThumbs');
  if (cont)
    cont.innerHTML = camFotos
      .map(
        (foto, i) =>
          `<span style="position:relative;display:inline-block"><img src="${URL.createObjectURL(foto)}" style="width:62px;height:82px;object-fit:cover;border-radius:6px;border:1px solid var(--line)"><button class="btn bad" type="button" data-rm="${i}" title="Quitar" style="position:absolute;top:-7px;right:-7px;padding:0 6px;border-radius:50%;line-height:18px">✕</button></span>`,
      )
      .join('');
  $$('#camThumbs [data-rm]').forEach(
    (boton) =>
      (boton.onclick = () => {
        camFotos.splice(+boton.dataset.rm, 1);
        renderCamThumbs();
      }),
  );
  const btnCatalogar = $('#camDone');
  if (btnCatalogar) {
    btnCatalogar.textContent = `✅ Catalogar (${camFotos.length})`;
    btnCatalogar.disabled = !camFotos.length;
  }
  const btnLimpiar = $('#camClear');
  if (btnLimpiar) btnLimpiar.style.display = camFotos.length ? '' : 'none';
}
async function camCatalogar() {
  if (!camFotos.length) {
    toast('Haz al menos una foto', 'warn');
    return;
  }
  const files = camFotos.slice();
  camFotos = [];
  renderCamThumbs();
  await subirInbox(files);
}
// FormData con los METADATOS del formulario (viajan con la subida → el pipeline trabaja menos).
// Metadatos del formulario como objeto (snapshot) → cada trabajo encolado lleva LOS SUYOS (el form
// puede cambiar mientras la cola procesa en segundo plano).
function metaSnapshot() {
  const valorCampo = (id) => (($('#' + id) && $('#' + id).value) || '').trim();
  return {
    isbn: valorCampo('inIsbn'),
    coleccion: valorCampo('inColeccion'),
    obra: valorCampo('inObra'),
    ambito: valorCampo('inAmbito'),
    estanteria: valorCampo('inEstanteria'),
  };
}
// Construye el FormData de la subida a partir del snapshot de metadatos + los ficheros elegidos.
function fdDesdeSnap(snap, files) {
  const formData = new FormData();
  if (snap.isbn) formData.append('isbn', snap.isbn);
  if (snap.isbn && snap.isbnOrigen) formData.append('isbn_origen', snap.isbnOrigen);
  if (snap.coleccion) formData.append('coleccion', snap.coleccion);
  if (snap.obra) formData.append('obra', snap.obra);
  if (snap.ambito || snap.estanteria)
    formData.append(
      'ubicacion',
      JSON.stringify({ ambito: snap.ambito || 'Sin asignar', estanteria: snap.estanteria || 'Sin asignar' }),
    );
  for (const fichero of files) formData.append('files', fichero, fichero.name);
  return formData;
}
// POST multipart /api/ingestar con PROGRESO DE SUBIDA. Se usa XHR (no fetch) porque fetch NO expone
// `upload.onprogress`: sin él, subir un fichero grande (p. ej. un PDF de 100+ MB) dejaba la UI en
// «⏳ Subiendo…» sin avanzar, y si el servidor tardaba en responder parecía un fallo SILENCIOSO. `onProgress`
// recibe (bytesSubidos, bytesTotales) mientras sube; al 100% el servidor pasa a catalogar. 403 = no admin.
function enviarIngesta(formData, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/ingestar');
    if (TOKEN) xhr.setRequestHeader('Authorization', 'Bearer ' + TOKEN);
    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    }
    xhr.onload = () => {
      if (xhr.status === 403) return reject(new Error('Solo los administradores pueden dar de alta recursos.'));
      let j = {};
      try { j = JSON.parse(xhr.responseText); } catch { /* respuesta no-JSON → {} */ }
      resolve(j);
    };
    xhr.onerror = () => reject(new Error('Error de red durante la subida (¿fichero demasiado grande o conexión caída?).'));
    xhr.send(formData);
  });
}
// Línea de estado del Inbox (bajo la zona de subida). Texto vacío = la limpia.
function setInboxEstado(texto) {
  const cont = $('#inboxEstado');
  if (cont) cont.innerHTML = texto ? `<span class="muted" style="font-size:13px">${esc(texto)}</span>` : '';
}
const esPdf = (f) => /\.pdf$/i.test((f && f.name) || '') || (f && f.type) === 'application/pdf';
// Conjunto de códigos de operación de pdf.js que PINTAN una imagen (para detectar páginas-foto de un escaneo).
function opsImagenPdf() {
  const ops = (window.pdfjsLib && window.pdfjsLib.OPS) || {};
  return new Set(
    [ops.paintImageXObject, ops.paintJpegXObject, ops.paintInlineImageXObject, ops.paintImageMaskXObject]
      .filter((codigo) => codigo != null),
  );
}
// Explota un PDF de ESCANEO (Adobe Scan/cámara) en páginas JPG EN EL NAVEGADOR (pdf.js). "escaneo" = las
// primeras páginas dibujan una imagen a página completa (foto). Un PDF DIGITAL de texto NO se explota
// (se sube tal cual; lo trata el servidor). Devuelve {escaneo, pages:File[]}.
async function pdfAImagenes(file, { maxPag = 60, ancho = 1500 } = {}) {
  await cargarPdfLib();
  const lib = window.pdfjsLib;
  lib.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.min.js';
  const pdf = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  try {
    const totalPaginas = pdf.numPages;
    const opsImg = opsImagenPdf();
    // Se considera "escaneo" si las primeras páginas (hasta 2) pintan una imagen: se explotan a JPG.
    const aComprobar = Math.min(totalPaginas, 2);
    let conImagen = 0;
    for (let i = 1; i <= aComprobar; i++) {
      const pagina = await pdf.getPage(i);
      const operaciones = await pagina.getOperatorList();
      if (operaciones.fnArray.some((fn) => opsImg.has(fn))) conImagen++;
    }
    if (!(aComprobar > 0 && conImagen === aComprobar)) return { escaneo: false, pages: [] }; // PDF digital → no explotar

    const pages = [];
    const nPaginas = Math.min(totalPaginas, maxPag);
    for (let i = 1; i <= nPaginas; i++) {
      const pagina = await pdf.getPage(i);
      const vistaBase = pagina.getViewport({ scale: 1 });
      const vista = pagina.getViewport({ scale: Math.max(1, Math.min(3, ancho / vistaBase.width)) });
      const lienzo = document.createElement('canvas');
      lienzo.width = Math.round(vista.width);
      lienzo.height = Math.round(vista.height);
      await pagina.render({ canvasContext: lienzo.getContext('2d'), viewport: vista }).promise;
      const blob = await new Promise((resolver) => lienzo.toBlob(resolver, 'image/jpeg', 0.85));
      if (blob)
        pages.push(new File([blob], 'pag-' + String(i).padStart(3, '0') + '.jpg', { type: 'image/jpeg' }));
      lienzo.width = lienzo.height = 0; // libera memoria del canvas (importante en el Atom/móvil)
    }
    return { escaneo: true, pages };
  } finally {
    try {
      pdf.destroy();
    } catch (_) {}
  }
}
// ── TAPETE: medir + recortar el libro sobre la alfombrilla, en el navegador (sin IA). Reutiliza
//    detectarBordesVerde / detectarRejillaPxCm / _homografia. ──
// Carga un File/Blob como <img> ya decodificada (para el tapete/CV). Rechaza si no carga.
function fileAImagen(fichero) {
  return new Promise((resolver, rechazar) => {
    const imagen = new Image();
    imagen.onload = () => resolver(imagen);
    imagen.onerror = rechazar;
    imagen.src = URL.createObjectURL(fichero);
  });
}
const _esImg = (f) =>
  /^image\//.test((f && f.type) || '') || /\.(jpe?g|png|webp)$/i.test((f && f.name) || '');
// Rectifica (recorta + desestira) el libro definido por quad a un rectángulo frontal. Devuelve canvas|null.
function rectificarLibro(work, quad, TOPE = 2200) {
  const [TL, TR, BR, BL] = quad;
  let W = Math.round((_dist(TL, TR) + _dist(BL, BR)) / 2),
    H = Math.round((_dist(TL, BL) + _dist(TR, BR)) / 2);
  if (W < 16 || H < 16) return null;
  const f = Math.min(1, TOPE / Math.max(W, H));
  W = Math.round(W * f);
  H = Math.round(H * f);
  const Hi = _homografia(
    [
      [0, 0],
      [W, 0],
      [W, H],
      [0, H],
    ],
    quad,
  ); // rect de salida → fuente
  const sd = work.getContext('2d').getImageData(0, 0, work.width, work.height).data,
    sw = work.width,
    sh = work.height;
  const oc = document.createElement('canvas');
  oc.width = W;
  oc.height = H;
  const octx = oc.getContext('2d');
  const out = octx.createImageData(W, H),
    od = out.data;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const [sx, sy] = _mapH(Hi, x + 0.5, y + 0.5);
      const ix = sx | 0,
        iy = sy | 0;
      const o = (y * W + x) * 4;
      if (ix >= 0 && iy >= 0 && ix < sw && iy < sh) {
        const s = (iy * sw + ix) * 4;
        od[o] = sd[s];
        od[o + 1] = sd[s + 1];
        od[o + 2] = sd[s + 2];
        od[o + 3] = 255;
      } else od[o + 3] = 255;
    }
  octx.putImageData(out, 0, 0);
  return oc;
}
// Procesa las imágenes que estén sobre el tapete: recorta+endereza cada una y MIDE (de la 1.ª plausible). Las
// que no tengan tapete/libro pasan TAL CUAL. Devuelve {files, dims:{ancho_cm,alto_cm}|null}.
async function recortarYMedirTapete(files) {
  let dims = null,
    recortadas = 0,
    tapetePct = null;
  const out = [];
  for (const f of files) {
    if (!_esImg(f)) {
      out.push(f);
      continue;
    }
    let url = null;
    try {
      const img = await fileAImagen(f);
      url = img.src;
      const work = document.createElement('canvas');
      work.width = img.naturalWidth;
      work.height = img.naturalHeight;
      work.getContext('2d').drawImage(img, 0, 0);
      if (tapetePct === null) {
        try {
          tapetePct = Math.round(fraccionVerde(work) * 100);
        } catch (_) {}
      } // diagnóstico
      const q = detectarBordesVerde(work);
      if (!q) {
        out.push(f);
        continue;
      } // sin tapete/libro → intacta
      if (!dims) {
        const pxcm = detectarRejillaPxCm(work);
        if (pxcm) {
          const W = (_dist(q[0], q[1]) + _dist(q[3], q[2])) / 2 / pxcm,
            H = (_dist(q[0], q[3]) + _dist(q[1], q[2])) / 2 / pxcm;
          if (W >= 4 && W <= 50 && H >= 4 && H <= 50)
            dims = { ancho_cm: +W.toFixed(1), alto_cm: +H.toFixed(1) };
        }
      }
      const oc = rectificarLibro(work, q);
      if (oc) {
        const blob = await new Promise((r) => oc.toBlob(r, 'image/jpeg', 0.9));
        out.push(
          blob
            ? new File([blob], nombreImagen(f.name || 'tapete', 'jpg'), { type: 'image/jpeg' })
            : f,
        );
        recortadas++;
      } else out.push(f);
    } catch (e) {
      console.warn('[tapete]', e && e.message);
      out.push(f);
    } finally {
      if (url)
        try {
          URL.revokeObjectURL(url);
        } catch (_) {}
    }
  }
  return { files: out, dims, recortadas, tapetePct };
}
// Guarda las dimensiones medidas (tapete) en cada documento recién catalogado (best-effort, no rompe la subida).
async function guardarDimsResultados(resultados, dims) {
  if (!dims || !Array.isArray(resultados)) return;
  for (const resultado of resultados) {
    if (resultado && resultado.ok && resultado.id) {
      try {
        await api('/documentos/' + encodeURIComponent(resultado.id) + '/dimensiones', {
          method: 'POST',
          body: JSON.stringify(dims),
        });
      } catch (_) {}
    }
  }
}
// Subida. SUPERVISADO = SÍNCRONO (sube y abre la ficha para revisar). AUTOPILOTO = ASÍNCRONO: ENCOLA y
// procesa en segundo plano. Un PDF de escaneo se EXPLOTA aquí (cliente) en páginas-imagen + se lee su
// código de barras → viaja como un libro escaneado (igual que la cámara). `extra` = {isbn,isbnOrigen,titulo}.
async function subirInbox(files, extra) {
  if (!files || !files.length) return;
  extra = extra || {};
  // Mensajes del proceso (PDF/ISBN/tapete/portada/visión): se acumulan y quedan BAJO el trabajo en la lista
  // del Inbox (no como toasts fugaces). log() = guarda + muestra en vivo en el estado.
  const msgs = [];
  const log = (m, vivo = true) => {
    if (m) {
      msgs.push(m);
      if (vivo) setInboxEstado(m);
    }
  };
  // PDF elegido de disco → se sube ÍNTEGRO. NO se explota en páginas-JPG en el cliente: hacerlo lo
  // catalogaba como libro de 'papel' con decenas de imágenes y, peor, PERDÍA el PDF (no quedaba fichero
  // digital en la carpeta del documento). El SERVIDOR ya clasifica el PDF correctamente —pdf digital, o
  // 'papel' solo si es un escaneo de <12 páginas— leyendo su ISBN/ISSN por código de barras + visión sobre
  // las páginas frontales, y CONSERVA el fichero. La explosión cliente→JPG es SOLO para la CÁMARA en vivo
  // (fotos de un ejemplar físico), que llega como .jpg (no .pdf) y por tanto no entra en esta rama.
  // Únicamente leemos el código de barras del PDF como PISTA barata de ISBN (sin sustituir el fichero).
  if (files.length === 1 && esPdf(files[0]) && !extra.isbn) {
    try {
      setInboxEstado('📄 Leyendo el código de barras del PDF (el fichero se sube íntegro)…');
      // Solo las primeras páginas (portada/créditos) para la PISTA de ISBN — no las 60: el fichero se sube
      // entero y el servidor hace la lectura completa (frontales + contraportada) de todos modos.
      const res = await pdfAImagenes(files[0], { maxPag: 6 });
      if (res.escaneo && res.pages.length) {
        const isbn = await detectarISBNenFiles(res.pages);
        if (isbn) extra = { ...extra, isbn, isbnOrigen: 'movil' };
        log(
          isbn
            ? `📄 PDF escaneado (se sube íntegro) · 📱 ISBN ${isbn} leído del código de barras`
            : '📄 PDF escaneado: se sube íntegro; el servidor lo clasifica (ISBN/ISSN + nº de páginas)',
        );
      }
    } catch (e) {
      console.warn('[PDF cliente] lectura de barras omitida:', e.message);
      setInboxEstado('');
    }
  }
  // TAPETE: recorta+endereza (quita el tapete de la imagen guardada) y mide. Es AUTOMÁTICO al enviar —no hace
  // falta previsualizar ni marcar el switch—: recortarYMedirTapete es SEGURO (si no detecta tapete deja la
  // imagen intacta). Se aplica a grupos de imágenes de escaneo (≤12) o si el modo tapete está activo/calibrado;
  // así una tanda enorme de páginas (p. ej. un PDF explotado) no paga la detección salvo que se pida.
  {
    const imgs = files.filter(_esImg);
    const forzar = ($('#inTapete') && $('#inTapete').checked) || !!_tapeteCal;
    const auto = imgs.length > 0 && imgs.length <= 12;
    if (imgs.length && (forzar || auto)) {
    setInboxEstado('📐 Tapete: midiendo y recortando…');
    try {
      const r = await recortarYMedirTapete(files);
      files = r.files;
      if (r.dims) extra.dims = r.dims;
      const pct = r.tapetePct != null ? ` · tapete ${r.tapetePct}%` : '';
      if (r.recortadas)
        log(
          r.dims
            ? `📐 ${String(r.dims.ancho_cm).replace('.', ',')}×${String(r.dims.alto_cm).replace('.', ',')} cm · recortado${pct}`
            : `✂️ Recortado (sin medida fiable)${pct}`,
        );
      else log(`⚠️ No detecté el tapete${pct} — ¿deja margen alrededor del libro?`);
    } catch (e) {
      console.warn('[tapete]', e && e.message);
    }
    }
  }
  // ELEGIR PORTADA: con el switch activo y VARIAS fotos de un libro, confirmar/cambiar la portada antes de
  // enviar (default automático: la del código de barras es la contra). Cancelar aborta el envío.
  {
    const imgs = files.filter(_esImg);
    if (
      !extra.saltarPortada && // la cámara en vivo ya la pidió al pulsar «Catalogar» (no volver a preguntar)
      $('#inPortada') &&
      $('#inPortada').checked &&
      imgs.length >= 2 &&
      imgs.length <= 12 &&
      imgs.length === files.length
    ) {
      setInboxEstado('🖼️ Elige la portada…');
      const r = await elegirPortada(files);
      if (!r) {
        setInboxEstado('');
        return;
      }
      files = r;
      setInboxEstado('');
    }
  }
  const supervisado = $('#inSupervisar') && $('#inSupervisar').checked;
  if (supervisado) {
    let isbn = extra.isbn || null,
      origenMovil = extra.isbnOrigen === 'movil';
    if (!isbn) {
      setInboxEstado('🔎 Buscando código de barras en el móvil…');
      isbn = await detectarISBNenFiles(files);
      if (isbn) origenMovil = true;
    }
    if (isbn && $('#inIsbn') && !$('#inIsbn').value.trim()) $('#inIsbn').value = isbn;
    if (isbn && origenMovil) log(`📱 ISBN ${isbn} leído en el móvil`, false);
    setInboxEstado(
      isbn
        ? `📱 ISBN ${isbn} · ⏳ subiendo y catalogando…`
        : '⏳ Subiendo y catalogando… (identificará el servidor)',
    );
    const snap = metaSnapshot();
    if (isbn && !snap.isbn) snap.isbn = isbn;
    if (snap.isbn && origenMovil) snap.isbnOrigen = 'movil';
    // Progreso de subida (0-100%) → al 100% avisa de que la subida TERMINÓ y ahora cataloga el servidor
    // (que en ficheros grandes puede tardar). Así el proceso nunca se ve "colgado en silencio".
    const prefijoIsbn = isbn ? `📱 ISBN ${isbn} · ` : '';
    const onProg = (subido, total) => {
      const pct = total ? Math.round((subido / total) * 100) : 0;
      setInboxEstado(
        pct >= 100
          ? `${prefijoIsbn}✅ Subida completa · el servidor está catalogando… (los ficheros grandes pueden tardar un poco)`
          : `${prefijoIsbn}⏳ Subiendo… ${pct}%${total ? ` (${(subido / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)` : ''}`,
      );
    };
    try {
      const j = await enviarIngesta(fdDesdeSnap(snap, files), onProg);
      await guardarDimsResultados(j.resultados, extra.dims); // tapete → dimensiones en la ficha
      setInboxEstado('');
      jobsHechos.unshift({ estado: 'ok', resultados: j.resultados || [], mensajes: msgs });
      cortarJobs();
      pintarCola();
      if ($('#inIsbn')) $('#inIsbn').value = '';
      cargarDatalistColecciones();
      cargarUbicaciones();
      const ok = (j.resultados || []).filter((x) => x.ok && x.id);
      if (ok.length === 1) revisarSupervisado(ok[0].id);
    } catch (e) {
      setInboxEstado('');
      jobsHechos.unshift({ estado: 'error', msg: e.message, mensajes: msgs });
      cortarJobs();
      pintarCola();
    }
    return;
  }
  // AUTOPILOTO: encolar (NO bloquea). La cola procesa una a una en segundo plano.
  const snap = metaSnapshot();
  if (extra.isbn) {
    snap.isbn = extra.isbn;
    if (extra.isbnOrigen) snap.isbnOrigen = extra.isbnOrigen;
  }
  if ($('#inIsbn')) $('#inIsbn').value = '';
  setInboxEstado('');
  colaInbox.push({
    id: ++jobSeq,
    files,
    snap,
    n: files.length,
    estado: 'cola',
    dims: extra.dims || null,
    mensajes: msgs,
    titulo: extra.titulo || files.map((f) => f.name).join(', '),
    isbnCliente: extra.isbnOrigen === 'movil' ? extra.isbn : null,
  });
  pintarCola();
  procesarCola();
}
async function procesarCola() {
  if (colaCorriendo) return;
  colaCorriendo = true;
  while (colaInbox.length) {
    const job = colaInbox[0];
    job.estado = 'procesando';
    job.mensajes = job.mensajes || [];
    pintarCola();
    try {
      if (!job.snap.isbn) {
        const isbn = await detectarISBNenFiles(job.files);
        if (isbn) {
          job.snap.isbn = isbn;
          job.snap.isbnOrigen = 'movil';
          job.isbnCliente = isbn;
          job.mensajes.push(`📱 ISBN ${isbn} leído en el móvil`);
        }
      }
      const onProg = (subido, total) => {
        const pct = total ? Math.round((subido / total) * 100) : 0;
        job.prog = pct >= 100 ? 'catalogando…' : `subiendo ${pct}%`;
        pintarCola();
      };
      const resp = await enviarIngesta(fdDesdeSnap(job.snap, job.files), onProg);
      await guardarDimsResultados(resp.resultados, job.dims); // tapete → dimensiones en la ficha
      job.estado = 'ok';
      job.resultados = resp.resultados || [];
    } catch (e) {
      job.estado = 'error';
      job.msg = e.message;
    }
    colaInbox.shift();
    jobsHechos.unshift(job);
    cortarJobs();
    pintarCola();
  }
  colaCorriendo = false;
  cargarDatalistColecciones();
  cargarUbicaciones();
}
function cortarJobs() {
  if (jobsHechos.length > 25) jobsHechos.length = 25;
}
const _filaInb = (html) =>
  `<div style="padding:7px 0;border-top:1px solid rgba(255,255,255,.06)">${html}</div>`;
function filaResultado(r) {
  if (!r.ok)
    return _filaInb(
      `<span class="tag bad">${esc(r.destino || 'error')}</span> <span class="muted">${esc(r.error || '')}</span>`,
    );
  const det = [r.tipo_recurso, (r.formatos || []).join(','), r.nImagenes ? `${r.nImagenes} pág/img` : '']
    .filter(Boolean)
    .join(' · ');
  const nota = r.nota
    ? `<div class="muted" style="font-size:11px;margin-top:2px">↳ ${esc(r.nota)}</div>`
    : '';
  return _filaInb(
    `<span class="tag ${r.estado === 'completado' ? 'ok' : 'warn'}">${esc(r.operacion || 'ok')}</span> <b>${esc(recortar(r.titulo || '(sin título)', 64))}</b> <span class="muted mono" style="font-size:11px">${esc(r.isbn || r.issn || '')}</span>${r.id ? ` · <a class="rowlink" data-doc="${esc(r.id)}">ver ficha</a>` : ''}${det ? `<div class="muted" style="font-size:11px">${esc(det)}</div>` : ''}${nota}${avisoYaIngresado(r)}`,
  );
}
// Aviso cuando el documento YA estaba en la base (actualización o duplicado): día de alta + ubicación.
function avisoYaIngresado(r) {
  if (!r || !r.ya_existia) return '';
  const fecha = r.fecha_ingreso ? new Date(r.fecha_ingreso) : null;
  const dia =
    fecha && !isNaN(fecha)
      ? fecha.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—';
  const ubic = r.ubicacion_existente || r.ubicacion;
  const ubicTexto =
    ubic && (ubic.ambito || ubic.estanteria)
      ? [ubic.ambito, ubic.estanteria].filter((x) => x && x !== 'Sin asignar').join(' · ') || 'Sin asignar'
      : 'Sin asignar';
  return `<div style="margin-top:5px;padding:6px 9px;border-radius:8px;background:rgba(230,180,0,.14);border:1px solid rgba(230,180,0,.4);font-size:12px">⚠️ <b>Documento ya ingresado</b> el día: ${esc(dia)} · Ubicación: ${esc(ubicTexto)}</div>`;
}
// Render de la cola (en cola / procesando) + resultados ya hechos (más reciente arriba).
function pintarCola() {
  const out = $('#inboxResults');
  if (!out) return;
  // Mensajes del proceso (tapete, ISBN, visión…) BAJO el trabajo, en muted pequeño.
  const msgsHtml = (j) =>
    (j.mensajes || [])
      .map((m) => `<div class="muted" style="font-size:11px;margin-left:2px">· ${esc(m)}</div>`)
      .join('');
  const cola = colaInbox
    .map((j) =>
      _filaInb(
        `<span class="tag ${j.estado === 'procesando' ? 'warn' : 'mut'}">${j.estado === 'procesando' ? `⏳ ${esc(j.prog || 'procesando')}` : '🕒 en cola'}</span> <span class="muted">${esc(recortar(j.titulo, 56))} · ${j.n} fich.</span>${msgsHtml(j)}`,
      ),
    )
    .join('');
  const hechas = [];
  for (const j of jobsHechos) {
    if (j.estado === 'error') {
      hechas.push(
        _filaInb(
          `<span class="tag bad">error</span> <span class="muted">${esc(j.msg || '')}</span>${msgsHtml(j)}`,
        ),
      );
      continue;
    }
    const ms = msgsHtml(j);
    if (ms) hechas.push(_filaInb(ms));
    for (const r of j.resultados || []) hechas.push(filaResultado(r));
  }
  out.innerHTML =
    colaInbox.length || jobsHechos.length
      ? `<div class="card"><h3 style="margin-top:0">Inbox${colaInbox.length ? ` · <span class="muted" style="font-weight:400">${colaInbox.length} en cola${colaCorriendo ? ' · procesando…' : ''}</span>` : ''}</h3>${cola}${hechas.join('') || '<div class="muted">—</div>'}</div>`
      : '';
  {
    const els = $$('#inboxResults [data-doc]');
    const lista = els.map((a) => a.dataset.doc);
    els.forEach((a) => (a.onclick = () => verDoc(a.dataset.doc, { volver: 'inbox', etiqueta: 'Inbox', lista })));
  }
}
// Compat: resultados directos (p. ej. al descartar lo compartido) → a la lista de hechos.
function pintarInboxResultados(res) {
  if (res && res.length) {
    jobsHechos.unshift({ estado: 'ok', resultados: res });
    cortarJobs();
  }
  pintarCola();
}

// ── INGESTA GUIADA · explorador del Inbox: árbol + marcar acción/pistas por carpeta → _guia.json ──────
// El usuario recorre el árbol del Inbox y, por CARPETA, elige una acción (omitir/aplanar/explotar/intacta)
// y da pistas (tipo probable, colección). Se guarda como _guia.json y el vigilante lo obedece al procesar.
const _guiaDirty = new Set(); // rutas de carpeta tocadas por el usuario (las que se guardarán)
const _ACCIONES_GUIA = [['normal', '—'], ['omitir', '⏭️ omitir'], ['aplanar', '📂 aplanar'], ['explotar', '💥 explotar'], ['intacta', '📦 intacta'], ['obra', '📚 obra'], ['software', '💿 software'], ['libro-material', '📖 libro + material']];
const _TIPOS_GUIA = [['', 'tipo…'], ['comic', 'cómic'], ['revista', 'revista'], ['libro', 'libro'], ['articulo', 'artículo'], ['capitulo', 'capítulo'], ['apuntes', 'apuntes']];
const _ICONO_CLASE = { doc: '📗', imagen: '🖼️', audio: '🎵', video: '🎬', comprimido: '🗜️', noclasificable: '⚠️' };

async function cargarArbolInbox() {
  const cont = $('#guiaArbol');
  if (!cont) return;
  cont.innerHTML = '<div class="muted">Cargando…</div>';
  _guiaDirty.clear();
  ['#guiaGuardar', '#guiaGuardar2'].forEach((s) => { if ($(s)) $(s).disabled = true; });
  let r;
  try { r = await api('/inbox/arbol'); } catch (e) { cont.innerHTML = 'No se pudo cargar: ' + esc(e.message); return; }
  if (!r.arbol || !r.arbol.length) { cont.innerHTML = '<div class="muted">El Inbox está vacío.</div>'; return; }
  cont.innerHTML = r.arbol.map(nodoGuiaHTML).join('');
  // Marcar un cambio habilita «Guardar» y hace aparecer la barra flotante (que lo lleva) al instante.
  const habilitarGuardar = () => {
    ['#guiaGuardar', '#guiaGuardar2'].forEach((s) => { if ($(s)) $(s).disabled = false; });
    actualizarSelBar();
  };
  $$('#guiaArbol .guiaCtl').forEach((el) => {
    const ev = el.tagName === 'SELECT' ? 'onchange' : 'oninput';
    el[ev] = () => { _guiaDirty.add(el.dataset.ruta); habilitarGuardar(); };
  });
  // Acción por FICHERO (contenedores): lo tocado es el fichero, pero se guarda en la guía de SU carpeta → se
  // marca sucia con el prefijo «@f:» para no confundirlo con haber tocado los controles de la propia carpeta.
  $$('#guiaArbol .guiaCtlFile').forEach((el) => {
    el.onchange = () => { _guiaDirty.add('@f:' + (el.dataset.carpeta || '')); habilitarGuardar(); };
  });
  // Casillas de SELECCIÓN de ficheros (agrupar) y de CARPETAS (acción en bloque).
  _guiaSel.clear();
  _guiaSelCarp.clear();
  actualizarSelBar();
  $$('#guiaArbol .guiaSel').forEach((el) => {
    el.onchange = () => { el.checked ? _guiaSel.add(el.dataset.ruta) : _guiaSel.delete(el.dataset.ruta); actualizarSelBar(); };
  });
  $$('#guiaArbol .guiaSelCarp').forEach((el) => {
    el.onclick = (e) => e.stopPropagation(); // no desplegar/colapsar la carpeta al marcar
    el.onchange = () => { el.checked ? _guiaSelCarp.add(el.dataset.ruta) : _guiaSelCarp.delete(el.dataset.ruta); actualizarSelBar(); };
  });
  // «☑ todos»: marca/desmarca todos los ficheros de la carpeta (recursivo si «incluir subcarpetas» está activo).
  $$('#guiaArbol .guiaTodos').forEach((btn) => {
    btn.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
      const det = btn.closest('details');
      if (!det) return;
      const recursivo = $('#guiaRecursivo') && $('#guiaRecursivo').checked;
      const casillas = [...det.querySelectorAll('.guiaSel')].filter((cb) => recursivo || cb.closest('details') === det);
      if (!casillas.length) return;
      const marcar = !casillas.every((cb) => cb.checked); // si no están todas marcadas → marcar; si sí → desmarcar
      casillas.forEach((cb) => { cb.checked = marcar; marcar ? _guiaSel.add(cb.dataset.ruta) : _guiaSel.delete(cb.dataset.ruta); });
      actualizarSelBar();
    };
  });
}
// Acciones por FICHERO (solo para CONTENEDORES: .iso .nrg .zip .rar .7z .ipa…). La máquina no puede adivinar
// si un .iso es un archivo de documentos o una enciclopedia de software: abrirlo por las bravas mete cientos
// de vídeos/recursos como fichas sueltas. Aquí lo decides tú ANTES de que el vigilante lo toque.
const _ACCIONES_FICHERO = [
  ['expandir', '📂 abrir y catalogar dentro'],
  ['software', '💿 software (intacto, 1 ficha)'],
  ['omitir', '⏭️ omitir'],
];
function nodoGuiaHTML(n) {
  if (n.tipo === 'file') {
    const ic = _ICONO_CLASE[n.clase] || '📄';
    const col = n.clase === 'noclasificable' ? ';color:#c60' : '';
    // CONTENEDOR: selector de acción. La guía vive en la carpeta que lo contiene → data-carpeta + data-nombre.
    let selAcc = '';
    if (n.clase === 'comprimido') {
      const carpetaRel = n.ruta.split('/').slice(0, -1).join('/');   // '' = raíz del Inbox
      selAcc = ` <select class="guiaCtlFile" data-carpeta="${esc(carpetaRel)}" data-nombre="${esc(n.nombre)}" title="Un contenedor puede traer documentos (abrir y catalogar cada uno) o ser un paquete de software (dejarlo intacto, 1 ficha)" style="font-size:11px;padding:1px 3px">${_ACCIONES_FICHERO
        .map(([v, t]) => `<option value="${v}"${v === (n.accion || 'expandir') ? ' selected' : ''}>${t}</option>`)
        .join('')}</select>`;
    }
    return `<div style="padding:2px 0 2px 20px;font-size:12.5px${col}"><label style="cursor:pointer"><input type="checkbox" class="guiaSel" data-ruta="${esc(n.ruta)}" style="vertical-align:-1px"> ${ic} ${esc(n.nombre)}</label>${selAcc}${n.clase === 'noclasificable' ? ' <span class="muted">· no clasificable</span>' : ''}</div>`;
  }
  const g = n.guia || { perfil: {}, accion: 'normal' };
  const sel = (k, opts, val) =>
    `<select class="guiaCtl" data-ruta="${esc(n.ruta)}" data-k="${k}" style="font-size:12px;padding:1px 3px">${opts
      .map(([v, t]) => `<option value="${v}"${v === (val || '') ? ' selected' : ''}>${t}</option>`)
      .join('')}</select>`;
  const cab = `<span style="display:inline-flex;gap:6px;align-items:center;flex-wrap:wrap">
      <input type="checkbox" class="guiaSelCarp" data-ruta="${esc(n.ruta)}" title="Seleccionar esta CARPETA (para acción en bloque: explotar/aplanar/omitir)" style="vertical-align:-1px" />
      <b style="font-size:13px">📁 ${esc(n.nombre)}</b>
      <button type="button" class="btn guiaTodos" title="Seleccionar todos los ficheros de esta carpeta (respeta «incluir subcarpetas»)" style="font-size:11px;padding:1px 6px">☑ todos</button>
      ${sel('accion', _ACCIONES_GUIA, g.accion)}
      ${sel('tipo_probable', _TIPOS_GUIA, g.perfil && g.perfil.tipo_probable)}
      <input class="guiaCtl" data-ruta="${esc(n.ruta)}" data-k="coleccion" placeholder="colección" value="${esc((g.perfil && g.perfil.coleccion) || '')}" style="font-size:12px;width:110px;padding:1px 4px" />
    </span>`;
  const hijos = (n.hijos || []).map(nodoGuiaHTML).join('') || '<div class="muted" style="padding-left:24px;font-size:12px">(vacía)</div>';
  // Cada sub-nivel se INDENTA (margin-left) además del borde izquierdo, para que la jerarquía se lea bien.
  return `<details class="foldcard" open style="margin:2px 0;border:0;border-left:2px solid rgba(128,128,128,.3);border-radius:0;padding:2px 0 2px 8px"><summary style="cursor:pointer">${cab}</summary><div style="margin-left:18px">${hijos}</div></details>`;
}
async function guardarGuiasInbox() {
  if (!_guiaDirty.size) return;
  const btn = $('#guiaGuardar');
  if (btn) { btn.disabled = true; btn.textContent = 'Guardando…'; }
  // Recoge el estado ACTUAL de los controles, solo de las carpetas tocadas.
  // Carpetas a guardar: las tocadas por sus PROPIOS controles, más aquellas donde solo cambió la acción de un
  // FICHERO contenedor (marcadas «@f:<carpeta>»).
  const porFichero = new Set(
    [...$$('#guiaArbol .guiaCtlFile')].map((el) => el.dataset.carpeta || '').filter((c) => _guiaDirty.has('@f:' + c)),
  );
  const porRuta = new Map();
  const guiaDe = (ruta) => {
    if (!porRuta.has(ruta)) porRuta.set(ruta, { accion: 'normal', perfil: {} });
    return porRuta.get(ruta);
  };
  // Estado ACTUAL de los controles de CARPETA. Se leen también en las carpetas que solo cambiaron por una
  // acción de fichero: si no, al guardar se les mandaría accion:'normal'/perfil vacío y se BORRARÍA lo suyo.
  $$('#guiaArbol .guiaCtl').forEach((el) => {
    const ruta = el.dataset.ruta;
    if (!_guiaDirty.has(ruta) && !porFichero.has(ruta)) return;
    const gg = guiaDe(ruta);
    if (el.dataset.k === 'accion') gg.accion = el.value || 'normal';
    else if (el.value && el.value.trim()) gg.perfil[el.dataset.k] = el.value.trim();
  });
  // Acciones por FICHERO (contenedores) → `archivos{}` de la guía de SU carpeta. 'expandir' es el defecto: no
  // se guarda (así la guía queda limpia y el comportamiento por defecto sigue siendo abrir).
  $$('#guiaArbol .guiaCtlFile').forEach((el) => {
    const carpeta = el.dataset.carpeta || '';
    if (!porFichero.has(carpeta)) return;
    const gg = guiaDe(carpeta);
    gg.archivos = gg.archivos || {};
    if (el.value && el.value !== 'expandir') gg.archivos[el.dataset.nombre] = { accion: el.value };
  });
  let ok = 0, err = 0;
  for (const [ruta, guia] of porRuta) {
    try { const r = await api('/inbox/guia', { method: 'POST', body: JSON.stringify({ ruta, guia }) }); r.ok ? ok++ : err++; } catch { err++; }
  }
  toast(`🧭 ${ok} guía(s) guardada(s)${err ? ` · ${err} error(es)` : ''}`, err ? 'warn' : 'ok');
  if (btn) btn.textContent = '💾 Guardar guías';
  // NO se repinta el árbol: hacerlo perdía las SELECCIONES, el SCROLL y las carpetas desplegadas justo después
  // de guardar (y en un árbol largo eso obliga a volver a empezar). Lo que se ve YA es lo que se guardó; solo
  // se limpian los pendientes y se actualiza la barra flotante.
  if (!err) _guiaDirty.clear();
  ['#guiaGuardar', '#guiaGuardar2'].forEach((s) => { if ($(s)) $(s).disabled = !_guiaDirty.size; });
  actualizarSelBar();
}
if ($('#guiaCargar')) $('#guiaCargar').onclick = cargarArbolInbox;
if ($('#guiaGuardar')) $('#guiaGuardar').onclick = guardarGuiasInbox;

// ── Selección de ficheros para AGRUPAR (dos vías): A) mover a una nueva subcarpeta ahora; B) marcar como
//    1 audiolibro / 1 obra en el _guia.json (el vigilante los agrupa al procesar). Ambas reutilizan la
//    autodetección de carpetas del vigilante. ──
const _guiaSel = new Set();      // ficheros seleccionados (rutas)
const _guiaSelCarp = new Set();  // CARPETAS seleccionadas (rutas) — para acción en bloque
// La barra de selección del Inspector es FLOTANTE y su anclaje (pie por defecto / cabecera) se RECUERDA: con
// un árbol largo, una barra inline quedaba arriba y fuera de vista al scrollear. El ⇅ la mueve; según dónde
// estés mirando (la cabecera con el árbol desplegado, o el final de la lista) conviene una u otra.
function anclarSelBar() {
  const bar = $('#guiaSelBar');
  if (!bar) return;
  const arriba = localStorage.getItem('guia_selbar_pos') === 'arriba';
  bar.classList.toggle('arriba', arriba);
  const b = $('#guiaSelPos');
  if (b) b.title = arriba ? 'Mover la barra al PIE de la pantalla' : 'Mover la barra a la CABECERA de la pantalla';
}
function actualizarSelBar() {
  const bar = $('#guiaSelBar');
  if (!bar) return;
  const nf = _guiaSel.size, nc = _guiaSelCarp.size, nd = _guiaDirty.size;
  // La barra flotante muestra TAMBIÉN «Guardar guías» cuando hay cambios pendientes: antes el botón vivía al
  // final del árbol y, con una lista larga, quedaba fuera de vista justo cuando hacía falta.
  bar.style.display = nf || nc || nd ? 'flex' : 'none';
  const secG = $('#guiaSelGuardar');
  if (secG) secG.style.display = nd ? 'flex' : 'none';
  if ($('#guiaDirtyN')) $('#guiaDirtyN').textContent = nd;
  anclarSelBar();
  const bpos = $('#guiaSelPos');
  if (bpos && !bpos._cableado) {
    bpos._cableado = true;
    bpos.onclick = () => {
      const arriba = localStorage.getItem('guia_selbar_pos') === 'arriba';
      localStorage.setItem('guia_selbar_pos', arriba ? 'pie' : 'arriba');
      anclarSelBar();
    };
  }
  const secF = $('#guiaSelFiles'), secC = $('#guiaSelCarps');
  if (secF) secF.style.display = nf ? 'flex' : 'none';
  if (secC) secC.style.display = nc ? 'flex' : 'none';
  if ($('#guiaSelN')) $('#guiaSelN').textContent = nf;
  if ($('#guiaSelNC')) $('#guiaSelNC').textContent = nc;
}
// Aplica una acción EN BLOQUE a las carpetas seleccionadas: fija su desplegable de acción y las marca
// «sucias» para que «Guardar guías» las persista (mismo camino que editar el desplegable a mano).
function aplicarAccionCarpetas(accion) {
  if (!_guiaSelCarp.size) return;
  let n = 0;
  $$('#guiaArbol .guiaCtl').forEach((el) => {
    if (el.dataset.k === 'accion' && _guiaSelCarp.has(el.dataset.ruta)) { el.value = accion; _guiaDirty.add(el.dataset.ruta); n++; }
  });
  ['#guiaGuardar', '#guiaGuardar2'].forEach((s) => { if ($(s)) $(s).disabled = false; });
  toast(`${n} carpeta(s) → «${accion}». Pulsa 💾 Guardar guías.`);
}
async function agruparEnCarpeta() {
  if (!_guiaSel.size) return;
  const nombre = prompt(`Nombre de la NUEVA carpeta para agrupar ${_guiaSel.size} fichero(s) (se moverán ahí):`, 'Audiolibro');
  if (!nombre || !nombre.trim()) return;
  try {
    const r = await api('/inbox/agrupar-carpeta', { method: 'POST', body: JSON.stringify({ rutas: [..._guiaSel], nombre: nombre.trim() }) });
    r.ok ? toast(`📁 ${r.movidos} fichero(s) → «${r.carpeta}»`) : toast(r.motivo || 'error', 'bad');
  } catch (e) { toast(e.message, 'bad'); }
  cargarArbolInbox();
}
async function marcarGrupo(tipo) {
  if (!_guiaSel.size) return;
  try {
    const r = await api('/inbox/grupo', { method: 'POST', body: JSON.stringify({ rutas: [..._guiaSel], tipo }) });
    r.ok ? toast(`${tipo === 'obra' ? '📚' : '🎧'} grupo marcado (${r.n} fichero(s)) en «${r.carpeta}»`) : toast(r.motivo || 'error', 'bad');
  } catch (e) { toast(e.message, 'bad'); }
  cargarArbolInbox();
}
if ($('#guiaGuardar2')) $('#guiaGuardar2').onclick = guardarGuiasInbox; // guardar también desde el final
if ($('#guiaMover')) $('#guiaMover').onclick = agruparEnCarpeta;
if ($('#guiaGrpAudio')) $('#guiaGrpAudio').onclick = () => marcarGrupo('audiolibro');
if ($('#guiaGrpObra')) $('#guiaGrpObra').onclick = () => marcarGrupo('obra');
// Acciones EN BLOQUE sobre las carpetas seleccionadas (fijan su desplegable + marcan sucio → Guardar).
if ($('#guiaCarpExplotar')) $('#guiaCarpExplotar').onclick = () => aplicarAccionCarpetas('explotar');
if ($('#guiaCarpAplanar')) $('#guiaCarpAplanar').onclick = () => aplicarAccionCarpetas('aplanar');
if ($('#guiaCarpOmitir')) $('#guiaCarpOmitir').onclick = () => aplicarAccionCarpetas('omitir');
if ($('#guiaCarpNormal')) $('#guiaCarpNormal').onclick = () => aplicarAccionCarpetas('normal');
if ($('#guiaSelNada'))
  $('#guiaSelNada').onclick = () => {
    _guiaSel.clear();
    _guiaSelCarp.clear();
    $$('#guiaArbol .guiaSel, #guiaArbol .guiaSelCarp').forEach((el) => (el.checked = false));
    actualizarSelBar();
  };
// Supervisado: trae la ficha recién creada y abre el formulario de edición como PREVIEW (sin navegar).
async function revisarSupervisado(id) {
  try {
    const r = await api('/documentos/' + encodeURIComponent(id));
    fichaEditar(r.doc, r, { supervisado: true });
  } catch (e) {
    toast('No se pudo abrir para revisar: ' + e.message, 'bad');
  }
}
// NFC (Web NFC, Android/Chrome). Extrae el _id de doc de una URL ?doc=<id> (etiqueta grabada por
// nosotros); en su defecto devuelve el texto/URL crudo (ISBN/identificador) para buscarlo.
function docIdDeURL(s) {
  try {
    const u = new URL(s, location.origin);
    return u.searchParams.get('doc') || '';
  } catch (_) {
    return '';
  }
}
async function leerNFC() {
  if (!('NDEFReader' in window)) {
    toast('Este navegador no soporta NFC (Android + Chrome)', 'bad');
    return;
  }
  const out = $('#nfcOut');
  if (out) out.textContent = 'Acerca la etiqueta…';
  try {
    const reader = new NDEFReader();
    await reader.scan();
    reader.onreading = async (ev) => {
      sonidoNfcLectura();
      let url = '',
        bib = '',
        ex = '';
      for (const rec of ev.message.records) {
        try {
          const val =
            rec.recordType === 'text' || rec.recordType === 'url'
              ? new TextDecoder(rec.encoding || 'utf-8').decode(rec.data)
              : '';
          if (rec.recordType === 'url' && !url) url = val;
          else if (rec.recordType === 'text') {
            if (/^BIB1:/.test(val)) {
              if (!bib) bib = val;
            } else if (!ex) ex = val;
          }
        } catch (_) {}
      }
      // ¿Etiqueta nuestra? URL ?doc=<id>. Se INTENTA la ficha online (no basta navigator.onLine: el móvil
      // puede tener red pero NO alcanzar el NAS). Si el servidor no responde, se cae a los DATOS OFFLINE:
      // preferimos los EMBEBIDOS en la URL (?o=) y, si no, el antiguo registro de texto BIB1 (etiquetas viejas).
      const id = docIdDeURL(url),
        off = _offDeURL(url) || _parseOffline(bib);
      if (id) {
        if (out) out.textContent = 'Conectando con la ficha…';
        let ok = false;
        try {
          const ctrl = new AbortController(),
            to = setTimeout(() => ctrl.abort(), 4000);
          const r = await fetch('/api/documentos/' + encodeURIComponent(id), {
            headers: TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {},
            signal: ctrl.signal,
          });
          clearTimeout(to);
          ok = r.ok;
        } catch (_) {
          ok = false;
        }
        if (ok) {
          if (out) out.textContent = '';
          verDoc(id, { volver: 'inbox', etiqueta: 'Inbox' });
          return;
        }
        if (off) {
          if (out) out.textContent = '';
          mostrarOfflineNFC(off, ex);
          return;
        }
        if (out) out.textContent = 'Sin conexión con el servidor y la etiqueta no trae datos offline.';
        return;
      }
      if (off) {
        if (out) out.textContent = '';
        mostrarOfflineNFC(off, ex);
        return;
      } // etiqueta sin URL pero con datos
      // Etiqueta de ESTANTERÍA (?amb=&est=): muestra ex-libris + nombre + «Ver libros».
      try {
        const u = new URL(url, location.origin),
          amb = u.searchParams.get('amb');
        if (amb) {
          const est = u.searchParams.get('est') || '';
          if (out) out.textContent = '';
          mostrarEstanteriaNFC((est ? est + ' · ' : '') + amb, amb, est, ex);
          return;
        }
      } catch (_) {}
      const q = (ex || url || '').trim();
      if (q) {
        if (out) out.innerHTML = `Leído: <b class="mono">${esc(q)}</b>`;
        go('search');
        const inp = $('#sqQ');
        if (inp) {
          inp.value = q;
          buscarCatalogo(1);
        }
      } else if (out) out.textContent = 'Etiqueta sin texto legible.';
    };
    reader.onreadingerror = () => {
      if (out) out.textContent = 'No se pudo leer la etiqueta.';
    };
  } catch (e) {
    if (out) out.textContent = 'NFC: ' + e.message;
  }
}
// ── NFC offline (Fase 2): además del enlace ?doc=, la etiqueta del libro lleva un registro de TEXTO
//    «BIB1:{json}» con datos OFFLINE (ubicación primero, para recolocar el libro sin conexión). Capacidad
//    acotada (NTAG215≈504 B): se RECORTA por prioridad sin desbordar (se conservan ubicación, título e ISBN).
const _blen = (s) => new TextEncoder().encode(String(s || '')).length;
function _txtUbic(d) {
  const u = (d && d.ubicacion) || {};
  const a = u.ambito && u.ambito !== 'Sin asignar' ? u.ambito : '';
  const e = u.estanteria && u.estanteria !== 'Sin asignar' ? u.estanteria : '';
  // Los DIGITALES no tienen ubicación física: su «estante» es su CDU (estantería virtual). Así las
  // tarjetas del catálogo muestran «CDU 004.65» en vez de «Sin asignar».
  const fisico = d && (d.formatos || []).includes('papel');
  if (!fisico && !a && !e && d && d.cdu) return 'CDU ' + d.cdu;
  return [a, e].filter(Boolean).join(' · ');
}
// LÍMITES FIJOS de caracteres (suficiente para IDENTIFICAR; evita overflow con títulos largos). El CDU NO
// se trunca y se reserva su longitud de forma PESIMISTA (los códigos con auxiliares pueden ser largos).
function _payloadOffline(d, r, budget) {
  const cut = (s, n) => {
    s = String(s || '');
    while (_blen(s) > n && s.length) s = s.slice(0, -1);
    return s;
  };
  let t = cut(d.titulo, 40),
    a = cut(r && r.autores && r.autores.length ? r.autores.join(', ') : '', 28),
    e = cut((r && r.editorial) || '', 22),
    x = cut((r && r.coleccion) || '', 22),
    c = String(d.cdu || ''),
    i = d.isbn || '',
    dd = String(d._id || ''),
    u = cut(_txtUbic(d), 30),
    va = d.valoracion && d.valoracion > 0 ? d.valoracion : '';
  // claves cortas: d=id, u=ubicación, t=título, i=isbn, c=cdu, x=colección, a=autor, e=editorial, s=estrellas
  const build = () =>
    'BIB1:' +
    JSON.stringify(
      Object.fromEntries(
        Object.entries({ v: 1, d: dd, u, t, i, c, x, a, e, s: va }).filter(([, v]) => v !== ''),
      ),
    );
  // Salvaguarda final SOLO si la URL fuese muy larga: nunca toca ubicación/título/isbn/cdu.
  const pasos = [() => (e = ''), () => (x = ''), () => (a = cut(a, 18)), () => (a = '')];
  let s = build(),
    k = 0;
  while (_blen(s) > budget && k < pasos.length) {
    pasos[k]();
    k++;
    s = build();
  }
  return s;
}
function _parseOffline(txt) {
  if (!txt || txt.indexOf('BIB1:') !== 0) return null;
  try {
    return JSON.parse(txt.slice(5));
  } catch (_) {
    return null;
  }
}
// base64url (UTF-8) para embeber los datos offline en la URL de la etiqueta (?o=…).
function _b64uEnc(s) {
  try {
    return btoa(unescape(encodeURIComponent(s)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  } catch (_) {
    return '';
  }
}
function _b64uDec(s) {
  try {
    return decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))));
  } catch (_) {
    return '';
  }
}
// Datos offline embebidos en una URL de etiqueta (?o=<base64url(BIB1)>): {…} o null.
function _offDeURL(url) {
  try {
    const o = new URL(url, location.origin).searchParams.get('o');
    return o ? _parseOffline(_b64uDec(o)) : null;
  } catch (_) {
    return null;
  }
}
// Inspecciona el contenido ACTUAL de una etiqueta (en el evento de lectura): {docId,titulo,url} o null (vacía).
function inspeccionarTagNFC(message) {
  let url = '',
    txt = '';
  for (const rec of (message && message.records) || []) {
    try {
      const val =
        rec.recordType === 'text' || rec.recordType === 'url'
          ? new TextDecoder(rec.encoding || 'utf-8').decode(rec.data)
          : '';
      if (rec.recordType === 'url' && !url) url = val;
      else if (rec.recordType === 'text' && !txt) txt = val;
    } catch (_) {}
  }
  const docId = docIdDeURL(url);
  let off = _parseOffline(txt) || _offDeURL(url);
  if (!docId && !off && !url && !txt) return null; // etiqueta en blanco
  return { docId: docId || null, titulo: (off && off.t) || '', url };
}
// Ex-libris / propietario: se graba como registro de texto LEGIBLE en TODA etiqueta (libro, estantería,
// sala). Editable aquí (o por un ajuste en el futuro).
let EX_LIBRIS = localStorage.getItem('exlibris') || 'BIBLIOTHECA LUDOVICIANA · Este libro pertenece a Luis Ortuño Molina';
// La cartela (biblioteca · propietario · contacto) es CONFIGURABLE desde el .env del servidor
// (NOMBRE_BIBLIOTECARIO, EMAIL, TELEFONO, NOMBRE_BIBLIOTECA). Se pide al endpoint PÚBLICO /api/exlibris —a
// propósito, para que quien ENCUENTRE un libro fuera de la biblioteca vea de quién es y cómo devolverlo— y se
// cachea en localStorage (así la lectura NFC OFFLINE también muestra el contacto). Cada « · » = una línea.
// Compone la cadena del ex-libris (biblioteca · propietario · contacto) desde la config del .env. « · » separa
// BLOQUES (heroExlibris pone una regla entre ellos); «\n» es un salto de línea DENTRO de un bloque (sin regla).
// El contacto es «Devolver a: <email>» + el <teléfono> en su propia línea, agrupados sin regla entre ambos.
function _construirExLibris(c) {
  const partes = [(c && c.biblioteca) || 'BIBLIOTHECA LUDOVICIANA'];
  if (c && c.nombre) partes.push('Este libro pertenece a ' + c.nombre);
  const email = c && c.email, tel = c && c.telefono;
  if (email || tel) {
    const l1 = 'Devolver a: ' + (email || tel);
    partes.push(email && tel ? l1 + '\n' + tel : l1);
  }
  return partes.join(' · ');
}
(async () => {
  try {
    const c = await fetch('/api/exlibris').then((r) => (r.ok ? r.json() : null));
    if (!c) return;
    EX_LIBRIS = _construirExLibris(c);
    localStorage.setItem('exlibris', EX_LIBRIS);
  } catch (_) { /* sin red: se queda la cacheada / la de por defecto */ }
})();
// Registros de una etiqueta de LIBRO: enlace ?doc= + ex-libris + datos offline (BIB1), recortando los datos
// para CABER junto al enlace y el ex-libris. Devuelve {url, records}.
function _recordsDoc(d, r) {
  // Datos offline EMBEBIDOS en la URL (?o=…): al TOCAR la etiqueta, el SO abre esa URL y la ficha offline
  // sale DIRECTA, sin necesidad de una segunda lectura NFC. base64url infla ~4/3 → presupuestamos el payload.
  const idUrl = location.origin + '/?doc=' + encodeURIComponent(d._id);
  const fijo = _blen(idUrl) + _blen('&o=') + _blen(EX_LIBRIS) + 14;
  const budget = Math.max(40, Math.floor(((470 - fijo) * 3) / 4));
  const url = idUrl + '&o=' + _b64uEnc(_payloadOffline(d, r, budget));
  return {
    url,
    records: [
      { recordType: 'url', data: url },
      { recordType: 'text', data: EX_LIBRIS },
    ],
  };
}
// Graba registros en una etiqueta (escanea y escribe en el MISMO toque → capta el UID). Si la etiqueta YA
// está grabada para OTRO documento y forzar=false, RECHAZA con {code:'OCUPADA',prev,uid} (sin escribir) para
// pedir confirmación. Usa un AbortController interno (parable) enlazado al signal externo (cancelar).
function escribirNFC(records, docIdActual, outerSignal, forzar) {
  return new Promise((resolve, reject) => {
    const ac = new AbortController();
    const onAb = () => {
      try {
        ac.abort();
      } catch (_) {}
    };
    if (outerSignal) {
      if (outerSignal.aborted) onAb();
      else outerSignal.addEventListener('abort', onAb, { once: true });
    }
    let done = false;
    const fin = () => {
      done = true;
      try {
        ac.abort();
      } catch (_) {}
      if (outerSignal)
        try {
          outerSignal.removeEventListener('abort', onAb);
        } catch (_) {}
    };
    let rd;
    try {
      rd = new NDEFReader();
    } catch (e) {
      fin();
      return reject(e);
    }
    rd.onreading = async (ev) => {
      if (done) return;
      const uid = ev.serialNumber || null;
      // `forzar` puede ser booleano O una función (se evalúa AL TOCAR, para poder marcar «sobrescribir» en
      // el modal después de abrirlo). Forzando NO se hace la lectura de comprobación → se escribe en el
      // PRIMER toque sin abortar el scan, así el sistema no captura la URL vieja y no redirige.
      const f = typeof forzar === 'function' ? forzar() : forzar;
      if (!f) {
        const prev = inspeccionarTagNFC(ev.message);
        if (prev && prev.docId !== docIdActual) {
          fin();
          reject({ code: 'OCUPADA', prev, uid });
          return;
        }
      }
      try {
        await rd.write({ records }, { signal: ac.signal });
        sonidoNfcEscritura();
        fin();
        resolve(uid);
      } catch (err) {
        if (!done) {
          fin();
          reject(err);
        }
      }
    };
    rd.scan({ signal: ac.signal }).catch((err) => {
      if (!done) {
        fin();
        reject(err);
      }
    });
  });
}
// Tarjeta OFFLINE (sin conexión): ubicación PROMINENTE para recolocar + datos básicos de la etiqueta.
// Ex-libris en modo HERO (placa de propietario, estilo clásico) — se muestra al leer la etiqueta offline.
function heroExlibris(ex) {
  if (!ex) return '';
  const p = String(ex)
    .split('·')
    .map((s) => s.trim())
    .filter(Boolean);
  const lib = p[0] || ex,
    lineas = p.slice(1); // propietario, «Devolver a: email-teléfono»
  // PRIORIDAD: que se lea TODO (no recortar). El texto ENVUELVE si hace falta (nada de nowrap/ellipsis) y las
  // palabras largas (emails) parten limpiamente. Entre línea y línea, una REGLA fina centrada al 50% del ancho.
  // Un BLOQUE puede tener varias líneas (separadas por «\n») que se pintan juntas SIN regla entre ellas
  // (p. ej. «Devolver a: email» + «teléfono»). La regla solo va ENTRE bloques.
  const linea = (txt, css) =>
    String(txt)
      .split('\n')
      .map((sub) => `<div style="overflow-wrap:anywhere;${css}">${esc(sub.trim())}</div>`)
      .join('');
  const regla = '<div style="width:50%;height:1px;margin:9px auto;background:rgba(42,29,14,.35)"></div>';
  const bloques = [
    linea(lib, 'font-size:17px;font-weight:700;letter-spacing:1px;text-transform:uppercase;line-height:1.2'),
    ...lineas.map((l) => linea(l, 'font-size:13px;font-style:italic;line-height:1.3')),
  ];
  return `<div style="text-align:center;font-family:Georgia,'Times New Roman',serif;background:linear-gradient(#cdab6c,#9c7a44);color:#2a1d0e;border:1px solid #6e5226;border-radius:10px;padding:14px 16px;margin:0 0 14px;box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 3px 10px rgba(0,0,0,.45)">
    ${bloques.join(regla)}</div>`;
}
// Estrellas estáticas (solo lectura) para la valoración guardada en la etiqueta.
const estrellasHTML = (n) => {
  n = +n || 0;
  return n
    ? `<span style="color:#ffcf5a;font-size:16px;letter-spacing:2px" title="${n}★">${'★'.repeat(n)}${'☆'.repeat(Math.max(0, 5 - n))}</span>`
    : '';
};
// Bloque «Ficha offline» (ubicación PROMINENTE + datos básicos). Reutilizado por la tarjeta offline (datos
// de la etiqueta) y por la ficha online (reconstruido de la base). o = {u,a,e,x,c,i}.
function _offlineInner(o) {
  return `<div style="margin:2px 0 12px;padding:12px;border:1px solid var(--acc);border-radius:10px;text-align:center;background:var(--card2)">
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:1px">Ubicación</div>
      <div style="font-size:21px;font-weight:700;color:var(--acc)">${esc(o.u || 'Sin asignar')}</div></div>
    <dl class="dl">${o.a ? `<dt>Autor</dt><dd>${esc(o.a)}</dd>` : ''}${o.e ? `<dt>Editorial</dt><dd>${esc(o.e)}</dd>` : ''}${o.x ? `<dt>Colección</dt><dd>${esc(o.x)}</dd>` : ''}${o.c ? `<dt>CDU</dt><dd class="mono">${esc(o.c)}</dd>` : ''}${o.i ? `<dt>ISBN</dt><dd class="mono">${esc(o.i)}</dd>` : ''}</dl>`;
}
// ── FICHA MÍNIMA: encabezado vistoso común (ficha online · lectura NFC offline · vista compartida por QR).
//   título → estrellas → [papel: ex-libris | digital: botón de descarga verde] → datos → [papel: ubicación].
//   Campos interactivos (estrellas editables, ubicación clicable, identificadores drillables) se pasan como
//   HTML por estrellasHTML/datosHTML/ubicacionHTML; si no, se generan versiones estáticas (solo lectura).
function fichaMinima(o) {
  const badge = o.origen
    ? `<div class="fmin-badge" onclick="this.classList.toggle('open')" title="¿De dónde salen estos datos?">ⓘ<span class="fmin-pop">${esc(o.origen)}</span></div>`
    : '';
  const starsInner =
    o.estrellasHTML != null ? o.estrellasHTML : o.estrellas ? estrellasHTML(o.estrellas) : '';
  const hero = o.esDigital
    ? o.descargaUrl
      ? `<a class="btn pri fmin-dl" href="${esc(o.descargaUrl)}" download="${esc(o.descargaNombre || '')}">⬇ Descargar</a>`
      : ''
    : heroExlibris(o.exlibris || EX_LIBRIS);
  let filas = o.datosHTML;
  if (filas == null) {
    filas = [
      ['Autor', o.autor],
      ['Editorial', o.editorial],
      ['Colección', o.coleccion],
      ['CDU', o.cdu, 'mono'],
      ['ISBN', o.isbn, 'mono'],
    ]
      .filter(function (p) {
        return p[1];
      })
      .map(function (p) {
        return `<dt>${p[0]}</dt><dd${p[2] ? ` class="${p[2]}"` : ''}>${esc(p[1])}</dd>`;
      })
      .join('');
  }
  // Ubicación: si el llamador la oculta explícitamente (ficha compartida) → nada. Si aporta su propio
  // ubicacionHTML → se muestra (los DIGITALES ahora traen su estantería virtual por CDU, así que también
  // se renderiza). Solo el FALLBACK «Sin asignar» por defecto se omite para digitales (no tienen ubicación
  // física ni CDU que mostrar).
  const pie = o.ocultarUbicacion
    ? ''
    : o.ubicacionHTML != null
      ? o.ubicacionHTML
      : o.esDigital
        ? ''
        : `<div class="fmin-ubic"><div class="lbl">Ubicación</div><div class="val">📍 ${esc(o.ubicacion || 'Sin asignar')}</div></div>`;
  // Botón «Editar» en la CABECERA (junto al título), centrado bajo las estrellas: acceso directo al modo
  // edición sin desplegar el acordeón «⚙️ Acciones». Solo si el llamador lo habilita (admin; nunca en la
  // ficha compartida). Se cablea en pintarDoc con id="fminEdit".
  const editBtn = o.editable
    ? `<div style="margin-top:10px"><button id="fminEdit" class="btn" title="Editar los datos a mano" style="padding:4px 14px;font-size:13px">✏️ Editar</button></div>`
    : '';
  return `<div class="fmin card">${badge}
    <h1 class="fmin-tit">${esc(o.titulo || '(sin título)')}</h1>${o.subtitulo ? `<div class="fmin-sub">${esc(o.subtitulo)}</div>` : ''}${starsInner ? `<div class="fmin-stars">${starsInner}</div>` : ''}
    ${o.tipoFormatoHTML || ''}
    ${editBtn}
    ${hero ? `<div style="margin-top:14px">${hero}</div>` : ''}
    ${o.obraColHTML || ''}
    ${filas ? `<dl class="dl fmin-data">${filas}</dl>` : ''}
    ${pie}</div>`;
}
// Entero → número romano (para el ordinal del volumen, «Vol.: III»). Fuera de rango: devuelve el número.
// Numeral romano (I..MMM) → entero, o null si no lo es. Para inferir el nº de tomo de un título.
function romanoANum(s) {
  const t = String(s || '').toUpperCase().trim();
  if (!/^[IVXLCDM]+$/.test(t)) return null;
  const val = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    const c = val[t[i]], sig = val[t[i + 1]] || 0;
    n += c < sig ? -c : c;
  }
  return n > 0 && n < 4000 ? n : null;
}
// Infiere el nº de tomo de un documento a partir de INDICIOS ya presentes (sin coste): nº existente,
// luego «Vol./Tomo/Libro/Parte/Band N» (arábigo o romano) en volumen_titulo → título → nombre de
// archivo (que a su vez recoge el OCR/APIs de la ingesta). Devuelve null si no hay indicio.
function inferirNumTomo(d) {
  if (Number.isInteger(d.volumen_numero)) return d.volumen_numero;
  const PAL = '(?:vol(?:umen|ume)?|tomo|libro|parte|part|band|bd|heft|teil|t)';
  for (const txt of [d.volumen_titulo, d.titulo, d.nombre_archivo]) {
    const s = String(txt || '');
    if (!s) continue;
    let m = s.match(new RegExp('\\b' + PAL + '\\.?\\s*(\\d{1,3})\\b', 'i'));
    if (m) return parseInt(m[1], 10);
    m = s.match(new RegExp('\\b' + PAL + '\\.?\\s*([IVXLCDM]{1,7})\\b', 'i'));
    if (m) { const n = romanoANum(m[1]); if (n) return n; }
  }
  return null;
}
function aRomano(n) {
  n = parseInt(n, 10);
  if (!Number.isFinite(n) || n <= 0 || n >= 4000) return String(n);
  const t = [
    [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
    [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
  ];
  let s = '';
  for (const [v, r] of t) while (n >= v) { s += r; n -= v; }
  return s;
}
// Dibuja un código QR (matriz de qrGenerar) en un <canvas> con zona de silencio. px = tamaño objetivo.
function qrCanvas(qr, px) {
  const quiet = 4,
    n = qr.size,
    total = n + quiet * 2,
    scale = Math.max(2, Math.floor((px || 260) / total)),
    W = total * scale;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = W;
  cv.style.cssText =
    'width:' + W + 'px;max-width:100%;height:auto;border-radius:10px;image-rendering:pixelated';
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, W, W);
  g.fillStyle = '#000';
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++)
      if (qr.mod[y][x]) g.fillRect((quiet + x) * scale, (quiet + y) * scale, scale, scale);
  return cv;
}
// Modal de compartir (QR + Web Share nativo + copiar enlace/imagen) para una URL ya generada. `titulo` va al
// share nativo; `descHtml` es el texto del modal. Reutilizado por documento y por grupo (colección/obra).
function _modalCompartir(url, titulo, descHtml) {
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:360px;text-align:center"><h3 style="margin-top:0">🔗 Compartir</h3>
    <div id="qrBox" style="display:flex;justify-content:center;margin:4px 0 12px"></div>
    <p class="muted" style="font-size:12px;line-height:1.5">${descHtml}</p>
    <div class="row" style="gap:8px;justify-content:center;margin-top:10px;flex-wrap:wrap">
      <button class="btn pri" id="cmpShare">📤 Compartir</button>
      <button class="btn" id="cmpCopyImg">🖼️ Copiar imagen</button>
      <button class="btn" id="cmpCopy">📋 Copiar enlace</button>
      <button class="btn" id="cmpXq">Cerrar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = cerrarCmp;
  let cv = null;
  try { cv = qrCanvas(qrGenerar(url), 260); const box = $('#qrBox'); if (box) box.appendChild(cv); }
  catch (e) { const box = $('#qrBox'); if (box) box.innerHTML = '<span class="muted" style="font-size:12px">No se pudo generar el QR; usa el enlace.</span>'; }
  $('#cmpXq').onclick = cerrarCmp;
  $('#cmpCopy').onclick = () => { copiar(url); toast('Enlace copiado'); };
  const ci = $('#cmpCopyImg');
  if (ci && cv && navigator.clipboard && window.ClipboardItem && cv.toBlob) {
    ci.onclick = () => { try { cv.toBlob(async (b) => { try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]); toast('Imagen del QR copiada'); } catch (e) { toast('No se pudo copiar la imagen — usa «Copiar enlace»', 'warn'); } }, 'image/png'); } catch (e) { toast('No se pudo copiar la imagen — usa «Copiar enlace»', 'warn'); } };
  } else if (ci) ci.style.display = 'none';
  const sh = $('#cmpShare');
  if (navigator.share) {
    sh.onclick = async () => {
      try {
        if (cv && cv.toBlob && navigator.canShare) {
          const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
          const file = blob && new File([blob], 'qr.png', { type: 'image/png' });
          if (file && navigator.canShare({ files: [file] })) { await navigator.share({ title: titulo || 'Compartir', text: url, files: [file] }); return; }
        }
        await navigator.share({ title: titulo || 'Compartir', url });
      } catch (_) { /* cancelado */ }
    };
  } else sh.style.display = 'none';
}
// Compartir una COLECCIÓN u OBRA: token firmado del grupo → mismo modal; abre todos sus documentos y su descarga.
async function compartirGrupo(tipo, id, nombre) {
  let token;
  try {
    const res = await api('/' + (tipo === 'obra' ? 'obras' : 'colecciones') + '/' + encodeURIComponent(id) + '/compartir', { method: 'POST', body: '{}' });
    token = res.token;
  } catch (e) { toast(e.message, 'bad'); return; }
  _modalCompartir(location.origin + '/?s=' + token, nombre || (tipo === 'obra' ? 'Obra' : 'Colección'),
    `Escanea el QR o comparte el enlace. Abre ${tipo === 'obra' ? 'la obra' : 'la colección'} con <b>todos sus documentos</b> y su descarga — sin acceso al resto de la biblioteca.`);
}
// Compartir por QR: pide al servidor un token firmado de ESTE documento y muestra el QR + enlace. Abre solo
// la ficha (y, si es digital, permite la descarga); no da acceso al resto de la app.
async function compartirDoc(d) {
  const esDigital = !(d.formatos || []).includes('papel');
  let token;
  try {
    const res = await api('/documentos/' + encodeURIComponent(d._id) + '/compartir', {
      method: 'POST',
      body: '{}',
    });
    token = res.token;
  } catch (e) {
    toast(e.message, 'bad');
    return;
  }
  _modalCompartir(location.origin + '/?s=' + token, d.titulo || 'Ficha',
    `Escanea el QR o comparte el enlace. Abre ${esDigital ? 'la ficha y permite la <b>descarga</b>' : 'solo la ficha'} — sin acceso al resto de la biblioteca.`);
}
// Contenedor de PÁGINA AUTÓNOMA (oculta el resto del panel): vista compartida por QR y lectura NFC offline.
function _sharedCont() {
  document.body.classList.add('shared');
  let c = document.getElementById('sharedView');
  if (!c) {
    c = document.createElement('div');
    c.id = 'sharedView';
    c.style.cssText = 'max-width:640px;margin:0 auto;padding:16px 14px 40px';
    document.body.appendChild(c);
  }
  return c;
}
// Colofón: dos líneas centradas y de la MISMA ANCHURA (la 2ª se justifica a lo ancho de la 1ª con
// text-align-last:justify sobre un contenedor inline-block que se ajusta a la línea más ancha).
const _brandLine =
  '<div style="text-align:center;margin:8px 0 16px"><div style="display:inline-block;text-align:justify;text-align-last:justify;font-family:Georgia,\'Times New Roman\',serif;color:var(--acc)"><div style="font-weight:700;letter-spacing:1.5px;font-size:14px">BIBLIOTHECA LUDOVICIANA</div><div class="muted" style="font-size:10px;margin-top:3px">© Luis Ortuño Molina · MMXXVI</div></div></div>';
// Sin conexión: pantalla completa que espera una etiqueta NFC y auto-escanea (no aterriza en el Inbox).
function pantallaEsperaNFC() {
  const cont = _sharedCont();
  cont.innerHTML = `<div style="text-align:center;margin-top:54px"><div style="font-size:44px">📴</div>
    <h2 style="margin:12px 0 4px">Sin conexión</h2>
    <p class="muted">Acerca una etiqueta NFC para ver la ficha del libro.</p>
    ${'NDEFReader' in window ? `<button class="btn pri" id="offRead" style="margin-top:16px">📲 Leer etiqueta</button>` : `<p class="muted" style="font-size:12px;margin-top:10px">Este navegador no soporta NFC (Android + Chrome).</p>`}</div>
    <div style="margin-top:30px">${_brandLine}</div>`;
  const b = document.getElementById('offRead');
  if (b)
    b.onclick = () => {
      try {
        leerNFC();
      } catch (_) {}
    };
  if ('NDEFReader' in window)
    setTimeout(() => {
      try {
        leerNFC();
      } catch (_) {}
    }, 300);
}
// VISTA COMPARTIDA (?s=<token>): página autónoma de SOLO la ficha (sin login ni resto de la app).
// Vista pública de un GRUPO compartido (colección u obra): ex-libris + nombre + lista de sus documentos con
// descarga individual. Sin acceso al resto de la biblioteca.
function renderGrupoCompartido(cont, g) {
  const tipoLbl = g.tipo === 'obra' ? 'Obra' : 'Colección';
  const filas = (g.miembros || []).map((m) => {
    const cov = m.portada
      ? `<img src="${esc(encUrl(m.portada))}" loading="lazy" style="width:44px;height:60px;object-fit:cover;border-radius:5px;background:var(--card)">`
      : `<div style="width:44px;height:60px;border-radius:5px;background:var(--card);display:flex;align-items:center;justify-content:center">📗</div>`;
    const meta = [m.volumen != null ? 'Vol. ' + m.volumen : '', m['año_edicion'] || '', (m.formatos || []).join('·')].filter(Boolean).join(' · ');
    const dl = m.descarga_url
      ? `<a class="btn pri" href="${esc(encUrl(m.descarga_url))}" download title="Descargar" style="padding:4px 11px;font-size:13px">⬇</a>`
      : '<span class="muted" style="font-size:11px">papel</span>';
    return `<div class="row" style="align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)">
      ${cov}
      <div style="flex:1;min-width:0"><div style="font-weight:600;word-break:break-word">${esc(m.titulo)}</div>${meta ? `<div class="muted" style="font-size:11px">${esc(meta)}</div>` : ''}</div>
      ${dl}</div>`;
  }).join('');
  cont.innerHTML = `${_brandLine}
    <div style="max-width:560px;margin:0 auto">
      ${heroExlibris(EX_LIBRIS)}
      <div style="text-align:center;margin:6px 0 14px">
        <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:1px">${tipoLbl}</div>
        <h2 style="margin:2px 0">${esc(g.nombre)}</h2>
        <div class="muted" style="font-size:12px">${g.total} documento${g.total === 1 ? '' : 's'} · descarga individual</div>
      </div>
      ${filas || '<p class="muted" style="text-align:center">Sin documentos.</p>'}
    </div>`;
}
async function vistaCompartida(token) {
  const cont = _sharedCont();
  cont.innerHTML = '<p class="muted" style="text-align:center;margin-top:50px">Cargando ficha…</p>';
  let data;
  try {
    data = await fetch('/api/compartido/' + encodeURIComponent(token)).then((r) => r.json());
  } catch (e) {
    data = null;
  }
  if (!data || !data.ok || !data.ficha) {
    cont.innerHTML =
      '<p class="muted" style="text-align:center;margin-top:50px">Enlace no válido o documento no disponible.</p>';
    return;
  }
  const f = data.ficha;
  if (f.grupo) { renderGrupoCompartido(cont, f); return; } // colección/obra: lista de documentos con descarga
  const portada = f.portada
    ? `<div style="text-align:center;margin-bottom:14px"><img src="${esc(encUrl(f.portada))}" style="max-height:260px;max-width:78%;border-radius:10px;box-shadow:0 6px 20px rgba(0,0,0,.5)"></div>`
    : '';
  const fmin = fichaMinima({
    titulo: f.titulo,
    subtitulo: f.subtitulo,
    estrellas: f.valoracion,
    esDigital: f.es_digital,
    exlibris: EX_LIBRIS,
    ocultarUbicacion: true, // nunca se expone la ubicación física
    descargaUrl: f.descarga_url ? encUrl(f.descarga_url) : '',
    descargaNombre: f.nombre_archivo || '',
    autor: (f.autores || []).join(', '),
    editorial: f.editorial || '',
    coleccion: f.coleccion || '',
    cdu: f.cdu || '',
    isbn: f.isbn || '',
    origen: 'Ficha compartida (solo lectura). No da acceso al resto de la biblioteca.',
  });
  const sinopsis = f.sinopsis
    ? `<details class="card foldcard" open style="margin-top:14px"><summary>📝 Sinopsis</summary><p class="sinopsis-text" style="margin-top:10px">${esc(f.sinopsis)}</p></details>`
    : '';
  cont.innerHTML = `${_brandLine}${portada}${fmin}${sinopsis}`;
}
function mostrarOfflineNFC(o, ex) {
  // Una etiqueta NFC se pega a un ejemplar FÍSICO → siempre papel: ex-libris + ubicación (Ficha mínima).
  const fmin = fichaMinima({
    titulo: o.t,
    estrellas: o.s,
    esDigital: false,
    exlibris: ex || EX_LIBRIS,
    autor: o.a || '',
    editorial: o.e || '',
    coleccion: o.x || '',
    cdu: o.c || '',
    isbn: o.i || '',
    ubicacion: o.u || '',
    origen: 'Datos leídos de la etiqueta NFC (sin conexión).',
  });
  // Sin conexión → PÁGINA COMPLETA con solo la Ficha mínima (no un modal sobre el Inbox). No hace falta
  //   «leer otra etiqueta»: al tocar otra, el SO reabre la app con su ?doc=&o= y sale su ficha directa.
  if (APP_OFFLINE) {
    const cont = _sharedCont();
    cont.innerHTML = `${fmin}<div style="margin-top:26px">${_brandLine}</div>`;
    return;
  }
  // Con conexión (lectura puntual que no alcanzó el servidor): modal ligero, sin abandonar la página. Cuando
  //   el servidor SÍ responde, leerNFC ya abre la ficha online directamente (con la Ficha mínima primero).
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:460px;padding:0;overflow:hidden;border:none">${fmin}
    <div style="padding:12px 16px 14px"><p class="muted" style="font-size:12px;margin:0 0 10px">📴 No hay conexión.</p>
    <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" id="nfcCerr">Cerrar</button></div></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  const cl = $('#nfcCerr');
  if (cl) cl.onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
}
// DEVOLVER-SI-SE-PIERDE: página PÚBLICA (sin login) para quien ENCUENTRE un libro fuera de la biblioteca y
// escanee su etiqueta. Muestra la propiedad (ex-libris con nombre + contacto del .env) y los datos del
// ejemplar leídos de la propia etiqueta (?o=), más un botón discreto «Entrar» para el propietario. Usa datos
// OFFLINE (no requiere que el finder tenga sesión ni que el servidor devuelva la ficha).
async function mostrarRetornoPublico(off) {
  // Refresca el contacto del ex-libris por si el fetch de arranque aún no había resuelto.
  try {
    const c = await fetch('/api/exlibris').then((r) => (r.ok ? r.json() : null));
    if (c) { EX_LIBRIS = _construirExLibris(c); localStorage.setItem('exlibris', EX_LIBRIS); }
  } catch (_) {}
  const fmin = fichaMinima({
    titulo: off.t, estrellas: off.s, esDigital: false, exlibris: EX_LIBRIS,
    autor: off.a || '', editorial: off.e || '', coleccion: off.x || '', cdu: off.c || '',
    isbn: off.i || '', ubicacion: off.u || '',
    origen: 'Datos leídos de la etiqueta NFC de este ejemplar.',
  });
  const cont = _sharedCont();
  cont.innerHTML = `<div style="max-width:460px;margin:0 auto">
      <p class="muted" style="text-align:center;font-size:13px;margin:6px 0 14px">📚 Has encontrado un libro de esta biblioteca. Aquí verás de quién es y cómo devolverlo.</p>
      ${fmin}
      <div style="text-align:center;margin-top:16px"><button class="btn" id="retLogin" style="font-size:12px">Soy el propietario · Entrar</button></div>
      <div style="margin-top:22px">${_brandLine}</div>
    </div>`;
  const b = $('#retLogin');
  if (b) b.onclick = () => mostrarLogin();
}
// Lectura de una etiqueta de ESTANTERÍA: ex-libris (hero) + nombre + «Ver libros» (lista esa ubicación).
function mostrarEstanteriaNFC(label, amb, est, ex) {
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:460px">${heroExlibris(ex)}
    <div style="margin:4px 0 14px;padding:12px;border:1px solid var(--acc);border-radius:10px;text-align:center;background:var(--card2)">
      <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:1px">Estantería</div>
      <div style="font-size:21px;font-weight:700;color:var(--acc)">📍 ${esc(label || amb || '—')}</div></div>
    <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn pri" id="nfcVerEst">Ver libros</button><button class="btn" id="nfcCerr2">Cerrar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  const c = $('#nfcCerr2');
  if (c) c.onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
  const v = $('#nfcVerEst');
  if (v)
    v.onclick = () => {
      cerrarCmp();
      verEstanteriaEnCatalogo(amb, est);
    };
}
// Graba en una etiqueta NFC (NTAG215, 504 B) el enlace ?doc=<id> (al acercar el móvil abre la ficha; en
// iPhone, Safari → mismo destino) + el registro OFFLINE para recolocar sin conexión.
async function grabarNFC(d, r) {
  if (!('NDEFReader' in window)) {
    toast('Este navegador no soporta NFC (Android + Chrome)', 'bad');
    return;
  }
  const { url, records: recs } = _recordsDoc(d, r);
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:420px;text-align:center"><h3 style="margin-top:0">📶 Grabar etiqueta NFC</h3>
    <p class="muted" id="nfcWrMsg">Acerca una etiqueta NFC (NTAG215) al móvil para grabarla…</p>
    <p class="muted" style="font-size:12px">📍 ${esc(_txtUbic(d) || 'Sin asignar')} · ex-libris + datos offline</p>
    <label style="display:flex;gap:6px;align-items:center;justify-content:center;font-size:12px;margin:6px 0"><input type="checkbox" id="nfcSobrescribir"> Sobrescribir sin comprobar (re-grabar una etiqueta ya usada)</label>
    <p class="muted" style="font-size:11px;margin:0 6px 6px">Márcalo si la etiqueta YA tiene datos (antiguos o de este mismo libro): escribe en el primer toque, sin leerla antes, para que el móvil no abra la ficha vieja.</p>
    <div style="display:flex;gap:10px;justify-content:center;margin-top:8px"><button class="btn" id="nfcWrX">Cancelar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  bloquearRotacion(); // no gires la pantalla mientras se manipula el móvil sobre la etiqueta (se libera en cerrarCmp)
  const ctrl = new AbortController();
  const cerrar = () => {
    try {
      ctrl.abort();
    } catch (_) {}
    cerrarCmp();
  };
  $('#nfcWrX').onclick = cerrar;
  $('#cmpScrim').onclick = cerrar;
  const marcar = async (uid) => {
    try {
      return await api('/documentos/' + encodeURIComponent(d._id) + '/nfc', {
        method: 'POST',
        body: JSON.stringify({ uid, url }),
      });
    } catch (_) {
      return null;
    }
  };
  // Graba pidiendo CONFIRMACIÓN si la etiqueta ya estaba grabada para otro libro (posible libro equivocado).
  const escribir = async (records) => {
    try {
      // forzar se lee EN EL TOQUE: si marcas «Sobrescribir sin comprobar», se escribe directo (sin leer la
      // etiqueta antes), lo que evita que el sistema abra la URL vieja al re-grabar una etiqueta ya usada.
      return await escribirNFC(records, d._id, ctrl.signal, () => !!($('#nfcSobrescribir') && $('#nfcSobrescribir').checked));
    } catch (eo) {
      if (eo && eo.code === 'OCUPADA') {
        const det =
          eo.prev && eo.prev.titulo
            ? `de «${recortar(eo.prev.titulo, 40)}»`
            : eo.prev && eo.prev.docId
              ? 'de OTRO libro'
              : 'con datos ajenos';
        if (
          !confirm(
            '⚠️ Esta etiqueta YA está grabada ' +
              det +
              '.\n¿Quizá es el libro equivocado? Pulsa Aceptar para SOBRESCRIBIR.',
          )
        )
          throw { code: 'CANCELADO' };
        const m = $('#nfcWrMsg');
        if (m) {
          m.textContent = 'Acerca de nuevo la etiqueta para sobrescribir…';
          m.style.color = 'var(--warn)';
        }
        return await escribirNFC(records, d._id, ctrl.signal, true);
      }
      throw eo;
    }
  };
  try {
    const uid = await escribir(recs);
    const res = await marcar(uid);
    const rea = res && res.reasignado;
    const m = $('#nfcWrMsg');
    if (m) {
      m.innerHTML =
        '✅ Etiqueta grabada y vinculada' +
        (uid ? ' · UID ' + esc(uid) : '') +
        '.' +
        (rea
          ? `<br><span style="color:var(--warn)">⚠️ Estaba en «${esc(recortar(rea.titulo || '?', 40))}» — reasignada a este libro.</span>`
          : '');
      m.style.color = 'var(--ok)';
    }
    toast(rea ? 'Etiqueta reasignada (estaba en otro libro)' : 'Etiqueta NFC grabada', rea ? 'warn' : 'ok');
    setTimeout(cerrarCmp, rea ? 2200 : 1100);
  } catch (e) {
    if (e && e.code === 'CANCELADO') {
      cerrarCmp();
      return;
    }
    if (e && e.name === 'AbortError') return; // cancelado por el usuario
    const m = $('#nfcWrMsg');
    if (m) {
      m.innerHTML = `No cupo con datos offline (${esc(e.message || '')}). <button class="btn" id="nfcSolo" style="margin-top:8px">Grabar solo el enlace</button>`;
      m.style.color = 'var(--bad)';
    }
    const so = $('#nfcSolo');
    if (so)
      so.onclick = async () => {
        try {
          const uid = await escribir([
            { recordType: 'url', data: url },
            { recordType: 'text', data: EX_LIBRIS },
          ]);
          await marcar(uid);
          if (m) {
            m.textContent = '✅ Enlace grabado (sin datos offline).';
            m.style.color = 'var(--ok)';
          }
          toast('Etiqueta NFC grabada');
          setTimeout(cerrarCmp, 1100);
        } catch (e2) {
          if (e2 && e2.code === 'CANCELADO') {
            cerrarCmp();
            return;
          }
          if (e2 && e2.name !== 'AbortError' && m) {
            m.textContent = 'No se pudo grabar: ' + (e2.message || '');
          }
        }
      };
  }
}
// ════════ ETIQUETADO NFC POR LOTES ════════
// Cola de documentos a etiquetar: muestra la ficha, pide acercar la etiqueta, graba (UID) y avanza —
// MANUAL (confirmar «Siguiente») o AUTOMÁTICO (avanza solo al grabar bien). Pausar/Continuar/Saltar/Vaciar.
// La cola pendiente se guarda en localStorage para REANUDAR si se cierra. Reutiliza _payloadOffline/_blen.
let _etq = null,
  _etqGen = 0;
const ETQ_LS = 'nfc_cola';
function guardarColaEtq() {
  try {
    if (_etq && _etq.i < _etq.ids.length)
      localStorage.setItem(ETQ_LS, JSON.stringify({ ids: _etq.ids.slice(_etq.i), auto: _etq.auto }));
    else localStorage.removeItem(ETQ_LS);
  } catch (_) {}
}
function colaEtqGuardada() {
  try {
    const j = JSON.parse(localStorage.getItem(ETQ_LS) || 'null');
    return j && Array.isArray(j.ids) && j.ids.length ? j : null;
  } catch (_) {
    return null;
  }
}
async function iniciarEtiquetadoLote(ids, auto) {
  if (!('NDEFReader' in window)) {
    toast('Este navegador no soporta NFC (Android + Chrome)', 'bad');
    return;
  }
  ids = [...new Set((ids || []).filter(Boolean))];
  if (!ids.length) {
    toast('No hay libros seleccionados', 'warn');
    return;
  }
  // Con 2+ libros, se pregunta EN QUÉ ORDEN etiquetarlos (la selección llega en orden arbitrario). Así se
  // etiquetan en un orden útil (ingreso, o colección+nº) que además puede coincidir con el orden físico.
  if (ids.length >= 2) {
    const criterio = await elegirOrdenLote();
    if (criterio === null) return; // cancelado
    if (criterio === 'ingreso' || criterio === 'coleccion') {
      try {
        const r = await api('/documentos/orden', { method: 'POST', body: JSON.stringify({ ids, criterio }) });
        if (r.ids && r.ids.length) ids = r.ids;
      } catch (_) {
        /* si falla la ordenación, se sigue con el orden de selección */
      }
    }
  }
  // reader/scanAbort/_onRead/ultimoUid: un ÚNICO lector con scan() sostenido durante TODA la cola (mantiene
  // el foreground NFC → el sistema nunca lee la etiqueta ni redirige, ni siquiera entre libros). Ver
  // _etqAsegurarScan/grabarItemEtq. `soportaScan` = si el navegador dejó abrir ese scan sostenido.
  _etq = { ids, i: 0, auto: !!auto, abort: null, actual: null, reader: null, scanAbort: null, _onRead: null, ultimoUid: null, soportaScan: true };
  $('#cmpModal').innerHTML = '<div class="box card" style="max-width:480px"><div id="etqBody"></div></div>';
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = null; // no cerrar por fuera
  bloquearRotacion(); // bloquea la rotación durante TODA la cola (se libera al terminar/pausar/vaciar → cerrarCmp)
  procesarEtq();
}
// Pregunta el orden para el etiquetado por lotes. Devuelve 'ingreso' | 'coleccion' | 'actual' | null(cancelar).
function elegirOrdenLote() {
  return new Promise((resolver) => {
    $('#cmpModal').innerHTML = `<div class="box card" style="max-width:420px">
      <h3 style="margin-top:0">📶 Etiquetar en lote — ¿en qué orden?</h3>
      <div class="muted" style="font-size:12px;margin-bottom:10px">Se irán pidiendo las etiquetas en ese orden (útil para dejarlas en el mismo orden físico).</div>
      <div style="display:flex;flex-direction:column;gap:8px">
        <button class="btn pri" data-ord="ingreso">📥 Por fecha de ingreso</button>
        <button class="btn" data-ord="coleccion">🗂️ Por colección + nº de volumen</button>
        <button class="btn" data-ord="actual">↕️ Como están seleccionados</button>
        <button class="btn" data-ord="">Cancelar</button>
      </div></div>`;
    $('#cmpScrim').style.display = 'block';
    $('#cmpModal').style.display = 'grid';
    const cerrarCon = (valor) => { cerrarCmp(); resolver(valor); };
    $('#cmpScrim').onclick = () => cerrarCon(null);
    $$('#cmpModal [data-ord]').forEach((b) => (b.onclick = () => cerrarCon(b.dataset.ord || null)));
  });
}
// Asegura UN lector con scan() ACTIVO durante toda la cola: así Chrome mantiene el foreground NFC de forma
// CONTINUA y el sistema no lee/redirige nunca (tampoco en el hueco entre libros). El onreading del scan se
// reenvía al «esperador» del ítem actual (_etq._onRead). Si el navegador no deja abrir el scan sostenido,
// `soportaScan=false` y se recae al método por-etiqueta (escribirNFC).
async function _etqAsegurarScan() {
  if (!_etq || _etq.reader || !_etq.soportaScan) return;
  try {
    _etq.reader = new NDEFReader();
    _etq.scanAbort = new AbortController();
    _etq.reader.onreading = (ev) => { if (_etq && typeof _etq._onRead === 'function') _etq._onRead(ev); };
    _etq.reader.onreadingerror = () => {};
    await _etq.reader.scan({ signal: _etq.scanAbort.signal });
  } catch (_) {
    _etq.reader = null;
    _etq.soportaScan = false; // el navegador no permite el scan sostenido → recambio por-etiqueta
  }
}
// Detiene el scan sostenido de la sesión (al terminar/pausar/vaciar la cola).
function _etqPararScan() {
  if (_etq && _etq.scanAbort) { try { _etq.scanAbort.abort(); } catch (_) {} }
  if (_etq) { _etq.reader = null; _etq._onRead = null; }
}
// Graba UN ítem sobre el lector sostenido: espera el PRÓXIMO toque (de ahí saca el UID), NO comprueba nada
// (escribe directo → sin lectura previa que redirija) y NO aborta el scan (sin hueco). Ignora la etiqueta
// recién grabada (mismo UID) para no reescribir el libro anterior si sigue cerca. Devuelve el UID (o null).
function grabarItemEtq(recs, signal) {
  return new Promise((resolve, reject) => {
    let hecho = false;
    const onAbort = () => {
      if (hecho) return;
      hecho = true; _etq._onRead = null;
      reject(new DOMException('abortado', 'AbortError'));
    };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    _etq._onRead = async (ev) => {
      if (hecho) return;
      const uid = ev.serialNumber || null;
      if (uid && _etq.ultimoUid && uid === _etq.ultimoUid) return; // misma etiqueta ya grabada: espera otra
      _etq._onRead = null; // desarma mientras escribe (no re-entrar)
      try {
        await _etq.reader.write({ records: recs }, { signal });
        sonidoNfcEscritura();
        hecho = true;
        if (uid) _etq.ultimoUid = uid;
        resolve(uid);
      } catch (e) {
        hecho = true;
        reject(e);
      }
    };
  });
}
async function procesarEtq() {
  if (!_etq) return;
  if (_etq.abort) {
    try {
      _etq.abort.abort();
    } catch (_) {}
  } // cancela el anterior (sus resultados se ignoran por gen)
  const gen = ++_etqGen;
  if (_etq.i >= _etq.ids.length) {
    finEtq();
    return;
  }
  guardarColaEtq();
  pintarEtq(null, null, 'cargando');
  const id = _etq.ids[_etq.i];
  let r = null,
    doc = null;
  try {
    r = await api('/documentos/' + encodeURIComponent(id));
    doc = r.doc;
  } catch (_) {}
  if (gen !== _etqGen) return;
  if (!doc) {
    pintarEtq(null, null, 'errorDoc');
    return;
  }
  const { url, records: recs } = _recordsDoc(doc, r);
  _etq.actual = { doc, r, url };
  await _etqAsegurarScan(); // scan sostenido de la sesión (foreground continuo, sin huecos)
  pintarEtq(doc, r, 'esperando');
  const abort = new AbortController();
  _etq.abort = abort;
  try {
    // Con el scan sostenido, se graba sobre ese lector (sin lectura previa de comprobación → sin el hueco
    // que hacía que el sistema abriera la URL). Si el navegador no lo soporta, recambio: escribirNFC forzado.
    const uid = _etq.reader
      ? await grabarItemEtq(recs, abort.signal)
      : await escribirNFC(recs, id, abort.signal, true);
    if (gen !== _etqGen) return;
    await etqTrasGrabar(doc, r, uid, url, gen);
  } catch (e) {
    if (gen !== _etqGen) return;
    if (e && e.name === 'AbortError') {
      pintarEtq(doc, r, 'pausa');
      return;
    }
    pintarEtq(doc, r, 'error', e && e.message);
  }
}
// Tras una grabación correcta (normal/solo-enlace/sobrescribir): marca el doc, vibra, avisa reasignación y avanza.
async function etqTrasGrabar(doc, r, uid, url, gen) {
  let res = null;
  try {
    res = await api('/documentos/' + encodeURIComponent(doc._id) + '/nfc', {
      method: 'POST',
      body: JSON.stringify({ uid, url }),
    });
  } catch (_) {}
  doc.nfc = { uid: uid || undefined, fecha_vinculacion: new Date().toISOString() };
  try {
    navigator.vibrate && navigator.vibrate(70);
  } catch (_) {}
  if (res && res.reasignado)
    toast('⚠️ Etiqueta reasignada (estaba en «' + recortar(res.reasignado.titulo || '?', 30) + '»)', 'warn');
  pintarEtq(doc, r, 'ok', uid);
  if (_etq && _etq.auto)
    setTimeout(() => {
      if (_etq && _etqGen === gen) {
        _etq.i++;
        procesarEtq();
      }
    }, 900);
}
// Reintento «solo el enlace» (si los datos offline no cupieron): graba url + ex-libris sobre el lector
// sostenido (o recambio). No hace lectura previa de comprobación.
async function etqSoloEnlace() {
  if (!_etq || !_etq.actual) return;
  const { doc, r, url } = _etq.actual;
  const recs = [
    { recordType: 'url', data: url },
    { recordType: 'text', data: EX_LIBRIS },
  ];
  const gen = ++_etqGen;
  const abort = new AbortController();
  _etq.abort = abort;
  await _etqAsegurarScan();
  pintarEtq(doc, r, 'esperando');
  try {
    const uid = _etq.reader
      ? await grabarItemEtq(recs, abort.signal)
      : await escribirNFC(recs, doc._id, abort.signal, true);
    if (gen !== _etqGen) return;
    await etqTrasGrabar(doc, r, uid, url, gen);
  } catch (e) {
    if (gen !== _etqGen) return;
    if (e && e.name === 'AbortError') {
      pintarEtq(doc, r, 'pausa');
      return;
    }
    pintarEtq(doc, r, 'error', e && e.message);
  }
}
function finEtq() {
  const n = _etq ? _etq.ids.length : 0;
  _etqPararScan(); // suelta el foreground NFC de la sesión
  localStorage.removeItem(ETQ_LS);
  _etqGen++;
  _etq = null;
  cerrarCmp();
  toast(`Etiquetado terminado (${n} libro/s)`);
  if ($('#sqQ')) buscarCatalogo(estadoBusqueda.page || 1);
}
function vaciarEtq() {
  _etqGen++;
  if (_etq && _etq.abort) {
    try {
      _etq.abort.abort();
    } catch (_) {}
  }
  _etqPararScan();
  localStorage.removeItem(ETQ_LS);
  _etq = null;
  cerrarCmp();
  toast('Cola de etiquetado vaciada', 'warn');
  if ($('#sqQ')) buscarCatalogo(estadoBusqueda.page || 1);
}
function cerrarEtqGuardando() {
  _etqGen++;
  if (_etq && _etq.abort) {
    try {
      _etq.abort.abort();
    } catch (_) {}
  }
  _etqPararScan();
  guardarColaEtq();
  _etq = null;
  cerrarCmp();
  toast('Etiquetado en pausa — «Reanudar» cuando quieras');
  if ($('#sqQ')) buscarCatalogo(estadoBusqueda.page || 1);
}
function pintarEtq(doc, r, estado, extra) {
  const b = $('#etqBody');
  if (!b || !_etq) return;
  const tot = _etq.ids.length,
    n = Math.min(_etq.i + 1, tot);
  const cov =
    doc && doc.portada
      ? `<img src="${esc(encUrl(doc.portada))}" style="width:64px;height:86px;object-fit:cover;border-radius:6px;border:1px solid var(--line)">`
      : `<div style="width:64px;height:86px;display:grid;place-items:center;background:var(--bg2);border-radius:6px;font-size:26px">📕</div>`;
  const tit = doc ? esc(recortar(doc.titulo || '(sin título)', 70)) : '—';
  const aut = r && r.autores && r.autores.length ? esc(r.autores.slice(0, 2).join(', ')) : '';
  const ubic = doc ? esc(_txtUbic(doc) || 'Sin asignar') : '';
  const yaTen = doc && doc.nfc && (doc.nfc.fecha_vinculacion || doc.nfc.uid) && estado !== 'ok';
  const cP = `<button class="btn" id="etqPausa">⏸ Pausar</button>`,
    cS = `<button class="btn" id="etqSaltar">⏭ Saltar</button>`,
    cX = `<button class="btn bad" id="etqCerrar">✕ Vaciar cola</button>`;
  let est = '',
    bot = '';
  if (estado === 'esperando') {
    est = '<span style="color:var(--acc);font-weight:600">📶 Acerca la etiqueta al móvil…</span>';
    bot = cP + cS + cX;
  } else if (estado === 'ok') {
    est = `<span style="color:var(--ok);font-weight:600">✅ Grabada${extra ? ' · UID ' + esc(extra) : ''}</span>`;
    bot =
      (_etq.auto
        ? '<span class="muted">siguiente…</span>'
        : `<button class="btn pri" id="etqSig">Siguiente ▶</button>`) + cX;
  } else if (estado === 'error') {
    est = `<span style="color:var(--bad)">No se pudo grabar: ${esc(extra || '')}</span>`;
    bot =
      `<button class="btn" id="etqReint">↻ Reintentar</button><button class="btn" id="etqSolo">Solo enlace</button>` +
      cS +
      cX;
  } else if (estado === 'pausa') {
    est = '<span class="muted">⏸ En pausa</span>';
    bot = `<button class="btn pri" id="etqCont">▶ Continuar</button>` + cS + cX;
  } else if (estado === 'errorDoc') {
    est = '<span style="color:var(--bad)">No se pudo cargar este documento.</span>';
    bot = cS + cX;
  } else {
    est = '<span class="muted">Cargando…</span>';
    bot = cX;
  }
  b.innerHTML = `<h3 style="margin-top:0">📶 Etiquetar — ${n} / ${tot} <button class="btn" id="etqMin" title="Cerrar conservando la cola (reanudar luego)" style="float:right;padding:2px 9px">✕</button></h3>
    <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:8px;cursor:pointer"><input type="checkbox" id="etqAuto" ${_etq.auto ? 'checked' : ''} style="width:auto;margin:0"> Modo automático (avanza solo al grabar)</label>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:8px">${cov}<div style="min-width:0"><div style="font-weight:600;word-break:break-word">${tit}</div>${aut ? `<div class="muted" style="font-size:12px">${aut}</div>` : ''}<div style="margin-top:6px"><span class="tag" style="background:rgba(40,217,168,.16);color:var(--acc)">📍 ${ubic}</span>${yaTen ? ' <span class="muted" style="font-size:11px">· ya tenía etiqueta (regrabar)</span>' : ''}</div></div></div>
    <div style="min-height:24px;margin:6px 0;font-size:14px">${est}</div>
    <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end">${bot}</div>`;
  const A = $('#etqAuto');
  if (A)
    A.onchange = () => {
      _etq.auto = A.checked;
      guardarColaEtq();
      if (_etq.auto && estado === 'ok') {
        _etq.i++;
        procesarEtq();
      }
    };
  const w = (id, fn) => {
    const e = $('#' + id);
    if (e) e.onclick = fn;
  };
  w('etqCerrar', vaciarEtq);
  w('etqMin', cerrarEtqGuardando);
  w('etqSaltar', () => {
    _etq.i++;
    procesarEtq();
  });
  w('etqSig', () => {
    _etq.i++;
    procesarEtq();
  });
  w('etqCont', () => procesarEtq());
  w('etqPausa', () => {
    if (_etq.abort) {
      try {
        _etq.abort.abort();
      } catch (_) {}
    }
  });
  w('etqReint', () => procesarEtq());
  w('etqSolo', etqSoloEnlace);
}
// ════════ UBICACIONES (ámbitos/estanterías gestionadas como colecciones de estanterías) ════════
let ubicArbol = [],
  ubicSel = null,
  ubicPendiente = null;
// Ámbitos COLAPSADOS por defecto: guardamos el set de EXPANDIDOS (persistente); lo no listado sale plegado,
// así al abrir Ubicaciones se ve la lista compacta.
function _cargarUbicExp() {
  try {
    return new Set(JSON.parse(localStorage.getItem('ubic_exp') || '[]'));
  } catch (_) {
    return new Set();
  }
}
let ubicExp = _cargarUbicExp();
const _guardarUbicExp = () => {
  try {
    localStorage.setItem('ubic_exp', JSON.stringify([...ubicExp]));
  } catch (_) {}
};
const ubBtn = (act, a, e, ico, tit) =>
  `<button type="button" class="ubx" data-act="${act}" data-a="${esc(a)}"${e != null ? ` data-e="${esc(e)}"` : ''} title="${esc(tit)}">${ico}</button>`;
// Ítem de un menú «⋯» (icono + rótulo, para las acciones secundarias — así la fila no es un bosque de botones).
const ubMenuItem = (act, a, e, label, extra = '') =>
  `<button type="button" class="ubmi${extra}" data-act="${act}" data-a="${esc(a)}"${e != null ? ` data-e="${esc(e)}"` : ''}>${label}</button>`;
function ambitosNombres() {
  return ubicArbol.map((x) => x.ambito);
}
function estanteriasNombres(a) {
  const A = ubicArbol.find((x) => x.ambito === a);
  return A ? A.estanterias.map((e) => e.estanteria) : [];
}
async function loadUbic() {
  const cont = $('#p-ubic');
  if (cont && !cont.innerHTML) cont.innerHTML = '<div class="muted" style="padding:22px">Cargando…</div>';
  try {
    const r = await api('/ubicaciones/gestion');
    ubicArbol = r.ambitos || [];
  } catch (e) {
    if (cont) cont.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  pintarUbic();
}
function pintarUbic() {
  const cont = $('#p-ubic');
  if (!cont) return;
  const arbol = ubicArbol;
  cont.innerHTML = `<style>
    #p-ubic .ubamb{border:1px solid var(--line);border-radius:11px;margin-bottom:10px;background:var(--card)}
    #p-ubic .ubhdr{border-radius:11px 11px 0 0}
    #p-ubic .ubrow{display:flex;gap:10px;align-items:center;padding:9px 11px;flex-wrap:wrap}
    #p-ubic .ubhdr{background:var(--card2);border-bottom:1px solid var(--line)}
    #p-ubic .ubests{background:var(--bg2)}
    #p-ubic .ubest{border-top:1px solid var(--bg2)}
    #p-ubic .ubest>.ubx:first-child{padding-left:12px}
    /* nombres + triángulo de plegado: texto clicable (no botón) */
    #p-ubic b.ubx,#p-ubic span.ubx{background:none;border:0;color:var(--txt);cursor:pointer;opacity:.9;padding:4px 3px;border-radius:6px}
    #p-ubic b.ubx:hover,#p-ubic span.ubx:hover{opacity:1;color:var(--acc)}
    /* botones de acción: superficie táctil amplia y bien separada (antes: diminutos y pegados) */
    #p-ubic .ubacts{margin-left:auto;display:flex;gap:8px;flex-wrap:wrap;align-items:center}
    #p-ubic button.ubx{background:var(--card2);border:1px solid var(--line);color:var(--txt);min-width:40px;height:40px;padding:0 9px;border-radius:10px;font-size:18px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;line-height:1;transition:.12s;opacity:1}
    #p-ubic button.ubx:hover{border-color:var(--acc);color:#fff;background:var(--card)}
    #p-ubic button.ubx:active{transform:scale(.93)}
    /* asa de reordenar: ↑/↓ apiladas y compactas (no ocupan como un botón de acción) */
    #p-ubic .ubreord{display:flex;flex-direction:column;gap:2px;flex:0 0 auto}
    #p-ubic .ubreord button.ubx{height:19px;min-width:34px;font-size:13px;padding:0 6px;border-radius:7px}
    #p-ubic .ubest{cursor:default}
    #p-ubic .ubest.dragging{opacity:.45}
    #p-ubic .ubest.dragover{box-shadow:inset 0 2px 0 var(--acc)}
    /* nombre destacado (clicable) + recuento discreto */
    #p-ubic .ubname{font-size:14.5px;font-weight:600}
    #p-ubic .ubcount{font-size:12px;white-space:nowrap}
    #p-ubic .ubnfctag{opacity:.8}
    /* NFC de LIBROS (🏷️) con un tinte propio para distinguirlo del NFC del estante (📶) */
    #p-ubic button.ubx[data-act$="nfc-libros"]{border-color:var(--acc2)}
    /* menú «⋯» de acciones secundarias: quita el bosque de botones de la fila */
    #p-ubic .ubmenu{position:relative;display:inline-block}
    #p-ubic .ubmenu>summary{list-style:none;cursor:pointer;background:var(--card2);border:1px solid var(--line);color:var(--txt);min-width:40px;height:40px;padding:0 9px;border-radius:10px;font-size:20px;display:inline-flex;align-items:center;justify-content:center;line-height:1;transition:.12s}
    #p-ubic .ubmenu>summary::-webkit-details-marker{display:none}
    #p-ubic .ubmenu>summary:hover{border-color:var(--acc);color:#fff}
    #p-ubic .ubmenu[open]>summary{border-color:var(--acc);color:#fff}
    #p-ubic .ubpop{position:absolute;right:0;top:46px;z-index:30;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px;min-width:210px;display:flex;flex-direction:column;gap:2px;box-shadow:0 8px 22px rgba(0,0,0,.45)}
    #p-ubic .ubmi{background:none;border:0;color:var(--txt);text-align:left;padding:9px 10px;border-radius:8px;font-size:13.5px;cursor:pointer;white-space:nowrap}
    #p-ubic .ubmi:hover{background:var(--card2);color:#fff}
    #p-ubic .ubmi.bad:hover{background:rgba(255,92,122,.18);color:var(--bad)}
    #p-ubic .ubgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:12px}
    #p-ubic .ubcard{background:var(--card2);border-radius:10px;padding:6px}
  </style>
  <div class="sec-h"><h2>📍 Ubicaciones</h2><span class="muted">${arbol.length} ámbito(s)</span></div>
  <div class="card" style="margin-bottom:16px">
    <h3 style="margin-top:0">➕ Crear estanterías</h3>
    <div class="row" style="gap:8px;align-items:flex-end">
      <div style="flex:1 1 160px"><label>Ámbito</label><input id="ubAmb" list="ubDlAmb" placeholder="p. ej. Biblioteca" autocomplete="off"></div>
      <div><label>Modo</label><select id="ubModo"><option value="una">Una</option><option value="lote">En lote</option></select></div>
    </div>
    <div id="ubUna" class="row" style="gap:8px;align-items:flex-end;margin-top:8px">
      <div style="flex:1 1 160px"><label>Estantería</label><input id="ubEstUna" placeholder="p. ej. Estante 3" autocomplete="off"></div>
    </div>
    <div id="ubLote" class="row" style="gap:8px;align-items:flex-end;margin-top:8px;display:none">
      <div style="flex:1 1 160px"><label>Prefijo</label><input id="ubPre" placeholder="Estanteria_pared_" autocomplete="off"></div>
      <div style="width:84px"><label>Desde</label><input id="ubDesde" type="number" value="1" min="0"></div>
      <div style="width:84px"><label>Hasta</label><input id="ubHasta" type="number" value="10" min="0"></div>
      <div style="width:84px"><label>Dígitos</label><input id="ubAncho" type="number" value="2" min="1" max="6"></div>
    </div>
    <div id="ubPrev" class="muted" style="font-size:12px;margin-top:8px"></div>
    <div style="margin-top:10px"><button class="btn pri" id="ubCrear">Crear</button></div>
    <datalist id="ubDlAmb">${arbol.map((a) => `<option value="${esc(a.ambito)}">`).join('')}</datalist>
  </div>
  <div class="card">${arbol.length ? arbol.map(ubicAmbHTML).join('') : '<div class="muted">Aún no hay ubicaciones. Crea estanterías arriba, o asigna libros desde el Catálogo (📍 Estantería).</div>'}</div>
  <div id="ubicLibros" style="margin-top:16px"></div>`;
  wireUbic();
  if (ubicPendiente) {
    const p = ubicPendiente;
    ubicPendiente = null;
    ubicVerLibros(p.a, p.e);
  }
}
function ubicAmbHTML(a) {
  const folded = !ubicExp.has(a.ambito);
  const nfc = a.nfc ? ` <span class="ubnfctag" title="NFC del ámbito: ${esc(a.nfc)}">📶</span>` : '';
  // Inline solo lo frecuente y DISTINGUIBLE: 📶 = NFC del ámbito · 🏷️ = NFC de sus libros en lote. El
  // resto (crear/renombrar/explotar/eliminar) va en el menú «⋯» para no saturar la cabecera.
  const nfcBtns = `${ubBtn('amb-nfc', a.ambito, null, '📶', 'Grabar la etiqueta NFC del ÁMBITO (al tocarla se abren sus libros)')}${ubBtn('amb-nfc-libros', a.ambito, null, '🏷️', 'Grabar la NFC de CADA LIBRO del ámbito (en lote, uno a uno)')}`;
  const mas = `<details class="ubmenu"><summary class="ubx" title="Más acciones">⋯</summary><div class="ubpop">
      ${ubMenuItem('amb-add', a.ambito, null, '➕ Añadir estantería')}
      ${ubMenuItem('amb-ren', a.ambito, null, '✏️ Renombrar ámbito')}
      ${ubMenuItem('amb-explotar', a.ambito, null, '🧹 Sus libros → sin ubicación')}
      ${ubMenuItem('amb-del', a.ambito, null, '🗑 Eliminar (si está vacío)', ' bad')}
    </div></details>`;
  const ests = a.estanterias.length
    ? a.estanterias.map((e) => ubicEstHTML(a.ambito, e)).join('')
    : `<div class="ubrow ubest"><span class="muted" style="font-size:12px">— sin estanterías —</span></div>`;
  return `<div class="ubamb"><div class="ubrow ubhdr"><span class="ubx" data-act="amb-fold" data-a="${esc(a.ambito)}" title="Plegar/desplegar" style="opacity:1;width:20px;text-align:center">${folded ? '▸' : '▾'}</span><b class="ubx ubname" data-act="amb-ver" data-a="${esc(a.ambito)}" title="Ver sus libros en el Catálogo (interactivo)">📍 ${esc(a.ambito)}</b><span class="muted ubcount">${a.estanterias.length} estante(s) · ${a.n} libro(s)</span>${nfc}<span class="ubacts">${nfcBtns}${mas}</span></div><div class="ubests"${folded ? ' style="display:none"' : ''}>${ests}</div></div>`;
}
function ubicEstHTML(amb, e) {
  const nfc = e.nfc ? ` <span class="ubnfctag" title="NFC del estante: ${esc(e.nfc)}">📶</span>` : '';
  // ↑/↓ reordenan la ESTANTERÍA (móvil; en escritorio se arrastra la fila). Inline solo lo frecuente y
  // DISTINGUIBLE: 📶 = NFC del ESTANTE · 🏷️ = NFC de sus LIBROS en lote. El resto, en el menú «⋯».
  const reord = `<span class="ubreord">${ubBtn('est-subir', amb, e.estanteria, '↑', 'Subir una posición')}${ubBtn('est-bajar', amb, e.estanteria, '↓', 'Bajar una posición')}</span>`;
  const nfcBtns = `${ubBtn('est-nfc', amb, e.estanteria, '📶', 'Grabar la etiqueta NFC del ESTANTE (al tocarla se abren sus libros)')}${ubBtn('est-nfc-libros', amb, e.estanteria, '🏷️', 'Grabar la NFC de CADA LIBRO de este estante (en lote, uno a uno)')}`;
  const mas = `<details class="ubmenu"><summary class="ubx" title="Más acciones">⋯</summary><div class="ubpop">
      ${ubMenuItem('est-orden', amb, e.estanteria, '📋 Ordenar libros por posición')}
      ${ubMenuItem('est-insertar', amb, e.estanteria, '➕ Insertar estantería debajo')}
      ${ubMenuItem('est-ren', amb, e.estanteria, '✏️ Renombrar')}
      ${ubMenuItem('est-mover', amb, e.estanteria, '➡️ Mover a otro ámbito')}
      ${ubMenuItem('est-fus', amb, e.estanteria, '🔀 Fusionar en otra')}
      ${ubMenuItem('est-explotar', amb, e.estanteria, '🧹 Libros → sin ubicación')}
      ${ubMenuItem('est-del', amb, e.estanteria, '🗑 Eliminar (si vacía)', ' bad')}
    </div></details>`;
  return `<div class="ubrow ubest" draggable="true" data-a="${esc(amb)}" data-e="${esc(e.estanteria)}">${reord}<span class="ubx ubname" data-act="est-ver" data-a="${esc(amb)}" data-e="${esc(e.estanteria)}" title="Ver sus libros en el Catálogo (interactivo)">📚 ${esc(e.estanteria)}</span><span class="muted ubcount">${e.n}</span>${nfc}<span class="ubacts">${nfcBtns}${mas}</span></div>`;
}
function wireUbic() {
  const modo = $('#ubModo');
  const sync = () => {
    const lote = modo && modo.value === 'lote';
    if ($('#ubUna')) $('#ubUna').style.display = lote ? 'none' : '';
    if ($('#ubLote')) $('#ubLote').style.display = lote ? '' : 'none';
    ubicPreview();
  };
  if (modo) modo.onchange = sync;
  ['ubPre', 'ubDesde', 'ubHasta', 'ubAncho', 'ubEstUna'].forEach((id) => {
    const el = $('#' + id);
    if (el) el.oninput = ubicPreview;
  });
  if ($('#ubCrear')) $('#ubCrear').onclick = ubicCrear;
  sync();
  $$('#p-ubic [data-act]').forEach(
    (el) => (el.onclick = () => ubicAccion(el.dataset.act, el.dataset.a, el.dataset.e)),
  );
  // Arrastrar para reordenar estanterías (escritorio; en móvil se usan ↑/↓). Solo dentro del MISMO ámbito.
  let arrastrada = null;
  $$('#p-ubic .ubest[draggable]').forEach((row) => {
    row.addEventListener('dragstart', (ev) => {
      arrastrada = { a: row.dataset.a, e: row.dataset.e };
      row.classList.add('dragging');
      try {
        ev.dataTransfer.effectAllowed = 'move';
        ev.dataTransfer.setData('text/plain', row.dataset.e);
      } catch (_) {}
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      $$('#p-ubic .ubest.dragover').forEach((x) => x.classList.remove('dragover'));
      arrastrada = null;
    });
    row.addEventListener('dragover', (ev) => {
      if (arrastrada && arrastrada.a === row.dataset.a && arrastrada.e !== row.dataset.e) {
        ev.preventDefault();
        row.classList.add('dragover');
      }
    });
    row.addEventListener('dragleave', () => row.classList.remove('dragover'));
    row.addEventListener('drop', (ev) => {
      ev.preventDefault();
      row.classList.remove('dragover');
      if (!arrastrada || arrastrada.a !== row.dataset.a || arrastrada.e === row.dataset.e) return;
      const A = ubicArbol.find((x) => x.ambito === arrastrada.a);
      if (!A) return;
      const nombres = A.estanterias.map((x) => x.estanteria);
      const from = nombres.indexOf(arrastrada.e),
        to = nombres.indexOf(row.dataset.e);
      if (from < 0 || to < 0) return;
      nombres.splice(from, 1);
      nombres.splice(to, 0, arrastrada.e);
      ubicReordenar(arrastrada.a, nombres);
    });
  });
}
function ubicLoteNombres() {
  const pre = ($('#ubPre') && $('#ubPre').value) || '';
  const d = parseInt($('#ubDesde').value, 10),
    h = parseInt($('#ubHasta').value, 10),
    w = Math.max(1, parseInt($('#ubAncho').value, 10) || 1);
  if (!Number.isFinite(d) || !Number.isFinite(h) || h < d) return [];
  const out = [];
  for (let i = d; i <= h && out.length < 500; i++) out.push(pre + String(i).padStart(w, '0'));
  return out;
}
function ubicPreview() {
  const box = $('#ubPrev');
  if (!box) return;
  if ($('#ubModo') && $('#ubModo').value === 'lote') {
    const n = ubicLoteNombres();
    box.textContent = n.length
      ? `${n.length} estantería(s): ${n[0]} … ${n[n.length - 1]}`
      : 'Rango no válido.';
  } else {
    const e = (($('#ubEstUna') && $('#ubEstUna').value) || '').trim();
    box.textContent = e
      ? `1 estantería: ${e}`
      : 'Escribe el nombre (o déjalo vacío para registrar solo el ámbito).';
  }
}
async function ubicCrear() {
  const amb = (($('#ubAmb') && $('#ubAmb').value) || '').trim();
  if (!amb) {
    toast('Indica el ámbito', 'warn');
    return;
  }
  let ests = [];
  if ($('#ubModo').value === 'lote') {
    ests = ubicLoteNombres();
    if (!ests.length) {
      toast('Rango no válido', 'warn');
      return;
    }
  } else {
    const e = ($('#ubEstUna').value || '').trim();
    if (e) ests = [e];
  }
  await ubicApi('/ubicaciones/crear', { ambito: amb, estanterias: ests });
}
async function ubicApi(path, body) {
  try {
    const r = await api(path, { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) {
      toast(r.motivo || 'error', 'bad');
      return r;
    }
    const det =
      r.modificados != null
        ? ` · ${r.modificados} libro(s)`
        : r.liberados != null
          ? ` · ${r.liberados} liberado(s)`
          : r.movidos != null
            ? ` · ${r.movidos} movido(s)`
            : r.creadas != null
              ? ` · ${r.creadas} creada(s)`
              : '';
    toast('Hecho' + det);
    loadUbic();
    return r;
  } catch (e) {
    toast(e.message, 'bad');
    return { ok: false };
  }
}
// Graba el nuevo orden de las estanterías de un ámbito (lista de nombres en orden) y refresca el árbol.
async function ubicReordenar(ambito, nombres) {
  try {
    const r = await api('/ubicaciones/ordenar', {
      method: 'POST',
      body: JSON.stringify({ ambito, orden: nombres }),
    });
    if (!r.ok) {
      toast(r.motivo || 'No se pudo ordenar', 'bad');
      return;
    }
    await loadUbic();
  } catch (e) {
    toast(e.message, 'bad');
  }
}
async function ubicAccion(act, a, e) {
  try {
    if (act === 'amb-fold') {
      if (ubicExp.has(a)) ubicExp.delete(a);
      else ubicExp.add(a);
      _guardarUbicExp();
      return pintarUbic();
    }
    // Pinchar el NOMBRE del ámbito/estantería = abrir la Búsqueda filtrada por él (allí hay interactividad total:
    // seleccionar, «todos los resultados», etiquetar NFC en lote, mover 📍, «añadir libros aquí»…), SIN tocar la
    // selección previa que hubiera acumulada.
    if (act === 'amb-ver') {
      estadoBusqueda.extra = { ambito: a, etiqueta: '📍 ' + a };
      estadoBusqueda.page = 1;
      return void go('search');
    }
    if (act === 'est-ver') {
      estadoBusqueda.extra = { ambito: a, estanteria: e, etiqueta: '📍 ' + a + ' · ' + e };
      estadoBusqueda.page = 1;
      return void go('search');
    }
    if (act === 'amb-nfc') return grabarNFCUbic(a, null);
    if (act === 'est-nfc') return grabarNFCUbic(a, e);
    // NFC en LOTE de los LIBROS que contiene el estante/ámbito (distinto de grabar la etiqueta del propio
    // estante): reúne sus ids y arranca el etiquetado uno a uno (iniciarEtiquetadoLote, mismo flujo que el Catálogo).
    if (act === 'est-nfc-libros' || act === 'amb-nfc-libros') {
      let ids = [];
      try {
        if (act === 'est-nfc-libros') {
          const r = await api('/ubicaciones/libros?' + new URLSearchParams({ ambito: a, estanteria: e }).toString());
          ids = (r.docs || []).map((d) => d._id);
        } else {
          const r = await api('/catalogo?' + new URLSearchParams({ ambito: a, soporte: 'papel', soloIds: '1' }).toString());
          ids = r.ids || [];
        }
      } catch (err) { toast(err.message, 'bad'); return; }
      if (!ids.length) { toast('No hay libros en papel aquí', 'warn'); return; }
      if (!('NDEFReader' in window)) { toast('Este dispositivo no puede escribir NFC (Android + Chrome)', 'warn'); return; }
      return void iniciarEtiquetadoLote(ids, false);
    }
    // Ordenar los LIBROS de la estantería por su posición física (localizar / inventario).
    if (act === 'est-orden') return ordenarLibrosEstanteria(a, e);
    // Reordenar las ESTANTERÍAS del ámbito: ↑/↓ mueven una posición; «insertar» crea una nueva justo debajo.
    if (act === 'est-subir' || act === 'est-bajar') {
      const A = ubicArbol.find((x) => x.ambito === a);
      if (!A) return;
      const nombres = A.estanterias.map((x) => x.estanteria);
      const i = nombres.indexOf(e);
      if (i < 0) return;
      const j = act === 'est-subir' ? i - 1 : i + 1;
      if (j < 0 || j >= nombres.length) return; // ya en el extremo
      nombres.splice(i, 1);
      nombres.splice(j, 0, e);
      return void ubicReordenar(a, nombres);
    }
    if (act === 'est-insertar') {
      const nom = await ubicPedirTexto('Insertar estantería DEBAJO de «' + e + '»');
      if (!nom) return;
      const A = ubicArbol.find((x) => x.ambito === a);
      if (!A) return;
      const nombres = A.estanterias.map((x) => x.estanteria).filter((x) => x !== nom); // por si ya existiera
      const i = nombres.indexOf(e);
      nombres.splice(i < 0 ? nombres.length : i + 1, 0, nom);
      try {
        await api('/ubicaciones/crear', {
          method: 'POST',
          body: JSON.stringify({ ambito: a, estanterias: [nom] }),
        });
      } catch (err) {
        toast(err.message, 'bad');
        return;
      }
      return void ubicReordenar(a, nombres);
    }
    if (act === 'amb-add') {
      const nom = await ubicPedirTexto('Añadir estantería a «' + a + '»');
      if (!nom) return;
      return void ubicApi('/ubicaciones/crear', { ambito: a, estanterias: [nom] });
    }
    if (act === 'amb-ren') {
      const nv = await ubicPedirTexto('Renombrar ámbito', a);
      if (!nv || nv === a) return;
      return void ubicApi('/ubicaciones/renombrar', { ambito: a, nuevoAmbito: nv });
    }
    if (act === 'est-ren') {
      const nv = await ubicPedirTexto('Renombrar estantería', e);
      if (!nv || nv === e) return;
      return void ubicApi('/ubicaciones/renombrar', { ambito: a, estanteria: e, nuevaEstanteria: nv });
    }
    if (act === 'est-mover') {
      const na = await ubicPedirTexto('Mover «' + e + '» a qué ámbito', a, ambitosNombres());
      if (!na || na === a) return;
      return void ubicApi('/ubicaciones/mover', { ambito: a, estanteria: e, nuevoAmbito: na });
    }
    if (act === 'est-fus') {
      const de = await ubicPedirTexto(
        'Fusionar «' + e + '» en qué estantería (mismo ámbito)',
        '',
        estanteriasNombres(a).filter((x) => x !== e),
      );
      if (!de || de === e) return;
      return void ubicApi('/ubicaciones/fusionar', {
        ambito: a,
        estanteria: e,
        destinoAmbito: a,
        destinoEstanteria: de,
      });
    }
    if (act === 'amb-explotar') {
      if (
        !(await ubicConfirm(
          'Explotar ámbito «' + a + '»',
          'Todos sus libros quedarán SIN ubicación. ¿Seguir?',
        ))
      )
        return;
      return void ubicApi('/ubicaciones/explotar', { ambito: a });
    }
    if (act === 'est-explotar') {
      if (
        !(await ubicConfirm('Explotar estantería «' + e + '»', 'Sus libros quedarán SIN ubicación. ¿Seguir?'))
      )
        return;
      return void ubicApi('/ubicaciones/explotar', { ambito: a, estanteria: e });
    }
    if (act === 'amb-del') return void ubicApi('/ubicaciones/eliminar', { ambito: a });
    if (act === 'est-del') return void ubicApi('/ubicaciones/eliminar', { ambito: a, estanteria: e });
  } catch (err) {
    toast(err.message, 'bad');
  }
}
async function ubicVerLibros(ambito, estanteria) {
  ubicSel = { ambito, estanteria: estanteria || null };
  const box = $('#ubicLibros');
  if (!box) return;
  box.innerHTML = '<div class="muted" style="padding:14px">Cargando libros…</div>';
  const p = new URLSearchParams({ ambito, page: '1' });
  if (estanteria) p.set('estanteria', estanteria);
  try {
    const r = await api('/catalogo?' + p.toString());
    const tit = esc(ambito) + (estanteria ? ' · ' + esc(estanteria) : '');
    box.innerHTML =
      `<div class="card"><div class="sec-h" style="margin-bottom:8px"><h3 style="margin:0">📚 ${tit}</h3><span class="muted">${r.total} libro(s)</span></div><div id="selbarUbic"></div>` +
      (r.docs.length
        ? `<div class="ubgrid">${r.docs.map(ubicCard).join('')}</div>${r.total > r.docs.length ? `<div class="muted" style="margin-top:10px">Mostrando ${r.docs.length} de ${r.total}. <a class="rowlink" id="ubVerBusq">Ver todos en el Catálogo →</a></div>` : ''}`
        : '<div class="muted">Sin libros en esta ubicación.</div>') +
      `</div>`;
    montarSelDocs({ scopeSel: '#ubicLibros', barSel: '#selbarUbic', verCtx: { volver: 'ubic', etiqueta: 'Ubicaciones' }, titulo: `📍 ${tit}` });
    const vb = $('#ubVerBusq');
    if (vb)
      vb.onclick = () => {
        estadoBusqueda.extra = {
          ambito,
          estanteria: estanteria || undefined,
          etiqueta: '📍 ' + ambito + (estanteria ? ' · ' + estanteria : ''),
        };
        estadoBusqueda.page = 1;
        go('search');
      };
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
  }
}
function ubicCard(d) {
  const por = d.portada
    ? `<img src="${esc(encUrl(d.portada))}" loading="lazy" style="width:100%;height:130px;object-fit:cover;border-radius:8px" onerror="this.style.display='none'">`
    : '<div style="height:130px;display:flex;align-items:center;justify-content:center;font-size:28px">📕</div>';
  const nfc =
    d.nfc && (d.nfc.fecha_vinculacion || d.nfc.uid)
      ? '<span class="nfctag" title="Etiqueta NFC vinculada">📶</span>'
      : '';
  return `<div class="ubcard" data-doc="${esc(d._id)}" style="cursor:pointer;position:relative;overflow:hidden">${nfc}${por}<div style="font-size:12px;margin-top:4px;line-height:1.3">${esc(recortar(d.titulo || '(sin título)', 48))}</div></div>`;
}
// Modal de texto reutilizable (con sugerencias opcionales via datalist). Promesa → valor o null.
function ubicPedirTexto(titulo, valor = '', sugerencias = null) {
  return new Promise((res) => {
    const dl = sugerencias
      ? `<datalist id="ptDl">${sugerencias.map((s) => `<option value="${esc(s)}">`).join('')}</datalist>`
      : '';
    $('#cmpModal').innerHTML =
      `<div class="box card" style="max-width:420px"><h3 style="margin-top:0">${esc(titulo)}</h3>
      <input id="ptVal" value="${esc(valor)}" autocomplete="off"${sugerencias ? ' list="ptDl"' : ''}>${dl}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px"><button class="btn" id="ptX">Cancelar</button><button class="btn pri" id="ptOk">Aceptar</button></div></div>`;
    $('#cmpScrim').style.display = 'block';
    $('#cmpModal').style.display = 'grid';
    const fin = (v) => {
      cerrarCmp();
      res(v);
    };
    $('#ptX').onclick = () => fin(null);
    $('#cmpScrim').onclick = () => fin(null);
    $('#ptOk').onclick = () => fin(($('#ptVal').value || '').trim());
    const inp = $('#ptVal');
    if (inp)
      inp.onkeydown = (ev) => {
        if (ev.key === 'Enter') fin((inp.value || '').trim());
      };
    setTimeout(() => {
      if (inp) {
        inp.focus();
        inp.select();
      }
    }, 30);
  });
}
function ubicConfirm(titulo, txt) {
  return new Promise((res) => {
    $('#cmpModal').innerHTML =
      `<div class="box card" style="max-width:420px"><h3 style="margin-top:0">${esc(titulo)}</h3><p class="muted">${esc(txt || '')}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:12px"><button class="btn" id="pcX">Cancelar</button><button class="btn bad" id="pcOk">Confirmar</button></div></div>`;
    $('#cmpScrim').style.display = 'block';
    $('#cmpModal').style.display = 'grid';
    const fin = (v) => {
      cerrarCmp();
      res(v);
    };
    $('#pcX').onclick = () => fin(false);
    $('#cmpScrim').onclick = () => fin(false);
    $('#pcOk').onclick = () => fin(true);
  });
}
// Graba (y registra el UID de) la etiqueta NFC de una estantería/ámbito. URL beacon ?amb=&est= → al
// acercar el móvil abre los libros de esa ubicación (Android Chrome o iPhone).
async function grabarNFCUbic(ambito, estanteria) {
  if (!('NDEFReader' in window)) {
    toast('Este navegador no soporta NFC (Android + Chrome)', 'bad');
    return;
  }
  const url =
    location.origin +
    '/?amb=' +
    encodeURIComponent(ambito) +
    (estanteria ? '&est=' + encodeURIComponent(estanteria) : '');
  const label = (estanteria ? estanteria + ' · ' : '') + ambito;
  const records = [
    { recordType: 'url', data: url },
    { recordType: 'text', data: EX_LIBRIS },
    { recordType: 'text', data: label },
  ];
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:420px;text-align:center"><h3 style="margin-top:0">📶 Etiqueta de ${estanteria ? 'estantería' : 'ámbito'}</h3>
    <p class="muted" id="nfcUMsg">Acerca la etiqueta de «${esc(label)}»…</p>
    <p class="mono" style="font-size:11px;word-break:break-all;color:var(--mut)">${esc(url)}</p>
    <div style="margin-top:8px"><button class="btn" id="nfcUX">Cancelar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  bloquearRotacion(); // no gires la pantalla mientras se graba la etiqueta de estantería (se libera en cerrarCmp)
  let done = false;
  const ctrl = new AbortController();
  const cerrar = () => {
    try {
      ctrl.abort();
    } catch (_) {}
    cerrarCmp();
  };
  $('#nfcUX').onclick = cerrar;
  $('#cmpScrim').onclick = cerrar;
  try {
    const reader = new NDEFReader();
    await reader.scan({ signal: ctrl.signal });
    reader.onreading = async (ev) => {
      if (done) return;
      done = true;
      const uid = ev.serialNumber || '';
      let escrito = false;
      try {
        await reader.write({ records }, { signal: ctrl.signal });
        escrito = true;
        sonidoNfcEscritura();
      } catch (_) {}
      try {
        await api('/ubicaciones/nfc', {
          method: 'POST',
          body: JSON.stringify({ ambito, estanteria: estanteria || null, uid }),
        });
      } catch (_) {}
      const m = $('#nfcUMsg');
      if (m) {
        m.textContent =
          (escrito ? '✅ Etiqueta grabada' : '✅ UID registrado (no se pudo escribir el tag)') +
          (uid ? ' · UID ' + uid : '');
        m.style.color = 'var(--ok)';
      }
      toast('NFC de estantería ' + (escrito ? 'grabada' : 'registrada'));
      setTimeout(() => {
        cerrarCmp();
        loadUbic();
      }, 1100);
    };
    reader.onreadingerror = () => {
      const m = $('#nfcUMsg');
      if (m) m.textContent = 'No se pudo leer la etiqueta.';
    };
  } catch (e) {
    const m = $('#nfcUMsg');
    if (m) {
      m.textContent = 'NFC: ' + e.message;
      m.style.color = 'var(--bad)';
    }
  }
}
// Asignar los documentos SELECCIONADOS en Búsqueda a una estantería (alta masiva, como añadir a colección).
async function pickerUbic() {
  await cargarUbicaciones();
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:460px"><h3 style="margin-top:0">📍 Asignar <b>${selDocs.size}</b> doc(s) a una estantería</h3>
    <div class="row" style="gap:8px"><div style="flex:1"><label>Ámbito</label><input id="puAmb" list="puDlA" autocomplete="off"></div>
    <div style="flex:1"><label>Estantería</label><input id="puEst" list="puDlE" autocomplete="off"></div></div>
    <datalist id="puDlA">${mapaUbicaciones.map((x) => `<option value="${esc(x.ambito)}">`).join('')}</datalist><datalist id="puDlE"></datalist>
    <div id="puErr" style="color:var(--bad);font-size:12px;min-height:15px;margin-top:6px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" id="puX">Cancelar</button><button class="btn pri" id="puOk">Asignar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#puX').onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
  const refE = () => llenarDatalist('puDlE', estanteriasDe($('#puAmb').value || ''));
  refE();
  $('#puAmb').oninput = refE;
  $('#puOk').onclick = async () => {
    const ambito = ($('#puAmb').value || '').trim(),
      estanteria = ($('#puEst').value || '').trim();
    if (!ambito) {
      $('#puErr').textContent = 'Indica el ámbito';
      return;
    }
    try {
      const r = await api('/ubicaciones/asignar', {
        method: 'POST',
        body: JSON.stringify({ ids: [...selDocs], ambito, estanteria }),
      });
      if (!r.ok) {
        $('#puErr').textContent = r.motivo;
        return;
      }
      cerrarCmp();
      toast(
        `${r.n} doc(s) → ${r.ambito}${r.estanteria && r.estanteria !== 'Sin asignar' ? ' · ' + r.estanteria : ''}${r.saltadosDigital ? ` · ${r.saltadosDigital} digital(es) ignorado(s)` : ''}`,
        r.saltadosDigital ? 'warn' : 'ok',
      );
      selDocs.clear();
      buscarCatalogo(estadoBusqueda.page || 1);
    } catch (e) {
      $('#puErr').textContent = e.message;
    }
  };
}
// Cambio RÁPIDO de la ubicación de UN documento desde su ficha (doble clic / pulsación larga en el chip
// 📍). Reutiliza el mismo modal y endpoint que la asignación en lote, precargado con la ubicación actual.
async function editarUbicacionRapida(doc) {
  if (ROL !== 'admin' || !doc || !doc._id) return;
  await cargarUbicaciones();
  const u = doc.ubicacion || {};
  const amb0 = u.ambito && u.ambito !== 'Sin asignar' ? u.ambito : '';
  const est0 = u.estanteria && u.estanteria !== 'Sin asignar' ? u.estanteria : '';
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:460px"><h3 style="margin-top:0">📍 Cambiar ubicación</h3>
    <div class="muted" style="font-size:12px;margin:-4px 0 10px">${esc(recortar(doc.titulo || '', 60))}</div>
    <div class="row" style="gap:8px"><div style="flex:1"><label>Ámbito</label><input id="puAmb" list="puDlA" autocomplete="off" value="${esc(amb0)}"></div>
    <div style="flex:1"><label>Estantería</label><input id="puEst" list="puDlE" autocomplete="off" value="${esc(est0)}"></div></div>
    <datalist id="puDlA">${mapaUbicaciones.map((x) => `<option value="${esc(x.ambito)}">`).join('')}</datalist><datalist id="puDlE"></datalist>
    <div id="puErr" style="color:var(--bad);font-size:12px;min-height:15px;margin-top:6px"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" id="puX">Cancelar</button><button class="btn pri" id="puOk">Guardar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#puX').onclick = cerrarCmp;
  $('#cmpScrim').onclick = cerrarCmp;
  const refE = () => llenarDatalist('puDlE', estanteriasDe($('#puAmb').value || ''));
  refE();
  $('#puAmb').oninput = refE;
  $('#puOk').onclick = async () => {
    const ambito = ($('#puAmb').value || '').trim(),
      estanteria = ($('#puEst').value || '').trim();
    if (!ambito) { $('#puErr').textContent = 'Indica el ámbito'; return; }
    try {
      const r = await api('/ubicaciones/asignar', { method: 'POST', body: JSON.stringify({ ids: [doc._id], ambito, estanteria }) });
      if (!r.ok) { $('#puErr').textContent = r.motivo; return; }
      cerrarCmp();
      toast(`Ubicación → ${r.ambito}${r.estanteria && r.estanteria !== 'Sin asignar' ? ' · ' + r.estanteria : ''}`);
      verDoc(doc._id, (detalle && detalle.ctx) || {}); // re-pintar la ficha con la nueva ubicación
    } catch (e) { $('#puErr').textContent = e.message; }
  };
}
// ── Página AUTORES ──────────────────────────────────────────────────────────────────────────────────
// Buscar autores, ver su ficha (foto/bio/libros) y COMBINAR duplicados (A→B): se mantiene el nombre de B,
// los de las A pasan a sus «también conocido como» y todos sus libros se reasignan a B. Es la versión
// INTERACTIVA de scripts/backfill-autores.js. Las mutaciones son solo admin (las exige el backend).
let _autores = []; // último listado recibido (página actual)
let _autoresPagina = 1, _autoresTotal = 0, _autoresPorPagina = 60, _autoresCapado = false; // paginación
const _autoresSel = new Set(); // ids marcados para combinar
// Caché de lo MARCADO (id → {nombre, n_libros}): la selección sobrevive a búsquedas Y a la paginación, así que
// `_autores` (la página visible) puede no contener todo lo marcado. Ver marcarAutor / autorCombinar.
const _autoresSelInfo = new Map();
let _autoresSelModo = false; // Modo selección (tap = marcar) — mismo patrón que Catálogo/estantes
let _autoresBuscarTimer = null; // debounce del buscador

// Marca/desmarca UN autor recordando nombre y nº de libros (para poder listarlo aunque cambie de página).
function marcarAutor(id, on) {
  const activar = on === undefined ? !_autoresSel.has(id) : !!on;
  if (activar) {
    _autoresSel.add(id);
    const a = (_autores || []).find((x) => x._id === id);
    if (a) _autoresSelInfo.set(id, { _id: id, nombre: a.nombre, n_libros: a.n_libros || 0 });
    else if (!_autoresSelInfo.has(id)) _autoresSelInfo.set(id, { _id: id, nombre: '(desconocido)', n_libros: 0 });
  } else {
    _autoresSel.delete(id);
    _autoresSelInfo.delete(id);
  }
  return activar;
}
function limpiarSelAutores() {
  _autoresSel.clear();
  _autoresSelInfo.clear();
}

async function loadAutores() {
  const cont = $('#p-autores');
  if (!cont) return;
  limpiarSelAutores();
  _autoresSelModo = false;
  cont.innerHTML = `
    <div class="sec-h"><h2>Autores</h2></div>
    <div class="row" style="gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
      <input id="autBuscar" placeholder="🔍 Buscar autor (nombre o variante)…" autocomplete="off" style="flex:1;min-width:200px" />
      <span id="autCombinaBar"></span>
    </div>
    <div class="row" style="gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <label class="muted" style="font-size:12px">Foto
        <select id="autFotoFiltro"><option value="">todas</option><option value="si">con</option><option value="no">sin</option></select>
      </label>
      <label class="muted" style="font-size:12px">Biografía
        <select id="autBioFiltro"><option value="">todas</option><option value="si">con</option><option value="no">sin</option></select>
      </label>
      <label class="muted" style="font-size:12px">Rol
        <select id="autRol"><option value="">todos</option><option value="autor">autor</option><option value="traductor">traductor</option><option value="ilustrador">ilustrador</option><option value="prologuista">prologuista</option><option value="anotador">anotador</option><option value="editor">editor</option><option value="compilador">compilador</option></select>
      </label>
      <label class="muted" style="font-size:12px">Obras
        <select id="autMin"><option value="0">todas</option><option value="sin">0 (sin libros)</option><option value="1">≥ 1</option><option value="2">≥ 2</option><option value="3">≥ 3</option><option value="5">≥ 5</option><option value="10">≥ 10</option></select>
      </label>
      <label class="muted" style="font-size:12px">Orden
        <select id="autOrden"><option value="libros">nº de obras</option><option value="nombre">nombre</option></select>
      </label>
    </div>
    <div id="autGrid" class="muted">Cargando…</div>`;
  const inp = $('#autBuscar');
  if (inp)
    inp.oninput = () => {
      clearTimeout(_autoresBuscarTimer);
      _autoresBuscarTimer = setTimeout(autoresBuscarReset, 300); // texto nuevo → página 1
    };
  // Los selectores de filtro/orden/rol recargan al instante (desde la página 1).
  ['#autFotoFiltro', '#autBioFiltro', '#autRol', '#autMin', '#autOrden'].forEach((sel) => {
    const el = $(sel);
    if (el) el.onchange = autoresBuscarReset;
  });
  _autoresPagina = 1;
  autoresBuscar();
}

// Lee los controles (texto + filtros foto/bio/rol + orden) y pide la lista al servidor.
async function autoresBuscar() {
  const grid = $('#autGrid');
  if (grid) grid.textContent = 'Cargando…';
  const params = new URLSearchParams({
    q: ($('#autBuscar') && $('#autBuscar').value.trim()) || '',
    foto: ($('#autFotoFiltro') && $('#autFotoFiltro').value) || '',
    bio: ($('#autBioFiltro') && $('#autBioFiltro').value) || '',
    rol: ($('#autRol') && $('#autRol').value) || '',
    orden: ($('#autOrden') && $('#autOrden').value) || 'libros',
  });
  // «Obras»: «sin» = solo autores con 0 libros; un número = «≥ N».
  const min = ($('#autMin') && $('#autMin').value) || '0';
  if (min === 'sin') params.set('sinLibros', '1');
  else params.set('minLibros', min);
  params.set('pagina', String(_autoresPagina));
  params.set('limite', String(_autoresPorPagina));
  try {
    const r = await api('/autores?' + params.toString());
    _autores = r.autores || [];
    _autoresTotal = r.total || _autores.length;
    _autoresPorPagina = r.porPagina || _autoresPorPagina;
    _autoresCapado = !!r.capado;
  } catch (e) {
    if (grid) grid.textContent = 'Error: ' + e.message;
    return;
  }
  autoresPintar();
}

// Re-busca desde la PÁGINA 1 (al cambiar el texto o un filtro). Los botones de paginación llaman a
// autoresBuscar directamente conservando _autoresPagina.
function autoresBuscarReset() { _autoresPagina = 1; autoresBuscar(); }
function autoresIrPagina(p) {
  const paginas = Math.max(1, Math.ceil(_autoresTotal / _autoresPorPagina));
  _autoresPagina = Math.min(paginas, Math.max(1, p));
  autoresBuscar();
}

// Barra de recuento + paginación (arriba de la rejilla). Muestra «desde–hasta de TOTAL autores» y ‹ N/M ›.
function autoresPager() {
  const paginas = Math.max(1, Math.ceil(_autoresTotal / _autoresPorPagina));
  const desde = _autoresTotal ? (_autoresPagina - 1) * _autoresPorPagina + 1 : 0;
  const hasta = Math.min(_autoresPagina * _autoresPorPagina, _autoresTotal);
  const cuenta = _autoresTotal
    ? `${desde}–${hasta} de ${_autoresTotal}${_autoresCapado ? '+' : ''} autor(es)`
    : 'Sin autores';
  const nav = paginas > 1
    ? `<span class="row" style="gap:6px;align-items:center;flex-wrap:wrap">${pagerControles(_autoresPagina, paginas)}</span>`
    : '';
  return `<div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px"><span class="muted" style="font-size:12px">${cuenta}</span>${nav}</div>`;
}
function autoresWirePager() {
  const paginas = Math.max(1, Math.ceil(_autoresTotal / _autoresPorPagina));
  wirePager($('#autGrid'), _autoresPagina, paginas, autoresIrPagina);
}
function autoresPintar() {
  const grid = $('#autGrid');
  if (!grid) return;
  if (!_autores.length) {
    grid.innerHTML = autoresPager() + '<div class="empty">Sin autores.</div>';
    autoresWirePager();
    autoresBarraCombinar();
    return;
  }
  const admin = ROL === 'admin';
  grid.innerHTML = autoresPager() + `<div class="${admin && _autoresSelModo ? 'selmode' : ''}" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">${_autores
    .map(autorCard)
    .join('')}</div>`;
  autoresWirePager();
  // Interacción unificada (igual que Catálogo/estantes): clic/toque = abrir la ficha (o MARCAR en Modo
  // selección); doble clic / pulsación larga = conmutar el modo (conservando lo ya marcado).
  grid.querySelectorAll('[data-aut]').forEach((el) =>
    attachGesto(
      el,
      () => {
        const id = el.dataset.aut;
        if (admin && _autoresSelModo) {
          marcarAutor(id);
          el.classList.toggle('sel', _autoresSel.has(id));
          autoresBarraCombinar();
        } else autorFicha(id);
      },
      () => alternarAutoresModo(el.dataset.aut),
    ),
  );
  setModoVisual(admin && _autoresSelModo);
  autoresBarraCombinar();
}

// Conmuta el Modo selección de la LISTA de autores (botón «Modo selección» o gesto doble-clic /
// pulsación-larga en una tarjeta). Al entrar por gesto, marca ya esa tarjeta. Re-pinta para aplicar el modo.
function alternarAutoresModo(selId) {
  if (ROL !== 'admin') return;
  const entrando = !_autoresSelModo;
  _autoresSelModo = !_autoresSelModo;
  if (entrando && _autoresSelModo && selId) marcarAutor(selId, true);
  autoresPintar();
}

function autorCard(a) {
  const sel = _autoresSel.has(a._id);
  const foto = a.foto
    ? `<img src="${esc(encUrl(a.foto))}" style="width:52px;height:52px;object-fit:cover;border-radius:50%;background:var(--card)" loading="lazy">`
    : `<div style="width:52px;height:52px;border-radius:50%;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:22px">👤</div>`;
  const vida =
    a.nacimiento || a.fallecimiento
      ? ` · <span class="muted" style="font-size:11px">${a.nacimiento || '?'}–${a.fallecimiento || ''}</span>`
      : '';
  const alt =
    a.nombres_alternativos && a.nombres_alternativos.length
      ? `<div class="muted" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(a.nombres_alternativos.join(' · '))}">a.k.a. ${esc(a.nombres_alternativos.join(' · '))}</div>`
      : '';
  // Tarjeta con la MISMA mecánica de selección que el resto: círculo .selmark (visible en Modo selección),
  // .sel al marcar. Sin checkbox: se marca tocando en Modo selección (toggle o pulsación larga).
  return `<div data-aut="${esc(a._id)}" class="card${sel ? ' sel' : ''}" style="position:relative;display:flex;gap:10px;align-items:center;padding:10px">
    <span class="selmark">✓</span>
    ${foto}
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.nombre || '—')}</div>
      <div class="muted" style="font-size:12px">${a.n_libros} libro(s)${vida}</div>
      ${alt}
    </div></div>`;
}

// Barra de acción: botón de Modo selección (admin) + «Combinar» al marcar 2+ autores.
function autoresBarraCombinar() {
  const bar = $('#autCombinaBar');
  if (!bar) return;
  const admin = ROL === 'admin';
  const n = _autoresSel.size;
  const modoBtn = admin
    ? `<button class="btn${_autoresSelModo ? ' pri' : ''}" id="autModo" title="Modo selección: tocar una tarjeta la marca (para combinar). Modo previsualización: tocar abre la ficha. Doble clic / pulsación larga en una tarjeta también conmuta. Lo marcado se conserva.">${_autoresSelModo ? '🖱 Modo selección' : '👁 Modo previsualización'}</button>`
    : '';
  let acciones = '';
  if (n >= 1) {
    const combinar = n >= 2 ? `<button class="btn pri admin-only" id="autCombinar">🔗 Combinar ${n}…</button> ` : '';
    const marca1 = n === 1 ? '<span class="muted" style="font-size:12px">1 marcado (marca 2+ para combinar)</span> ' : '';
    const elim = admin ? `<button class="btn admin-only" id="autEliminar" title="Borra los marcados que NO figuren en ningún documento (ni como autor ni como contribuyente); los que tengan obras se conservan intactos">🗑 Eliminar ${n}</button> ` : '';
    acciones = ` ${combinar}${marca1}${elim}<button class="btn" id="autSelClear">✕ deseleccionar</button>`;
  }
  bar.innerHTML = modoBtn + acciones;
  if ($('#autModo')) $('#autModo').onclick = () => alternarAutoresModo();
  if ($('#autCombinar')) $('#autCombinar').onclick = autorCombinar;
  if ($('#autEliminar')) $('#autEliminar').onclick = autoresEliminarSel;
  if ($('#autSelClear'))
    $('#autSelClear').onclick = () => {
      limpiarSelAutores();
      autoresPintar();
    };
}

// Elimina los autores MARCADOS, pero solo los que no figuran en ningún documento (salvaguarda en el server).
async function autoresEliminarSel() {
  const ids = [..._autoresSel];
  if (!ids.length) return;
  const nombres = ids.map((id) => (_autores.find((a) => a._id === id) || {}).nombre).filter(Boolean);
  if (!confirm(`¿Eliminar ${ids.length} autor(es)?\n\nSolo se borran los que NO figuren en ningún documento (ni autor ni contribuyente); los que tengan obras se CONSERVAN.\n\n${nombres.slice(0, 10).join('\n')}${nombres.length > 10 ? '\n…' : ''}`)) return;
  try {
    const r = await api('/autores/eliminar', { method: 'POST', body: JSON.stringify({ ids }) });
    if (!r.ok) { toast(r.motivo, 'bad'); return; }
    toast(`🗑 ${r.borrados} borrado(s)${r.conservados ? ` · ${r.conservados} conservado(s) (tienen obras)` : ''}`);
    limpiarSelAutores();
    autoresBuscar();
  } catch (e) { toast(e.message, 'bad'); }
}

// Ficha de autor (modal): foto, datos (editables si admin) y sus libros (clic → ficha del libro).
// Selección ergonómica de libros DENTRO de la ficha del autor: en «modo selección» tocar una tarjeta la
// marca (en vez de abrir su ficha), para enviar luego esa selección al panel de Búsqueda. Se reinicia en
// cada apertura de la ficha.
let _autFichaSel = new Set();
let _autFichaSelModo = false;

async function autorFicha(id) {
  let r;
  try {
    r = await api('/autores/' + encodeURIComponent(id));
  } catch (e) {
    toast(e.message, 'bad');
    return;
  }
  const a = r.autor || {};
  const libros = r.libros || [];
  const admin = ROL === 'admin';
  _autFichaSel = new Set(); // selección limpia al (re)abrir la ficha
  _autFichaSelModo = false;
  const foto = a.foto
    ? `<img src="${esc(encUrl(a.foto))}" style="width:110px;height:110px;object-fit:cover;border-radius:12px;background:var(--card)">`
    : `<div style="width:110px;height:110px;border-radius:12px;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:44px">👤</div>`;
  const alt = Array.isArray(a.nombres_alternativos) ? a.nombres_alternativos.join('; ') : '';
  // Datos: editables (admin) o de solo lectura (invitado).
  // Roles que desempeña (autor/traductor/…), como línea plegada junto al resto de datos.
  const rolesLinea = Array.isArray(r.roles) && r.roles.length
    ? `<div class="muted" style="font-size:11px;margin-top:8px">Roles: ${r.roles.map((x) => esc(x)).join(' · ')}</div>`
    : '';
  // DATOS COLAPSADOS: solo el NOMBRE (y la foto, en su columna) quedan visibles; alias/fechas/biografía/roles
  // van dentro de un <details> colapsado y se despliegan al tocar. Los <input> siguen en el DOM (para Guardar).
  const campos = admin
    ? `<div><label>Nombre</label><input id="autNombre" value="${esc(a.nombre || '')}" autocomplete="off"></div>
       <details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:var(--mut)">✏️ Alias, fechas y biografía…</summary>
         <div style="margin-top:8px"><label>También conocido como (separa con ;)</label><input id="autAlt" value="${esc(alt)}" autocomplete="off"></div>
         <div class="row" style="margin-top:6px">
           <div><label>Nacimiento</label><input id="autNac" value="${esc(a.nacimiento || '')}" inputmode="numeric" autocomplete="off"></div>
           <div><label>Fallecimiento</label><input id="autFall" value="${esc(a.fallecimiento || '')}" inputmode="numeric" autocomplete="off"></div>
         </div>
         <div style="margin-top:6px"><label>Biografía</label><textarea id="autBio" rows="4" style="width:100%;resize:vertical;font-family:inherit">${esc(a.biografia || '')}</textarea></div>
         ${rolesLinea}
       </details>`
    : `<h3 style="margin:0">${esc(a.nombre || '—')}</h3>
       ${(alt || a.nacimiento || a.fallecimiento || a.biografia || rolesLinea)
        ? `<details style="margin-top:6px"><summary style="cursor:pointer;font-size:12px;color:var(--mut)">▸ Más datos…</summary>
           ${alt ? `<div class="muted" style="font-size:12px;margin-top:6px">a.k.a. ${esc(alt)}</div>` : ''}
           ${a.nacimiento || a.fallecimiento ? `<div class="muted" style="font-size:12px;margin-top:4px">${a.nacimiento || '?'}–${a.fallecimiento || ''}</div>` : ''}
           ${a.biografia ? `<p class="sinopsis-text" style="margin-top:8px">${esc(a.biografia)}</p>` : ''}
           ${rolesLinea}
         </details>`
        : ''}`;
  // Badge de etiqueta NFC (el libro ya tiene una grabada).
  const nfcBadge = (l) =>
    l.nfc
      ? `<span title="Tiene etiqueta NFC" style="position:absolute;top:3px;right:3px;font-size:11px;background:var(--card);border-radius:6px;padding:0 3px">📶</span>`
      : '';
  // Badges de TIPO (libro/revista/cómic) y SOPORTE (papel/digital) de cada documento.
  const tipoBadge = (l) =>
    l.comic
      ? '<span class="docbadge" style="background:rgba(180,120,255,.18);color:#b478ff">📓 cómic</span>'
      : `<span class="docbadge" style="background:rgba(120,160,255,.16);color:#78a0ff">${tipoIcono(l.tipo_recurso)} ${tipoNombre(l.tipo_recurso).toLowerCase()}</span>`;
  const soporteBadge = (l) =>
    l.papel
      ? '<span class="docbadge" style="background:rgba(200,160,90,.18);color:#d0a860">📄 papel</span>'
      : '<span class="docbadge" style="background:rgba(40,217,168,.16);color:var(--acc)">💾 digital</span>';
  // Tarjeta de un libro: selección + NFC + badges de tipo/soporte bajo el título.
  const cardLibro = (l) => `<div data-libro="${esc(l._id)}" title="${esc(l.titulo || '')}" style="position:relative;cursor:pointer;text-align:center;border-radius:8px;padding:2px">
      <span class="selmark">✓</span>
      ${nfcBadge(l)}
      ${l.portada ? `<img src="${esc(encUrl(l.portada))}" style="width:100%;height:118px;object-fit:contain;border-radius:6px;background:var(--card)" loading="lazy">` : `<div style="height:118px;border-radius:6px;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:22px">${tipoIcono(l.tipo_recurso, l.comic)}</div>`}
      <div class="muted" style="font-size:10px;line-height:1.2;margin-top:2px">${esc(recortar(l.titulo || '—', 40))}${l['año_edicion'] ? ` · ${l['año_edicion']}` : ''}</div>
      <div style="display:flex;gap:3px;justify-content:center;flex-wrap:wrap;margin-top:3px">${tipoBadge(l)}${soporteBadge(l)}</div>
    </div>`;
  const gridLibros = (arr) =>
    `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:10px;margin-top:8px">${arr.map(cardLibro).join('')}</div>`;
  // AGRUPADO POR ROL (estilo IMDB) en CARDS COLAPSABLES con rótulo grande. Dentro de cada rol, papel primero.
  const ROL_SECCION = [
    ['autor', '✍️ Como autor'],
    ['traductor', '🌐 Como traductor'],
    ['ilustrador', '🎨 Como ilustrador'],
    ['editor', '📝 Como editor'],
    ['prologuista', '📖 Como prologuista'],
    ['anotador', '🖊️ Como anotador'],
    ['compilador', '📚 Como compilador'],
    ['contribuyente', '👥 Otras contribuciones'],
  ];
  const porRol = new Map();
  for (const l of libros) {
    const k = l.rol || 'contribuyente';
    if (!porRol.has(k)) porRol.set(k, []);
    porRol.get(k).push(l);
  }
  const seccionRol = (rol, lab) => {
    const arr = porRol.get(rol);
    if (!arr || !arr.length) return '';
    const orden = [...arr].sort((a, b) => (b.papel ? 1 : 0) - (a.papel ? 1 : 0)); // papel primero dentro del rol
    return `<details class="autrolsec" open>
        <summary><span class="autrol-tit">${lab}</span> <span class="muted" style="font-weight:400;font-size:12px">· ${arr.length}</span></summary>
        ${gridLibros(orden)}
      </details>`;
  };
  let librosHtml;
  if (!libros.length) librosHtml = '<div class="muted" style="font-size:12px;margin-top:6px">Sin libros asociados.</div>';
  else librosHtml = ROL_SECCION.map(([rol, lab]) => seccionRol(rol, lab)).join('') || gridLibros(libros);
  // DESGLOSE por rol junto al total: resuelve la confusión del «0 libros» (p. ej. Arthur Rackham no es AUTOR
  // de ninguno pero es ILUSTRADOR de 3). Se muestra SIEMPRE «autor N» (aunque sea 0) y luego cada función con
  // libros (>0), en el orden de las secciones.
  const nRol = (rol) => (porRol.get(rol) || []).length;
  const desgloseRoles = libros.length
    ? [`autor ${nRol('autor')}`, ...ROL_SECCION.filter(([rol]) => rol !== 'autor' && nRol(rol)).map(([rol]) => `${rol} ${nRol(rol)}`)].join(' · ')
    : '';
  // Resumen de roles que desempeña esta persona (autor/traductor/…).
  // Botones de la columna de la foto (arriba): admin ve Foto/Autocompletar + Guardar/Cerrar DUPLICADOS aquí
  // (cómodos sin bajar hasta el pie); el invitado solo Cerrar.
  const bm = 'padding:4px 9px;font-size:12px'; // botones compactos: menos distancia con la lista de libros
  const botonesFoto = admin
    ? `<div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">
         <div class="row" style="gap:4px;justify-content:center">
           <button class="btn" id="autFoto" style="${bm}" title="Subir una foto desde archivo">📷 Foto</button>
           ${libros.length ? `<button class="btn" id="autFotoObra" style="${bm}" title="Usar como foto una imagen del interior/portada de uno de sus libros">🖼️ De obra</button>` : ''}
         </div>
         <button class="btn" id="autEnriquecer" style="${bm}" title="Rellena foto, biografía, seudónimos y fechas desde OpenLibrary, Wikidata y Wikipedia (sin IA)">✨ Autocompletar</button>
         <button class="btn" id="autFusionar" style="${bm}" title="Fundir ESTE autor en otro que elijas: sus libros pasan al otro y este se borra">🔀 Fusionar en…</button>
         ${libros.length
           ? `<button class="btn" id="autQuitarTodos" style="${bm}" title="Quitar este autor de TODOS sus libros (quedan sin este autor); si se queda sin obras, se borra">🚫 Quitar de todos</button>`
           : `<button class="btn bad" id="autEliminarUno" style="${bm}" title="Eliminar este autor (no tiene ninguna obra asociada)">🗑 Eliminar autor</button>`}
         <div class="row" style="gap:4px;justify-content:center">
           <button class="btn pri" id="autGuardarTop" style="${bm}">💾 Guardar</button>
           <button class="btn" id="autCerrarTop" style="${bm}">Cerrar</button>
         </div>
         <input type="file" id="autFotoFile" accept="image/*" style="display:none">
       </div>`
    : `<div style="margin-top:6px"><button class="btn" id="autCerrarTop" style="${bm}">Cerrar</button></div>`;
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:660px;max-height:92vh;overflow:auto">
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      <div style="text-align:center">
        ${foto}
        ${botonesFoto}
      </div>
      <div style="flex:1;min-width:250px">${campos}</div>
    </div>
    <div style="margin-top:12px">
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Libros (${libros.length})${desgloseRoles ? `<span style="text-transform:none;letter-spacing:0;font-weight:400"> · ${esc(desgloseRoles)}</span>` : ''}</div>
        ${libros.length ? `<div class="row" style="gap:6px">
          <button class="btn" id="autSelModo" style="padding:3px 9px;font-size:12px">🖱 Modo selección</button>
          <button class="btn" id="autVerBusqueda" style="padding:3px 9px;font-size:12px" title="Ver todos sus libros en el Catálogo (con filtros, orden y selección)">🔍 Ver en Catálogo</button>
        </div>` : ''}
      </div>
      <div id="autSelBarra" class="row" style="display:none;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
        <span class="muted" id="autSelCuenta" style="font-size:12px">0 seleccionados</span>
        <button class="btn" id="autSelTodos" style="padding:2px 8px;font-size:12px">Todos</button>
        <button class="btn" id="autSelNinguno" style="padding:2px 8px;font-size:12px">Ninguno</button>
        <button class="btn pri" id="autSelEnviar" style="padding:2px 8px;font-size:12px">🔍 Mostrar en Catálogo</button>
        ${admin ? '<button class="btn" id="autSelMover" style="padding:2px 8px;font-size:12px" title="Enviar los libros seleccionados a OTRO autor (este los deja de tener)">➡️ A otro autor</button>' : ''}
        ${admin ? '<button class="btn" id="autSelQuitar" style="padding:2px 8px;font-size:12px" title="Quitar este autor de los libros seleccionados">🚫 Quitar autoría</button>' : ''}
      </div>
      ${librosHtml}
    </div>
    <div class="row" style="gap:8px;margin-top:14px;justify-content:flex-end">
      ${admin ? '<button class="btn pri" id="autGuardar">💾 Guardar</button>' : ''}
      <button class="btn" id="autCerrar">Cerrar</button>
    </div>
    <div id="autMsg" class="muted" style="font-size:12px;margin-top:6px"></div>
  </div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = cerrarCmp;
  $('#autCerrar').onclick = cerrarCmp;
  if ($('#autCerrarTop')) $('#autCerrarTop').onclick = cerrarCmp;

  // ── Selección de libros (modo selección) ──────────────────────────────────────────────
  const nombreAutor = a.nombre || 'Autor';
  // Marca/desmarca una tarjeta con el patrón compartido: clase .sel (muestra el tick ✓ vía CSS) + recuadro.
  const pintarSel = (el, on) => {
    el.classList.toggle('sel', on);
    el.style.outline = on ? '2px solid var(--acc)' : '';
  };
  const actualizarCuenta = () => {
    if ($('#autSelCuenta')) $('#autSelCuenta').textContent = _autFichaSel.size + ' seleccionados';
  };
  const tarjetas = [...$('#cmpModal').querySelectorAll('[data-libro]')];
  const listaLibros = tarjetas.map((el) => el.dataset.libro); // orden mostrado (para navegar en la ficha)
  const alternarAutFicha = () => {
    _autFichaSelModo = !_autFichaSelModo;
    if ($('#autSelModo')) $('#autSelModo').classList.toggle('pri', _autFichaSelModo);
    if ($('#autSelBarra')) $('#autSelBarra').style.display = _autFichaSelModo ? 'flex' : 'none';
    // Añade el círculo de selección en CADA tarjeta + el realce (misma pista visual que en el resto).
    const cont = $('#cmpModal'); if (cont) cont.classList.toggle('selmode', _autFichaSelModo);
    if (!_autFichaSelModo) { _autFichaSel.clear(); tarjetas.forEach((el) => pintarSel(el, false)); } // al salir, limpiar
    actualizarCuenta();
  };
  // Interacción unificada: clic/toque = abrir ficha (o marcar en Modo selección); doble clic / pulsación
  // larga = conmutar el Modo selección.
  tarjetas.forEach((el) =>
    attachGesto(
      el,
      () => {
        if (_autFichaSelModo) {
          const lid = el.dataset.libro;
          _autFichaSel.has(lid) ? _autFichaSel.delete(lid) : _autFichaSel.add(lid);
          pintarSel(el, _autFichaSel.has(lid));
          actualizarCuenta();
        } else {
          cerrarCmp();
          verDoc(el.dataset.libro, { volver: 'autores', etiqueta: 'Autores', lista: listaLibros });
        }
      },
      () => {
        const entrando = !_autFichaSelModo;
        alternarAutFicha();
        if (entrando && _autFichaSelModo) { _autFichaSel.add(el.dataset.libro); pintarSel(el, true); actualizarCuenta(); } // marca la del gesto
      },
    ),
  );
  if ($('#autSelModo')) $('#autSelModo').onclick = alternarAutFicha;
  if ($('#autSelTodos'))
    $('#autSelTodos').onclick = () => {
      tarjetas.forEach((el) => {
        _autFichaSel.add(el.dataset.libro);
        pintarSel(el, true);
      });
      actualizarCuenta();
    };
  if ($('#autSelNinguno'))
    $('#autSelNinguno').onclick = () => {
      _autFichaSel.clear();
      tarjetas.forEach((el) => pintarSel(el, false));
      actualizarCuenta();
    };
  if ($('#autSelEnviar'))
    $('#autSelEnviar').onclick = () => {
      if (!_autFichaSel.size) {
        toast('Selecciona al menos un libro', 'warn');
        return;
      }
      const ids = [..._autFichaSel];
      cerrarCmp();
      // Los libros llegan al Catálogo YA SELECCIONADOS (en modo selección), listos para actuar sobre ellos.
      mostrarEnCatalogo(ids, '👤 ' + nombreAutor + ' (' + ids.length + ')');
    };
  // Ver TODOS sus libros en el Catálogo (selección/filtros/orden ergonómicos allí).
  if ($('#autVerBusqueda'))
    $('#autVerBusqueda').onclick = () => {
      cerrarCmp();
      irBusquedaFiltro({ autor: id, etiqueta: '👤 ' + nombreAutor });
    };

  if (admin) {
    if ($('#autFoto')) $('#autFoto').onclick = () => $('#autFotoFile').click();
    if ($('#autFotoFile')) $('#autFotoFile').onchange = () => autorSubirFoto(id, $('#autFotoFile'));
    if ($('#autFotoObra')) $('#autFotoObra').onclick = () => autorFotoDeObras(id);
    if ($('#autEliminarUno')) $('#autEliminarUno').onclick = async () => {
      if (!confirm(`¿Eliminar el autor «${nombreAutor}»?\n\nNo tiene obras asociadas; se borrará su ficha.`)) return;
      try {
        const rr = await api('/autores/eliminar', { method: 'POST', body: JSON.stringify({ ids: [id] }) });
        if (!rr.ok) { toast(rr.motivo, 'bad'); return; }
        cerrarCmp();
        toast(rr.borrados ? '🗑 Autor eliminado' : 'Conservado (tiene obras)');
        autoresBuscar();
      } catch (e) { toast(e.message, 'bad'); }
    };
    if ($('#autEnriquecer')) $('#autEnriquecer').onclick = () => autorEnriquecer(id);
    if ($('#autGuardar')) $('#autGuardar').onclick = () => autorGuardar(id);
    if ($('#autGuardarTop')) $('#autGuardarTop').onclick = () => autorGuardar(id);
    // Fusionar ESTE autor en otro (el actual se absorbe en el elegido y se borra).
    if ($('#autFusionar')) $('#autFusionar').onclick = () =>
      elegirAutorOverlay(id, `🔀 Fusionar «${recortar(nombreAutor, 24)}» en…`, 'Sus libros pasarán al autor que elijas y este se borrará.', async (bId, bNom) => {
        if (!confirm(`¿Fundir «${nombreAutor}» EN «${bNom}»?\n\nTodos sus libros pasan a «${bNom}» y «${nombreAutor}» se borra.`)) return;
        const rr = await api('/autores/fusionar', { method: 'POST', body: JSON.stringify({ destino: bId, ids: [id] }) });
        cerrarCmp();
        toast(`✔ Fusionado en «${bNom}» · ${rr.reasignados || 0} libro(s)`);
        autoresBuscar();
      });
    if ($('#autQuitarTodos')) $('#autQuitarTodos').onclick = () => autorQuitar(id, nombreAutor, null, libros.length);
    if ($('#autSelQuitar')) $('#autSelQuitar').onclick = () => {
      if (!_autFichaSel.size) { toast('Selecciona al menos un libro', 'warn'); return; }
      autorQuitar(id, nombreAutor, [..._autFichaSel], _autFichaSel.size);
    };
    // Enviar los libros SELECCIONADOS a otro autor (el actual conserva los no seleccionados).
    if ($('#autSelMover')) $('#autSelMover').onclick = () => {
      if (!_autFichaSel.size) { toast('Selecciona al menos un libro', 'warn'); return; }
      const ids = [..._autFichaSel];
      elegirAutorOverlay(id, `➡️ Mover ${ids.length} libro(s) a…`, 'Los libros seleccionados pasan al autor elegido; este los deja de tener.', async (bId, bNom) => {
        const rr = await api('/autores/' + encodeURIComponent(id) + '/reasignar', { method: 'POST', body: JSON.stringify({ destino: bId, ids }) });
        cerrarCmp();
        toast(`✔ ${rr.reasignados || 0} libro(s) → «${bNom}»${rr.autorBorrado ? ' · autor vaciado y borrado' : ''}`);
        autoresBuscar();
      });
    };
  }
}

// Quitar un autor de sus documentos (todos o los `ids` seleccionados): quedan SIN ese autor; si se queda
// sin obras, el servidor lo borra. Útil para revistas/anónimos o para deshacer una autoría errónea.
async function autorQuitar(id, nombre, ids, count) {
  const ambito = ids ? `de los ${count} libro(s) seleccionados` : 'de TODOS sus libros';
  if (!confirm(`¿Quitar a «${nombre}» ${ambito}?\n\nEsos documentos quedarán sin este autor/colaborador. Si se queda sin obras, el autor se borrará. (Nunca se borra un autor con obras.)`)) return;
  try {
    const r = await api('/autores/' + encodeURIComponent(id) + '/quitar', { method: 'POST', body: JSON.stringify(ids ? { ids } : {}) });
    cerrarCmp();
    toast(`✔ Quitado de ${r.quitados} doc(s)${r.autorBorrado ? ' · autor borrado (se quedó sin obras)' : ''}`);
    autoresBuscar();
  } catch (e) { toast('Error: ' + e.message, 'bad'); }
}

// Overlay de BÚSQUEDA de autor (para fusionar/reasignar). `excluir` = id a no ofrecer (el actual). Al elegir
// uno llama a onPick(id, nombre); la propia acción cierra el overlay. Reutilizable por varias acciones.
function elegirAutorOverlay(excluir, titulo, subtitulo, onPick) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.55);display:grid;place-items:center;padding:16px';
  ov.innerHTML = `<div class="box card" style="max-width:460px;width:94vw;max-height:82vh;overflow:auto">
      <h3 style="margin-top:0">${esc(titulo)}</h3>
      <div class="muted" style="font-size:12px;margin-bottom:8px">${esc(subtitulo)}</div>
      <input id="fusBuscar" placeholder="Buscar autor por nombre…" autocomplete="off" style="width:100%;box-sizing:border-box">
      <div id="fusRes" class="muted" style="margin-top:10px;max-height:46vh;overflow:auto;font-size:13px">Escribe para buscar…</div>
      <div style="margin-top:12px;text-align:right"><button class="btn" id="fusX">Cancelar</button></div>
    </div>`;
  document.body.appendChild(ov);
  const cerrar = () => ov.remove();
  ov.onclick = (e) => { if (e.target === ov) cerrar(); };
  ov.querySelector('#fusX').onclick = cerrar;
  const inp = ov.querySelector('#fusBuscar'), res = ov.querySelector('#fusRes');
  inp.focus();
  let t;
  const buscar = async () => {
    const q = inp.value.trim();
    if (q.length < 2) { res.textContent = 'Escribe al menos 2 letras…'; return; }
    res.textContent = 'Buscando…';
    try {
      const r = await api('/autores?q=' + encodeURIComponent(q) + '&limite=40');
      const cand = (r.autores || []).filter((x) => String(x._id) !== String(excluir));
      if (!cand.length) { res.textContent = 'Sin resultados.'; return; }
      res.innerHTML = cand.map((x) =>
        `<button type="button" class="btn fusPick" data-id="${esc(x._id)}" data-nom="${esc(x.nombre)}" style="display:block;width:100%;text-align:left;margin-top:5px">${esc(x.nombre)} <span class="muted">· ${x.n_libros || 0} libro(s)</span></button>`).join('');
      res.querySelectorAll('.fusPick').forEach((b) => (b.onclick = async () => {
        try { await onPick(b.dataset.id, b.dataset.nom); cerrar(); }
        catch (e) { toast('Error: ' + e.message, 'bad'); }
      }));
    } catch (e) { res.textContent = 'Error: ' + e.message; }
  };
  inp.oninput = () => { clearTimeout(t); t = setTimeout(buscar, 300); };
}

async function autorGuardar(id) {
  const cambios = {
    nombre: ($('#autNombre') && $('#autNombre').value) || '',
    nombres_alternativos: (($('#autAlt') && $('#autAlt').value) || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean),
    nacimiento: ($('#autNac') && $('#autNac').value) || '',
    fallecimiento: ($('#autFall') && $('#autFall').value) || '',
    biografia: ($('#autBio') && $('#autBio').value) || '',
  };
  const msg = $('#autMsg');
  if (msg) msg.textContent = 'Guardando…';
  try {
    await api('/autores/' + encodeURIComponent(id) + '/editar', { method: 'POST', body: JSON.stringify(cambios) });
  } catch (e) {
    if (msg) msg.textContent = 'Error: ' + e.message;
    return;
  }
  cerrarCmp();
  toast('✔ Autor guardado');
  autoresBuscar();
}

async function autorSubirFoto(id, inp) {
  const f = inp && inp.files && inp.files[0];
  if (inp) inp.value = '';
  if (!f) return;
  const msg = $('#autMsg');
  if (msg) msg.textContent = 'Subiendo foto…';
  try {
    const red = await reducirImagen(f);
    const base64 = await fileADataURL(red);
    await api('/autores/' + encodeURIComponent(id) + '/foto', { method: 'POST', body: JSON.stringify({ base64 }) });
  } catch (e) {
    if (msg) msg.textContent = 'Error: ' + e.message;
    return;
  }
  toast('📷 Foto guardada');
  autorFicha(id); // recargar la ficha para mostrar la nueva foto
}

// Elegir la foto del autor de entre las imágenes (portada + carrusel) de sus obras — p. ej. una foto suya
// del interior del libro (ver «Extraer del documento» en la ficha del libro). Toca una imagen → se fija.
async function autorFotoDeObras(id) {
  let r;
  try { r = await api('/autores/' + encodeURIComponent(id) + '/imagenes-obras'); }
  catch (e) { toast(e.message, 'bad'); return; }
  const obras = (r && r.obras) || [];
  if (!obras.length) { toast('Sus obras no tienen imágenes', 'warn'); return; }
  const bloques = obras.map((o) => `
    <div style="margin-bottom:10px">
      <div class="muted" style="font-size:11px;margin-bottom:4px">${esc(recortar(o.titulo || '—', 60))}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px">
        ${o.imagenes.map((u) => `<img data-foto="${esc(u)}" src="${esc(encUrl(u))}" loading="lazy" style="width:100%;height:96px;object-fit:cover;border-radius:6px;background:var(--card);cursor:pointer;border:2px solid transparent">`).join('')}
      </div>
    </div>`).join('');
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:600px;max-height:88vh;overflow:auto">
    <h3 style="margin-top:0">🖼️ Elegir foto de una obra</h3>
    <div class="muted" style="font-size:12px;margin-bottom:10px">Toca una imagen (portada o interior) de sus libros para usarla como foto del autor.</div>
    ${bloques}
    <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="afoX">Volver a la ficha</button></div>
    <div id="afoMsg" class="muted" style="font-size:12px;margin-top:6px"></div>
  </div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#afoX').onclick = () => autorFicha(id);
  $('#cmpScrim').onclick = cerrarCmp;
  $$('#cmpModal [data-foto]').forEach((im) => (im.onclick = async () => {
    const msg = $('#afoMsg'); if (msg) msg.textContent = 'Guardando foto…';
    try {
      const resp = await fetch(encUrl(im.dataset.foto));
      const blob = await resp.blob();
      const file = new File([blob], 'foto.jpg', { type: blob.type || 'image/jpeg' });
      const base64 = await fileADataURL(await reducirImagen(file));
      await api('/autores/' + encodeURIComponent(id) + '/foto', { method: 'POST', body: JSON.stringify({ base64 }) });
      toast('📷 Foto guardada');
      autorFicha(id);
    } catch (e) { if (msg) msg.textContent = 'Error: ' + e.message; }
  }));
}

// Autocompletar (web): rellena huecos (foto/biografía/seudónimos/fechas) desde OpenLibrary + Wikidata +
// Wikipedia (sin clave, sin IA). Conservador: no pisa lo que ya haya. Recarga la ficha con lo encontrado.
async function autorEnriquecer(id) {
  const msg = $('#autMsg');
  if (msg) msg.textContent = '✨ Buscando en OpenLibrary / Wikidata / Wikipedia…';
  let r;
  try {
    r = await api('/autores/' + encodeURIComponent(id) + '/enriquecer-web', { method: 'POST', body: JSON.stringify({}) });
  } catch (e) {
    if (msg) msg.textContent = 'Error: ' + e.message;
    return;
  }
  if (!r.cambios || !r.cambios.length) {
    if (msg) msg.textContent = r.motivo || 'Sin datos nuevos en la web para este autor.';
    toast('Sin datos nuevos', 'warn');
    return;
  }
  toast(`✨ Autocompletado: ${r.cambios.join(', ')} (${(r.fuentes || []).join(', ')})`);
  autorFicha(id); // recargar para mostrar foto/bio/alternativos nuevos
}

// Combinar (A→B): elige entre los seleccionados cuál es el DESTINO (B, se conserva) y funde el resto en él.
// SEGURIDAD (mismo arreglo que en editoriales): se listan y se funden EXACTAMENTE los mismos autores (los de
// `_autoresSelInfo`). Antes se mostraban solo los de la PÁGINA actual pero se enviaba TODA la selección, que
// sobrevive a búsquedas y paginación → se podían absorber autores sin verlos. La fusión borra y es irreversible.
function autorCombinar() {
  const sel = [..._autoresSelInfo.values()];
  if (sel.length < 2) return;
  // Por defecto, destino = el que más libros tiene (menos reasignaciones).
  const porDefecto = sel.slice().sort((a, b) => (b.n_libros || 0) - (a.n_libros || 0))[0];
  const total = sel.reduce((s, a) => s + (a.n_libros || 0), 0);
  const opciones = sel
    .map(
      (a) =>
        `<label style="display:flex;gap:8px;align-items:center;padding:6px;border-bottom:1px solid var(--line);cursor:pointer">
          <input type="radio" name="autDest" value="${esc(a._id)}" ${a._id === porDefecto._id ? 'checked' : ''}>
          <span style="flex:1">${esc(a.nombre)} <span class="muted" style="font-size:11px">· ${a.n_libros} libro(s)</span></span>
        </label>`,
    )
    .join('');
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:480px;max-height:88vh;overflow:auto">
    <h3 style="margin-top:0">🔗 Combinar ${sel.length} autores</h3>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Elige el autor que se CONSERVA (destino). Los <b>${sel.length - 1}</b> restantes se FUNDIRÁN en él y <b>se borrarán</b>: sus nombres pasarán a «también conocido como» y sus libros se reasignarán. Esta lista es EXACTAMENTE lo que se va a fusionar.</div>
    ${opciones}
    <div class="muted" style="font-size:11px;margin-top:8px">Entre todos suman <b>${total}</b> libro(s).</div>
    <div id="autCombAviso" style="margin-top:8px"></div>
    <div id="autCombMsg" class="muted" style="font-size:12px;margin-top:8px"></div>
    <div class="row" style="gap:8px;margin-top:12px;justify-content:flex-end">
      <button class="btn pri" id="autCombOk">🔗 Combinar</button>
      <button class="btn" id="autCombX">Cancelar</button>
    </div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = cerrarCmp;
  $('#autCombX').onclick = cerrarCmp;
  const pintarAviso = () => {
    const destino = ($('#cmpModal input[name="autDest"]:checked') || {}).value;
    const mover = sel.filter((a) => a._id !== destino).reduce((s, a) => s + (a.n_libros || 0), 0);
    const av = $('#autCombAviso');
    if (!av) return;
    av.innerHTML =
      mover > UMBRAL_FUSION_GRANDE
        ? `<label style="display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--warn)">
             <input type="checkbox" id="autCombConfirm" style="margin-top:2px">
             <span>⚠️ Se reasignarán <b>${mover}</b> libro(s) y se borrarán ${sel.length - 1} autor(es). Es IRREVERSIBLE. Marca para confirmar.</span>
           </label>`
        : `<div class="muted" style="font-size:11px">Se reasignarán ${mover} libro(s).</div>`;
  };
  $$('#cmpModal input[name="autDest"]').forEach((r) => (r.onchange = pintarAviso));
  pintarAviso();
  $('#autCombOk').onclick = async () => {
    const destino = ($('#cmpModal input[name="autDest"]:checked') || {}).value;
    if (!destino) return;
    const conf = $('#autCombConfirm');
    if (conf && !conf.checked) { toast('Marca la casilla de confirmación', 'warn'); return; }
    const msg = $('#autCombMsg');
    if (msg) msg.textContent = 'Combinando…';
    try {
      const ids = sel.map((a) => a._id); // exactamente los listados arriba
      const r = await api('/autores/fusionar', { method: 'POST', body: JSON.stringify({ destino, ids }) });
      cerrarCmp();
      toast(`🔗 ${r.fusionados} fundido(s) en «${r.destino.nombre}» · ${r.reasignados} libro(s) reasignados`);
      limpiarSelAutores();
      autoresBuscar();
    } catch (e) {
      if (msg) msg.textContent = 'Error: ' + e.message;
    }
  };
}

// ── EDITORIALES (página «Editoriales», GEMELA de Autores) ────────────────────────────────────────────
// buscar/listar (con nº de libros) · ficha (nombre/alternativos editables + libros que publica) ·
// COMBINAR duplicadas (A→B) · fusionar ESTA en otra · borrar (solo sin libros). Misma mecánica de
// selección que el resto (tap-para-marcar, círculo .selmark, hundido; ver loadAutores).
let _editoriales = []; // último listado recibido
const _editorialesSel = new Set(); // ids marcadas para combinar
// Caché de lo MARCADO (id → {nombre, n_libros}). La selección SOBREVIVE a las búsquedas, así que la lista
// visible (`_editoriales`) puede NO contener todo lo marcado. Sin esta caché, el diálogo de combinar mostraba
// solo lo visible pero FUNDÍA toda la selección → se absorbían editoriales sin que el usuario las viera.
const _editorialesSelInfo = new Map();
let _editorialesSelModo = false; // Modo selección (tap = marcar)
let _editorialesBuscarTimer = null; // debounce del buscador
let _editorialesPagina = 1; // paginación (paridad con Autores)
let _editorialesTotal = 0; // total de editoriales que casan (para el recuento)
let _editorialesPorPagina = 60; // editoriales por página (lo confirma el servidor)
let _editorialesCapado = false; // el escaneo llegó al tope → el recuento puede quedarse corto

// Marca/desmarca UNA editorial recordando su nombre y nº de libros (para poder enseñarla luego aunque no esté
// en la vista actual). `on` = true marca, false desmarca, undefined conmuta.
function marcarEditorial(id, on) {
  const activar = on === undefined ? !_editorialesSel.has(id) : !!on;
  if (activar) {
    _editorialesSel.add(id);
    const e = (_editoriales || []).find((x) => x._id === id);
    if (e) _editorialesSelInfo.set(id, { _id: id, nombre: e.nombre, n_libros: e.n_libros || 0 });
    else if (!_editorialesSelInfo.has(id)) _editorialesSelInfo.set(id, { _id: id, nombre: '(desconocida)', n_libros: 0 });
  } else {
    _editorialesSel.delete(id);
    _editorialesSelInfo.delete(id);
  }
  return activar;
}
function limpiarSelEditoriales() {
  _editorialesSel.clear();
  _editorialesSelInfo.clear();
}

async function loadEditoriales() {
  const cont = $('#p-editoriales');
  if (!cont) return;
  limpiarSelEditoriales();
  _editorialesSelModo = false;
  cont.innerHTML = `
    <div class="sec-h"><h2>Editoriales</h2></div>
    <div class="row" style="gap:8px;align-items:center;margin-bottom:8px;flex-wrap:wrap">
      <input id="edBuscar" placeholder="🔍 Buscar editorial (nombre o variante)…" autocomplete="off" style="flex:1;min-width:200px" />
      <span id="edCombinaBar"></span>
    </div>
    <div class="row" style="gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <label class="muted" style="font-size:12px">Orden
        <select id="edOrden"><option value="libros">nº de libros</option><option value="nombre">nombre</option></select>
      </label>
    </div>
    <div id="edGrid" class="muted">Cargando…</div>`;
  const inp = $('#edBuscar');
  if (inp)
    inp.oninput = () => {
      clearTimeout(_editorialesBuscarTimer);
      _editorialesBuscarTimer = setTimeout(editorialesBuscarReset, 300); // texto nuevo → página 1
    };
  const so = $('#edOrden');
  if (so) so.onchange = editorialesBuscarReset; // cambiar el orden recarga desde la página 1
  _editorialesPagina = 1;
  editorialesBuscar();
}

// Lee los controles (texto + orden) y pide la PÁGINA actual al servidor.
async function editorialesBuscar() {
  const grid = $('#edGrid');
  if (grid) grid.textContent = 'Cargando…';
  const params = new URLSearchParams({
    q: ($('#edBuscar') && $('#edBuscar').value.trim()) || '',
    orden: ($('#edOrden') && $('#edOrden').value) || 'libros',
    pagina: String(_editorialesPagina),
    limite: String(_editorialesPorPagina),
  });
  try {
    const r = await api('/editoriales?' + params.toString());
    _editoriales = r.editoriales || [];
    _editorialesTotal = r.total || _editoriales.length;
    _editorialesPorPagina = r.porPagina || _editorialesPorPagina;
    _editorialesCapado = !!r.capado;
  } catch (e) {
    if (grid) grid.textContent = 'Error: ' + e.message;
    return;
  }
  editorialesPintar();
}

// Re-busca desde la PÁGINA 1 (al cambiar el texto o el orden). Los botones de paginación llaman a
// editorialesBuscar directamente conservando _editorialesPagina.
function editorialesBuscarReset() { _editorialesPagina = 1; editorialesBuscar(); }
function editorialesIrPagina(p) {
  const paginas = Math.max(1, Math.ceil(_editorialesTotal / _editorialesPorPagina));
  _editorialesPagina = Math.min(paginas, Math.max(1, p));
  editorialesBuscar();
}

// Barra de recuento + paginación (arriba de la rejilla). «desde–hasta de TOTAL editorial(es)» y ‹ N/M ›.
function editorialesPager() {
  const paginas = Math.max(1, Math.ceil(_editorialesTotal / _editorialesPorPagina));
  const desde = _editorialesTotal ? (_editorialesPagina - 1) * _editorialesPorPagina + 1 : 0;
  const hasta = Math.min(_editorialesPagina * _editorialesPorPagina, _editorialesTotal);
  const cuenta = _editorialesTotal
    ? `${desde}–${hasta} de ${_editorialesTotal}${_editorialesCapado ? '+' : ''} editorial(es)`
    : 'Sin editoriales';
  const nav = paginas > 1
    ? `<span class="row" style="gap:6px;align-items:center;flex-wrap:wrap">${pagerControles(_editorialesPagina, paginas)}</span>`
    : '';
  return `<div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:10px"><span class="muted" style="font-size:12px">${cuenta}</span>${nav}</div>`;
}
function editorialesWirePager() {
  const paginas = Math.max(1, Math.ceil(_editorialesTotal / _editorialesPorPagina));
  wirePager($('#edGrid'), _editorialesPagina, paginas, editorialesIrPagina);
}

function editorialesPintar() {
  const grid = $('#edGrid');
  if (!grid) return;
  if (!_editoriales.length) {
    grid.innerHTML = editorialesPager() + '<div class="empty">Sin editoriales.</div>';
    editorialesWirePager();
    editorialesBarra();
    return;
  }
  const admin = ROL === 'admin';
  grid.innerHTML = editorialesPager() + `<div class="${admin && _editorialesSelModo ? 'selmode' : ''}" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">${_editoriales
    .map(editorialCard)
    .join('')}</div>`;
  editorialesWirePager();
  // Interacción unificada (igual que Autores/Catálogo): clic/toque = abrir la ficha (o MARCAR en Modo
  // selección); doble clic / pulsación larga = conmutar el modo (conservando lo ya marcado).
  grid.querySelectorAll('[data-edi]').forEach((el) =>
    attachGesto(
      el,
      () => {
        const id = el.dataset.edi;
        if (admin && _editorialesSelModo) {
          marcarEditorial(id);
          el.classList.toggle('sel', _editorialesSel.has(id));
          editorialesBarra();
        } else editorialFicha(id);
      },
      () => alternarEditorialesModo(el.dataset.edi),
    ),
  );
  setModoVisual(admin && _editorialesSelModo);
  editorialesBarra();
}

// Conmuta el Modo selección de la LISTA de editoriales (botón o gesto doble-clic / pulsación-larga).
function alternarEditorialesModo(selId) {
  if (ROL !== 'admin') return;
  const entrando = !_editorialesSelModo;
  _editorialesSelModo = !_editorialesSelModo;
  if (entrando && _editorialesSelModo && selId) marcarEditorial(selId, true);
  editorialesPintar();
}

function editorialCard(e) {
  const sel = _editorialesSel.has(e._id);
  const alt =
    e.nombres_alternativos && e.nombres_alternativos.length
      ? `<div class="muted" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${esc(e.nombres_alternativos.join(' · '))}">a.k.a. ${esc(e.nombres_alternativos.join(' · '))}</div>`
      : '';
  // Thumbnail = el LOGO si lo tiene (contain: un logo no se recorta); si no, el icono genérico.
  const thumb = e.logo
    ? `<img src="${esc(encUrl(e.logo))}" loading="lazy" style="width:52px;height:52px;border-radius:12px;object-fit:contain;background:var(--card);flex:0 0 auto">`
    : `<div style="width:52px;height:52px;border-radius:12px;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:24px;flex:0 0 auto">🏢</div>`;
  // Sede y años de actividad, si se han rellenado («Barcelona · España · 1911–»).
  const sede = [e.ciudad, e.pais].filter(Boolean).join(' · ');
  const anios = e.fecha_fundacion || e.fecha_disolucion ? `${e.fecha_fundacion || '?'}–${e.fecha_disolucion || ''}` : '';
  const meta = sede || anios
    ? `<div class="muted" style="font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(sede)}${sede && anios ? ' · ' : ''}${esc(anios)}</div>`
    : '';
  // Misma mecánica de selección que Autores: círculo .selmark (visible en Modo selección), .sel al marcar.
  return `<div data-edi="${esc(e._id)}" class="card${sel ? ' sel' : ''}" style="position:relative;display:flex;gap:10px;align-items:center;padding:10px">
    <span class="selmark">✓</span>
    ${thumb}
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(e.nombre || '—')}</div>
      <div class="muted" style="font-size:12px">${e.n_libros} libro(s)</div>
      ${meta}
      ${alt}
    </div></div>`;
}

// Barra de acción: botón de Modo selección (admin) + «Combinar» al marcar 2+ editoriales.
function editorialesBarra() {
  const bar = $('#edCombinaBar');
  if (!bar) return;
  const admin = ROL === 'admin';
  const n = _editorialesSel.size;
  const modoBtn = admin
    ? `<button class="btn${_editorialesSelModo ? ' pri' : ''}" id="edModo" title="Modo selección: tocar una tarjeta la marca (para combinar). Modo previsualización: tocar abre la ficha. Doble clic / pulsación larga en una tarjeta también conmuta. Lo marcado se conserva.">${_editorialesSelModo ? '🖱 Modo selección' : '👁 Modo previsualización'}</button>`
    : '';
  const acciones =
    n >= 2
      ? ` <button class="btn pri admin-only" id="edCombinar">🔗 Combinar ${n}…</button> <button class="btn" id="edSelClear">✕ deseleccionar</button>`
      : n === 1
        ? ` <span class="muted" style="font-size:12px">1 marcada (marca 2+ para combinar)</span> <button class="btn" id="edSelClear">✕</button>`
        : '';
  bar.innerHTML = modoBtn + acciones;
  if ($('#edModo')) $('#edModo').onclick = () => alternarEditorialesModo();
  if ($('#edCombinar')) $('#edCombinar').onclick = editorialCombinar;
  if ($('#edSelClear'))
    $('#edSelClear').onclick = () => {
      limpiarSelEditoriales();
      editorialesPintar();
    };
}

// Combinar (A→B): elige entre las seleccionadas cuál es el DESTINO (B, se conserva) y funde el resto en ella.
// SEGURIDAD: se listan y se funden EXACTAMENTE las mismas (las de `_editorialesSelInfo`, la caché de lo marcado).
// Antes se mostraban solo las visibles en la búsqueda actual pero se enviaba TODA la selección, así que podían
// absorberse editoriales que el usuario no veía (así se tragó «Seix Barral», con 292 libros, sin avisar).
// La fusión BORRA las absorbidas y es irreversible, así que una reasignación grande pide confirmación extra.
const UMBRAL_FUSION_GRANDE = 25; // libros a reasignar por encima de los cuales se exige confirmación explícita
function editorialCombinar() {
  const sel = [..._editorialesSelInfo.values()];
  if (sel.length < 2) return;
  const porDefecto = sel.slice().sort((a, b) => (b.n_libros || 0) - (a.n_libros || 0))[0];
  const total = sel.reduce((s, e) => s + (e.n_libros || 0), 0);
  const opciones = sel
    .map(
      (e) =>
        `<label style="display:flex;gap:8px;align-items:center;padding:6px;border-bottom:1px solid var(--line);cursor:pointer">
          <input type="radio" name="ediDest" value="${esc(e._id)}" ${e._id === porDefecto._id ? 'checked' : ''}>
          <span style="flex:1">${esc(e.nombre)} <span class="muted" style="font-size:11px">· ${e.n_libros} libro(s)</span></span>
        </label>`,
    )
    .join('');
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:480px;max-height:88vh;overflow:auto">
    <h3 style="margin-top:0">🔗 Combinar ${sel.length} editoriales</h3>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Elige la editorial que se CONSERVA (destino). Las <b>${sel.length - 1}</b> restantes se FUNDIRÁN en ella y <b>se borrarán</b>: sus nombres pasarán a «también conocida como» y sus libros se reasignarán. Esta lista es EXACTAMENTE lo que se va a fusionar.</div>
    ${opciones}
    <div class="muted" style="font-size:11px;margin-top:8px">Entre todas suman <b>${total}</b> libro(s).</div>
    <div id="ediCombAviso" style="margin-top:8px"></div>
    <div id="ediCombMsg" class="muted" style="font-size:12px;margin-top:8px"></div>
    <div class="row" style="gap:8px;margin-top:12px;justify-content:flex-end">
      <button class="btn pri" id="ediCombOk">🔗 Combinar</button>
      <button class="btn" id="ediCombX">Cancelar</button>
    </div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = cerrarCmp;
  $('#ediCombX').onclick = cerrarCmp;
  // Cuántos libros se MOVERÍAN según el destino elegido (los de todas menos el destino) → aviso si es grande.
  const pintarAviso = () => {
    const destino = ($('#cmpModal input[name="ediDest"]:checked') || {}).value;
    const mover = sel.filter((e) => e._id !== destino).reduce((s, e) => s + (e.n_libros || 0), 0);
    const av = $('#ediCombAviso');
    if (!av) return;
    av.innerHTML =
      mover > UMBRAL_FUSION_GRANDE
        ? `<label style="display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--warn)">
             <input type="checkbox" id="ediCombConfirm" style="margin-top:2px">
             <span>⚠️ Se reasignarán <b>${mover}</b> libro(s) y se borrarán ${sel.length - 1} editorial(es). Es IRREVERSIBLE. Marca para confirmar.</span>
           </label>`
        : `<div class="muted" style="font-size:11px">Se reasignarán ${mover} libro(s).</div>`;
  };
  $$('#cmpModal input[name="ediDest"]').forEach((r) => (r.onchange = pintarAviso));
  pintarAviso();
  $('#ediCombOk').onclick = async () => {
    const destino = ($('#cmpModal input[name="ediDest"]:checked') || {}).value;
    if (!destino) return;
    const conf = $('#ediCombConfirm');
    if (conf && !conf.checked) { toast('Marca la casilla de confirmación', 'warn'); return; }
    const msg = $('#ediCombMsg');
    if (msg) msg.textContent = 'Combinando…';
    try {
      const ids = sel.map((e) => e._id); // exactamente las listadas arriba
      const r = await api('/editoriales/fusionar', { method: 'POST', body: JSON.stringify({ destino, ids }) });
      cerrarCmp();
      toast(`🔗 ${r.fusionadas} fundida(s) en «${r.destino.nombre}» · ${r.reasignados} libro(s) reasignados`);
      limpiarSelEditoriales();
      editorialesBuscar();
    } catch (e) {
      if (msg) msg.textContent = 'Error: ' + e.message;
    }
  };
}

// Selección ergonómica de libros DENTRO de la ficha de editorial (gemela de la de autor): en «modo
// selección» tocar una tarjeta la marca (en vez de abrir su ficha), para actuar luego sobre la selección
// (mostrar en Catálogo · mover a otra editorial · quitar la editorial). Se reinicia al abrir la ficha.
let _ediFichaSel = new Set();
let _ediFichaSelModo = false;

// Ficha de editorial (modal): nombre/alternativos/logo/sede/fechas (editables si admin) + libros que
// publica. Acciones admin: fusionar ESTA en otra · EXPLOTAR (liberar sus libros) · borrar (solo sin libros)
// · selección de libros con «mostrar en Catálogo / mover a otra editorial / quitar la editorial».
async function editorialFicha(id) {
  let r;
  try {
    r = await api('/editoriales/' + encodeURIComponent(id));
  } catch (e) {
    toast(e.message, 'bad');
    return;
  }
  const ed = r.editorial || {};
  const libros = r.libros || [];
  const admin = ROL === 'admin';
  _ediFichaSel = new Set(); // selección limpia al (re)abrir la ficha
  _ediFichaSelModo = false;
  const alt = Array.isArray(ed.nombres_alternativos) ? ed.nombres_alternativos.join('; ') : '';
  // Sede y años de actividad, en una línea legible para el invitado («Barcelona (España) · 1911–»).
  const sede = [ed.ciudad, ed.pais].filter(Boolean).join(' · ');
  const anios = ed.fecha_fundacion || ed.fecha_disolucion
    ? `${ed.fecha_fundacion || '?'}–${ed.fecha_disolucion || ''}`
    : '';
  const campos = admin
    ? `<div><label>Nombre</label><input id="ediNombre" value="${esc(ed.nombre || '')}" autocomplete="off"></div>
       <div style="margin-top:6px"><label>También conocida como (separa con ;)</label><input id="ediAlt" value="${esc(alt)}" autocomplete="off"></div>
       <details style="margin-top:8px"${ed.descripcion || sede || anios ? ' open' : ''}>
         <summary style="cursor:pointer;font-size:12px;color:var(--mut)">✏️ Sede, fechas e historia…</summary>
         <div class="row" style="margin-top:6px;gap:8px">
           <div style="flex:1"><label>Ciudad</label><input id="ediCiudad" value="${esc(ed.ciudad || '')}" autocomplete="off"></div>
           <div style="flex:1"><label>País</label><input id="ediPais" value="${esc(ed.pais || '')}" autocomplete="off"></div>
         </div>
         <div class="row" style="margin-top:6px;gap:8px">
           <div style="flex:1"><label>Año de fundación</label><input id="ediFundacion" value="${esc(ed.fecha_fundacion || '')}" inputmode="numeric" placeholder="p. ej. 1911" autocomplete="off"></div>
           <div style="flex:1"><label>Año de disolución</label><input id="ediDisolucion" value="${esc(ed.fecha_disolucion || '')}" inputmode="numeric" placeholder="vacío = sigue activa" autocomplete="off"></div>
         </div>
         <div style="margin-top:6px"><label>Historia / notas</label><textarea id="ediDesc" rows="5" style="width:100%;resize:vertical;font-family:inherit">${esc(ed.descripcion || '')}</textarea></div>
       </details>`
    : `<h3 style="margin:0">${esc(ed.nombre || '—')}</h3>
       ${alt ? `<div class="muted" style="font-size:12px;margin-top:4px">a.k.a. ${esc(alt)}</div>` : ''}
       ${sede || anios ? `<div class="muted" style="font-size:12px;margin-top:4px">${esc(sede)}${sede && anios ? ' · ' : ''}${esc(anios)}</div>` : ''}
       ${ed.descripcion ? `<p class="sinopsis-text" style="margin-top:8px">${esc(ed.descripcion)}</p>` : ''}`;
  const nfcBadge = (l) =>
    l.nfc
      ? `<span title="Tiene etiqueta NFC" style="position:absolute;top:3px;right:3px;font-size:11px;background:var(--card);border-radius:6px;padding:0 3px">📶</span>`
      : '';
  const tipoBadge = (l) =>
    l.comic
      ? '<span class="docbadge" style="background:rgba(180,120,255,.18);color:#b478ff">📓 cómic</span>'
      : `<span class="docbadge" style="background:rgba(120,160,255,.16);color:#78a0ff">${tipoIcono(l.tipo_recurso)} ${tipoNombre(l.tipo_recurso).toLowerCase()}</span>`;
  const soporteBadge = (l) =>
    l.papel
      ? '<span class="docbadge" style="background:rgba(200,160,90,.18);color:#d0a860">📄 papel</span>'
      : '<span class="docbadge" style="background:rgba(40,217,168,.16);color:var(--acc)">💾 digital</span>';
  const cardLibro = (l) => `<div data-libro="${esc(l._id)}" title="${esc(l.titulo || '')}" style="position:relative;cursor:pointer;text-align:center;border-radius:8px;padding:2px">
      <span class="selmark">✓</span>
      ${nfcBadge(l)}
      ${l.portada ? `<img src="${esc(encUrl(l.portada))}" style="width:100%;height:118px;object-fit:contain;border-radius:6px;background:var(--card)" loading="lazy">` : `<div style="height:118px;border-radius:6px;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:22px">${tipoIcono(l.tipo_recurso, l.comic)}</div>`}
      <div class="muted" style="font-size:10px;line-height:1.2;margin-top:2px">${esc(recortar(l.titulo || '—', 40))}${l['año_edicion'] ? ` · ${l['año_edicion']}` : ''}</div>
      <div style="display:flex;gap:3px;justify-content:center;flex-wrap:wrap;margin-top:3px">${tipoBadge(l)}${soporteBadge(l)}</div>
    </div>`;
  const librosHtml = libros.length
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:10px;margin-top:8px">${libros.map(cardLibro).join('')}</div>`
    : '<div class="muted" style="font-size:12px;margin-top:6px">Sin libros asociados.</div>';
  // LOGO: `object-fit: contain` (un logo no se recorta como una foto) sobre fondo de tarjeta.
  const logo = ed.logo
    ? `<img src="${esc(encUrl(ed.logo))}?t=${Date.now()}" style="width:110px;height:110px;object-fit:contain;border-radius:12px;background:var(--card)">`
    : `<div style="width:110px;height:110px;border-radius:12px;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:44px">🏢</div>`;
  const bm = 'padding:4px 9px;font-size:12px';
  const acciones = admin
    ? `<div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">
         <div class="row" style="gap:4px;justify-content:center">
           <button class="btn" id="ediLogo" style="${bm}" title="Subir un logo desde archivo">📷 Logo</button>
           ${libros.length ? `<button class="btn" id="ediLogoLibro" style="${bm}" title="Usar como logo una imagen (portada o interior) de uno de sus libros; luego puedes recortarla">🖼️ De un libro</button>` : ''}
         </div>
         <button class="btn" id="ediFusionar" style="${bm}" title="Fundir ESTA editorial en otra que elijas: sus libros pasan a la otra y esta se borra">🔀 Fusionar esta en…</button>
         ${libros.length ? `<button class="btn" id="ediExplotar" style="${bm}" title="Liberar TODOS sus libros (quedan sin editorial) y borrar esta editorial. Distinto de fusionar (reasigna) y de borrar (solo vacías)">💥 Explotar</button>` : ''}
         ${!libros.length ? `<button class="btn" id="ediBorrar" style="${bm}" title="Borrar esta editorial (solo si no tiene libros)">🗑️ Borrar</button>` : ''}
         <div class="row" style="gap:4px;justify-content:center">
           <button class="btn pri" id="ediGuardarTop" style="${bm}">💾 Guardar</button>
           <button class="btn" id="ediCerrarTop" style="${bm}">Cerrar</button>
         </div>
         <input type="file" id="ediLogoFile" accept="image/*" style="display:none">
       </div>`
    : `<div style="margin-top:6px"><button class="btn" id="ediCerrarTop">Cerrar</button></div>`;
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:660px;max-height:92vh;overflow:auto">
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      <div style="text-align:center">
        ${logo}
        ${acciones}
      </div>
      <div style="flex:1;min-width:250px">${campos}</div>
    </div>
    <div style="margin-top:12px">
      <div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
        <div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Libros (${libros.length})</div>
        ${libros.length ? `<div class="row" style="gap:6px">
          ${admin ? `<button class="btn" id="ediSelModo" style="padding:3px 9px;font-size:12px">🖱 Modo selección</button>` : ''}
          <button class="btn" id="ediVerBusqueda" style="padding:3px 9px;font-size:12px" title="Ver todos sus libros en el Catálogo (con filtros, orden y selección)">🔍 Ver en Catálogo</button>
        </div>` : ''}
      </div>
      <div id="ediSelBarra" class="row" style="display:none;gap:8px;align-items:center;margin-top:6px;flex-wrap:wrap">
        <span class="muted" id="ediSelCuenta" style="font-size:12px">0 seleccionados</span>
        <button class="btn" id="ediSelTodos" style="padding:2px 8px;font-size:12px">Todos</button>
        <button class="btn" id="ediSelNinguno" style="padding:2px 8px;font-size:12px">Ninguno</button>
        <button class="btn pri" id="ediSelEnviar" style="padding:2px 8px;font-size:12px">🔍 Mostrar en Catálogo</button>
        ${admin ? '<button class="btn" id="ediSelMover" style="padding:2px 8px;font-size:12px" title="Enviar los libros seleccionados a OTRA editorial (esta los deja de tener)">➡️ A otra editorial</button>' : ''}
        ${admin ? '<button class="btn" id="ediSelQuitar" style="padding:2px 8px;font-size:12px" title="Quitar la editorial de los libros seleccionados (quedan sin ninguna)">🚫 Quitar editorial</button>' : ''}
        ${admin ? '<button class="btn" id="ediSelReclas" style="padding:2px 8px;font-size:12px" title="Reclasificar la editorial de los seleccionados buscándola en cascada (fichero → OpenLibrary → Google → IA opcional), con informe antes de aplicar">🏢 Reclasificar</button>' : ''}
      </div>
      ${librosHtml}
    </div>
    <div class="row" style="gap:8px;margin-top:14px;justify-content:flex-end">
      ${admin ? '<button class="btn pri" id="ediGuardar">💾 Guardar</button>' : ''}
      <button class="btn" id="ediCerrar">Cerrar</button>
    </div>
    <div id="ediMsg" class="muted" style="font-size:12px;margin-top:6px"></div>
  </div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = cerrarCmp;
  $('#ediCerrar').onclick = cerrarCmp;
  if ($('#ediCerrarTop')) $('#ediCerrarTop').onclick = cerrarCmp;
  const nombreEd = ed.nombre || 'Editorial';
  const listaLibros = libros.map((l) => l._id);

  // ── Selección de libros (modo selección), gemela de la ficha de autor ─────────────────────────────────
  const pintarSel = (el, on) => {
    el.classList.toggle('sel', on);
    el.style.outline = on ? '2px solid var(--acc)' : '';
  };
  const actualizarCuenta = () => {
    if ($('#ediSelCuenta')) $('#ediSelCuenta').textContent = _ediFichaSel.size + ' seleccionados';
  };
  const tarjetas = [...$('#cmpModal').querySelectorAll('[data-libro]')];
  const alternarEdiFicha = () => {
    _ediFichaSelModo = !_ediFichaSelModo;
    if ($('#ediSelModo')) $('#ediSelModo').classList.toggle('pri', _ediFichaSelModo);
    if ($('#ediSelBarra')) $('#ediSelBarra').style.display = _ediFichaSelModo ? 'flex' : 'none';
    const cont = $('#cmpModal'); if (cont) cont.classList.toggle('selmode', _ediFichaSelModo);
    if (!_ediFichaSelModo) { _ediFichaSel.clear(); tarjetas.forEach((el) => pintarSel(el, false)); } // al salir, limpiar
    actualizarCuenta();
  };
  // Interacción unificada: clic/toque = abrir ficha (o marcar en Modo selección); doble clic / pulsación
  // larga = conmutar el Modo selección.
  tarjetas.forEach((el) =>
    attachGesto(
      el,
      () => {
        if (_ediFichaSelModo) {
          const lid = el.dataset.libro;
          _ediFichaSel.has(lid) ? _ediFichaSel.delete(lid) : _ediFichaSel.add(lid);
          pintarSel(el, _ediFichaSel.has(lid));
          actualizarCuenta();
        } else {
          cerrarCmp();
          verDoc(el.dataset.libro, { volver: 'editoriales', etiqueta: 'Editoriales', lista: listaLibros });
        }
      },
      () => {
        const entrando = !_ediFichaSelModo;
        alternarEdiFicha();
        if (entrando && _ediFichaSelModo) { _ediFichaSel.add(el.dataset.libro); pintarSel(el, true); actualizarCuenta(); } // marca la del gesto
      },
    ),
  );
  if ($('#ediSelModo')) $('#ediSelModo').onclick = alternarEdiFicha;
  if ($('#ediSelTodos'))
    $('#ediSelTodos').onclick = () => {
      tarjetas.forEach((el) => { _ediFichaSel.add(el.dataset.libro); pintarSel(el, true); });
      actualizarCuenta();
    };
  if ($('#ediSelNinguno'))
    $('#ediSelNinguno').onclick = () => {
      _ediFichaSel.clear();
      tarjetas.forEach((el) => pintarSel(el, false));
      actualizarCuenta();
    };
  if ($('#ediSelEnviar'))
    $('#ediSelEnviar').onclick = () => {
      if (!_ediFichaSel.size) { toast('Selecciona al menos un libro', 'warn'); return; }
      const ids = [..._ediFichaSel];
      cerrarCmp();
      // Los libros llegan al Catálogo YA SELECCIONADOS, listos para actuar sobre ellos.
      mostrarEnCatalogo(ids, '🏢 ' + nombreEd + ' (' + ids.length + ')');
    };
  if ($('#ediVerBusqueda'))
    $('#ediVerBusqueda').onclick = () => {
      cerrarCmp();
      irBusquedaFiltro({ editorial: id, etiqueta: '🏢 ' + nombreEd });
    };
  if (admin) {
    if ($('#ediGuardar')) $('#ediGuardar').onclick = () => editorialGuardar(id);
    if ($('#ediGuardarTop')) $('#ediGuardarTop').onclick = () => editorialGuardar(id);
    if ($('#ediLogo')) $('#ediLogo').onclick = () => $('#ediLogoFile').click();
    if ($('#ediLogoFile')) $('#ediLogoFile').onchange = () => editorialSubirLogo(id, $('#ediLogoFile'));
    if ($('#ediLogoLibro')) $('#ediLogoLibro').onclick = () => editorialLogoDeLibro(id);
    // Fusionar ESTA editorial en otra (la actual se absorbe en la elegida y se borra).
    if ($('#ediFusionar'))
      $('#ediFusionar').onclick = () =>
        elegirEditorialOverlay(id, `🔀 Fusionar «${recortar(nombreEd, 24)}» en…`, 'Sus libros pasarán a la editorial que elijas y esta se borrará.', async (bId, bNom) => {
          if (!confirm(`¿Fundir «${nombreEd}» EN «${bNom}»?\n\nTodos sus libros pasan a «${bNom}» y «${nombreEd}» se borra.`)) return;
          const rr = await api('/editoriales/fusionar', { method: 'POST', body: JSON.stringify({ destino: bId, ids: [id] }) });
          cerrarCmp();
          toast(`✔ Fusionada en «${bNom}» · ${rr.reasignados || 0} libro(s)`);
          editorialesBuscar();
        });
    if ($('#ediBorrar'))
      $('#ediBorrar').onclick = async () => {
        if (!confirm(`¿Borrar la editorial «${nombreEd}»?\n\nSolo se borra si no tiene libros.`)) return;
        try {
          const rr = await api('/editoriales/' + encodeURIComponent(id) + '/borrar', { method: 'POST', body: JSON.stringify({}) });
          if (!rr.ok) {
            toast(rr.motivo || 'No se pudo borrar', 'warn');
            return;
          }
          cerrarCmp();
          toast('🗑️ Editorial borrada');
          editorialesBuscar();
        } catch (e) {
          toast('Error: ' + e.message, 'bad');
        }
      };
    // Enviar los libros SELECCIONADOS a otra editorial (esta conserva los no seleccionados; si se queda sin
    // ninguno, el servidor la borra).
    if ($('#ediSelMover'))
      $('#ediSelMover').onclick = () => {
        if (!_ediFichaSel.size) { toast('Selecciona al menos un libro', 'warn'); return; }
        const ids = [..._ediFichaSel];
        elegirEditorialOverlay(id, `➡️ Mover ${ids.length} libro(s) a…`, 'Los libros seleccionados pasan a la editorial elegida; esta los deja de tener.', async (bId, bNom) => {
          const rr = await api('/editoriales/' + encodeURIComponent(id) + '/reasignar', { method: 'POST', body: JSON.stringify({ destino: bId, ids }) });
          if (!rr.ok) { toast(rr.motivo || 'No se pudo reasignar', 'bad'); return; }
          cerrarCmp();
          toast(`✔ ${rr.reasignados || 0} libro(s) → «${bNom}»${rr.editorialBorrada ? ' · editorial vaciada y borrada' : ''}`);
          editorialesBuscar();
        });
      };
    // Quitar la editorial de los libros SELECCIONADOS (quedan sin ninguna); si se queda sin libros, se borra.
    if ($('#ediSelQuitar'))
      $('#ediSelQuitar').onclick = async () => {
        if (!_ediFichaSel.size) { toast('Selecciona al menos un libro', 'warn'); return; }
        const ids = [..._ediFichaSel];
        if (!confirm(`¿Quitar la editorial «${nombreEd}» de ${ids.length} libro(s)?\n\nEsos libros quedarán SIN editorial. Si la editorial se queda sin ninguno, se borrará.`)) return;
        try {
          const rr = await api('/editoriales/' + encodeURIComponent(id) + '/quitar', { method: 'POST', body: JSON.stringify({ ids }) });
          if (!rr.ok) { toast(rr.motivo || 'No se pudo quitar', 'bad'); return; }
          cerrarCmp();
          toast(`🚫 ${rr.quitados || 0} libro(s) sin editorial${rr.editorialBorrada ? ' · editorial vaciada y borrada' : ''}`);
          editorialesBuscar();
        } catch (e) { toast('Error: ' + e.message, 'bad'); }
      };
    // Reclasificar la editorial de los libros SELECCIONADOS (cascada fichero→OL→Google→IA opcional).
    if ($('#ediSelReclas'))
      $('#ediSelReclas').onclick = () => {
        if (!_ediFichaSel.size) { toast('Selecciona al menos un libro', 'warn'); return; }
        reclasificarEditorialLote([..._ediFichaSel], `🏢 ${nombreEd} · ${_ediFichaSel.size} sel.`, () => { cerrarCmp(); editorialesBuscar(); });
      };
    // EXPLOTAR: liberar TODOS sus libros (quedan sin editorial) y borrar la editorial.
    if ($('#ediExplotar'))
      $('#ediExplotar').onclick = async () => {
        if (!confirm(`¿EXPLOTAR la editorial «${nombreEd}»?\n\nSus ${libros.length} libro(s) quedarán SIN editorial y la editorial se BORRARÁ.\n\nNo se pierde ningún libro (solo se les quita la referencia; podrás reclasificarlos después). Distinto de fusionar (que los reasigna).`)) return;
        try {
          const rr = await api('/editoriales/' + encodeURIComponent(id) + '/explotar', { method: 'POST', body: JSON.stringify({}) });
          if (!rr.ok) { toast(rr.motivo || 'No se pudo explotar', 'bad'); return; }
          cerrarCmp();
          toast(`💥 «${rr.nombre || nombreEd}» explotada · ${rr.liberados || 0} libro(s) liberados`);
          editorialesBuscar();
        } catch (e) { toast('Error: ' + e.message, 'bad'); }
      };
  }
}

// LOGO de la editorial — subir desde archivo. Gemelo de autorSubirFoto. El logo anterior no se borra: se
// conserva en `logos[]` y solo cambia cuál es el principal.
async function editorialSubirLogo(id, inp) {
  const f = inp && inp.files && inp.files[0];
  if (inp) inp.value = '';
  if (!f) return;
  const msg = $('#ediMsg');
  if (msg) msg.textContent = 'Subiendo logo…';
  try {
    const base64 = await fileADataURL(await reducirImagen(f));
    const r = await api('/editoriales/' + encodeURIComponent(id) + '/logo', { method: 'POST', body: JSON.stringify({ base64 }) });
    if (!r.ok) { toast(r.motivo || 'No se pudo guardar el logo', 'bad'); return; }
  } catch (e) {
    if (msg) msg.textContent = 'Error: ' + e.message;
    return;
  }
  toast('📷 Logo guardado');
  editorialFicha(id); // recargar la ficha para verlo
}

// LOGO desde una imagen de uno de sus libros (portada o interior). Después se puede recortar en el editor de
// imágenes de la ficha del documento. Gemelo de autorFotoDeObras.
async function editorialLogoDeLibro(id) {
  let r;
  try { r = await api('/editoriales/' + encodeURIComponent(id) + '/imagenes-libros'); }
  catch (e) { toast(e.message, 'bad'); return; }
  const obras = (r && r.obras) || [];
  if (!obras.length) { toast('Sus libros no tienen imágenes', 'warn'); return; }
  const bloques = obras.map((o) => `
    <div style="margin-bottom:10px">
      <div class="muted" style="font-size:11px;margin-bottom:4px">${esc(recortar(o.titulo || '—', 60))}</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(72px,1fr));gap:6px">
        ${o.imagenes.map((u) => `<img data-logo="${esc(u)}" src="${esc(encUrl(u))}" loading="lazy" style="width:100%;height:96px;object-fit:cover;border-radius:6px;background:var(--card);cursor:pointer;border:2px solid transparent">`).join('')}
      </div>
    </div>`).join('');
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:600px;max-height:88vh;overflow:auto">
    <h3 style="margin-top:0">🖼️ Elegir logo de un libro</h3>
    <div class="muted" style="font-size:12px;margin-bottom:10px">Toca una imagen (portada o interior) de sus libros para usarla como logo. Luego podrás recortarla en el editor de imágenes.</div>
    ${bloques}
    <div class="row" style="justify-content:flex-end;margin-top:10px"><button class="btn" id="eloX">Volver a la ficha</button></div>
    <div id="eloMsg" class="muted" style="font-size:12px;margin-top:6px"></div>
  </div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#eloX').onclick = () => editorialFicha(id);
  $('#cmpScrim').onclick = cerrarCmp;
  $$('#cmpModal [data-logo]').forEach((im) => (im.onclick = async () => {
    const msg = $('#eloMsg');
    if (msg) msg.textContent = 'Guardando logo…';
    try {
      // La imagen vive en /recursos: se descarga, se reduce y se sube como base64 (mismo endpoint que el archivo).
      const resp = await fetch(encUrl(im.dataset.logo));
      if (!resp.ok) throw new Error('no se pudo leer la imagen');
      const base64 = await fileADataURL(await reducirImagen(new File([await resp.blob()], 'logo.jpg', { type: 'image/jpeg' })));
      const rr = await api('/editoriales/' + encodeURIComponent(id) + '/logo', { method: 'POST', body: JSON.stringify({ base64 }) });
      if (!rr.ok) { if (msg) msg.textContent = rr.motivo || 'No se pudo guardar'; return; }
    } catch (e) {
      if (msg) msg.textContent = 'Error: ' + e.message;
      return;
    }
    toast('🖼️ Logo guardado');
    editorialFicha(id);
  }));
}

async function editorialGuardar(id) {
  const val = (sel) => ($(sel) ? $(sel).value : undefined); // sin el campo en el DOM → no se envía la clave
  const cambios = {
    nombre: ($('#ediNombre') && $('#ediNombre').value) || '',
    nombres_alternativos: (($('#ediAlt') && $('#ediAlt').value) || '')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean),
    ciudad: val('#ediCiudad'),
    pais: val('#ediPais'),
    fecha_fundacion: val('#ediFundacion'),
    fecha_disolucion: val('#ediDisolucion'),
    descripcion: val('#ediDesc'),
  };
  const msg = $('#ediMsg');
  if (msg) msg.textContent = 'Guardando…';
  let r;
  try {
    r = await api('/editoriales/' + encodeURIComponent(id) + '/editar', { method: 'POST', body: JSON.stringify(cambios) });
  } catch (e) {
    if (msg) msg.textContent = 'Error: ' + e.message;
    return;
  }
  cerrarCmp();
  toast('✔ Editorial guardada' + ((r && r.avisos || []).length ? ' · ' + r.avisos.join('; ') : ''));
  editorialesBuscar();
}

// RECLASIFICADOR de la EDITORIAL de una selección de libros. Flujo: opt-in de IA → DRY-RUN en 2º plano con
// progreso → INFORME por transición → aplicar. Lanzable desde el Catálogo (selección) y desde la ficha de
// editorial (libros seleccionados). `alAplicar` (opcional) se llama tras aplicar con éxito; si no se pasa,
// refresca el Catálogo. Respeta [[minimize-ai-ingestion]]: la IA es opt-in y último recurso.
const FUENTE_ETQ = { fichero: 'Fichero', openlibrary: 'OpenLibrary', google: 'Google', ia: 'IA' };
async function reclasificarEditorialLote(ids, etiqueta, alAplicar) {
  if (!ids || !ids.length) { toast('Selecciona al menos un libro', 'warn'); return; }
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:560px;max-height:88vh;overflow:auto">
    <h3 style="margin-top:0">🏢 Reclasificar editorial</h3>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Se buscará la editorial correcta de <b>${ids.length}</b> libro(s) en cascada: <b>Fichero local → OpenLibrary → Google Books</b>. Verás un informe por transición ANTES de aplicar nada.${etiqueta ? ` <span style="opacity:.8">(${esc(etiqueta)})</span>` : ''}</div>
    <label style="display:flex;gap:8px;align-items:flex-start;font-size:13px;margin:8px 0">
      <input type="checkbox" id="reclasIA" style="margin-top:2px">
      <span>Usar <b>IA (visión sobre la portada)</b> como ÚLTIMO recurso si las fuentes gratuitas no resuelven. Más lento y con coste; por defecto <b>no</b>.</span>
    </label>
    <div id="reclasProg" class="muted" style="font-size:12px;margin-top:8px"></div>
    <div id="reclasInforme" style="margin-top:8px"></div>
    <div class="row" style="gap:8px;margin-top:12px;justify-content:flex-end" id="reclasBotones">
      <button class="btn pri" id="reclasStart">Empezar</button>
      <button class="btn" id="reclasX">Cancelar</button>
    </div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  let vivo = true;
  const cerrar = () => { vivo = false; cerrarCmp(); };
  $('#cmpScrim').onclick = cerrar;
  $('#reclasX').onclick = cerrar;

  // Pinta el informe agregado + el botón Aplicar (o solo Cerrar si no hay cambios que proponer).
  const pintarInforme = (inf) => {
    if (!inf) { $('#reclasInforme').innerHTML = '<div class="muted">Sin informe.</div>'; return; }
    const trans = (inf.transiciones || []).map((t) =>
      `<div style="padding:5px 0;border-bottom:1px solid var(--line)"><b>${t.n}</b> libro(s): «${esc(t.de)}» → «${esc(t.a)}» <span class="muted" style="font-size:11px">· ${(t.fuentes || []).map((f) => FUENTE_ETQ[f] || f).join(', ')}</span></div>`).join('');
    const elim = (inf.eliminados || []).map((e) =>
      `<div style="padding:5px 0;border-bottom:1px solid var(--line)"><b>${e.n}</b> libro(s) quitados de «${esc(e.de)}» (quedan sin editorial)</div>`).join('');
    const hayCambios = (inf.cambios || 0) + (inf.eliminadosTotal || 0) > 0;
    $('#reclasInforme').innerHTML = `<div style="font-size:13px">
        ${trans}${elim}
        ${!hayCambios ? '<div class="muted">No hay cambios que proponer (todo está bien o no se pudo resolver).</div>' : ''}
        <div class="muted" style="font-size:12px;margin-top:8px">Sin cambio: ${inf.sinCambio || 0} · No resueltos: ${(inf.noResueltos || []).length} · Total: ${inf.total || 0}${inf.usarIA ? ' · IA activada' : ''}</div>
      </div>`;
    $('#reclasBotones').innerHTML = `${hayCambios ? '<button class="btn pri" id="reclasAplicar">✅ Aplicar cambios</button>' : ''}<button class="btn" id="reclasCerrar">Cerrar</button>`;
    $('#reclasCerrar').onclick = cerrar;
    if ($('#reclasAplicar'))
      $('#reclasAplicar').onclick = async () => {
        $('#reclasAplicar').disabled = true;
        $('#reclasProg').textContent = 'Aplicando…';
        try {
          const r = await api('/editoriales/reclasificar/aplicar', { method: 'POST', body: JSON.stringify({}) });
          if (!r.ok) { $('#reclasProg').textContent = r.motivo || 'No se pudo aplicar'; $('#reclasAplicar').disabled = false; return; }
          vivo = false;
          cerrarCmp();
          toast(`🏢 ${r.cambios || 0} reclasificado(s)${r.eliminadosTotal ? ` · ${r.eliminadosTotal} sin editorial` : ''}${r.creadas ? ` · ${r.creadas} editorial(es) nueva(s)` : ''}`);
          if (typeof alAplicar === 'function') alAplicar();
          else buscarCatalogo(1);
        } catch (e) { $('#reclasProg').textContent = 'Error: ' + e.message; $('#reclasAplicar').disabled = false; }
      };
  };

  // Sondea el estado del dry-run (2º plano) hasta que esté 'listo' (o error).
  const poll = async () => {
    if (!vivo) return;
    let est;
    try { est = await api('/editoriales/reclasificar/estado'); } catch { setTimeout(poll, 1200); return; }
    if (est.fase === 'buscando') {
      $('#reclasProg').textContent = `Buscando editoriales… ${est.hechos || 0}/${est.total || ids.length}`;
      setTimeout(poll, 1000);
    } else if (est.fase === 'error') {
      $('#reclasProg').textContent = 'Error: ' + (est.error || 'desconocido');
    } else if (est.fase === 'listo') {
      $('#reclasProg').textContent = '';
      pintarInforme(est.informe);
    } else {
      setTimeout(poll, 1000); // 'inactivo'/'aplicado': esperar a que arranque el nuestro
    }
  };

  $('#reclasStart').onclick = async () => {
    const usarIA = !!($('#reclasIA') && $('#reclasIA').checked);
    $('#reclasStart').disabled = true;
    $('#reclasProg').textContent = 'Lanzando…';
    try {
      const r = await api('/editoriales/reclasificar', { method: 'POST', body: JSON.stringify({ ids, usarIA }) });
      if (!(r.ok && r.lanzado)) { $('#reclasProg').textContent = r.motivo || 'No se pudo lanzar'; $('#reclasStart').disabled = false; return; }
    } catch (e) { $('#reclasProg').textContent = 'Error: ' + e.message; $('#reclasStart').disabled = false; return; }
    poll();
  };
}

// Overlay reutilizable para elegir OTRA editorial (fusión): busca por nombre y llama onPick(id, nombre).
function elegirEditorialOverlay(excluir, titulo, subtitulo, onPick) {
  const ov = document.createElement('div');
  ov.style.cssText = 'position:fixed;inset:0;z-index:2000;background:rgba(0,0,0,.55);display:grid;place-items:center;padding:16px';
  ov.innerHTML = `<div class="box card" style="max-width:460px;width:94vw;max-height:82vh;overflow:auto">
      <h3 style="margin-top:0">${esc(titulo)}</h3>
      <div class="muted" style="font-size:12px;margin-bottom:8px">${esc(subtitulo)}</div>
      <input id="fusBuscar" placeholder="Buscar editorial por nombre…" autocomplete="off" style="width:100%;box-sizing:border-box">
      <div id="fusRes" class="muted" style="margin-top:10px;max-height:46vh;overflow:auto;font-size:13px">Escribe para buscar…</div>
      <div style="margin-top:12px;text-align:right"><button class="btn" id="fusX">Cancelar</button></div>
    </div>`;
  document.body.appendChild(ov);
  const cerrar = () => ov.remove();
  ov.onclick = (e) => {
    if (e.target === ov) cerrar();
  };
  ov.querySelector('#fusX').onclick = cerrar;
  const inp = ov.querySelector('#fusBuscar'),
    res = ov.querySelector('#fusRes');
  inp.focus();
  let t;
  const buscar = async () => {
    const q = inp.value.trim();
    if (q.length < 2) {
      res.textContent = 'Escribe al menos 2 letras…';
      return;
    }
    res.textContent = 'Buscando…';
    try {
      const r = await api('/editoriales?q=' + encodeURIComponent(q) + '&limite=40');
      const cand = (r.editoriales || []).filter((x) => String(x._id) !== String(excluir));
      if (!cand.length) {
        res.textContent = 'Sin resultados.';
        return;
      }
      res.innerHTML = cand
        .map(
          (x) =>
            `<button type="button" class="btn fusPick" data-id="${esc(x._id)}" data-nom="${esc(x.nombre)}" style="display:block;width:100%;text-align:left;margin-top:5px">${esc(x.nombre)} <span class="muted">· ${x.n_libros || 0} libro(s)</span></button>`,
        )
        .join('');
      res.querySelectorAll('.fusPick').forEach(
        (b) =>
          (b.onclick = async () => {
            try {
              await onPick(b.dataset.id, b.dataset.nom);
              cerrar();
            } catch (e) {
              toast('Error: ' + e.message, 'bad');
            }
          }),
      );
    } catch (e) {
      res.textContent = 'Error: ' + e.message;
    }
  };
  inp.oninput = () => {
    clearTimeout(t);
    t = setTimeout(buscar, 300);
  };
}

const loaders = {
  dashboard: loadDashboard,
  activity: loadActivity,
  cuar: loadCuar,
  pap: loadPap,
  obras: loadObras,
  colecciones: loadColecciones,
  autores: loadAutores,
  editoriales: loadEditoriales,
  ubic: loadUbic,
  inbox: loadInbox,
  search: loadSearch,
};

// ── auth ──
let estadoTimer = null;
// Enlace profundo ?doc=<id>: lo lee una etiqueta NFC grabada por nosotros (Android Chrome) y también
// un iPhone que abre la URL en Safari. Se captura ANTES de que autoLoginURL limpie la query, y se
// aplica al final de arrancar() (tras autenticar) abriendo la ficha.
let _deepDoc = null,
  _deepUbic = null,
  _deepOff = null,
  _compartido = false;
function abrirEnlaceProfundo() {
  try {
    history.replaceState(null, '', location.pathname);
  } catch (_) {}
  if (_deepDoc) {
    const id = _deepDoc;
    _deepDoc = null;
    _deepUbic = null;
    return verDoc(id, { volver: 'search', etiqueta: 'Catálogo' });
  }
  // Etiqueta de estantería (?amb=&est=) → abrir sus libros en el Catálogo (disponible para invitados).
  if (_deepUbic) {
    const { amb, est } = _deepUbic;
    _deepUbic = null;
    verEstanteriaEnCatalogo(amb, est);
  }
}
// ¿Procesar lo compartido al instante? Interruptor persistente (localStorage). Por defecto SÍ.
let compartidosPendientes = [];
const autoCompartir = () => {
  const sw = $('#inAutoCompartir');
  return sw ? sw.checked : localStorage.getItem('auto_compartir') !== '0';
};
// SHARE TARGET (Task 1): al compartir ficheros a la PWA, el service worker los guarda en una Cache y
// redirige a /?compartido=1. Aquí los recogemos y, según el interruptor: los subimos al instante
// (honra «Supervisado») o los dejamos EN ESPERA para añadir datos y pulsar Procesar. Solo admin.
async function procesarCompartidos() {
  if (!_compartido) return;
  _compartido = false;
  if (ROL !== 'admin') {
    toast('Solo un administrador puede dar de alta lo compartido', 'warn');
    return;
  }
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('compartidos-v1');
    const idx = await cache.match('/__shared__/index.json');
    if (!idx) {
      toast('No llegó nada que compartir', 'warn');
      return;
    }
    const metas = await idx.json();
    const files = [];
    for (const m of metas || []) {
      const r = await cache.match('/__shared__/' + m.i);
      if (!r) continue;
      const b = await r.blob();
      files.push(new File([b], m.nombre || 'compartido-' + m.i, { type: m.type || b.type }));
    }
    for (const k of await cache.keys()) await cache.delete(k); // vaciar tras leer
    if (!files.length) return;
    go('inbox');
    if (autoCompartir()) {
      toast(`📥 Recibido(s) ${files.length} fichero(s) compartido(s)`);
      subirInbox(files);
    } else {
      compartidosPendientes = files;
      toast(`📥 ${files.length} fichero(s) en espera: añade datos y pulsa Procesar`);
      pintarCompartidosPendientes();
    }
  } catch (e) {
    toast('No se pudo procesar lo compartido: ' + e.message, 'bad');
  }
}
// Panel de lo compartido EN ESPERA: deja añadir ISBN/colección/ubicación arriba y procesar (o descartar).
function pintarCompartidosPendientes() {
  const out = $('#inboxResults');
  if (!out) return;
  if (!compartidosPendientes.length) {
    out.innerHTML = '';
    return;
  }
  out.innerHTML = `<div class="card" style="border-color:rgba(120,160,255,.35)"><h3 style="margin-top:0">📥 ${compartidosPendientes.length} fichero(s) compartido(s) en espera</h3>
    <p class="muted" style="font-size:12px;margin:0 0 10px">Añade arriba ISBN/colección/ubicación si quieres y pulsa Procesar.</p>
    <div style="display:flex;gap:10px"><button class="btn pri" id="shProc">▶ Procesar</button><button class="btn" id="shDesc">Descartar</button></div></div>`;
  $('#shProc').onclick = () => {
    const f = compartidosPendientes.slice();
    compartidosPendientes = [];
    subirInbox(f);
  };
  $('#shDesc').onclick = () => {
    compartidosPendientes = [];
    out.innerHTML = '';
    toast('Descartado');
  };
}
// Registrar el service worker (necesario para el share target + instalación como PWA). Best-effort.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
// Rellena el desplegable de usuarios del login (sin contraseñas; de /api/usuarios).
async function cargarUsuariosLogin() {
  try {
    const r = await fetch('/api/usuarios').then((x) => x.json());
    const sel = $('#lgUser');
    if (!sel) return;
    sel.innerHTML =
      (r.usuarios || [])
        .map(
          (u) =>
            `<option value="${esc(u.user)}">${esc(u.user)}${u.rol === 'admin' ? ' · admin' : ''}</option>`,
        )
        .join('') || '<option value="">—</option>';
  } catch {}
}
const tokenDeCookie = () => {
  const m = document.cookie.match(/(?:^|;\s*)panel_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
};
const limpiarCookieToken = () => {
  document.cookie = 'panel_token=; Max-Age=0; path=/';
};
// AUTO-LOGIN POR URL (robusto): https://host/?u=USUARIO&p=CONTRASEÑA  (también ?user=&pwd=).
// La query la lee JS directamente, así que NO depende de la cabecera Basic (que DSM/el proxy inverso
// se comen en :4443) ni cachea credenciales en el navegador (lo que dejaba el desplegable bloqueado).
// Tras intentarlo, LIMPIA las credenciales de la barra/historial pase lo que pase.
async function autoLoginURL() {
  const q = new URLSearchParams(location.search);
  const u = q.get('u') || q.get('user'),
    p = q.get('p') || q.get('pwd');
  const limpiar = () => history.replaceState(null, '', location.pathname + location.hash);
  if (!u || !p) return false;
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: u, password: p }),
    }).then((x) => x.json());
    limpiar();
    if (r && r.ok) {
      TOKEN = r.token;
      USER = r.usuario;
      ROL = r.rol;
      localStorage.setItem('panel_token', TOKEN);
      return true;
    }
  } catch {
    limpiar();
  }
  return false;
}
function mostrarLogin() {
  TOKEN = '';
  ROL = null;
  localStorage.removeItem('panel_token');
  cargarUsuariosLogin();
  $('#login').classList.add('show');
  if (estadoTimer) clearInterval(estadoTimer);
}
function aplicarRol() {
  document.body.classList.toggle('guest', ROL === 'guest');
  $('#who').textContent = USER || '';
  $('#rol').textContent = ROL || '';
  $('#rol').className = 'rol ' + (ROL || '');
}
function bannerOffline() {
  let b = document.getElementById('offBanner');
  if (!b) {
    b = document.createElement('div');
    b.id = 'offBanner';
    b.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:400;background:#7a5c00;color:#fff;text-align:center;font-size:13px;padding:6px 10px;box-shadow:0 1px 6px rgba(0,0,0,.4)';
    b.innerHTML = '📴 Sin conexión — acerca una etiqueta NFC para ver su ficha offline';
    document.body.appendChild(b);
  }
}
function arrancar() {
  $('#login').classList.remove('show');
  aplicarRol();
  iniciarHistorial();
  // Sin red: si la etiqueta que abrió la app ya trae los datos offline en la URL (?o=), mostramos su Ficha
  //   mínima DIRECTAMENTE (sin segunda lectura). Si no (etiqueta antigua sin ?o=), pantalla de espera + escaneo.
  if (APP_OFFLINE) {
    if (_deepOff) {
      const off = _parseOffline(_b64uDec(_deepOff));
      if (off) {
        mostrarOfflineNFC(off, null);
        return;
      }
    }
    pantallaEsperaNFC();
    return;
  }
  cargarUbicaciones();
  go('search');
  abrirEnlaceProfundo();
  procesarCompartidos();
  refrescarEstado();
  if (estadoTimer) clearInterval(estadoTimer);
  estadoTimer = setInterval(refrescarEstado, 8000);
}
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#lgErr').textContent = '';
  try {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: $('#lgUser').value.trim(), password: $('#lgPass').value }),
    });
    const j = await r.json();
    if (!r.ok || !j.ok) throw new Error(j.motivo || 'usuario o contraseña incorrectos');
    TOKEN = j.token;
    USER = j.usuario;
    ROL = j.rol;
    localStorage.setItem('panel_token', TOKEN);
    _recordarSesion();
    $('#lgPass').value = '';
    arrancar();
  } catch (err) {
    $('#lgErr').textContent = err.message;
  }
};
// Recuerda usuario/rol para poder ARRANCAR sin red (NFC offline). El logout sí los borra.
function _recordarSesion() {
  try {
    localStorage.setItem('panel_user', USER || '');
    localStorage.setItem('panel_rol', ROL || '');
  } catch (_) {}
}
$('#logout').onclick = async () => {
  try {
    await api('/logout', { method: 'POST' });
  } catch {}
  try {
    localStorage.removeItem('panel_user');
    localStorage.removeItem('panel_rol');
  } catch (_) {}
  mostrarLogin();
};
// sesión inicial: token guardado, o el sembrado por auto-login de URL (cookie), o mostrar el login
(async () => {
  // 0a) VISTA COMPARTIDA (?s=<token>): página autónoma de SOLO esa ficha (sin login ni resto de la app).
  try {
    const sp = new URLSearchParams(location.search).get('s');
    if (sp) {
      await vistaCompartida(sp);
      return;
    }
  } catch (_) {}
  // 0b) Captura los enlaces profundos (?doc=<id> de un libro, ?amb=&est= de una estantería) ANTES de que
  //    autoLoginURL limpie la query.
  try {
    const qp = new URLSearchParams(location.search);
    _deepDoc = qp.get('doc') || null;
    _deepOff = qp.get('o') || null;
    _compartido = qp.get('compartido') === '1';
    const amb = qp.get('amb');
    if (amb) _deepUbic = { amb, est: qp.get('est') || '' };
  } catch (_) {}
  // 1) Credenciales en la query (?u=&p=): forma robusta, atraviesa DSM/proxy. Prioritaria.
  if (await autoLoginURL()) return arrancar();
  // 2) Cookie sembrada por la cabecera Basic (https://user:pwd@host): solo si llega a la app (acceso
  //    directo; vía DSM:4443 normalmente NO). Tiene prioridad sobre un token viejo de localStorage.
  const ck = tokenDeCookie();
  if (ck) {
    TOKEN = ck;
    localStorage.setItem('panel_token', TOKEN);
    limpiarCookieToken();
  }
  if (!TOKEN) {
    // Etiqueta de un LIBRO abierta por alguien SIN sesión (típicamente quien lo ENCONTRÓ): en vez del login,
    // se muestra la tarjeta PÚBLICA de propiedad + contacto para devolverlo (datos offline de la propia
    // etiqueta, ?o=). El propietario tiene un botón «Entrar». Sin ?o= (o ilegible) → login normal.
    if (_deepOff) {
      try { const off = _parseOffline(_b64uDec(_deepOff)); if (off) return mostrarRetornoPublico(off); } catch (_) {}
    }
    return mostrarLogin();
  }
  try {
    const me = await fetch('/api/yo', { headers: { Authorization: 'Bearer ' + TOKEN } }).then((r) =>
      r.json(),
    );
    if (me && me.rol) {
      USER = me.usuario;
      ROL = me.rol;
      _recordarSesion();
      arrancar();
    } else mostrarLogin();
  } catch {
    // SIN RED al validar: si hay token + rol recordado, ARRANCA igualmente (modo offline → leer NFC sin
    // servidor). No se borra el token; cuando vuelva la red, todo opera normal.
    const rol = localStorage.getItem('panel_rol');
    if (TOKEN && rol) {
      USER = localStorage.getItem('panel_user') || '';
      ROL = rol;
      APP_OFFLINE = true;
      arrancar();
    } else mostrarLogin();
  }
})();
