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
const titles = {
  dashboard: 'Dashboard',
  activity: 'Actividad',
  cuar: 'Cuarentena',
  pap: 'Papelera',
  obras: 'Obras',
  colecciones: 'Colecciones',
  autores: 'Autores',
  inbox: 'Inbox',
  search: 'Búsqueda',
};
let logTimer = null; // intervalo de refresco de los logs en vivo (solo activo en la página Actividad)

// Cambia de página: marca el botón de nav, muestra su <section>, ajusta el título, carga sus datos
// (loaders[pagina]) y apila la vista en el historial (para el botón atrás del móvil).
function go(pagina) {
  detalle = null;
  $$('#nav button').forEach((boton) => boton.classList.toggle('on', boton.dataset.p === pagina));
  $$('.page').forEach((seccion) => seccion.classList.remove('on'));
  $('#p-' + pagina).classList.add('on');
  $('#title').textContent = titles[pagina] || pagina;
  if (logTimer && pagina !== 'activity') {
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
      ${rowN('Libros sin ISBN', def.libros_sin_isbn, 'mut', 'sin_isbn', 'Libros sin ISBN')}${rowN('Sin hash', def.sin_hash, 'mut', 'sin_hash', 'Sin hash')}
      ${rowN('Sin portada', def.sin_portada, 'mut', 'sin_portada', 'Sin portada')}${rowN('CDU genérica', def.cdu_generica, 'mut', 'cdu_generica', 'CDU genérica')}
      ${rowN('Pendientes', def.pendientes, def.pendientes ? 'warn' : 'ok', 'pendientes', 'Pendientes')}${rowN('Sin colección', def.sin_coleccion, 'mut', 'sin_coleccion', 'Sin colección')}</table>`;
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
      ? `<a class="cntclas" data-filtro="${esc(filtro)}" data-etq="${esc(etqFiltro || filtro)}" title="Ver estos documentos en la Búsqueda">${badge}</a>`
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
  $('#cmpScrim').style.display = 'none';
  $('#cmpModal').style.display = 'none';
  $('#cmpModal').innerHTML = '';
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
      <td style="text-align:right"><button class="btn" data-ver="${esc(sub.nombre)}">ver</button> <button class="btn bad admin-only" data-del="${esc(sub.nombre)}">vaciar</button></td></tr>`,
      )
      .join('')}</table>`
      : '<div class="empty">Papelera vacía</div>';
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
const shelf = { obra: { items: [], sel: new Set() }, coleccion: { items: [], sel: new Set() } };
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
  const chk = `<input type="checkbox" class="shelfchk admin-only" data-id="${esc(x._id)}"${sel ? ' checked' : ''}>`;
  const req =
    esObra && x.isbn_obra
      ? ` <button class="rbtn shreq admin-only" data-req="${esc(x._id)}" title="Re-consultar título/sinopsis por ISBN">↻</button>`
      : '';
  return `<div class="vol${sel ? ' sel' : ''}" data-${kind}="${esc(x._id)}" data-nombre="${esc((nombre || '').toLowerCase())}">${chk}<div class="cov">${cov}</div><div class="meta"><div class="n">${esc(recortar(nombre || '—', 60))}${x.nsfw ? ' 🔞' : ''}${req}</div><div class="t">${estado}</div><div style="margin-top:5px">${ratingBar(esObra ? 'obras' : 'colecciones', x._id, x.valoracion, x.nsfw)}</div></div></div>`;
}
function pintarShelf(kind) {
  const cont = kind === 'obra' ? $('#obrasBody') : $('#colsBody');
  if (!cont) return;
  const st = shelf[kind];
  cont.innerHTML = `<div class="row" style="margin-bottom:10px"><input id="shf_${kind}" placeholder="🔍 filtrar por nombre…" autocomplete="off" style="flex:1"></div>
    <div id="shbulk_${kind}"></div>
    ${st.items.length ? `<div class="vol-grid">${st.items.map((x) => shelfCard(kind, x)).join('')}</div>` : `<div class="empty">Sin ${kind === 'obra' ? 'obras' : 'colecciones'}</div>`}`;
  const fi = $('#shf_' + kind);
  if (fi)
    fi.oninput = () => {
      const q = fi.value.toLowerCase();
      $$(`#${cont.id} .vol[data-${kind}]`).forEach((c) => {
        c.style.display = (c.dataset.nombre || '').includes(q) ? '' : 'none';
      });
    };
  $$(`#${cont.id} .vol[data-${kind}]`).forEach(
    (el) =>
      (el.onclick = () => {
        kind === 'obra' ? verObra(el.dataset.obra) : verColeccion(el.dataset.coleccion);
      }),
  );
  $$(`#${cont.id} .shelfchk`).forEach((cb) => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      cb.checked ? st.sel.add(cb.dataset.id) : st.sel.delete(cb.dataset.id);
      const c = cb.closest('.vol');
      if (c) c.classList.toggle('sel', cb.checked);
      renderShelfBulk(kind);
    };
  });
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
    enSel = ids.filter((id) => st.sel.has(id)).length;
  const acc = st.sel.size
    ? `<span style="margin-left:auto"></span><b>${st.sel.size}</b> sel.
    ${st.sel.size >= 2 ? `<button class="btn pri" id="shMerge">⛙ Fusionar</button>` : ''}
    <button class="btn" id="shExpl">💥 Explotar</button>
    <button class="btn bad" id="shDel">🗑 Eliminar vacías</button>
    <button class="btn" id="shClr">Limpiar</button>`
    : '';
  el.innerHTML = `<div class="bulkbar"><label style="display:flex;gap:7px;align-items:center;cursor:pointer"><input type="checkbox" id="shAll" style="width:18px;height:18px;accent-color:var(--acc)"> Seleccionar todas</label>${acc}</div>`;
  const all = $('#shAll');
  all.checked = enSel > 0 && enSel === ids.length;
  all.indeterminate = enSel > 0 && enSel < ids.length;
  all.onchange = () => {
    const on = all.checked;
    ids.forEach((id) => (on ? st.sel.add(id) : st.sel.delete(id)));
    $$(`#${cont.id} .shelfchk`).forEach((cb) => (cb.checked = on));
    $$(`#${cont.id} .vol`).forEach((c) => c.classList.toggle('sel', on));
    renderShelfBulk(kind);
  };
  if (st.sel.size) {
    const mg = $('#shMerge');
    if (mg) mg.onclick = () => shelfFusionar(kind);
    $('#shExpl').onclick = () => shelfExplotar(kind);
    $('#shDel').onclick = () => shelfEliminar(kind);
    $('#shClr').onclick = () => {
      st.sel.clear();
      $$(`#${cont.id} .shelfchk`).forEach((cb) => (cb.checked = false));
      $$(`#${cont.id} .vol.sel`).forEach((c) => c.classList.remove('sel'));
      renderShelfBulk(kind);
    };
  }
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
  return `<div class="vol" data-doc="${esc(d._id)}"><div class="cov">${cov}${nfcBadge(d)}</div><div class="meta"><div class="n">Tomo ${numero ?? '?'} ${fmt}${badgesDoc(d)}</div><div class="t">${esc(d.volumen_titulo || d.titulo || '—')}</div></div></div>`;
}

function pintarObra(r) {
  const o = r.obra,
    desc = o.cdu_desc;
  const sub =
    [o.isbn_obra ? 'ISBN obra ' + o.isbn_obra : '', o.editorial, o.coleccion]
      .filter(Boolean)
      .map(esc)
      .join(' · ') || '—';
  const head = `<div class="crumb"><a onclick="go('obras')">Obras</a> › <span>${esc(recortar(o.titulo, 50))}</span></div>
    <div class="det-head"><button class="det-back" title="Volver" onclick="volverAtras()">←</button>
      <div class="det-title"><h2>${esc(o.titulo || '(sin título)')}</h2><div class="sub">${sub}</div>
        <div style="margin-top:8px">${o.completa ? '<span class="tag ok">completa</span>' : '<span class="tag warn">incompleta</span>'} ${o.revision_requerida ? '<span class="tag bad">revisar</span>' : ''} <span class="muted">${o.volumenes_presentes || 0} presentes · ${Math.max(0, (o.total_volumenes || 0) - (o.volumenes_presentes || 0))} ausentes · ${o.total_volumenes || '?'} total</span></div>
        <div style="margin-top:8px">${ratingBar('obras', o._id, o.valoracion, o.nsfw)}</div>
        ${o.cdu ? `<div class="mono muted" style="margin-top:8px">CDU ${esc(o.cdu)}${desc && desc.titulo_es ? ' · ' + esc(desc.titulo_es) : ''}</div>` : ''}
        ${desc && desc.descripcion_es ? `<details style="margin-top:6px"><summary class="muted" style="cursor:pointer;font-size:12px">Descripción CDU</summary><p class="muted" style="font-size:12px;margin-top:6px">${esc(desc.descripcion_es)}</p></details>` : ''}
      </div></div>`;
  const vols = r.volumenes.length
    ? r.volumenes.map((v) => tomoCard(v.doc, v.numero, !v.presente)).join('')
    : '<div class="empty">Sin tomos registrados</div>';
  const sin =
    r.sin_numero && r.sin_numero.length
      ? `<div class="card" style="margin-top:14px"><h3 style="color:var(--warn)">Tomos sin número (${r.sin_numero.length})</h3><div class="vol-grid">${r.sin_numero.map((d) => tomoCard(d, '?', false)).join('')}</div></div>`
      : '';
  $('#p-detalle').innerHTML =
    head + `<div class="card"><h3>Tomos</h3><div class="vol-grid">${vols}</div></div>` + sin;
  $$('#p-detalle .vol[data-doc]').forEach(
    (el) => (el.onclick = () => verDoc(el.dataset.doc, { obra: { _id: o._id, titulo: o.titulo } })),
  );
  attachRating('#p-detalle');
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

function miembroCard(d, etiqueta) {
  const cov = d.portada
    ? `<img src="${esc(encUrl(d.portada))}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=ph>📕</div>'">`
    : '<div class="ph">📕</div>';
  const fmt = (d.formatos || [])
    .slice(0, 3)
    .map((f) => `<span class="fmt">${esc(f)}</span>`)
    .join('');
  return `<div class="vol" data-doc="${esc(d._id)}"><div class="cov">${cov}${nfcBadge(d)}</div><div class="meta"><div class="n">${esc(etiqueta || '')} ${fmt}${badgesDoc(d)}</div><div class="t">${esc(d.titulo || '—')}</div></div></div>`;
}

function pintarColeccion(r) {
  const c = r.coleccion,
    desc = c.cdu_desc,
    esRev = c.tipo === 'revista';
  const tipoLabel = esRev ? '📰 Revista (cabecera)' : '📚 Serie de libros';
  const sub = [c.issn ? 'ISSN ' + c.issn : '', c.editorial].filter(Boolean).map(esc).join(' · ') || '—';
  const head = `<div class="crumb"><a onclick="go('colecciones')">Colecciones</a> › <span>${esc(recortar(c.nombre, 50))}</span></div>
    <div class="det-head"><button class="det-back" title="Volver" onclick="volverAtras()">←</button>
      <div class="det-title"><h2>${esc(c.nombre || '(sin título)')}</h2><div class="sub">${tipoLabel} · ${sub}</div>
        <div style="margin-top:8px"><span class="muted">${r.miembros.length} ${esRev ? 'número(s)' : 'libro(s)'}</span> ${c.revision_requerida ? '<span class="tag bad">revisar</span>' : ''}</div>
        <div style="margin-top:8px">${ratingBar('colecciones', c._id, c.valoracion, c.nsfw)}</div>
        ${c.cdu ? `<div class="mono muted" style="margin-top:8px">CDU ${esc(c.cdu)}${desc && desc.titulo_es ? ' · ' + esc(desc.titulo_es) : ''}</div>` : ''}
        ${c.descripcion ? `<p class="muted" style="font-size:12px;margin-top:6px">${esc(c.descripcion)}</p>` : ''}
      </div></div>`;
  const etiq = (d) =>
    esRev
      ? d.clave_numero || (d.año_edicion ? String(d.año_edicion) : '') || 'nº ?'
      : d.coleccion_numero
        ? 'nº ' + d.coleccion_numero
        : '';
  const cards = r.miembros.length
    ? r.miembros.map((d) => miembroCard(d, etiq(d))).join('')
    : `<div class="empty">Sin ${esRev ? 'números' : 'libros'} registrados</div>`;
  $('#p-detalle').innerHTML =
    head +
    `<div class="card"><h3>${esRev ? 'Números' : 'Libros'}</h3><div class="vol-grid">${cards}</div></div>`;
  $$('#p-detalle .vol[data-doc]').forEach(
    (el) => (el.onclick = () => verDoc(el.dataset.doc, { coleccion: { _id: c._id, nombre: c.nombre } })),
  );
  attachRating('#p-detalle');
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
  ['subtitulo', 'Subtítulo'],
  ['_autores', 'Autores'],
  ['_editorial', 'Editorial'],
  ['_coleccion', 'Colección'],
  ['año_edicion', 'Año'],
  ['numero_edicion', 'Edición'],
  ['idioma', 'Idioma'],
  ['_formatos', 'Formatos'],
  ['paginas', 'Páginas'],
  ['_dimensiones', 'Tamaño'],
  ['_isbn', 'ISBN'],
  ['_isbns_alt', 'Otras ediciones'],
  ['_issn', 'ISSN'],
  ['lccn', 'LCCN'],
  ['volumen_numero', 'Volumen nº'],
  ['volumen_titulo', 'Título del volumen'],
  ['obra_titulo', 'Obra'],
  ['_isbn_obra', 'ISBN obra'],
  ['coleccion_numero', 'Nº en colección'],
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
  estadoBusqueda.extra = extra;
  estadoBusqueda.page = 1;
  if ($('#sqQ')) $('#sqQ').value = '';
  if ($('#sqCdu')) $('#sqCdu').value = '';
  go('search');
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
  const especiales = {
    _autores: r.autores && r.autores.length ? r.autores.map(esc).join(', ') : null,
    _editorial: r.editorial ? esc(r.editorial) : null,
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
    _dimensiones:
      d.ancho_cm && d.alto_cm
        ? `${esc(String(d.ancho_cm).replace('.', ','))} × ${esc(String(d.alto_cm).replace('.', ','))} cm`
        : null,
    _ingreso: d.fecha_ingreso ? fmtFecha(d.fecha_ingreso) : null,
    _actualizado: d.fecha_actualizacion ? fmtFecha(d.fecha_actualizacion) : null,
    _ruta: d.ruta_base
      ? (() => {
          const rb = d.ruta_base.replace(/^\/recursos/, '');
          return `<span class="mono">${esc(rb)}</span> <button class="rbtn copybtn" data-copy="${esc(rb)}" title="Copiar la ruta">📋</button>`;
        })()
      : null,
    obra_titulo: r.obra
      ? `<a onclick="verObra('${esc(r.obra._id)}')" class="rowlink">${esc(r.obra.titulo || d.obra_titulo || '(obra)')}</a>`
      : d.obra_titulo
        ? esc(d.obra_titulo)
        : null,
    // Identificadores DRILLABLES: clic → Búsqueda por ese ISSN/ISBN (ve TODO lo que lo comparte — útil
    // para destapar libros mal clasificados colgando de un ISSN de serie, o ediciones del mismo ISBN).
    _issn: d.issn
      ? `<a class="rowlink" data-q="${esc(d.issn)}" title="Ver todo lo que comparte este ISSN">${esc(d.issn)}</a>`
      : null,
    _isbn: d.isbn
      ? `<a class="rowlink" data-q="${esc(d.isbn)}" title="Ver todo lo que comparte este ISBN">${esc(d.isbn)}</a>`
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
  const carrusel = imgs.length
    ? `<div class="carousel" style="position:relative">${nfcOv}<div class="track" id="carTrack">${imgs.map((im) => `<img src="${esc(encUrl(im.ruta))}" loading="lazy" onclick="window.open('${esc(encUrl(im.ruta))}','_blank')">`).join('')}</div>${imgs.length > 1 ? `<button class="cnav prev" onclick="carMove(-1)">‹</button><button class="cnav next" onclick="carMove(1)">›</button><div class="cdots" id="carDots">1 / ${imgs.length}</div>` : ''}</div>`
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
    ['Autor', especiales._autores],
    ['Editorial', especiales._editorial],
    ['Colección', especiales._coleccion],
    ['CDU', d.cdu ? `<span class="mono">${esc(d.cdu)}</span>` : null],
    ['ISBN', especiales._isbn],
    ['ISSN', especiales._issn],
  ]
    .filter((p) => p[1])
    .map((p) => `<dt>${p[0]}</dt><dd>${p[1]}</dd>`)
    .join('');
  const ubicFmin = `<div class="fmin-ubic"><div class="lbl">Ubicación</div><div class="val">${_txtUbic(d) ? `<a class="rowlink" id="ubicChip" style="color:var(--acc)" title="Ver los libros de esta estantería">📍 ${esc(_txtUbic(d))}</a>` : '<span class="muted">Sin asignar</span>'}</div></div>`;
  const fmin = fichaMinima({
    titulo: d.titulo,
    subtitulo: d.subtitulo || subDoc,
    esDigital: !_fisico,
    exlibris: EX_LIBRIS,
    descargaUrl: r.archivo_url ? encUrl(r.archivo_url) : '',
    descargaNombre: r.nombre_archivo || '',
    estrellasHTML: ratingBar('documentos', d._id, d.valoracion, d.nsfw) + ' ' + badgesDoc(d),
    datosHTML: filasFmin,
    ubicacionHTML: ubicFmin,
    origen,
  });
  // Debajo de la ficha, secciones PLEGABLES y colapsadas por defecto (acciones, imágenes, lectura, datos, sinopsis).
  const botones = `<div class="det-acts">
      <button class="fbtn admin-only" id="actEdit" title="Editar los datos a mano (y bloquear para que el Conformador no los cambie)">✏️ Editar</button>
      <button class="fbtn admin-only" id="actImgs" title="Gestionar las imágenes: reordenar, borrar, añadir, rotar/recortar/corregir perspectiva">🖼️ Imágenes</button>
      <button class="fbtn admin-only" id="actMedir" title="Estimar el tamaño físico del libro (cm) sobre la alfombrilla reglada">📐 Medir</button>
      <button class="fbtn admin-only" id="actConf" title="Ejecuta el Conformador solo sobre este documento (portada, re-clasificar CDU, sidecars…)">🧹 Conformar</button>
      <button class="fbtn admin-only" id="actEnr" title="Re-consulta las APIs/IA para mejorar este documento (rellena huecos)">✨ Enriquecer</button>
      <button class="fbtn admin-only" id="actShare" title="Genera un QR/enlace para compartir esta ficha (y su descarga, si es digital)">🔗 Compartir</button>
      <button class="fbtn admin-only" id="actNfc" style="display:none" title="Graba una etiqueta NFC (NTAG215) con esta ficha: al acercar el móvil se abrirá este documento">📶 Grabar NFC</button>
      <button class="fbtn bad admin-only" id="actRepr" title="Devuelve el fichero al Inbox y re-cataloga de cero (recicla la carpeta actual)">♻️ Reprocesar</button>
      <button class="fbtn bad admin-only" id="actDel" title="Borra el documento y su carpeta (sidecars/imágenes → Papelera, recuperable)">🗑 Eliminar</button>
    </div>`;
  const lector = _fisico ? '' : previewArchivo(r);
  const secAcc = `<details class="card foldcard admin-only" style="margin-top:14px"><summary>⚙️ Acciones</summary>${botones}</details>`;
  const secImg = `<details class="card foldcard" open style="margin-top:14px"><summary>🖼️ Imágenes</summary><div style="margin-top:10px">${carrusel}</div></details>`;
  const secLect = lector
    ? `<details class="card foldcard" id="lectDet" open style="margin-top:14px"><summary>📖 Leer / archivo</summary><div style="margin-top:10px">${lector}</div></details>`
    : '';
  const secCat = `<details class="card foldcard" style="margin-top:14px"><summary>📚 Datos catalográficos</summary><div style="margin-top:10px"><dl class="dl">${dl}</dl>${clas}${palabras}${alertas}</div></details>`;
  const secSin = d.sinopsis
    ? `<details class="card foldcard" open style="margin-top:14px"><summary>📝 Sinopsis</summary><p class="sinopsis-text" style="margin-top:10px">${esc(d.sinopsis)}</p></details>`
    : '';
  // 🩺 Salud: plegable, admin-only, carga perezosa al abrir (checklist de tareas de mantenimiento).
  const secSalud = `<details class="card foldcard admin-only" id="saludDet" style="margin-top:14px"><summary>🩺 Salud del documento</summary><div id="saludBody" class="muted" style="margin-top:10px">Abre para ver el estado de mantenimiento…</div></details>`;
  // Imágenes y sinopsis DESPLEGADAS y ANTES de las acciones; el resto (lectura, catalográficos, salud) plegado, después.
  $('#p-detalle').innerHTML =
    `${crumb}<div style="margin:2px 0 12px"><button class="det-back" title="Volver" onclick="${back}">←</button></div>${fmin}${secImg}${secSin}${secAcc}${secLect}${secCat}${secSalud}`;
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
    const ci = $('#actImgs');
    if (ci)
      ci.onclick = () =>
        editarImagenes(d._id, r.imagenes || (r.portada ? [{ ruta: r.portada, tipo: 'portada' }] : []));
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
    if (uc)
      uc.onclick = () => {
        const u = d.ubicacion || {};
        estadoBusqueda.extra = {
          ambito: u.ambito,
          estanteria: u.estanteria && u.estanteria !== 'Sin asignar' ? u.estanteria : undefined,
          etiqueta: '📍 ' + _txtUbic(d),
        };
        estadoBusqueda.page = 1;
        go('search');
      };
  }
  $$('#p-detalle [data-colid]').forEach((a) => (a.onclick = () => verColeccion(a.dataset.colid)));
  $$('#p-detalle [data-q]').forEach((a) => (a.onclick = () => buscarTexto(a.dataset.q)));
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
  const _nom = (r.nombre_archivo || '').toLowerCase();
  const initLector = () => {
    if (r.archivo_url && _nom.endsWith('.epub')) iniciarLectorEpub(encUrl(r.archivo_url));
    else if (r.archivo_url && _nom.endsWith('.pdf')) iniciarLectorPdf(encUrl(r.archivo_url));
    else if (/\.(cbz|cbr|cb7|djvu)$/.test(_nom)) iniciarLectorComic(d._id);
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

// ── valoración (estrellas, estilo Lightroom) + quitar (⊘) + NSFW (🔞) — para documentos / obras / colecciones ──
// `ent` = 'documentos' | 'obras' | 'colecciones'. La valoración es por nivel (independiente); marcar NSFW en
// una obra/colección oculta a los invitados todos sus miembros (actuales y futuros).
function ratingBar(ent, id, v, nsfw) {
  v = Number(v) || 0;
  const admin = ROL === 'admin';
  const st = [5, 4, 3, 2, 1]
    .map((n) => `<span class="st${n <= v ? ' on' : ''}" data-v="${n}">★</span>`)
    .join(''); // 5→1 + row-reverse: relleno al pasar el ratón
  // Invitado: solo VE la valoración (estrellas de solo lectura, sin botones de quitar/NSFW ni clic).
  if (!admin)
    return `<span class="ratebar ro"><span class="stars ro" title="Valoración: ${v}/5">${st}</span></span>`;
  return (
    `<span class="ratebar" data-ent="${ent}" data-id="${esc(id)}" data-v="${v}">` +
    `<button class="rbtn rclear" title="Quitar valoración (0★)">⊘</button>` +
    `<span class="stars" title="Valora (clic en una estrella; repite la misma para quitar)">${st}</span>` +
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
async function fichaReprocesar(id) {
  const pw = await modalPassword({
    titulo: '♻️ Reprocesar documento',
    aviso:
      'Se borrará el documento, su fichero volverá al <b>Inbox</b> para re-catalogarse y su carpeta actual (sidecars e imágenes) irá a la <b>Papelera</b> (recuperable). El Vigilante debe estar activo para que se vuelva a procesar.',
  });
  if (pw == null) return;
  try {
    const r = await api('/documentos/' + encodeURIComponent(id) + '/reprocesar', {
      method: 'POST',
      body: JSON.stringify({ password: pw }),
    });
    if (!r.ok) {
      toast(r.motivo, 'bad');
      return;
    }
    toast('Reprocesando: «' + r.inbox + '» devuelto al Inbox');
    go('search');
  } catch (e) {
    toast(e.message, 'bad');
  }
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
const fileADataURL = (blob) =>
  new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = rej;
    fr.readAsDataURL(blob);
  });
let _imgState = null;
function editarImagenes(id, imagenes) {
  _imgState = { id, imgs: (imagenes || []).map((im) => ({ ...im })) };
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
    <div style="display:flex;gap:10px;justify-content:space-between;margin-top:12px"><div class="row" style="gap:8px"><button class="btn" id="imgAdd">➕ Añadir</button><button class="btn" id="imgCam">📷 Cámara</button></div><button class="btn pri" id="imgCerrar">Cerrar</button></div>
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
        try {
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
  // DILATAR el tapete (cierre morfológico, radio 2, max-filter separable) para TRAGARSE las LÍNEAS de la
  // rejilla: son "no-tapete" y, si no, conectan el libro con el exterior y el flood-fill se cuela en él.
  const r = 2,
    tmp = new Uint8Array(N),
    mat = new Uint8Array(N);
  for (let y = 0; y < h; y++) {
    const o = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = -r; k <= r; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < w && verde[o + xx]) {
          v = 1;
          break;
        }
      }
      tmp[o + x] = v;
    }
  }
  for (let x = 0; x < w; x++)
    for (let y = 0; y < h; y++) {
      let v = 0;
      for (let k = -r; k <= r; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < h && tmp[yy * w + x]) {
          v = 1;
          break;
        }
      }
      mat[y * w + x] = v;
    }
  // flood-fill del EXTERIOR (no-tapete alcanzable desde los bordes) sobre el tapete YA SÓLIDO.
  const fuera = new Uint8Array(N),
    pila = [];
  const meter = (i) => {
    if (!mat[i] && !fuera[i]) {
      fuera[i] = 1;
      pila.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    meter(x);
    meter((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    meter(y * w);
    meter(y * w + w - 1);
  }
  while (pila.length) {
    const i = pila.pop(),
      x = i % w,
      y = (i / w) | 0;
    if (x > 0) meter(i - 1);
    if (x < w - 1) meter(i + 1);
    if (y > 0) meter(i - w);
    if (y < h - 1) meter(i + w);
  }
  // ISLA = no-tapete RODEADO de tapete. Etiquetar componentes conexas y quedarse con la MAYOR (el libro):
  // así se ignoran restos sueltos fuera y los "agujeros" mat dentro de la cubierta no rompen la forma.
  const comp = new Int32Array(N);
  let id = 0,
    bestId = 0,
    bestSz = 0;
  for (let s = 0; s < N; s++) {
    if (mat[s] || fuera[s] || comp[s]) continue;
    id++;
    let sz = 0;
    const st = [s];
    comp[s] = id;
    while (st.length) {
      const i = st.pop();
      sz++;
      const x = i % w,
        y = (i / w) | 0;
      const push = (j) => {
        if (!mat[j] && !fuera[j] && !comp[j]) {
          comp[j] = id;
          st.push(j);
        }
      };
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }
    if (sz > bestSz) {
      bestSz = sz;
      bestId = id;
    }
  }
  if (bestSz < N * 0.01) return null; // libro demasiado pequeño / no fiable
  // 4 esquinas de la MAYOR componente (extremos diagonales x±y) — se adapta a giro/trapecio. Erosión: el
  // píxel de esquina debe tener ≥3 vecinos de la misma componente (evita protuberancias finas).
  const dela = (i) => comp[i] === bestId;
  let tl = null,
    br = null,
    bl = null,
    tr = null;
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
      const s = x + y,
        df = x - y;
      if (tl === null || s < tl[2]) tl = [x, y, s];
      if (br === null || s > br[2]) br = [x, y, s];
      if (bl === null || df < bl[2]) bl = [x, y, df];
      if (tr === null || df > tr[2]) tr = [x, y, df];
    }
  if (!tl || !tr || !br || !bl) return null;
  const up = (p) => [p[0] / sc, p[1] / sc];
  return [up(tl), up(tr), up(br), up(bl)];
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
        q = detectarCuadrilateroGenerico(work);
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
    <select id="edTipo"><option value="libro"${d.tipo_recurso !== 'revista' ? ' selected' : ''}>📕 Libro</option><option value="revista"${d.tipo_recurso === 'revista' ? ' selected' : ''}>📰 Revista</option></select>
    ${campo('edAut', 'Autores (coma)', (r.autores || []).join(', '))}
    ${campo('edEdi', 'Editorial', r.editorial || '')}
    <div class="row" style="gap:8px">${`<div style="flex:1">${campo('edAno', 'Año', d.año_edicion)}</div><div style="flex:1">${campo('edIdi', 'Idioma', d.idioma)}</div><div style="flex:1">${campo('edPag', 'Páginas', d.paginas)}</div>`}</div>
    <div class="row" style="gap:8px"><div style="flex:1"><label style="display:block;margin-top:8px">ISBN</label><div style="display:flex;gap:6px"><input id="edIsbn" value="${esc(d.isbn || '')}" autocomplete="off" style="flex:1">${btnScanIsbn}</div></div><div style="flex:1">${campo('edIssn', 'ISSN', d.issn)}</div></div>
    <div style="margin-top:8px"><label style="display:block">Otras ediciones (ISBN)</label><div id="edAltList"></div><button type="button" class="btn" id="edAltAdd" style="margin-top:6px">➕ Añadir edición</button></div>
    <div class="row" style="gap:8px">${`<div style="flex:1">${campo('edCdu', 'CDU', d.cdu)}</div><div style="flex:1">${campo('edEd', 'Edición nº', d.numero_edicion)}</div></div>`}
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
  // Editor de OTRAS EDICIONES (ISBN alternativo + rol). Filas añadibles/borrables.
  const rolOpts = (sel) =>
    ROL_ISBN_OPC.map(
      ([val, lab]) => `<option value="${val}"${val === sel ? ' selected' : ''}>${lab}</option>`,
    ).join('');
  const edAltFila = (a) =>
    `<div class="edAltRow" style="display:flex;gap:6px;margin-top:6px;align-items:center"><input class="edAltIsbn" value="${esc((a && a.isbn) || '')}" placeholder="ISBN" autocomplete="off" style="flex:1"><select class="edAltRol" style="flex:0 0 auto">${rolOpts((a && a.rol) || 'otro')}</select><button type="button" class="btn bad edAltDel" title="Quitar" style="padding:2px 9px">✕</button></div>`;
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
  if ($('#edScan')) $('#edScan').onclick = () => escanearISBN('edIsbn'); // escanear ISBN en la ficha (supervisado)
  const onGuardar = async () => {
    const campos = {
      titulo: $('#edTit').value,
      subtitulo: $('#edSub').value,
      tipo_recurso: $('#edTipo').value,
      autores: $('#edAut').value,
      editorial: $('#edEdi').value,
      año_edicion: $('#edAno').value,
      idioma: $('#edIdi').value,
      paginas: $('#edPag').value,
      isbn: $('#edIsbn').value,
      issn: $('#edIssn').value,
      cdu: $('#edCdu').value,
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

function previewArchivo(r) {
  if (!r.archivo_url) return '';
  const nombre = r.nombre_archivo || 'archivo',
    url = encUrl(r.archivo_url),
    ext = (nombre.split('.').pop() || '').toLowerCase();
  if (['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext)) return ''; // un set de imágenes ya se ve en el carrusel
  // Solo "Descargar": PDF y EPUB se LEEN EMBEBIDOS aquí (visores propios). Ya no se ofrece "Abrir en
  // pestaña" (en PC, según la config del navegador, descargaba el PDF en vez de previsualizarlo).
  const acc = `<div class="row" style="margin-top:12px;gap:8px"><a class="btn pri" href="${esc(url)}" download="${esc(nombre)}">⬇ Descargar</a></div>`;
  // PDF: visor PDF.js embebido (vendored) — render propio en canvas → previsualiza IGUAL en PC y móvil,
  // sin depender de la config de PDF del navegador. Se inicializa tras pintar (iniciarLectorPdf).
  if (ext === 'pdf')
    return `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">📄 ${esc(nombre)}</h3>
    <div class="pdfwrap" id="pdfWrap"><div class="pdfscroll" id="pdfScroll"></div>
      <button class="epubfs" id="pdfFs" title="Pantalla completa" style="display:none">⛶</button>
      <div class="epubbar" id="pdfBar" style="display:none"><span class="epubpct" style="text-align:left;min-width:0"><span id="pdfCur">1</span> / <span id="pdfTotal">?</span></span></div>
      <div class="epubmsg" id="pdfMsg">Cargando PDF…</div></div>${acc}</div>`;
  // EPUB: lector epub.js (vendored en /vendor) — se inicializa tras pintar (iniciarLectorEpub).
  if (ext === 'epub')
    return `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">📗 ${esc(nombre)}</h3>
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
    return `<div class="fileprev"><h3 style="margin:16px 0 8px;color:var(--mut);font-size:13px">${ext === 'djvu' ? '📘' : '🗂️'} ${esc(nombre)}</h3>
    <div class="pdfwrap" id="comicWrap"><img id="comicImg" class="comicpg" alt="">
      <button class="cnav prev" id="comicPrev" style="display:none">‹</button><button class="cnav next" id="comicNext" style="display:none">›</button>
      <button class="epubfs" id="comicFs" title="Pantalla completa" style="display:none">⛶</button>
      <div class="epubbar" id="comicBar" style="display:none"><span class="epubpct" style="text-align:left;min-width:0"><span id="comicCur">1</span> / <span id="comicTotal">?</span></span></div>
      <div class="epubmsg" id="comicMsg">Cargando cómic…</div></div>${acc}</div>`;
  // Resto de formatos: sin vista previa integrada — solo descarga.
  const ic = { djvu: '📘', mobi: '📙', azw3: '📙' }[ext] || '📦';
  return `<div class="fileprev"><div class="filebox"><div class="ic">${ic}</div><div style="font-weight:600;word-break:break-word">${esc(nombre)}</div>
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
      let pct = null;
      if (locsReady) {
        try {
          pct = book.locations.percentageFromCfi(loc.start.cfi);
        } catch {}
      }
      if (pct != null) {
        if (bi) bi.style.width = Math.round(pct * 100) + '%';
        if (pc) pc.textContent = Math.round(pct * 100) + '%';
      } else if (pc && loc.start.displayed)
        pc.textContent = `${loc.start.displayed.page}/${loc.start.displayed.total}`;
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
let selDocs = new Set(),
  paginaIds = [];
function toggleSel(id, on) {
  if (on) selDocs.add(id);
  else selDocs.delete(id);
  const c = $('#searchResults .vol[data-doc="' + id + '"]');
  if (c) c.classList.toggle('sel', on);
  renderBulk();
}
function renderBulk() {
  const el = $('#searchBulk');
  if (!el) return;
  if (!paginaIds.length || ROL !== 'admin') {
    el.innerHTML = '';
    return;
  }
  const enPag = paginaIds.filter((id) => selDocs.has(id)).length;
  const acc = selDocs.size
    ? `<span style="margin-left:auto"></span><b>${selDocs.size}</b> sel.
    <button class="btn" id="bkVer">👁 Ver</button>
    <button class="btn pri" id="bkCol">📚 Colección</button>
    <button class="btn pri" id="bkObra">📖 Obra</button>
    <button class="btn pri" id="bkUbic">📍 Estantería</button>
    <button class="btn" id="bkQuitUbic" title="Quitar de su estantería/ámbito (pasan a «Sin asignar»)">🚫 Quitar de estantería</button>
    ${'NDEFReader' in window ? '<button class="btn pri" id="bkNfc">📶 Etiquetar</button>' : ''}
    <button class="btn bad" id="bkDel">🗑 Eliminar</button>
    <button class="btn" id="bkClear">Limpiar</button>`
    : '';
  const g = colaEtqGuardada();
  const resume =
    g && 'NDEFReader' in window && !selDocs.size
      ? `<button class="btn pri" id="bkResumeNfc" style="margin-left:auto">📶 Reanudar etiquetado (${g.ids.length})</button>`
      : '';
  const selNfc =
    'NDEFReader' in window
      ? `<button class="btn" id="bkSelNfc" title="Acumula en la selección los libros que vayas tocando con etiquetas NFC">📶 Seleccionar por NFC</button>`
      : '';
  el.innerHTML = `<div class="bulkbar"><label style="display:flex;gap:7px;align-items:center;cursor:pointer"><input type="checkbox" id="bkAll" style="width:18px;height:18px;accent-color:var(--acc)"> Seleccionar todos <span class="muted">(${paginaIds.length} en esta página)</span></label><button class="btn" id="bkAllRes" title="Selecciona TODOS los resultados de esta búsqueda (todas las páginas)">🗂 Todos los resultados</button>${selNfc}${resume}${acc}</div>`;
  if ($('#bkResumeNfc'))
    $('#bkResumeNfc').onclick = () => {
      const s = colaEtqGuardada();
      if (s) iniciarEtiquetadoLote(s.ids, s.auto);
    };
  if ($('#bkSelNfc')) $('#bkSelNfc').onclick = seleccionarPorNFC;
  const all = $('#bkAll');
  all.checked = enPag > 0 && enPag === paginaIds.length;
  all.indeterminate = enPag > 0 && enPag < paginaIds.length;
  all.onchange = () => {
    const on = all.checked;
    paginaIds.forEach((id) => {
      if (on) selDocs.add(id);
      else selDocs.delete(id);
    });
    $$('#searchResults .selchk').forEach((cb) => (cb.checked = on));
    $$('#searchResults .vol').forEach((c) => c.classList.toggle('sel', on));
    renderBulk();
  };
  if ($('#bkAllRes')) $('#bkAllRes').onclick = selTodosResultados;
  if (selDocs.size) {
    $('#bkCol').onclick = () => pickerGrupo('coleccion');
    $('#bkObra').onclick = () => pickerGrupo('obra');
    $('#bkUbic').onclick = () => pickerUbic();
    if ($('#bkQuitUbic')) $('#bkQuitUbic').onclick = quitarSeleccionDeUbic;
    if ($('#bkNfc')) $('#bkNfc').onclick = () => iniciarEtiquetadoLote([...selDocs], false);
    if ($('#bkVer')) $('#bkVer').onclick = verSeleccion;
    $('#bkDel').onclick = eliminarSeleccionados;
    $('#bkClear').onclick = () => {
      selDocs.clear();
      $$('#searchResults .vol.sel').forEach((c) => c.classList.remove('sel'));
      $$('#searchResults .selchk').forEach((c) => (c.checked = false));
      renderBulk();
    };
  }
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
  $$('#searchResults .selchk').forEach((cb) => {
    if (selDocs.has(cb.dataset.id)) {
      cb.checked = true;
      const v = cb.closest('.vol');
      if (v) v.classList.add('sel');
    }
  });
  renderBulk();
  toast(`${(r.ids || []).length} resultado(s) seleccionados · total ${selDocs.size}`);
}
// Ver la selección acumulada (de todas las búsquedas): lista con quitar uno a uno + borrar todo.
async function verSeleccion() {
  if (!selDocs.size) return;
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:520px;max-height:88vh;overflow:auto"><h3 style="margin-top:0">👁 Selección (<b id="vsN">${selDocs.size}</b>)</h3><div id="vsBody" class="muted">Cargando…</div>
    <div class="row" style="gap:10px;justify-content:flex-end;margin-top:12px"><button class="btn bad" id="vsClr">Borrar selección</button><button class="btn" id="vsX">Cerrar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = cerrarCmp;
  $('#vsX').onclick = cerrarCmp;
  $('#vsClr').onclick = () => {
    selDocs.clear();
    $$('#searchResults .vol.sel').forEach((c) => c.classList.remove('sel'));
    $$('#searchResults .selchk').forEach((c) => (c.checked = false));
    renderBulk();
    cerrarCmp();
  };
  let docs = [];
  try {
    const r = await api('/documentos/por-ids', {
      method: 'POST',
      body: JSON.stringify({ ids: [...selDocs] }),
    });
    docs = r.docs || [];
  } catch (e) {}
  const body = $('#vsBody');
  if (!body) return;
  body.classList.remove('muted');
  body.innerHTML = docs.length
    ? docs
        .map(
          (
            d,
          ) => `<div class="row" style="align-items:center;gap:8px;border-top:1px solid var(--line);padding:6px 0">
      <span style="flex:1;font-size:13px">${d.nfc ? '📶 ' : ''}${esc(recortar(d.titulo || '(sin título)', 60))}</span>
      <a class="rowlink" data-vsver="${esc(d._id)}" style="font-size:12px">ficha</a>
      <button class="rbtn" data-vsdel="${esc(d._id)}" title="Quitar de la selección">✕</button></div>`,
        )
        .join('')
    : '<div class="muted">No se pudieron cargar los títulos (la selección sigue activa).</div>';
  body.querySelectorAll('[data-vsdel]').forEach(
    (b) =>
      (b.onclick = () => {
        selDocs.delete(b.dataset.vsdel);
        const c = $(`#searchResults .vol[data-doc="${b.dataset.vsdel}"]`);
        if (c) {
          c.classList.remove('sel');
          const cb = c.querySelector('.selchk');
          if (cb) cb.checked = false;
        }
        renderBulk();
        if (!selDocs.size) cerrarCmp();
        else {
          $('#vsN').textContent = selDocs.size;
          b.closest('.row').remove();
        }
      }),
  );
  body.querySelectorAll('[data-vsver]').forEach(
    (a) =>
      (a.onclick = () => {
        cerrarCmp();
        verDoc(a.dataset.vsver, { volver: 'search', etiqueta: 'Búsqueda' });
      }),
  );
}
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
      const c = $(`#searchResults .vol[data-doc="${id}"]`);
      if (c) {
        c.classList.add('sel');
        const cb = c.querySelector('.selchk');
        if (cb) cb.checked = true;
      }
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
async function eliminarSeleccionados() {
  const n = selDocs.size;
  if (!n) return;
  const pw = await modalPassword({
    titulo: `🗑 Eliminar ${n} libro(s)`,
    aviso: `Se borrarán <b>${n}</b> documento(s); sus carpetas (sidecars e imágenes) irán a la <b>Papelera</b> (recuperable). Acción MASIVA. Confirma con tu contraseña de administrador.`,
  });
  if (pw == null) return;
  try {
    const r = await api('/documentos/eliminar-lote', {
      method: 'POST',
      body: JSON.stringify({ ids: [...selDocs], password: pw }),
    });
    if (!r.ok) {
      toast(r.motivo || 'No se pudo eliminar', 'bad');
      return;
    }
    toast(
      `Eliminado(s) ${r.eliminados} libro(s)${r.fallidos ? ` · ${r.fallidos} fallido(s)` : ''} → Papelera`,
    );
    selDocs.clear();
    buscarCatalogo(estadoBusqueda.page || 1);
  } catch (e) {
    toast(e.message, 'bad');
  }
}
// Selector con FILTRO + PREVISUALIZACIÓN (en vez de un desplegable largo): clic en una tarjeta → añade
// los seleccionados a esa colección/obra; o crear una nueva abajo. kind: 'coleccion' | 'obra'.
async function pickerGrupo(kind) {
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
    `<div class="box card" style="max-width:560px"><h3 style="margin-top:0">${ico} Añadir <b>${selDocs.size}</b> doc(s) a una ${esCol ? 'colección' : 'obra'}</h3>
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
    $$('#pkLista .pkitem').forEach((el) => (el.onclick = () => aplicarGrupo(kind, { id: el.dataset.id })));
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
    aplicarGrupo(kind, { nombre, tipo: esCol ? $('#pkTipo').value : undefined });
  };
}
async function aplicarGrupo(kind, { id, nombre, tipo }) {
  const esCol = kind === 'coleccion';
  const body = esCol
    ? { ids: [...selDocs], coleccionId: id || null, nombre: nombre || null, tipo }
    : { ids: [...selDocs], obraId: id || null, titulo: nombre || null };
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
    toast(`${r.n} doc(s) → ${esCol ? 'colección «' + r.coleccion.nombre : 'obra «' + r.obra.titulo}»`);
    selDocs.clear();
    buscarCatalogo(estadoBusqueda.page || 1);
  } catch (e) {
    const el = $('#pkErr');
    if (el) el.textContent = e.message;
    else toast(e.message, 'bad');
  }
}
function construirSearch() {
  $('#p-search').innerHTML = `
    <div class="sec-h"><h2>Búsqueda y catálogo</h2><span class="muted" id="searchCount"></span></div>
    <details class="card foldcard" id="sqFiltros" style="margin-bottom:16px">
      <summary>🔎 Buscar y filtrar</summary>
      <div class="row">
        <div style="flex:2 1 220px"><label>Buscar</label><input id="sqQ" placeholder="título, autor, editorial, ISBN, ISSN, archivo…" autocomplete="off"></div>
        <div style="display:flex;align-items:flex-end"><button class="btn pri" id="sqClear" title="Limpiar todos los filtros de búsqueda">✕ Limpiar</button></div>
        <div><label>Tipo</label><select id="sqTipo"><option value="">Todos</option><option value="libro">Libros</option><option value="revista">Revistas</option><option value="comic">Cómics</option></select></div>
        <div><label>Soporte</label><select id="sqSoporte"><option value="">Ambos</option><option value="papel">Papel</option><option value="digital">Digital</option></select></div>
        <div><label>Ámbito</label><select id="sqAmbito"><option value="">Todos</option></select></div>
        <div><label>Estantería</label><select id="sqEstanteria" disabled><option value="">Todas</option></select></div>
        <div class="admin-only" style="display:flex;align-items:flex-end"><button class="btn" id="sqGoUbic" title="Gestionar ubicaciones (o ver esta estantería)">📍 Gestionar</button></div>
        <div><label>CDU (prefijo)</label><input id="sqCdu" placeholder="ej. 82" autocomplete="off"></div>
        <div><label>Estrellas${ROL === 'admin' ? ' / NSFW' : ''}</label><details class="ddown" id="sqStarsDD"><summary id="sqStarsSum">Todas</summary>
          <div class="pop">${[5, 4, 3, 2, 1].map((n) => `<label><input type="checkbox" class="sqStar" value="${n}">${'★'.repeat(n)}</label>`).join('')}<label><input type="checkbox" class="sqStar" value="0">Sin valorar</label>${ROL === 'admin' ? '<label style="border-top:1px solid var(--line);margin-top:4px;padding-top:6px" title="Sin marcar: OCULTA lo NSFW · Marcada con otros filtros: lo INCLUYE también · Marcada y sola: SOLO NSFW"><input type="checkbox" id="sqNsfw"> 🔞 NSFW</label>' : ''}</div>
        </details></div>
        <div><label>Orden</label><select id="sqOrden"><option value="reciente">Recientes</option><option value="titulo">Título A-Z</option><option value="antiguo">Antiguos</option></select></div>
        <div class="admin-only"><label>Etiqueta NFC</label><select id="sqNfc"><option value="">Todas</option><option value="con">📶 Con etiqueta</option><option value="sin">Sin etiqueta</option></select></div>
        <div class="admin-only"><label>Descubrir</label><div style="display:flex;align-items:center;gap:6px;height:36px"><label class="switch" style="flex:0 0 auto"><input type="checkbox" id="sqDescubrir"><span class="slider"></span></label><span class="muted" title="Busca en el Fichero (58,7 M) libros que NO tienes, con enlaces para conseguirlos">🔭 Fichero</span></div></div>
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
  $('#sqQ').oninput = () => {
    clearTimeout(busqTimer);
    busqTimer = setTimeout(() => buscarCatalogo(1), 350);
  };
  $('#sqQ').onkeydown = (e) => {
    if (e.key === 'Enter') {
      clearTimeout(busqTimer);
      buscarCatalogo(1);
      if ($('#sqDescubrir') && $('#sqDescubrir').checked) lanzarDescubrir();
    }
  };
  $('#sqCdu').oninput = () => {
    clearTimeout(busqTimer);
    busqTimer = setTimeout(() => buscarCatalogo(1), 350);
  };
  $('#sqTipo').onchange = () => buscarCatalogo(1);
  if ($('#sqSoporte')) $('#sqSoporte').onchange = () => buscarCatalogo(1);
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
  $('#sqOrden').onchange = () => buscarCatalogo(1);
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
    $('#sqOrden').value = 'reciente';
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
    actualizarSumEstrellas();
    buscarCatalogo(1);
  };
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
function _paramsBusqueda() {
  const params = new URLSearchParams({
    q: $('#sqQ').value.trim(),
    tipo: $('#sqTipo').value,
    soporte: $('#sqSoporte') ? $('#sqSoporte').value : '',
    cdu: $('#sqCdu').value.trim(),
    orden: $('#sqOrden').value,
  });
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
  const pager =
    tp > 1
      ? `<div style="display:flex;gap:10px;align-items:center;justify-content:center;margin-top:12px"><button class="btn" id="descPrev"${descPagina <= 1 ? ' disabled' : ''}>‹ Anterior</button><span class="muted">Página ${descPagina} de ${tp}</span><button class="btn" id="descNext"${descPagina >= tp ? ' disabled' : ''}>Siguiente ›</button></div>`
      : '';
  ext.innerHTML =
    descCaja(`<div class="row" style="align-items:center;margin-bottom:6px"><b>🔭 Fuera de tu biblioteca</b><span class="muted">${tot}${tot >= 100 ? '+' : ''} candidato${tot === 1 ? '' : 's'} del Fichero · «${esc(recortar(descQ, 36))}»</span><div style="flex:1"></div><button class="btn" id="descAgain" title="Buscar de nuevo">↻</button></div>
    ${tot ? slice.map(descRow).join('') : '<div class="muted" style="padding:6px 0">Sin candidatos en el Fichero para esa búsqueda (busca por título/autor).</div>'}
    ${pager}
    ${tot ? '<div class="muted" style="font-size:11px;margin-top:10px">No están en tu biblioteca. Los enlaces buscan una copia descargable; al obtenerla, déjala en el Inbox para catalogarla.</div>' : ''}`);
  if ($('#descPrev'))
    $('#descPrev').onclick = () => {
      descPagina--;
      pintarDescubrir();
    };
  if ($('#descNext'))
    $('#descNext').onclick = () => {
      descPagina++;
      pintarDescubrir();
    };
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
// Distintivos de admin: 🔞 NSFW (oculto a invitados) y 🔒 bloqueado (el Conformador no lo altera).
const badgesDoc = (d) =>
  `${d.nsfw ? ' <span class="fmt" style="background:rgba(255,92,122,.18);color:var(--bad)" title="NSFW: oculto a invitados">🔞</span>' : ''}${d.locked ? ' <span class="fmt" style="background:rgba(255,180,84,.18);color:var(--warn)" title="Bloqueado: el Conformador no lo altera">🔒</span>' : ''}${d.nfc && (d.nfc.fecha_vinculacion || d.nfc.uid) ? ' <span class="fmt" style="background:rgba(40,217,168,.18);color:var(--acc)" title="Tiene etiqueta NFC vinculada">📶</span>' : ''}`;
function docCard(d) {
  const ph = d.tipo_recurso === 'revista' ? '📰' : '📕';
  const cov = d.portada
    ? `<img src="${esc(encUrl(d.portada))}" loading="lazy" onerror="this.parentNode.innerHTML='<div class=ph>${ph}</div>'">`
    : `<div class="ph">${ph}</div>`;
  const fmt = (d.formatos || [])
    .slice(0, 2)
    .map((f) => `<span class="fmt">${esc(f)}</span>`)
    .join('');
  const sub =
    (d.autores && d.autores.length ? d.autores.slice(0, 2).join(', ') : '') ||
    (d.año_edicion ? String(d.año_edicion) : '') ||
    d.isbn ||
    '—';
  const chk = `<input type="checkbox" class="selchk admin-only" data-id="${esc(d._id)}" title="Seleccionar"${selDocs.has(d._id) ? ' checked' : ''}>`;
  const nfcTag = nfcBadge(d);
  return `<div class="vol${selDocs.has(d._id) ? ' sel' : ''}" data-doc="${esc(d._id)}">${chk}<div class="cov">${cov}${nfcTag}${posBadge(d)}</div><div class="meta"><div class="n">${esc(recortar(d.titulo || '(sin título)', 64))} ${fmt}${badgesDoc(d)}</div><div class="t">${esc(sub)}</div><div style="margin-top:5px">${ratingBar('documentos', d._id, d.valoracion, d.nsfw)}</div></div></div>`;
}
// Nº de POSICIÓN física en la estantería — solo al ver UNA estantería (ayuda a localizar el libro / inventario).
function posBadge(d) {
  const ex = estadoBusqueda.extra;
  if (!(ex && ex.ambito && ex.estanteria) || !Number.isFinite(d.orden_estanteria)) return '';
  return `<span class="posbadge" title="Posición física en la estantería">#${d.orden_estanteria + 1}</span>`;
}
function pintarBusqueda(r) {
  paginaIds = r.docs.map((d) => d._id); // ids de la página actual (para «seleccionar todos»)
  $('#searchCount').textContent = `${r.total.toLocaleString('es-ES')} resultado${r.total === 1 ? '' : 's'}`;
  $('#searchResults').innerHTML = r.docs.length
    ? `<div class="vol-grid">${r.docs.map(docCard).join('')}</div>`
    : '<div class="empty">Sin resultados</div>';
  $$('#searchResults .vol[data-doc]').forEach(
    (el) => (el.onclick = () => verDoc(el.dataset.doc, { volver: 'search', etiqueta: 'Búsqueda' })),
  );
  $$('#searchResults .selchk').forEach((cb) => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => toggleSel(cb.dataset.id, cb.checked);
  });
  attachRating('#searchResults');
  renderBulk();
  const p = r.page,
    tp = r.paginas;
  // Paginación ARRIBA y ABAJO de los thumbnails. Al cambiar de página, desliza hasta el primer resultado.
  const pagerHtml =
    tp > 1
      ? `<button class="btn pgPrev" ${p <= 1 ? 'disabled' : ''}>‹ Anterior</button><span class="muted">Página ${p} de ${tp}</span><button class="btn pgNext" ${p >= tp ? 'disabled' : ''}>Siguiente ›</button>`
      : '';
  $('#searchPager').innerHTML = pagerHtml;
  if ($('#searchPagerTop')) $('#searchPagerTop').innerHTML = pagerHtml;
  const irA = async (np) => {
    await buscarCatalogo(np);
    const sb = $('#searchBulk');
    const a = sb && sb.textContent.trim() ? sb : $('#searchPagerTop') || $('#searchResults');
    if (a) a.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }; // muestra la barra «seleccionar todos» (y la nav fija)
  ['#searchPagerTop', '#searchPager'].forEach((sel) => {
    const c = $(sel);
    if (!c) return;
    const pv = c.querySelector('.pgPrev'),
      nx = c.querySelector('.pgNext');
    if (pv && !pv.disabled) pv.onclick = () => irA(p - 1);
    if (nx && !nx.disabled) nx.onclick = () => irA(p + 1);
  });
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
  let h = `<div class="card" style="margin-bottom:14px"><h3>Diagnóstico · ${esc(new Date(r.ts).toLocaleString('es-ES'))} · ${r.totalDocs} docs</h3>
    <table>${Object.keys(et).map(fila).join('')}</table>
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
    const sop = await BarcodeDetector.getSupportedFormats();
    formatos = formatos.filter((f) => sop.includes(f));
    if (!formatos.length) formatos = ['ean_13'];
  } catch (_) {}
  const det = new BarcodeDetector({ formats: formatos });
  // Overlay PROPIO (no usa #cmpModal) para poder escanear TAMBIÉN sobre el formulario de edición.
  const ov = document.createElement('div');
  ov.style.cssText =
    'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.85);display:grid;place-items:center;padding:16px';
  ov.innerHTML = `<div class="box card" style="max-width:480px;width:100%"><h3 style="margin-top:0">📷 Escanear ISBN</h3>
    <video id="scVid" playsinline muted style="width:100%;border-radius:10px;background:#000;max-height:60vh"></video>
    <p class="muted" style="font-size:12px;margin:8px 0 0">Enfoca el código de barras de la contraportada…</p>
    <div style="display:flex;justify-content:flex-end;margin-top:10px"><button class="btn" id="scX">Cancelar</button></div></div>`;
  document.body.appendChild(ov);
  const vid = ov.querySelector('#scVid');
  vid.srcObject = stream;
  try {
    await vid.play();
  } catch (_) {}
  let activo = true;
  const parar = () => {
    activo = false;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch (_) {}
  };
  const cerrar = () => {
    parar();
    ov.remove();
  };
  ov.querySelector('#scX').onclick = cerrar;
  ov.onclick = (e) => {
    if (e.target === ov) cerrar();
  };
  const loop = async () => {
    if (!activo) return;
    try {
      const codes = await det.detect(vid);
      const hit = (codes || [])
        .map((c) => String(c.rawValue || '').replace(/\D/g, ''))
        .find((v) => /^97[89]\d{10}$/.test(v));
      if (hit) {
        parar();
        const inp = $('#' + targetId);
        if (inp) inp.value = hit;
        ov.remove();
        toast('ISBN leído: ' + hit);
        return;
      }
    } catch (_) {}
    setTimeout(loop, 300);
  };
  loop();
}
// Detecta un ISBN (EAN-13 978/979) en las IMÁGENES (sin tocar el DOM): lo lee EN EL MÓVIL con
// BarcodeDetector. Devuelve el ISBN o null. Lo usan la subida (autopiloto y supervisado) para que el
// ISBN viaje como autoridad → fast-path por Fichero (sin visión IA). Un PDF lo lee el servidor.
async function detectarISBNenFiles(files) {
  if (!('BarcodeDetector' in window)) return null;
  const imgs = (files || []).filter((f) => /^image\//.test(f.type || ''));
  if (!imgs.length) return null;
  let det;
  try {
    det = new BarcodeDetector({ formats: ['ean_13'] });
  } catch (_) {
    return null;
  }
  for (const f of imgs) {
    try {
      const bmp = await createImageBitmap(f);
      const codes = await det.detect(bmp);
      if (bmp.close) bmp.close();
      const hit = (codes || [])
        .map((c) => String(c.rawValue || '').replace(/\D/g, ''))
        .find((v) => /^97[89]\d{10}$/.test(v));
      if (hit) return hit;
    } catch (_) {}
  }
  return null;
}
// Índice de la imagen que lleva el CÓDIGO DE BARRAS EAN-13 (suele ser la CONTRAPORTADA), o -1.
async function indiceConBarcode(files) {
  if (!('BarcodeDetector' in window)) return -1;
  let det;
  try {
    det = new BarcodeDetector({ formats: ['ean_13'] });
  } catch (_) {
    return -1;
  }
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (!/^image\//.test(f.type || '')) continue;
    try {
      const bmp = await createImageBitmap(f);
      const codes = await det.detect(bmp);
      if (bmp.close) bmp.close();
      if ((codes || []).some((c) => /^97[89]\d{10}$/.test(String(c.rawValue || '').replace(/\D/g, ''))))
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
  // Calibración del tapete (foto del tapete vacío): fija su color de sesión (cualquier color / luz).
  const tcb = $('#inTapeteCal'),
    tcf = $('#inTapeteCalFile');
  if (tcb && tcf) {
    tcb.onclick = () => tcf.click();
    tcf.onchange = async () => {
      if (tcf.files[0]) {
        try {
          const c = await calibrarTapete(tcf.files[0]);
          toast(`Tapete calibrado: rgb(${c.r},${c.g},${c.b})${c.crom ? '' : ' · acromático'}`);
        } catch (e) {
          toast('No se pudo calibrar: ' + e.message, 'bad');
        }
      }
      tcf.value = '';
      pintarTapeteCalEstado();
    };
    pintarTapeteCalEstado();
  }
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
function estanteriasDe(ambito) {
  const a = (ambito || '').trim().toLowerCase();
  const e = mapaUbicaciones.find((x) => (x.ambito || '').trim().toLowerCase() === a);
  return e ? e.estanterias : [];
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
  const sa = $('#sqAmbito');
  if (sa) {
    const cur = sa.value;
    sa.innerHTML =
      '<option value="">Todos</option>' +
      mapaUbicaciones.map((x) => `<option value="${esc(x.ambito)}">${esc(x.ambito)}</option>`).join('');
    sa.value = cur;
  }
  pintarEstanteriaSearch();
}
function pintarEstanteriaSearch() {
  const se = $('#sqEstanteria');
  if (!se) return;
  const amb = ($('#sqAmbito') && $('#sqAmbito').value) || '',
    cur = se.value,
    ests = estanteriasDe(amb);
  se.innerHTML =
    '<option value="">Todas</option>' +
    ests.map((e) => `<option value="${esc(e)}">${esc(e)}</option>`).join('');
  se.disabled = !amb;
  se.value = [...se.options].some((o) => o.value === cur) ? cur : '';
}
// Reduce una foto a máx. 2000px (canvas) antes de subir → menos datos y más rápido en el Atom.
function reducirImagen(file, max = 2000, q = 0.85) {
  return new Promise((res, rej) => {
    const img = new Image(),
      url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const w = img.naturalWidth,
        h = img.naturalHeight,
        s = Math.min(1, max / Math.max(w, h));
      if (s >= 1) {
        res(file);
        return;
      }
      const c = document.createElement('canvas');
      c.width = Math.round(w * s);
      c.height = Math.round(h * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(
        (b) => res(b ? new File([b], (file.name || 'foto') + '.jpg', { type: 'image/jpeg' }) : file),
        'image/jpeg',
        q,
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      rej(new Error('img'));
    };
    img.src = url;
  });
}
function renderCamThumbs() {
  const t = $('#camThumbs');
  if (t)
    t.innerHTML = camFotos
      .map(
        (b, i) =>
          `<span style="position:relative;display:inline-block"><img src="${URL.createObjectURL(b)}" style="width:62px;height:82px;object-fit:cover;border-radius:6px;border:1px solid var(--line)"><button class="btn bad" type="button" data-rm="${i}" title="Quitar" style="position:absolute;top:-7px;right:-7px;padding:0 6px;border-radius:50%;line-height:18px">✕</button></span>`,
      )
      .join('');
  $$('#camThumbs [data-rm]').forEach(
    (b) =>
      (b.onclick = () => {
        camFotos.splice(+b.dataset.rm, 1);
        renderCamThumbs();
      }),
  );
  const d = $('#camDone');
  if (d) {
    d.textContent = `✅ Catalogar (${camFotos.length})`;
    d.disabled = !camFotos.length;
  }
  const cl = $('#camClear');
  if (cl) cl.style.display = camFotos.length ? '' : 'none';
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
  const v = (id) => (($('#' + id) && $('#' + id).value) || '').trim();
  return {
    isbn: v('inIsbn'),
    coleccion: v('inColeccion'),
    obra: v('inObra'),
    ambito: v('inAmbito'),
    estanteria: v('inEstanteria'),
  };
}
function fdDesdeSnap(snap, files) {
  const fd = new FormData();
  if (snap.isbn) fd.append('isbn', snap.isbn);
  if (snap.isbn && snap.isbnOrigen) fd.append('isbn_origen', snap.isbnOrigen);
  if (snap.coleccion) fd.append('coleccion', snap.coleccion);
  if (snap.obra) fd.append('obra', snap.obra);
  if (snap.ambito || snap.estanteria)
    fd.append(
      'ubicacion',
      JSON.stringify({ ambito: snap.ambito || 'Sin asignar', estanteria: snap.estanteria || 'Sin asignar' }),
    );
  for (const f of files) fd.append('files', f, f.name);
  return fd;
}
async function enviarIngesta(fd) {
  const r = await fetch('/api/ingestar', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + TOKEN },
    body: fd,
  });
  if (r.status === 403) throw new Error('Solo los administradores pueden dar de alta recursos.');
  return await r.json().catch(() => ({}));
}
function setInboxEstado(txt) {
  const el = $('#inboxEstado');
  if (el) el.innerHTML = txt ? `<span class="muted" style="font-size:13px">${esc(txt)}</span>` : '';
}
const esPdf = (f) => /\.pdf$/i.test((f && f.name) || '') || (f && f.type) === 'application/pdf';
function opsImagenPdf() {
  const O = (window.pdfjsLib && window.pdfjsLib.OPS) || {};
  return new Set(
    [O.paintImageXObject, O.paintJpegXObject, O.paintInlineImageXObject, O.paintImageMaskXObject].filter(
      (v) => v != null,
    ),
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
    const total = pdf.numPages,
      setImg = opsImagenPdf(),
      comprobar = Math.min(total, 2);
    let conImg = 0;
    for (let i = 1; i <= comprobar; i++) {
      const pg = await pdf.getPage(i);
      const ol = await pg.getOperatorList();
      if (ol.fnArray.some((fn) => setImg.has(fn))) conImg++;
    }
    if (!(comprobar > 0 && conImg === comprobar)) return { escaneo: false, pages: [] }; // PDF digital → no explotar
    const pages = [],
      n = Math.min(total, maxPag);
    for (let i = 1; i <= n; i++) {
      const pg = await pdf.getPage(i);
      const vp1 = pg.getViewport({ scale: 1 });
      const vp = pg.getViewport({ scale: Math.max(1, Math.min(3, ancho / vp1.width)) });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width);
      c.height = Math.round(vp.height);
      await pg.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.85));
      if (blob)
        pages.push(new File([blob], 'pag-' + String(i).padStart(3, '0') + '.jpg', { type: 'image/jpeg' }));
      c.width = c.height = 0;
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
function fileAImagen(f) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = URL.createObjectURL(f);
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
            ? new File([blob], (f.name || 'tapete.jpg').replace(/\.(png|webp|jpeg)$/i, '.jpg'), {
                type: 'image/jpeg',
              })
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
// Guarda las dimensiones medidas en cada documento recién catalogado (best-effort, no rompe la subida).
async function guardarDimsResultados(resultados, dims) {
  if (!dims || !Array.isArray(resultados)) return;
  for (const x of resultados) {
    if (x && x.ok && x.id) {
      try {
        await api('/documentos/' + encodeURIComponent(x.id) + '/dimensiones', {
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
  // PDF (Adobe Scan/cámara/importado) → explotar en páginas JPG EN EL NAVEGADOR + leer el código de barras.
  if (files.length === 1 && esPdf(files[0]) && !extra.isbn) {
    try {
      setInboxEstado('🧩 Explotando el PDF en páginas y leyendo el código de barras…');
      const res = await pdfAImagenes(files[0]);
      if (res.escaneo && res.pages.length) {
        const isbn = await detectarISBNenFiles(res.pages);
        extra = { isbn: isbn || undefined, isbnOrigen: isbn ? 'movil' : undefined, titulo: files[0].name };
        files = res.pages;
        log(
          `🧩 PDF → ${res.pages.length} página(s)${isbn ? ` · 📱 ISBN ${isbn} leído en el móvil` : ' · sin código de barras (lo leerá el servidor)'}`,
        );
      }
    } catch (e) {
      console.warn('[PDF cliente] no explotado:', e.message);
      setInboxEstado('');
    }
  }
  // TAPETE: si está activo y hay imágenes, recorta+endereza (quita el tapete de la imagen guardada) y mide.
  if ($('#inTapete') && $('#inTapete').checked && files.some(_esImg)) {
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
  // ELEGIR PORTADA: con el switch activo y VARIAS fotos de un libro, confirmar/cambiar la portada antes de
  // enviar (default automático: la del código de barras es la contra). Cancelar aborta el envío.
  {
    const imgs = files.filter(_esImg);
    if (
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
    try {
      const j = await enviarIngesta(fdDesdeSnap(snap, files));
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
      const j = await enviarIngesta(fdDesdeSnap(job.snap, job.files));
      await guardarDimsResultados(j.resultados, job.dims); // tapete → dimensiones en la ficha
      job.estado = 'ok';
      job.resultados = j.resultados || [];
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
  const f = r.fecha_ingreso ? new Date(r.fecha_ingreso) : null;
  const dia =
    f && !isNaN(f)
      ? f.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' })
      : '—';
  const u = r.ubicacion_existente || r.ubicacion;
  const ub =
    u && (u.ambito || u.estanteria)
      ? [u.ambito, u.estanteria].filter((x) => x && x !== 'Sin asignar').join(' · ') || 'Sin asignar'
      : 'Sin asignar';
  return `<div style="margin-top:5px;padding:6px 9px;border-radius:8px;background:rgba(230,180,0,.14);border:1px solid rgba(230,180,0,.4);font-size:12px">⚠️ <b>Documento ya ingresado</b> el día: ${esc(dia)} · Ubicación: ${esc(ub)}</div>`;
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
        `<span class="tag ${j.estado === 'procesando' ? 'warn' : 'mut'}">${j.estado === 'procesando' ? '⏳ procesando' : '🕒 en cola'}</span> <span class="muted">${esc(recortar(j.titulo, 56))} · ${j.n} fich.</span>${msgsHtml(j)}`,
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
  $$('#inboxResults [data-doc]').forEach(
    (a) => (a.onclick = () => verDoc(a.dataset.doc, { volver: 'inbox', etiqueta: 'Inbox' })),
  );
}
// Compat: resultados directos (p. ej. al descartar lo compartido) → a la lista de hechos.
function pintarInboxResultados(res) {
  if (res && res.length) {
    jobsHechos.unshift({ estado: 'ok', resultados: res });
    cortarJobs();
  }
  pintarCola();
}
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
const EX_LIBRIS = 'BIBLIOTHECA LUDOVICIANA · Este libro pertenece a Luis Ortuño Molina';
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
      if (!forzar) {
        const prev = inspeccionarTagNFC(ev.message);
        if (prev && prev.docId !== docIdActual) {
          fin();
          reject({ code: 'OCUPADA', prev, uid });
          return;
        }
      }
      try {
        await rd.write({ records }, { signal: ac.signal });
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
    prop = p.slice(1).join(' · ');
  return `<div style="text-align:center;font-family:Georgia,'Times New Roman',serif;background:linear-gradient(#cdab6c,#9c7a44);color:#2a1d0e;border:1px solid #6e5226;border-radius:10px;padding:16px 12px;margin:0 0 14px;box-shadow:inset 0 1px 0 rgba(255,255,255,.45),0 3px 10px rgba(0,0,0,.45)">
    <div style="font-size:19px;font-weight:700;letter-spacing:2px;text-transform:uppercase">${esc(lib)}</div>${prop ? `<div style="font-size:13px;margin-top:5px;font-style:italic">${esc(prop)}</div>` : ''}</div>`;
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
  const pie =
    o.esDigital || o.ocultarUbicacion
      ? ''
      : o.ubicacionHTML != null
        ? o.ubicacionHTML
        : `<div class="fmin-ubic"><div class="lbl">Ubicación</div><div class="val">📍 ${esc(o.ubicacion || 'Sin asignar')}</div></div>`;
  return `<div class="fmin card">${badge}
    <h1 class="fmin-tit">${esc(o.titulo || '(sin título)')}</h1>${o.subtitulo ? `<div class="fmin-sub">${esc(o.subtitulo)}</div>` : ''}${starsInner ? `<div class="fmin-stars">${starsInner}</div>` : ''}
    ${hero ? `<div style="margin-top:14px">${hero}</div>` : ''}
    ${filas ? `<dl class="dl fmin-data">${filas}</dl>` : ''}
    ${pie}</div>`;
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
  const url = location.origin + '/?s=' + token;
  $('#cmpModal').innerHTML =
    `<div class="box card" style="max-width:360px;text-align:center"><h3 style="margin-top:0">🔗 Compartir ficha</h3>
    <div id="qrBox" style="display:flex;justify-content:center;margin:4px 0 12px"></div>
    <p class="muted" style="font-size:12px;line-height:1.5">Escanea el QR o comparte el enlace. Abre ${esDigital ? 'la ficha y permite la <b>descarga</b>' : 'solo la ficha'} — sin acceso al resto de la biblioteca.</p>
    <div class="row" style="gap:8px;justify-content:center;margin-top:10px;flex-wrap:wrap">
      <button class="btn pri" id="cmpShare">📤 Compartir</button>
      <button class="btn" id="cmpCopyImg">🖼️ Copiar imagen</button>
      <button class="btn" id="cmpCopy">📋 Copiar enlace</button>
      <button class="btn" id="cmpXq">Cerrar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = cerrarCmp;
  let cv = null;
  try {
    cv = qrCanvas(qrGenerar(url), 260);
    const box = $('#qrBox');
    if (box) box.appendChild(cv);
  } catch (e) {
    const box = $('#qrBox');
    if (box)
      box.innerHTML =
        '<span class="muted" style="font-size:12px">No se pudo generar el QR; usa el enlace.</span>';
  }
  $('#cmpXq').onclick = cerrarCmp;
  $('#cmpCopy').onclick = () => {
    copiar(url);
    toast('Enlace copiado');
  };
  // Copiar la IMAGEN del QR al portapapeles (Clipboard API; requiere contexto seguro). Si no hay soporte
  // o no hay canvas, se oculta el botón y queda «Copiar enlace».
  const ci = $('#cmpCopyImg');
  if (ci && cv && navigator.clipboard && window.ClipboardItem && cv.toBlob) {
    ci.onclick = () => {
      try {
        cv.toBlob(async (b) => {
          try {
            await navigator.clipboard.write([new ClipboardItem({ 'image/png': b })]);
            toast('Imagen del QR copiada');
          } catch (e) {
            toast('No se pudo copiar la imagen — usa «Copiar enlace»', 'warn');
          }
        }, 'image/png');
      } catch (e) {
        toast('No se pudo copiar la imagen — usa «Copiar enlace»', 'warn');
      }
    };
  } else if (ci) ci.style.display = 'none';
  const sh = $('#cmpShare');
  // Compartir nativo: preferimos compartir la IMAGEN (si el sistema admite ficheros); si no, el enlace.
  if (navigator.share) {
    sh.onclick = async () => {
      try {
        if (cv && cv.toBlob && navigator.canShare) {
          const blob = await new Promise((res) => cv.toBlob(res, 'image/png'));
          const file = blob && new File([blob], 'qr.png', { type: 'image/png' });
          if (file && navigator.canShare({ files: [file] })) {
            await navigator.share({ title: d.titulo || 'Ficha', text: url, files: [file] });
            return;
          }
        }
        await navigator.share({ title: d.titulo || 'Ficha', url });
      } catch (_) {
        /* cancelado */
      }
    };
  } else sh.style.display = 'none';
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
      estadoBusqueda.extra = { ambito: amb, estanteria: est || undefined, etiqueta: '📍 ' + (label || amb) };
      estadoBusqueda.page = 1;
      go('search');
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
    <div style="display:flex;gap:10px;justify-content:center;margin-top:8px"><button class="btn" id="nfcWrX">Cancelar</button></div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
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
      return await escribirNFC(records, d._id, ctrl.signal, false);
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
function iniciarEtiquetadoLote(ids, auto) {
  if (!('NDEFReader' in window)) {
    toast('Este navegador no soporta NFC (Android + Chrome)', 'bad');
    return;
  }
  ids = [...new Set((ids || []).filter(Boolean))];
  if (!ids.length) {
    toast('No hay libros seleccionados', 'warn');
    return;
  }
  _etq = { ids, i: 0, auto: !!auto, abort: null, actual: null };
  $('#cmpModal').innerHTML = '<div class="box card" style="max-width:480px"><div id="etqBody"></div></div>';
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = null; // no cerrar por fuera
  procesarEtq();
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
  pintarEtq(doc, r, 'esperando');
  const abort = new AbortController();
  _etq.abort = abort;
  try {
    const uid = await escribirNFC(recs, id, abort.signal, false);
    if (gen !== _etqGen) return;
    await etqTrasGrabar(doc, r, uid, url, gen);
  } catch (e) {
    if (gen !== _etqGen) return;
    if (e && e.code === 'OCUPADA') {
      _etq.pend = { recs, id, url };
      pintarEtq(doc, r, 'ocupada', e.prev);
      return;
    }
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
// SOBRESCRIBIR (confirmado) la etiqueta ocupada del documento actual.
async function etqSobrescribir() {
  if (!_etq || !_etq.pend || !_etq.actual) return;
  const { recs, id, url } = _etq.pend;
  _etq.pend = null;
  const { doc, r } = _etq.actual;
  const gen = ++_etqGen;
  const abort = new AbortController();
  _etq.abort = abort;
  pintarEtq(doc, r, 'esperando');
  try {
    const uid = await escribirNFC(recs, id, abort.signal, true);
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
async function etqSoloEnlace() {
  if (!_etq || !_etq.actual) return;
  const { doc, r, url } = _etq.actual;
  const gen = ++_etqGen;
  const abort = new AbortController();
  _etq.abort = abort;
  pintarEtq(doc, r, 'esperando');
  try {
    const uid = await escribirNFC(
      [
        { recordType: 'url', data: url },
        { recordType: 'text', data: EX_LIBRIS },
      ],
      doc._id,
      abort.signal,
      true,
    );
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
  } else if (estado === 'ocupada') {
    est = `<span style="color:var(--warn)">⚠️ Esta etiqueta YA está grabada${extra && extra.titulo ? ` de «${esc(recortar(extra.titulo, 30))}»` : extra && extra.docId ? ' de OTRO libro' : ' (datos ajenos)'}. ¿Libro equivocado?</span>`;
    bot = `<button class="btn pri" id="etqSobre">Sobrescribir</button>` + cS + cX;
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
  w('etqSobre', etqSobrescribir);
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
    #p-ubic .ubamb{border:1px solid var(--line);border-radius:11px;margin-bottom:10px;overflow:hidden;background:var(--card)}
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
  <div class="card">${arbol.length ? arbol.map(ubicAmbHTML).join('') : '<div class="muted">Aún no hay ubicaciones. Crea estanterías arriba, o asigna libros desde la Búsqueda (📍 Estantería).</div>'}</div>
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
  const nfc = a.nfc ? ` <span title="NFC ${esc(a.nfc)}">📶</span>` : '';
  const acts = `<span class="ubacts">${ubBtn('amb-add', a.ambito, null, '➕', 'Añadir estantería')}${ubBtn('amb-ren', a.ambito, null, '✏️', 'Renombrar ámbito')}${ubBtn('amb-nfc', a.ambito, null, '📶', 'Grabar NFC del ámbito')}${ubBtn('amb-explotar', a.ambito, null, '🧹', 'Sus libros → sin ubicación')}${ubBtn('amb-del', a.ambito, null, '🗑', 'Eliminar (si está vacío)')}</span>`;
  const ests = a.estanterias.length
    ? a.estanterias.map((e) => ubicEstHTML(a.ambito, e)).join('')
    : `<div class="ubrow ubest"><span class="muted" style="font-size:12px">— sin estanterías —</span></div>`;
  return `<div class="ubamb"><div class="ubrow ubhdr"><span class="ubx" data-act="amb-fold" data-a="${esc(a.ambito)}" title="Plegar/desplegar" style="opacity:1;width:20px;text-align:center">${folded ? '▸' : '▾'}</span><b class="ubx" data-act="amb-ver" data-a="${esc(a.ambito)}" style="font-size:14px;opacity:1" title="Ver sus libros en la Búsqueda (interactivo)">📍 ${esc(a.ambito)}</b><span class="muted">${a.estanterias.length} estante(s) · ${a.n} libro(s)</span>${nfc}${acts}</div><div class="ubests"${folded ? ' style="display:none"' : ''}>${ests}</div></div>`;
}
function ubicEstHTML(amb, e) {
  const nfc = e.nfc ? ` <span title="NFC ${esc(e.nfc)}">📶</span>` : '';
  // Reordenar la ESTANTERÍA dentro del ámbito: ↑/↓ (fiable en móvil) — la fila también es arrastrable en
  // escritorio (wireUbic). El 📋 ordena los LIBROS de dentro por su posición física (feature distinta).
  const reord = `<span class="ubreord">${ubBtn('est-subir', amb, e.estanteria, '↑', 'Subir una posición')}${ubBtn('est-bajar', amb, e.estanteria, '↓', 'Bajar una posición')}</span>`;
  const acts = `<span class="ubacts">${ubBtn('est-orden', amb, e.estanteria, '📋', 'Ordenar los libros por su posición física')}${ubBtn('est-insertar', amb, e.estanteria, '➕', 'Insertar una estantería DEBAJO de esta')}${ubBtn('est-ren', amb, e.estanteria, '✏️', 'Renombrar')}${ubBtn('est-mover', amb, e.estanteria, '➡️', 'Mover a otro ámbito')}${ubBtn('est-fus', amb, e.estanteria, '🔀', 'Fusionar en otra estantería')}${ubBtn('est-nfc', amb, e.estanteria, '📶', 'Grabar NFC')}${ubBtn('est-explotar', amb, e.estanteria, '🧹', 'Libros → sin ubicación')}${ubBtn('est-del', amb, e.estanteria, '🗑', 'Eliminar (si vacía)')}</span>`;
  return `<div class="ubrow ubest" draggable="true" data-a="${esc(amb)}" data-e="${esc(e.estanteria)}">${reord}<span class="ubx" data-act="est-ver" data-a="${esc(amb)}" data-e="${esc(e.estanteria)}" style="opacity:1" title="Ver sus libros en la Búsqueda (interactivo)">📚 ${esc(e.estanteria)}</span><span class="muted">${e.n}</span>${nfc}${acts}</div>`;
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
      `<div class="card"><div class="sec-h" style="margin-bottom:8px"><h3 style="margin:0">📚 ${tit}</h3><span class="muted">${r.total} libro(s)</span></div>` +
      (r.docs.length
        ? `<div class="ubgrid">${r.docs.map(ubicCard).join('')}</div>${r.total > r.docs.length ? `<div class="muted" style="margin-top:10px">Mostrando ${r.docs.length} de ${r.total}. <a class="rowlink" id="ubVerBusq">Ver todos en Búsqueda →</a></div>` : ''}`
        : '<div class="muted">Sin libros en esta ubicación.</div>') +
      `</div>`;
    $$('#ubicLibros [data-doc]').forEach(
      (el) => (el.onclick = () => verDoc(el.dataset.doc, { volver: 'ubic', etiqueta: 'Ubicaciones' })),
    );
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
        `${r.n} doc(s) → ${r.ambito}${r.estanteria && r.estanteria !== 'Sin asignar' ? ' · ' + r.estanteria : ''}`,
      );
      selDocs.clear();
      buscarCatalogo(estadoBusqueda.page || 1);
    } catch (e) {
      $('#puErr').textContent = e.message;
    }
  };
}
// ── Página AUTORES ──────────────────────────────────────────────────────────────────────────────────
// Buscar autores, ver su ficha (foto/bio/libros) y COMBINAR duplicados (A→B): se mantiene el nombre de B,
// los de las A pasan a sus «también conocido como» y todos sus libros se reasignan a B. Es la versión
// INTERACTIVA de scripts/backfill-autores.js. Las mutaciones son solo admin (las exige el backend).
let _autores = []; // último listado recibido
const _autoresSel = new Set(); // ids marcados para combinar
let _autoresBuscarTimer = null; // debounce del buscador

async function loadAutores() {
  const cont = $('#p-autores');
  if (!cont) return;
  _autoresSel.clear();
  cont.innerHTML = `
    <div class="sec-h"><h2>Autores</h2></div>
    <div class="row" style="gap:8px;align-items:center;margin-bottom:12px;flex-wrap:wrap">
      <input id="autBuscar" placeholder="🔍 Buscar autor (nombre o variante)…" autocomplete="off" style="flex:1;min-width:220px" />
      <span id="autCombinaBar"></span>
    </div>
    <div id="autGrid" class="muted">Cargando…</div>`;
  const inp = $('#autBuscar');
  if (inp)
    inp.oninput = () => {
      clearTimeout(_autoresBuscarTimer);
      _autoresBuscarTimer = setTimeout(() => autoresBuscar(inp.value), 300);
    };
  autoresBuscar('');
}

async function autoresBuscar(q) {
  const grid = $('#autGrid');
  if (grid) grid.textContent = 'Cargando…';
  try {
    const r = await api('/autores?q=' + encodeURIComponent(q || ''));
    _autores = r.autores || [];
  } catch (e) {
    if (grid) grid.textContent = 'Error: ' + e.message;
    return;
  }
  autoresPintar();
}

function autoresPintar() {
  const grid = $('#autGrid');
  if (!grid) return;
  if (!_autores.length) {
    grid.innerHTML = '<div class="empty">Sin autores.</div>';
    autoresBarraCombinar();
    return;
  }
  grid.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px">${_autores
    .map(autorCard)
    .join('')}</div>`;
  grid.querySelectorAll('[data-aut]').forEach(
    (el) =>
      (el.onclick = (e) => {
        if (e.target.closest('[data-autchk]')) return; // clic en la casilla: no abre la ficha
        autorFicha(el.dataset.aut);
      }),
  );
  grid.querySelectorAll('[data-autchk]').forEach(
    (cb) =>
      (cb.onchange = () => {
        cb.checked ? _autoresSel.add(cb.dataset.autchk) : _autoresSel.delete(cb.dataset.autchk);
        autoresBarraCombinar();
      }),
  );
  autoresBarraCombinar();
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
  return `<div data-aut="${esc(a._id)}" class="card" style="display:flex;gap:10px;align-items:center;cursor:pointer;padding:10px${sel ? ';outline:2px solid var(--acc)' : ''}">
    <input type="checkbox" class="admin-only" data-autchk="${esc(a._id)}" ${sel ? 'checked' : ''} title="Seleccionar para combinar" style="width:16px;height:16px;flex:0 0 auto">
    ${foto}
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(a.nombre || '—')}</div>
      <div class="muted" style="font-size:12px">${a.n_libros} libro(s)${vida}</div>
      ${alt}
    </div></div>`;
}

// Barra de acción de «Combinar»: aparece al marcar 2+ autores.
function autoresBarraCombinar() {
  const bar = $('#autCombinaBar');
  if (!bar) return;
  const n = _autoresSel.size;
  bar.innerHTML =
    n >= 2
      ? `<button class="btn pri admin-only" id="autCombinar">🔗 Combinar ${n}…</button> <button class="btn" id="autSelClear">✕ deseleccionar</button>`
      : n === 1
        ? `<span class="muted" style="font-size:12px">1 marcado (marca 2+ para combinar)</span> <button class="btn" id="autSelClear">✕</button>`
        : '';
  if ($('#autCombinar')) $('#autCombinar').onclick = autorCombinar;
  if ($('#autSelClear'))
    $('#autSelClear').onclick = () => {
      _autoresSel.clear();
      autoresPintar();
    };
}

// Ficha de autor (modal): foto, datos (editables si admin) y sus libros (clic → ficha del libro).
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
  const foto = a.foto
    ? `<img src="${esc(encUrl(a.foto))}" style="width:110px;height:110px;object-fit:cover;border-radius:12px;background:var(--card)">`
    : `<div style="width:110px;height:110px;border-radius:12px;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:44px">👤</div>`;
  const alt = Array.isArray(a.nombres_alternativos) ? a.nombres_alternativos.join('; ') : '';
  // Datos: editables (admin) o de solo lectura (invitado).
  const campos = admin
    ? `<div><label>Nombre</label><input id="autNombre" value="${esc(a.nombre || '')}" autocomplete="off"></div>
       <div style="margin-top:6px"><label>También conocido como (separa con ;)</label><input id="autAlt" value="${esc(alt)}" autocomplete="off"></div>
       <div class="row" style="margin-top:6px">
         <div><label>Nacimiento</label><input id="autNac" value="${esc(a.nacimiento || '')}" inputmode="numeric" autocomplete="off"></div>
         <div><label>Fallecimiento</label><input id="autFall" value="${esc(a.fallecimiento || '')}" inputmode="numeric" autocomplete="off"></div>
       </div>
       <div style="margin-top:6px"><label>Biografía</label><textarea id="autBio" rows="4" style="width:100%;resize:vertical;font-family:inherit">${esc(a.biografia || '')}</textarea></div>`
    : `<h3 style="margin:0">${esc(a.nombre || '—')}</h3>
       ${alt ? `<div class="muted" style="font-size:12px;margin-top:4px">a.k.a. ${esc(alt)}</div>` : ''}
       ${a.nacimiento || a.fallecimiento ? `<div class="muted" style="font-size:12px;margin-top:4px">${a.nacimiento || '?'}–${a.fallecimiento || ''}</div>` : ''}
       ${a.biografia ? `<p class="sinopsis-text" style="margin-top:8px">${esc(a.biografia)}</p>` : ''}`;
  const librosHtml = libros.length
    ? `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:10px;margin-top:8px">${libros
        .map(
          (l) => `<div data-libro="${esc(l._id)}" title="${esc(l.titulo || '')}" style="cursor:pointer;text-align:center">
            ${l.portada ? `<img src="${esc(encUrl(l.portada))}" style="width:100%;height:118px;object-fit:contain;border-radius:6px;background:var(--card)" loading="lazy">` : `<div style="height:118px;border-radius:6px;background:var(--card);display:flex;align-items:center;justify-content:center;font-size:22px">📕</div>`}
            <div class="muted" style="font-size:10px;line-height:1.2;margin-top:2px">${esc(recortar(l.titulo || '—', 40))}${l['año_edicion'] ? ` · ${l['año_edicion']}` : ''}</div>
          </div>`,
        )
        .join('')}</div>`
    : '<div class="muted" style="font-size:12px;margin-top:6px">Sin libros asociados.</div>';
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:660px;max-height:92vh;overflow:auto">
    <div style="display:flex;gap:14px;flex-wrap:wrap">
      <div style="text-align:center">
        ${foto}
        ${admin ? `<div style="margin-top:6px"><button class="btn" id="autFoto">📷 Foto</button><input type="file" id="autFotoFile" accept="image/*" style="display:none"></div>` : ''}
      </div>
      <div style="flex:1;min-width:250px">${campos}</div>
    </div>
    <div style="margin-top:12px"><div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;font-weight:600">Libros (${libros.length})</div>${librosHtml}</div>
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
  $('#cmpModal')
    .querySelectorAll('[data-libro]')
    .forEach(
      (el) =>
        (el.onclick = () => {
          cerrarCmp();
          verDoc(el.dataset.libro, { volver: 'autores', etiqueta: 'Autores' });
        }),
    );
  if (admin) {
    if ($('#autFoto')) $('#autFoto').onclick = () => $('#autFotoFile').click();
    if ($('#autFotoFile')) $('#autFotoFile').onchange = () => autorSubirFoto(id, $('#autFotoFile'));
    if ($('#autGuardar')) $('#autGuardar').onclick = () => autorGuardar(id);
  }
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
  autoresBuscar(($('#autBuscar') && $('#autBuscar').value) || '');
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

// Combinar (A→B): elige entre los seleccionados cuál es el DESTINO (B, se conserva) y funde el resto en él.
function autorCombinar() {
  const ids = [..._autoresSel];
  if (ids.length < 2) return;
  const sel = ids.map((id) => _autores.find((a) => a._id === id)).filter(Boolean);
  // Por defecto, destino = el que más libros tiene (menos reasignaciones).
  const porDefecto = sel.slice().sort((a, b) => b.n_libros - a.n_libros)[0];
  const opciones = sel
    .map(
      (a) =>
        `<label style="display:flex;gap:8px;align-items:center;padding:6px;border-bottom:1px solid var(--line);cursor:pointer">
          <input type="radio" name="autDest" value="${esc(a._id)}" ${a._id === porDefecto._id ? 'checked' : ''}>
          <span style="flex:1">${esc(a.nombre)} <span class="muted" style="font-size:11px">· ${a.n_libros} libro(s)</span></span>
        </label>`,
    )
    .join('');
  $('#cmpModal').innerHTML = `<div class="box card" style="max-width:480px">
    <h3 style="margin-top:0">🔗 Combinar autores</h3>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Elige el autor que se CONSERVA (destino). El resto se fundirán en él: sus nombres pasarán a «también conocido como» y todos sus libros se reasignarán.</div>
    ${opciones}
    <div id="autCombMsg" class="muted" style="font-size:12px;margin-top:8px"></div>
    <div class="row" style="gap:8px;margin-top:12px;justify-content:flex-end">
      <button class="btn pri" id="autCombOk">🔗 Combinar</button>
      <button class="btn" id="autCombX">Cancelar</button>
    </div></div>`;
  $('#cmpScrim').style.display = 'block';
  $('#cmpModal').style.display = 'grid';
  $('#cmpScrim').onclick = cerrarCmp;
  $('#autCombX').onclick = cerrarCmp;
  $('#autCombOk').onclick = async () => {
    const destino = ($('#cmpModal input[name="autDest"]:checked') || {}).value;
    if (!destino) return;
    const msg = $('#autCombMsg');
    if (msg) msg.textContent = 'Combinando…';
    try {
      const r = await api('/autores/fusionar', { method: 'POST', body: JSON.stringify({ destino, ids }) });
      cerrarCmp();
      toast(`🔗 ${r.fusionados} fundido(s) en «${r.destino.nombre}» · ${r.reasignados} libro(s) reasignados`);
      _autoresSel.clear();
      autoresBuscar(($('#autBuscar') && $('#autBuscar').value) || '');
    } catch (e) {
      if (msg) msg.textContent = 'Error: ' + e.message;
    }
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
    return verDoc(id, { volver: 'search', etiqueta: 'Búsqueda' });
  }
  // Etiqueta de estantería (?amb=&est=) → abrir sus libros en la Búsqueda (disponible para invitados).
  if (_deepUbic) {
    const { amb, est } = _deepUbic;
    _deepUbic = null;
    estadoBusqueda.extra = {
      ambito: amb,
      estanteria: est || undefined,
      etiqueta: '📍 ' + amb + (est ? ' · ' + est : ''),
    };
    estadoBusqueda.page = 1;
    go('search');
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
  if (!TOKEN) return mostrarLogin();
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
