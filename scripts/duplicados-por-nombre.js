/**
 * DUPLICADOS POR NOMBRE (dentro de la MISMA carpeta) — localiza documentos que son la MISMA obra representada con
 * nombres que solo difieren en cosas COSMÉTICAS o de CODIFICACIÓN, y propone quedarse con el más grande, enviando
 * el resto a una papelera (nunca borra). NO son duplicados por hash (esos ya se depuraron): aquí el criterio es el
 * NOMBRE, comparado con cuidado para NO fusionar tomos de una serie.
 *
 * QUÉ CUENTA COMO DUPLICADO (mismo formato, misma carpeta):
 *   · Nombres IDÉNTICOS tras normalizar lo cosmético: minúsculas, sin acentos, corchetes/llaves → paréntesis
 *     ([Retail]=(Retail)), guiones unicode → '-', extensión en minúsculas (.PDF=.pdf).
 *   · Nombres iguales salvo CARACTERES PERDIDOS por codificación ('?' o '�'), que se tratan como COMODÍN: solo
 *     casan si la LONGITUD coincide y las diferencias están SOLO en esas posiciones (con un tope). Así
 *     «…750–940…» = «…750?940…» y «Aršāma» = «Ar??ma».
 * QUÉ NO (para no perder únicos): cualquier diferencia en un carácter REAL (un dígito, una letra, un romano) →
 *   NO se agrupan. Por eso «Volume I/II/III» y «Book 24/25» quedan SIEMPRE separados. Sin similitud difusa.
 *
 * CUÁL SE CONSERVA: el de MAYOR TAMAÑO (empate → el de nombre «limpio» sin ?/�, luego el más corto, luego alfabético).
 *
 * FLUJO (nunca borra; papelera conservando la estructura de carpetas):
 *   1) node scripts/duplicados-por-nombre.js "<carpeta>"            → escribe el PLAN «_plan-duplicados.json» en la
 *      raíz (preselección conservar/eliminar + tamaños) y lo resume por consola. NO toca nada.
 *   2) Revisa/edita el plan (cambia «accion»: "conservar" | "eliminar" en los ficheros que quieras).
 *   3) node scripts/duplicados-por-nombre.js "<carpeta>" --ejecutar → lee el plan y MUEVE los "eliminar" a
 *      «_papelera-duplicados/<misma ruta relativa>» (recuperable). Solo mueve si en su grupo queda un "conservar".
 */
import fs from 'fs/promises';
import path from 'path';

import { pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const RAIZ = args.find((a) => !a.startsWith('--'));
const PLAN_FICHERO = '_plan-duplicados.json';
const PAPELERA = '_papelera-duplicados';
const MAX_COMODIN = 0.25; // los '?' (pérdida de codificación) no pueden ser más del 25% del nombre

const existe = (p) => fs.access(p).then(() => true, () => false);
const tieneRarezas = (n) => /[?�]/.test(n);
const tieneRetail = (n) => /\b(retail|official|oficial)\b/i.test(n);

// Marcadores COSMÉTICOS de formato/procedencia que NO forman parte del título: si un grupo entre (), [] o {}
// contiene SOLO estos (p. ej. «[Retail]», «(ebook)», «[True PDF]», «[z-lib]»), se quita para comparar. Si el
// grupo tiene algo con SIGNIFICADO (un número, un año, «Book 24», «Volume II», un nombre de serie…), se CONSERVA.
const MARCA_TOK = new Set(['retail', 'ebook', 'epub', 'mobi', 'azw', 'azw3', 'kindle', 'pdf', 'true', 'scan', 'scanned', 'ocr', 'drm', 'complete', 'completo', 'official', 'oficial', 'libgen', 'zlib', 'zlibrary', 'annas', 'anna', 'kobo', 'calibre', 'nook', 'repack', 'hq']);
const MARCA_FRASE = new Set(['z lib', 'z library', 'true pdf', 'annas archive', 'anna s archive', 'ebook retail', 'retail ebook']);
function quitarMarcadores(s) {
    return s.replace(/[([{]([^)\]}]*)[)\]}]/g, (grupo, dentro) => {
        const limpio = dentro.replace(/[\s,.+/|·&_-]+/g, ' ').trim(); // separadores → espacio
        if (!limpio) return ' ';
        if (MARCA_FRASE.has(limpio)) return ' ';
        const toks = limpio.split(' ').filter(Boolean);
        return toks.every((t) => MARCA_TOK.has(t)) ? ' ' : grupo; // solo marcadores → fuera; algo con sentido → se queda
    });
}

// Caracteres INVISIBLES / de formato que hay que ELIMINAR (basura que no se ve pero rompe la comparacion):
// ancho cero (ZWSP/ZWNJ/ZWJ), union de palabra, BOM, guion suave, separador mongol. Y espacios unicode "raros"
// (no-separable, finos, ideografico). Construidas con new RegExp + \u para no meter bytes invisibles en el fuente.
const INVISIBLES = new RegExp('[\\u200B\\u200C\\u200D\\u2060\\uFEFF\\u00AD\\u180E]', 'g');
const ESPACIOS_RAROS = new RegExp('[\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]', 'g');
const COMBINANTES = new RegExp('[\\u0300-\\u036F]', 'g');              // diacriticos combinantes (tras NFKD)
const COMILLAS_S = new RegExp('[\\u2018\\u2019\\u201B\\u2032]', 'g');  // apostrofos/comillas simples curvas -> '
const COMILLAS_D = new RegExp('[\\u201C\\u201D\\u201E\\u2033]', 'g');  // comillas dobles curvas -> "
const REEMPLAZO = new RegExp('\\uFFFD', 'g');                          // caracter de reemplazo -> ?
const GUIONES = new RegExp('[\\u2013\\u2014\\u2212]', 'g');            // guiones unicode (en/em/menos) -> '-'
const PUNTUACION_COSMETICA = new RegExp('[.,;:_\\u00B7]+', 'g');       // . , ; : _ · -> espacio (diferencias cosmeticas)

// Nombre BASE (sin extension) normalizado a lo COSMETICO. Conserva numeros, romanos y palabras (para no fusionar
// tomos). Deja '?' como marca de caracter perdido (se compara como comodin en mismaObra). Robusto frente a
// caracteres invisibles, espacios unicode y comillas curvas (basura que no se ve pero impide agrupar).
function normBase(base) {
    let s = base
        .normalize('NFKD').replace(COMBINANTES, '')          // compatibilidad (ligaduras, ancho completo) + sin acentos
        .replace(INVISIBLES, '')                             // elimina caracteres invisibles/de formato
        .replace(ESPACIOS_RAROS, ' ')                        // espacios unicode -> espacio normal
        .replace(COMILLAS_S, "'")                            // comillas/apostrofos simples curvos -> '
        .replace(COMILLAS_D, '"')                            // comillas dobles curvas -> "
        .replace(REEMPLAZO, '?')                             // caracter de reemplazo -> ?
        .replace(GUIONES, '-')                               // guiones unicode -> '-'
        .toLowerCase();
    s = quitarMarcadores(s);                                 // quita [Retail], (ebook), etc. (anotaciones cosmeticas)
    return s
        .replace(/[\[{]/g, '(').replace(/[\]}]/g, ')')       // corchetes/llaves restantes -> parentesis (cosmetico)
        .replace(PUNTUACION_COSMETICA, ' ')                  // «Título. Subtítulo» = «Título Subtítulo» (punto/coma/…)
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-]+|[\s\-]+$/g, '')                   // recorta espacios/guiones sueltos que deja el hueco
        .trim();
}
const formatoDe = (nombre) => path.extname(nombre).slice(1).toLowerCase();

const esLetra = (ch) => /\p{L}/u.test(ch);                         // letra (cualquier alfabeto)
const esSimboloRaro = (ch) => !/[\p{L}\p{N}\s]/u.test(ch);        // ni letra, ni dígito, ni espacio → símbolo

// ¿Dos nombres YA normalizados representan la misma obra? Idénticos, o iguales salvo posiciones con '?' (carácter
// perdido) o una letra corrompida en un símbolo (p. ej. «ø»→«°»), con misma longitud y pocos comodines. Una
// diferencia REAL entre dos alfanuméricos (dígito↔dígito, letra↔letra) → false: así los tomos y las series
// («Book 24» vs «Book 25», «Volume I» vs «Volume II», «(1998)» vs «(2003)») NUNCA se fusionan.
function mismaObra(a, b) {
    if (a === b) return { dup: true, criterio: 'idéntico' };
    if (a.length !== b.length) return { dup: false };
    let comodines = 0;
    for (let i = 0; i < a.length; i++) {
        if (a[i] === b[i]) continue;
        if (a[i] === '?' || b[i] === '?') { comodines++; continue; } // uno perdió el carácter (?) → comodín
        if ((esSimboloRaro(a[i]) && esLetra(b[i])) || (esLetra(a[i]) && esSimboloRaro(b[i]))) { comodines++; continue; } // letra ↔ símbolo (corrupción)
        return { dup: false };                                       // difieren en un carácter real → NO
    }
    if (comodines && comodines <= Math.max(1, Math.floor(a.length * MAX_COMODIN))) return { dup: true, criterio: 'comodín' };
    return { dup: false };
}

// Elige el fichero a CONSERVAR de un grupo: mayor tamaño → (empate) el marcado «Retail»/oficial → nombre limpio
// (sin ?/�) → más corto → alfabético. El tamaño manda; ante igualdad, se prefiere la edición Retail/oficial.
function elegirConservado(archivos) {
    return [...archivos].sort((x, y) =>
        (y.tamano - x.tamano) ||
        ((tieneRetail(y.nombre) ? 1 : 0) - (tieneRetail(x.nombre) ? 1 : 0)) ||
        ((tieneRarezas(x.nombre) ? 1 : 0) - (tieneRarezas(y.nombre) ? 1 : 0)) ||
        (x.nombre.length - y.nombre.length) ||
        x.nombre.localeCompare(y.nombre),
    )[0];
}

/** Recorre el árbol y, POR CARPETA, agrupa los ficheros del MISMO formato que son la misma obra (≥2 = duplicados). */
async function buscarGrupos(raiz) {
    const grupos = [];
    const rec = async (dir) => {
        let ents;
        try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        // Ficheros directos de esta carpeta (excluye la propia papelera y el plan).
        const ficheros = [];
        for (const e of ents) {
            if (e.isDirectory()) { if (e.name !== PAPELERA) await rec(path.join(dir, e.name)); continue; }
            if (e.name === PLAN_FICHERO) continue;
            const abs = path.join(dir, e.name);
            const st = await fs.stat(abs).catch(() => null);
            if (st) ficheros.push({ nombre: e.name, tamano: st.size, norm: normBase(e.name.slice(0, e.name.length - path.extname(e.name).length)) });
        }
        // Agrupa por formato y, dentro, por «misma obra» (greedy contra el representante del grupo).
        const porFmt = new Map();
        for (const f of ficheros) { const k = formatoDe(f.nombre); (porFmt.get(k) || porFmt.set(k, []).get(k)).push(f); }
        for (const [fmt, arr] of porFmt) {
            const usados = new Array(arr.length).fill(false);
            for (let i = 0; i < arr.length; i++) {
                if (usados[i]) continue;
                const grupo = [arr[i]]; usados[i] = true; let criterio = 'idéntico';
                for (let j = i + 1; j < arr.length; j++) {
                    if (usados[j]) continue;
                    const r = mismaObra(arr[i].norm, arr[j].norm);
                    if (r.dup) { grupo.push(arr[j]); usados[j] = true; if (r.criterio === 'comodín') criterio = 'comodín'; }
                }
                if (grupo.length >= 2) grupos.push({ carpeta: path.relative(raiz, dir) || '.', formato: fmt, criterio, archivos: grupo });
            }
        }
    };
    await rec(raiz);
    return grupos;
}

const humano = (b) => b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';

// ── Informe HTML interactivo (casillas) ─────────────────────────────────────
// Se escribe junto al plan («_plan-duplicados.html»). Muestra los grupos con casillas: lo marcado ✖ se elimina
// (va a la papelera), lo desmarcado ✔ se conserva. Permite editar y DESCARGAR el «_plan-duplicados.json» ya
// corregido para sustituir el de la carpeta y luego ejecutar --ejecutar. Autocontenido (sin red, sin CDNs).
const CSS_HTML = `
:root{--bg:#f6f4ef;--surface:#fffdfa;--ink:#2a2730;--muted:#746f7b;--line:#e7e2d9;--del:#b83856;--del-bg:rgba(184,56,86,.10);--keep:#2f8f6b;--keep-bg:rgba(47,143,107,.09);--warn:#b8791f;--accent:#b83856}
@media (prefers-color-scheme:dark){:root{--bg:#141218;--surface:#201d25;--ink:#ece8f0;--muted:#a09aa8;--line:#332e3a;--del:#e07290;--del-bg:rgba(224,114,144,.15);--keep:#57c39a;--keep-bg:rgba(87,195,154,.13);--warn:#e0a94a;--accent:#e07290}}
:root[data-theme=light]{--bg:#f6f4ef;--surface:#fffdfa;--ink:#2a2730;--muted:#746f7b;--line:#e7e2d9;--del:#b83856;--del-bg:rgba(184,56,86,.10);--keep:#2f8f6b;--keep-bg:rgba(47,143,107,.09);--warn:#b8791f;--accent:#b83856}
:root[data-theme=dark]{--bg:#141218;--surface:#201d25;--ink:#ece8f0;--muted:#a09aa8;--line:#332e3a;--del:#e07290;--del-bg:rgba(224,114,144,.15);--keep:#57c39a;--keep-bg:rgba(87,195,154,.13);--warn:#e0a94a;--accent:#e07290}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.top{position:sticky;top:0;z-index:5;display:flex;flex-wrap:wrap;align-items:center;gap:16px;padding:14px 20px;background:var(--surface);border-bottom:1px solid var(--line)}
.brand h1{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em}
.eyebrow{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);font-weight:600}
.stats{display:flex;gap:8px;flex-wrap:wrap;margin-left:auto}
.stat{display:flex;flex-direction:column;padding:4px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);line-height:1.2}
.stat b{font-size:16px;font-variant-numeric:tabular-nums}
.stat small{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted)}
.stat.del b{color:var(--del)}
.acciones{display:flex;gap:8px;flex-wrap:wrap}
.btn{font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.btn.primary:disabled{opacity:.45;cursor:not-allowed}
.ayuda{max-width:74ch;margin:16px 20px 4px;color:var(--muted);font-size:13px}
.ayuda code{background:var(--del-bg);padding:1px 5px;border-radius:5px;color:var(--ink);font-size:12px}
.aviso{margin:8px 20px;padding:10px 14px;border-radius:10px;background:var(--del-bg);border:1px solid var(--del);color:var(--del);font-weight:600;font-size:13px}
#lista{display:flex;flex-direction:column;gap:14px;padding:12px 20px 60px;max-width:1120px}
.vacio{color:var(--muted);padding:30px;text-align:center}
.grupo{border:1px solid var(--line);border-radius:14px;background:var(--surface);overflow:hidden}
.grupo.invalido{border-color:var(--del);box-shadow:0 0 0 1px var(--del)}
.ghead{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 14px;border-bottom:1px solid var(--line)}
.badge.fmt{font-size:11px;font-weight:700;letter-spacing:.05em;padding:2px 8px;border-radius:6px;background:var(--ink);color:var(--surface)}
.carpeta{font-weight:600;word-break:break-word}
.crit{font-size:12px;color:var(--muted)}
.gacc{margin-left:auto;display:flex;gap:6px}
.gacc button{font:inherit;font-size:11px;color:var(--muted);background:none;border:1px solid var(--line);border-radius:7px;padding:3px 8px;cursor:pointer}
.gacc button:hover{color:var(--ink);border-color:var(--muted)}
.files{list-style:none;margin:0;padding:6px}
.file label{display:grid;grid-template-columns:auto auto auto 1fr;align-items:center;gap:12px;padding:8px 10px;border-radius:9px;cursor:pointer}
.file+.file{margin-top:2px}
.file.elim label{background:var(--del-bg)}
.file.keep label{background:var(--keep-bg)}
.file input{width:17px;height:17px;accent-color:var(--del);cursor:pointer}
.chip{font-size:11px;font-weight:700;letter-spacing:.02em;min-width:84px}
.file.elim .chip{color:var(--del)}
.file.keep .chip{color:var(--keep)}
.size{font-variant-numeric:tabular-nums;color:var(--muted);text-align:right;min-width:64px;font-size:13px}
.name{word-break:break-word}
.name .warn{color:var(--warn);font-weight:700}
@media (max-width:640px){.file label{grid-template-columns:auto 1fr;gap:6px}.chip,.size{grid-column:2}.stats{margin-left:0;width:100%}}
`;
const BODY_HTML = `
<header class="top">
  <div class="brand"><div class="eyebrow">Gestor de biblioteca · limpieza</div><h1>Duplicados por nombre</h1></div>
  <div class="stats" id="stats"></div>
  <div class="acciones">
    <label class="btn" title="Cargar otro _plan-duplicados.json">Cargar plan…<input type="file" id="file" accept=".json,application/json" hidden></label>
    <button class="btn" id="reset" type="button">Restablecer</button>
    <button class="btn primary" id="download" type="button">Descargar plan editado</button>
  </div>
</header>
<p class="ayuda">Marcado <b>✖</b> = se envía a la papelera · sin marcar <b>✔</b> = se conserva. Preselección: se conserva el <b>más grande</b> de cada grupo. Cada grupo mantiene al menos una copia. Edita a tu gusto, pulsa <b>Descargar plan editado</b>, sustituye con él el <code>_plan-duplicados.json</code> de la carpeta y ejecuta <code>--ejecutar</code>.</p>
<div class="aviso" id="aviso" hidden></div>
<main id="lista"></main>
`;
// OJO: este JS se incrusta tal cual en el HTML → sin literales de plantilla ni backticks (para poder guardarlo dentro
// de un backtick en Node). Usa concatenación y createElement (a prueba de nombres con caracteres raros).
const APP_JS = `
(function(){
  var $=function(s){return document.querySelector(s);};
  var ORIG=window.PLAN||null, plan=ORIG, estados=[];
  function humano(b){return b>=1048576?(b/1048576).toFixed(1)+' MB':Math.round(b/1024)+' KB';}
  function construirEstados(p){estados=(p&&p.grupos?p.grupos:[]).map(function(g){return g.archivos.map(function(a){return a.accion==='eliminar';});});}
  function idxMayor(g){var m=0;for(var i=1;i<g.archivos.length;i++){if((g.archivos[i].tamano||0)>(g.archivos[m].tamano||0))m=i;}return m;}
  function boton(txt,fn){var b=document.createElement('button');b.type='button';b.textContent=txt;b.addEventListener('click',fn);return b;}
  function statEl(val,label,cls){var d=document.createElement('div');d.className='stat'+(cls?' '+cls:'');var b=document.createElement('b');b.textContent=val;var s=document.createElement('small');s.textContent=label;d.appendChild(b);d.appendChild(s);return d;}
  function pintarFila(li,gi,ai){var del=!!estados[gi][ai];li.classList.toggle('elim',del);li.classList.toggle('keep',!del);li.querySelector('.chip').textContent=del?'✖ eliminar':'✔ conservar';}
  function setGrupo(gi,marcar){var g=plan.grupos[gi];var may=idxMayor(g);g.archivos.forEach(function(a,ai){estados[gi][ai]=marcar?ai!==may:false;});render();}
  function render(){
    var lista=$('#lista');lista.textContent='';
    if(!plan||!plan.grupos||!plan.grupos.length){var v=document.createElement('div');v.className='vacio';v.textContent='No hay grupos de duplicados en el plan.';lista.appendChild(v);recompute();return;}
    plan.grupos.forEach(function(g,gi){
      var sec=document.createElement('section');sec.className='grupo';sec.setAttribute('data-g',gi);
      var head=document.createElement('div');head.className='ghead';
      var fmt=document.createElement('span');fmt.className='badge fmt';fmt.textContent=(g.formato||'?').toUpperCase();head.appendChild(fmt);
      var carp=document.createElement('span');carp.className='carpeta';carp.textContent=g.carpeta==='.'?'(raíz)':g.carpeta;head.appendChild(carp);
      var crit=document.createElement('span');crit.className='crit';crit.textContent='coincidencia: '+(g.criterio||'');head.appendChild(crit);
      var acc=document.createElement('span');acc.className='gacc';
      acc.appendChild(boton('marcar todo menos el mayor',function(){setGrupo(gi,true);}));
      acc.appendChild(boton('no eliminar nada',function(){setGrupo(gi,false);}));
      head.appendChild(acc);sec.appendChild(head);
      var ul=document.createElement('ul');ul.className='files';
      g.archivos.forEach(function(a,ai){
        var li=document.createElement('li');li.className='file';
        var lab=document.createElement('label');
        var cb=document.createElement('input');cb.type='checkbox';cb.checked=!!estados[gi][ai];
        cb.addEventListener('change',function(){estados[gi][ai]=cb.checked;pintarFila(li,gi,ai);recompute();});
        var chip=document.createElement('span');chip.className='chip';
        var size=document.createElement('span');size.className='size';size.textContent=a.tamano_h||humano(a.tamano||0);
        var name=document.createElement('span');name.className='name';name.textContent=a.nombre;
        if(a.rareza){var w=document.createElement('span');w.className='warn';w.title='nombre con caracteres extraños (?/'+String.fromCharCode(65533)+')';w.textContent=' ⚠';name.appendChild(w);}
        lab.appendChild(cb);lab.appendChild(chip);lab.appendChild(size);lab.appendChild(name);
        li.appendChild(lab);ul.appendChild(li);pintarFila(li,gi,ai);
      });
      sec.appendChild(ul);lista.appendChild(sec);
    });
    recompute();
  }
  function recompute(){
    var grupos=plan&&plan.grupos?plan.grupos.length:0,elim=0,bytes=0,inval=0;
    if(plan&&plan.grupos)plan.grupos.forEach(function(g,gi){
      var keepers=0;g.archivos.forEach(function(a,ai){if(estados[gi][ai]){elim++;bytes+=(a.tamano||0);}else keepers++;});
      if(keepers===0)inval++;
      var sec=document.querySelector('.grupo[data-g=\"'+gi+'\"]');if(sec)sec.classList.toggle('invalido',keepers===0);
    });
    var st=$('#stats');st.textContent='';st.appendChild(statEl(grupos,'grupos'));st.appendChild(statEl(elim,'a eliminar','del'));st.appendChild(statEl(humano(bytes),'a liberar'));
    var av=$('#aviso');
    if(inval){av.hidden=false;av.textContent='⚠ '+inval+' grupo(s) sin ninguna copia conservada — no se puede eliminar toda copia. Desmarca al menos uno en cada uno.';$('#download').disabled=true;}
    else{av.hidden=true;$('#download').disabled=false;}
  }
  function descargar(){
    var out={generado:plan.generado||null,raiz:plan.raiz,papelera:plan.papelera,criterio:plan.criterio,grupos:[]},elim=0,bytes=0;
    plan.grupos.forEach(function(g,gi){
      var archivos=g.archivos.map(function(a,ai){
        var accion=estados[gi][ai]?'eliminar':'conservar';if(accion==='eliminar'){elim++;bytes+=(a.tamano||0);}
        var o={nombre:a.nombre,tamano:a.tamano,tamano_h:a.tamano_h,accion:accion};if(a.rareza)o.rareza=true;if(accion==='conservar')o.motivo='elegido en la revisión';return o;
      });
      out.grupos.push({carpeta:g.carpeta,formato:g.formato,criterio:g.criterio,archivos:archivos});
    });
    out.resumen={grupos:plan.grupos.length,a_eliminar:elim,espacio_a_liberar_h:humano(bytes)};
    var blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});
    var url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='_plan-duplicados.json';document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }
  var fi=$('#file');if(fi)fi.addEventListener('change',function(e){var f=e.target.files[0];if(!f)return;var r=new FileReader();r.onload=function(){try{plan=JSON.parse(r.result);ORIG=plan;construirEstados(plan);render();}catch(err){alert('No pude leer el plan: '+err.message);}};r.readAsText(f);});
  $('#reset').addEventListener('click',function(){if(!ORIG)return;plan=ORIG;construirEstados(plan);render();});
  $('#download').addEventListener('click',descargar);
  if(plan)construirEstados(plan);render();
})();
`;
function construirHTML(plan) {
    const datos = JSON.stringify(plan).replace(/</g, '\\u003c'); // no romper </script> con nombres raros
    return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Duplicados por nombre — plan de limpieza</title><style>' + CSS_HTML + '</style></head><body>'
        + BODY_HTML + '<script>window.PLAN=' + datos + ';</script><script>' + APP_JS + '</script></body></html>';
}

async function generar(raiz) {
    console.log(`\nDuplicados por nombre — GENERAR PLAN · carpeta: ${raiz}\n`);
    process.stdout.write('Explorando el árbol… ');
    const grupos = await buscarGrupos(raiz);
    process.stdout.write('hecho.\n');
    if (!grupos.length) { console.log('No se han encontrado duplicados por nombre. Nada que planificar.'); process.exit(0); }

    let aEliminar = 0, bytes = 0;
    const plan = { generado: null, raiz, papelera: PAPELERA, criterio: 'conservar el MÁS GRANDE; revisa y edita «accion» antes de --ejecutar', grupos: [] };
    for (const g of grupos) {
        const conservado = elegirConservado(g.archivos);
        const archivos = g.archivos.map((f) => {
            const accion = f === conservado ? 'conservar' : 'eliminar';
            if (accion === 'eliminar') { aEliminar++; bytes += f.tamano; }
            return { nombre: f.nombre, tamano: f.tamano, tamano_h: humano(f.tamano), rareza: tieneRarezas(f.nombre) || undefined, accion, motivo: accion === 'conservar' ? 'el más grande' : undefined };
        });
        plan.grupos.push({ carpeta: g.carpeta, formato: g.formato, criterio: g.criterio, archivos });
    }
    plan.resumen = { grupos: grupos.length, a_eliminar: aEliminar, espacio_a_liberar_h: humano(bytes) };

    const rutaPlan = path.join(raiz, PLAN_FICHERO);
    await fs.writeFile(rutaPlan, JSON.stringify(plan, null, 2), 'utf8');
    const rutaHtml = path.join(raiz, '_plan-duplicados.html');
    await fs.writeFile(rutaHtml, construirHTML(plan), 'utf8');

    // Resumen legible por consola (una muestra; el detalle completo está en el plan).
    console.log(`\nGrupos de duplicados: ${grupos.length} · a eliminar: ${aEliminar} · espacio a liberar: ${humano(bytes)}\n`);
    for (const g of plan.grupos.slice(0, 20)) {
        console.log(`  [${g.formato}] ${g.carpeta}   (${g.criterio})`);
        for (const a of g.archivos) console.log(`     ${a.accion === 'conservar' ? '✔ CONSERVA' : '✖ elimina '} ${a.tamano_h.padStart(8)}  ${a.rareza ? '⚠ ' : '  '}${a.nombre}`);
    }
    if (plan.grupos.length > 20) console.log(`  … y ${plan.grupos.length - 20} grupos más (todos en el plan).`);
    console.log(`\n📄 Plan (JSON):  ${rutaPlan}`);
    console.log(`🌐 Revisión con casillas (ábrelo en el navegador):  ${rutaHtml}`);
    console.log('   Marca/desmarca lo que quieras y pulsa «Descargar plan editado» → sustituye el JSON de la carpeta.');
    console.log('   O edita el JSON a mano (campo «accion»: "conservar" | "eliminar"). Luego, para aplicarlo:');
    console.log(`   node scripts/duplicados-por-nombre.js "${raiz}" --ejecutar`);
    process.exit(0);
}

/** Nombre libre en la papelera (sufijo « (2)» si ya existe), sin pisar nada. */
async function rutaLibre(p) {
    const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
    let q = p;
    for (let n = 2; await existe(q); n++) q = path.join(dir, `${base} (${n})${ext}`);
    return q;
}

async function ejecutar(raiz) {
    const rutaPlan = path.join(raiz, PLAN_FICHERO);
    let plan;
    try { plan = JSON.parse(await fs.readFile(rutaPlan, 'utf8')); }
    catch { console.error(`No encuentro/leo el plan «${rutaPlan}». Genera primero el plan (sin --ejecutar).`); process.exit(1); }
    console.log(`\nDuplicados por nombre — EJECUTAR PLAN · ${rutaPlan}\n`);

    let movidos = 0, saltados = 0, bytes = 0;
    for (const g of plan.grupos || []) {
        const carpetaAbs = path.join(raiz, g.carpeta);
        const conservar = (g.archivos || []).filter((a) => a.accion === 'conservar');
        const eliminar = (g.archivos || []).filter((a) => a.accion === 'eliminar');
        // SEGURIDAD: no se toca el grupo si no quedaría al menos un "conservar" existente (no borrar la última copia).
        const hayConservadoVivo = (await Promise.all(conservar.map((a) => existe(path.join(carpetaAbs, a.nombre))))).some(Boolean);
        if (!hayConservadoVivo) { for (const a of eliminar) { saltados++; console.log(`  ⚠ SALTADO (sin copia conservada viva): ${path.join(g.carpeta, a.nombre)}`); } continue; }
        for (const a of eliminar) {
            const src = path.join(carpetaAbs, a.nombre);
            if (!await existe(src)) { continue; } // ya no está (¿movido antes?) → nada que hacer
            const dst = await rutaLibre(path.join(raiz, PAPELERA, g.carpeta, a.nombre)); // papelera conservando estructura
            await fs.mkdir(path.dirname(dst), { recursive: true });
            await fs.rename(src, dst);
            movidos++; bytes += (a.tamano || 0);
            console.log(`  ✖→papelera  ${path.join(g.carpeta, a.nombre)}`);
        }
    }
    console.log(`\n${'═'.repeat(60)}\nRESUMEN`);
    console.log(`  Movidos a la papelera: ${movidos} · espacio liberado: ${humano(bytes)}${saltados ? ` · saltados: ${saltados}` : ''}`);
    console.log(`  Papelera (recuperable): ${path.join(raiz, PAPELERA)}`);
    process.exit(0);
}

// Se ejecuta solo si se invoca como script (no al importarlo para tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (!RAIZ) {
        console.error('Uso: node scripts/duplicados-por-nombre.js "<carpeta>" [--ejecutar]');
        process.exit(1);
    }
    (EJECUTAR ? ejecutar(path.resolve(RAIZ)) : generar(path.resolve(RAIZ))).catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
}

export { normBase, mismaObra, formatoDe, elegirConservado, buscarGrupos, construirHTML };
