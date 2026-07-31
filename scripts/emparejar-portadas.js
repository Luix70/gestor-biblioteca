#!/usr/bin/env node
/**
 * emparejar-portadas.js — Empareja las imágenes de una carpeta «Covers» con documentos YA catalogados (por
 * NOMBRE, difuso, ignorando la extensión) y pone cada imagen como PORTADA del documento correspondiente dentro
 * del árbol CDU. La portada que tuviera el documento NO se borra: baja a «otra» en el carrusel (se conserva,
 * solo se desplaza). La imagen original de Covers se mueve a «Covers/_emparejadas/» (recuperable).
 *
 * Ejemplo: «20 Home Strength Training … 2021.jpg» (en Covers) ↔ doc cuyo fichero es «…2021.pdf» → la imagen
 * pasa a ser la portada de ese documento.
 *
 * EMPAREJADO seguro (reutiliza normBase/mismaObra de duplicados-por-nombre.js): tolera mayúsculas, acentos,
 * corchetes, marcadores ([Retail]…), puntuación, guiones, invisibles y caracteres corruptos; pero NO fusiona
 * series/tomos (un número o una letra distinta lo impide). Una imagen que casa con VARIOS documentos, o varias
 * imágenes que casan con el MISMO documento → «ambiguo» (no se asigna solo; se revisa a mano).
 *
 * Flujo (mismo patrón que duplicados-por-nombre): PLAN EDITABLE primero.
 *   1) node scripts/emparejar-portadas.js "<Covers>"            → escribe «_plan-portadas.json» + «_plan-portadas.html»
 *      (revisión con casillas) en la carpeta Covers. NO toca nada.
 *   2) Revisa/edita el plan (casillas «asignar»/«omitir», o el campo «accion» del JSON).
 *   3) node scripts/emparejar-portadas.js "<Covers>" --ejecutar → aplica el plan.
 *
 * ⚠ Antes de --ejecutar: COPIA DE SEGURIDAD de la BD (actualiza documentos: portada + carrusel).
 * Debe correr donde están los ficheros y la BD (el NAS): docker exec -t gestor-biblioteca node scripts/…
 */
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import '../src/config.js';
import { normBase, mismaObra } from './duplicados-por-nombre.js';

const RE_IMG = /\.(jpe?g|png|webp)$/i;
const PLAN_JSON = '_plan-portadas.json';
const PLAN_HTML = '_plan-portadas.html';
const DIR_EMPAREJADAS = '_emparejadas';

const existe = (p) => fs.access(p).then(() => true, () => false);
const humano = (b) => (b >= 1 << 20 ? (b / (1 << 20)).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB');

// ── Emparejado (función PURA, testeable sin BD ni disco) ─────────────────────
const baseSinExt = (nombre) => nombre.slice(0, nombre.length - path.extname(nombre).length);
// Clave FLEXIBLE (agresiva) solo para acotar candidatos: parte de normBase (ya pliega marcadores/puntuación/
// invisibles/'?') y deja solo alfanumérico ASCII → así imagen y doc caen en el MISMO cubo aunque uno traiga
// «[Retail]», un punto o un carácter perdido. mismaObra confirma después con toda la lógica (y la seguridad).
const claveFlexible = (textoSinExt) => normBase(textoSinExt).replace(/[^a-z0-9]/g, '');
// Texto identificador del doc para casar: su nombre de fichero (sin extensión) o, si no lo tiene, el título.
const textoDoc = (d) => (d.nombre_archivo ? baseSinExt(d.nombre_archivo) : d.titulo || '');

/**
 * Empareja imágenes ↔ documentos por nombre. Devuelve {emparejamientos, ambiguos, sin_coincidencia}.
 *   imagenes: [{ nombre, tamano }]   ·   docs: [{ _id, titulo, nombre_archivo, ... }]
 * 1:1 confirmado → emparejamiento. Imagen→varios docs o varias imágenes→mismo doc → ambiguo (nunca automático).
 */
export function construirEmparejamientos(imagenes, docs) {
    const cubos = new Map(); // claveFlexible → [docs]
    for (const d of docs) {
        const t = textoDoc(d);
        if (!t) continue;
        const k = claveFlexible(t);
        if (!k) continue;
        (cubos.get(k) || cubos.set(k, []).get(k)).push(d);
    }
    const empar = [], ambiguos = [], sin = [];
    const porDoc = new Map(); // doc_id → [emparejamiento] (para detectar varias imágenes al mismo doc)
    for (const img of imagenes) {
        const nb = normBase(baseSinExt(img.nombre));
        const bucket = cubos.get(claveFlexible(baseSinExt(img.nombre))) || [];
        const matches = bucket.filter((d) => mismaObra(nb, normBase(textoDoc(d))).dup);
        if (!matches.length) { sin.push(img); continue; }
        if (matches.length > 1) { ambiguos.push({ img, candidatos: matches, motivo: 'la imagen casa con varios documentos' }); continue; }
        const e = { img, doc: matches[0], criterio: mismaObra(nb, normBase(textoDoc(matches[0]))).criterio };
        const id = String(matches[0]._id);
        (porDoc.get(id) || porDoc.set(id, []).get(id)).push(e);
        empar.push(e);
    }
    // Varias imágenes → mismo documento: no se puede decidir cuál es la portada → todas a ambiguos.
    const conflictivo = new Set([...porDoc].filter(([, es]) => es.length > 1).map(([id]) => id));
    const limpios = [];
    for (const e of empar) {
        if (conflictivo.has(String(e.doc._id))) {
            if (!ambiguos.some((a) => a.img === e.img)) ambiguos.push({ img: e.img, candidatos: [e.doc], motivo: 'varias imágenes apuntan al mismo documento' });
        } else limpios.push(e);
    }
    return { emparejamientos: limpios, ambiguos, sin_coincidencia: sin };
}

// ── Recorrido de la carpeta Covers ──────────────────────────────────────────
async function listarImagenes(raiz) {
    const out = [];
    const rec = async (dir) => {
        let ents;
        try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
        for (const e of ents) {
            if (e.isDirectory()) { if (e.name !== DIR_EMPAREJADAS) await rec(path.join(dir, e.name)); continue; }
            if (!RE_IMG.test(e.name)) continue;
            const abs = path.join(dir, e.name);
            const st = await fs.stat(abs).catch(() => null);
            if (st) out.push({ nombre: e.name, rel: path.relative(raiz, abs), tamano: st.size });
        }
    };
    await rec(raiz);
    return out;
}

// ── FASE 1: generar el plan ──────────────────────────────────────────────────
async function generar(covers) {
    const { conectarDB } = await import('../src/database.js');
    const { carpetaDeDoc, webDeDoc } = await import('../src/mantenimiento/util-mantenimiento.js');
    console.log(`\nEmparejar portadas — GENERAR PLAN · Covers: ${covers}\n`);
    process.stdout.write('Leyendo imágenes… ');
    const imagenes = await listarImagenes(covers);
    process.stdout.write(`${imagenes.length} imagen(es).\n`);
    if (!imagenes.length) { console.log('No hay imágenes en la carpeta. Nada que hacer.'); process.exit(0); }

    process.stdout.write('Cargando documentos de la BD… ');
    const db = await conectarDB();
    const docs = await db.collection('biblioteca')
        .find({}, { projection: { titulo: 1, nombre_archivo: 1, portada: 1, ruta_base: 1, cdu: 1, tipo_recurso: 1, isbn: 1, issn: 1, año_edicion: 1, mes_publicacion: 1, obra: 1, isbn_obra: 1, obra_titulo: 1, volumen_numero: 1 } })
        .toArray();
    process.stdout.write(`${docs.length} documento(s).\n`);

    const { emparejamientos, ambiguos, sin_coincidencia } = construirEmparejamientos(imagenes, docs);

    // Enriquece cada emparejamiento con carpeta/portada actual (y comprueba que la carpeta exista en disco).
    const plan = { generado: null, covers, plan_html: PLAN_HTML, emparejamientos: [], ambiguos: [], sin_coincidencia: [] };
    for (const e of emparejamientos) {
        const carpeta = carpetaDeDoc(e.doc);
        const hayCarpeta = await existe(carpeta);
        plan.emparejamientos.push({
            imagen: e.img.rel, imagen_tamano: e.img.tamano, imagen_tamano_h: humano(e.img.tamano),
            doc_id: String(e.doc._id), doc_titulo: e.doc.titulo || '(sin título)',
            doc_nombre_archivo: e.doc.nombre_archivo || null,
            carpeta_rel: path.relative(process.cwd(), carpeta), carpeta_existe: hayCarpeta,
            portada_actual: e.doc.portada ? path.basename(String(e.doc.portada)) : null,
            criterio: e.criterio,
            accion: hayCarpeta ? 'asignar' : 'omitir',
            motivo: hayCarpeta ? undefined : 'la carpeta del documento no existe en esta máquina',
        });
    }
    for (const a of ambiguos) plan.ambiguos.push({ imagen: a.img.rel, imagen_tamano_h: humano(a.img.tamano), motivo: a.motivo, candidatos: a.candidatos.map((d) => ({ doc_id: String(d._id), doc_titulo: d.titulo || '(sin título)' })) });
    for (const s of sin_coincidencia) plan.sin_coincidencia.push({ imagen: s.rel, imagen_tamano_h: humano(s.tamano) });
    const aAsignar = plan.emparejamientos.filter((e) => e.accion === 'asignar').length;
    plan.resumen = { imagenes: imagenes.length, emparejadas: plan.emparejamientos.length, a_asignar: aAsignar, ambiguos: plan.ambiguos.length, sin_coincidencia: plan.sin_coincidencia.length };

    await fs.writeFile(path.join(covers, PLAN_JSON), JSON.stringify(plan, null, 2), 'utf8');
    await fs.writeFile(path.join(covers, PLAN_HTML), construirHTML(plan), 'utf8');

    console.log(`\nEmparejadas: ${plan.emparejamientos.length} (a asignar: ${aAsignar}) · ambiguas: ${plan.ambiguos.length} · sin coincidencia: ${plan.sin_coincidencia.length}\n`);
    for (const e of plan.emparejamientos.slice(0, 20)) console.log(`  ${e.accion === 'asignar' ? '✔ asigna ' : '· omite  '} ${e.imagen_tamano_h.padStart(8)}  ${e.imagen}\n        → ${e.doc_titulo}${e.portada_actual ? `  (desplaza: ${e.portada_actual})` : '  (sin portada previa)'}`);
    if (plan.emparejamientos.length > 20) console.log(`  … y ${plan.emparejamientos.length - 20} más (todas en el plan).`);
    console.log(`\n📄 Plan (JSON):  ${path.join(covers, PLAN_JSON)}`);
    console.log(`🌐 Revisión con casillas:  ${path.join(covers, PLAN_HTML)}`);
    console.log(`   Edítalo y luego:  node scripts/emparejar-portadas.js "${covers}" --ejecutar`);
    process.exit(0);
}

// ── FASE 2: ejecutar el plan ─────────────────────────────────────────────────
const extMime = (ext) => (ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : 'jpeg');
async function rutaLibre(p) {
    const dir = path.dirname(p), ext = path.extname(p), base = path.basename(p, ext);
    let q = p;
    for (let n = 2; await existe(q); n++) q = path.join(dir, `${base} (${n})${ext}`);
    return q;
}

async function ejecutar(covers) {
    const { conectarDB } = await import('../src/database.js');
    const { anadirImagen } = await import('../src/utils/imagenes-doc.js');
    const rutaPlan = path.join(covers, PLAN_JSON);
    let plan;
    try { plan = JSON.parse(await fs.readFile(rutaPlan, 'utf8')); }
    catch { console.error(`No encuentro/leo el plan «${rutaPlan}». Genera primero el plan (sin --ejecutar).`); process.exit(1); }
    console.log(`\nEmparejar portadas — EJECUTAR PLAN · ${rutaPlan}\n`);

    const db = await conectarDB();
    const aAsignar = (plan.emparejamientos || []).filter((e) => e.accion === 'asignar');
    let hechas = 0, fallos = 0;
    for (let i = 0; i < aAsignar.length; i++) {
        const e = aAsignar[i];
        const marca = `[${i + 1}/${aAsignar.length}]`;
        const src = path.join(covers, e.imagen);
        try {
            if (!(await existe(src))) { console.log(`${marca} ⚠ ya no está la imagen: ${e.imagen}`); fallos++; continue; }
            const buf = await fs.readFile(src);
            const ext = path.extname(src).slice(1).toLowerCase();
            const b64 = `data:image/${extMime(ext)};base64,${buf.toString('base64')}`;
            const r = await anadirImagen(db, e.doc_id, b64, { comoPortada: true }); // entra como portada; la previa baja a «otra»
            if (!r || r.ok === false) { console.log(`${marca} ✗ ${e.doc_titulo}: ${r?.motivo || 'no aplicado'}`); fallos++; continue; }
            // Mueve la imagen original de Covers a _emparejadas/ (conservando su ruta relativa) — recuperable.
            const dst = await rutaLibre(path.join(covers, DIR_EMPAREJADAS, e.imagen));
            await fs.mkdir(path.dirname(dst), { recursive: true });
            await fs.rename(src, dst).catch(async () => { await fs.copyFile(src, dst); await fs.rm(src); });
            hechas++;
            console.log(`${marca} ✔ ${e.imagen}  →  ${e.doc_titulo}`);
        } catch (err) { console.log(`${marca} ✗ ${e.imagen}: ${err.message}`); fallos++; }
    }
    console.log(`\n${'═'.repeat(60)}\nRESUMEN`);
    console.log(`  Portadas asignadas: ${hechas}${fallos ? ` · fallos/omitidas: ${fallos}` : ''}`);
    console.log(`  Imágenes usadas movidas a: ${path.join(covers, DIR_EMPAREJADAS)}`);
    process.exit(0);
}

// ── Informe HTML interactivo (casillas) ─────────────────────────────────────
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
.stat.keep b{color:var(--keep)}
.acciones{display:flex;gap:8px;flex-wrap:wrap}
.btn{font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--ink);cursor:pointer}
.btn:hover{border-color:var(--muted)}
.btn.primary{background:var(--accent);border-color:var(--accent);color:#fff}
.ayuda{max-width:78ch;margin:16px 20px 4px;color:var(--muted);font-size:13px}
.ayuda code{background:var(--del-bg);padding:1px 5px;border-radius:5px;color:var(--ink);font-size:12px}
h2.sec{margin:22px 20px 6px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
#lista{display:flex;flex-direction:column;gap:8px;padding:6px 20px 40px;max-width:1120px}
.par{border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:10px 12px;display:grid;grid-template-columns:auto 1fr;gap:12px;align-items:start}
.par.omite{opacity:.55}
.par input{width:17px;height:17px;margin-top:3px;accent-color:var(--keep);cursor:pointer}
.par .cuerpo{min-width:0}
.par .img{font-weight:600;word-break:break-word}
.par .flecha{color:var(--muted)}
.par .doc{margin-top:2px}
.par .meta{font-size:12px;color:var(--muted);margin-top:2px}
.par .crit{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;padding:1px 6px;border-radius:5px;background:var(--keep-bg);color:var(--keep);margin-left:6px}
.par .desplaza{color:var(--warn)}
.info{margin:2px 20px;max-width:1120px;color:var(--muted);font-size:13px}
.info .fila{padding:6px 12px;border:1px dashed var(--line);border-radius:9px;margin-bottom:6px;background:var(--surface)}
.info b{color:var(--ink)}
@media (max-width:640px){.stats{margin-left:0;width:100%}}
`;
const BODY_HTML = `
<header class="top">
  <div class="brand"><div class="eyebrow">Gestor de biblioteca · portadas</div><h1>Emparejar portadas</h1></div>
  <div class="stats" id="stats"></div>
  <div class="acciones">
    <label class="btn" title="Cargar otro _plan-portadas.json">Cargar plan…<input type="file" id="file" accept=".json,application/json" hidden></label>
    <button class="btn" id="reset" type="button">Restablecer</button>
    <button class="btn primary" id="download" type="button">Descargar plan editado</button>
  </div>
</header>
<p class="ayuda">Marcado ✔ = la imagen se pone como <b>portada</b> del documento (la portada anterior se conserva, solo se desplaza). Sin marcar = se omite. Edita a tu gusto, pulsa <b>Descargar plan editado</b>, sustituye con él el <code>_plan-portadas.json</code> de la carpeta y ejecuta <code>--ejecutar</code>. Los <b>ambiguos</b> y <b>sin coincidencia</b> son informativos (no se asignan solos).</p>
<main id="lista"></main>
`;
const APP_JS = `
(function(){
  var $=function(s){return document.querySelector(s);};
  var ORIG=window.PLAN||null, plan=ORIG, estados=[];
  function construirEstados(p){estados=((p&&p.emparejamientos)||[]).map(function(e){return e.accion==='asignar';});}
  function statEl(v,l,cls){var d=document.createElement('div');d.className='stat'+(cls?' '+cls:'');var b=document.createElement('b');b.textContent=v;var s=document.createElement('small');s.textContent=l;d.appendChild(b);d.appendChild(s);return d;}
  function h2(t){var e=document.createElement('h2');e.className='sec';e.textContent=t;return e;}
  function render(){
    var lista=$('#lista');lista.textContent='';
    var emp=(plan&&plan.emparejamientos)||[];
    if(emp.length){lista.appendChild(h2('Emparejamientos ('+emp.length+')'));}
    emp.forEach(function(e,i){
      var row=document.createElement('div');row.className='par';
      var cb=document.createElement('input');cb.type='checkbox';cb.checked=!!estados[i];
      cb.addEventListener('change',function(){estados[i]=cb.checked;row.classList.toggle('omite',!cb.checked);recompute();});
      var cuerpo=document.createElement('div');cuerpo.className='cuerpo';
      var img=document.createElement('div');img.className='img';img.textContent=e.imagen+'  ('+ (e.imagen_tamano_h||'') +')';
      var doc=document.createElement('div');doc.className='doc';
      var fl=document.createElement('span');fl.className='flecha';fl.textContent='→ ';
      doc.appendChild(fl);doc.appendChild(document.createTextNode(e.doc_titulo||''));
      if(e.criterio){var c=document.createElement('span');c.className='crit';c.textContent=e.criterio;doc.appendChild(c);}
      var meta=document.createElement('div');meta.className='meta';
      var txt='carpeta: '+(e.carpeta_rel||'?');
      if(e.portada_actual){meta.appendChild(document.createTextNode(txt+' · '));var w=document.createElement('span');w.className='desplaza';w.textContent='desplaza: '+e.portada_actual;meta.appendChild(w);}
      else{meta.textContent=txt+' · (sin portada previa)';}
      if(e.carpeta_existe===false){var w2=document.createElement('div');w2.className='meta desplaza';w2.textContent='⚠ '+(e.motivo||'carpeta no encontrada');meta.appendChild(w2);}
      cuerpo.appendChild(img);cuerpo.appendChild(doc);cuerpo.appendChild(meta);
      row.appendChild(cb);row.appendChild(cuerpo);row.classList.toggle('omite',!estados[i]);
      lista.appendChild(row);
    });
    var amb=(plan&&plan.ambiguos)||[];
    if(amb.length){lista.appendChild(h2('Ambiguos — revísalos tú ('+amb.length+')'));var box=document.createElement('div');box.className='info';
      amb.forEach(function(a){var f=document.createElement('div');f.className='fila';var b=document.createElement('b');b.textContent=a.imagen;f.appendChild(b);f.appendChild(document.createTextNode('  — '+(a.motivo||'')+': '+(a.candidatos||[]).map(function(c){return c.doc_titulo;}).join(' | ')));box.appendChild(f);});
      lista.appendChild(box);}
    var sin=(plan&&plan.sin_coincidencia)||[];
    if(sin.length){lista.appendChild(h2('Sin coincidencia ('+sin.length+')'));var box2=document.createElement('div');box2.className='info';
      sin.forEach(function(s){var f=document.createElement('div');f.className='fila';f.textContent=s.imagen;box2.appendChild(f);});
      lista.appendChild(box2);}
    recompute();
  }
  function recompute(){
    var emp=(plan&&plan.emparejamientos)||[];
    var asignar=estados.filter(Boolean).length;
    var st=$('#stats');st.textContent='';
    st.appendChild(statEl(((plan&&plan.resumen&&plan.resumen.imagenes)||emp.length),'imágenes'));
    st.appendChild(statEl(asignar,'a asignar','keep'));
    st.appendChild(statEl(((plan&&plan.ambiguos)||[]).length,'ambiguos'));
    st.appendChild(statEl(((plan&&plan.sin_coincidencia)||[]).length,'sin match'));
  }
  function descargar(){
    var out={generado:plan.generado||null,covers:plan.covers,plan_html:plan.plan_html,emparejamientos:[],ambiguos:plan.ambiguos||[],sin_coincidencia:plan.sin_coincidencia||[]};
    var asignar=0;
    (plan.emparejamientos||[]).forEach(function(e,i){var o={};for(var k in e)o[k]=e[k];o.accion=estados[i]?'asignar':'omitir';if(estados[i])asignar++;out.emparejamientos.push(o);});
    out.resumen={imagenes:(plan.resumen&&plan.resumen.imagenes)||out.emparejamientos.length,emparejadas:out.emparejamientos.length,a_asignar:asignar,ambiguos:out.ambiguos.length,sin_coincidencia:out.sin_coincidencia.length};
    var blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});
    var url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='_plan-portadas.json';document.body.appendChild(a);a.click();a.remove();
    setTimeout(function(){URL.revokeObjectURL(url);},1000);
  }
  var fi=$('#file');if(fi)fi.addEventListener('change',function(ev){var f=ev.target.files[0];if(!f)return;var r=new FileReader();r.onload=function(){try{plan=JSON.parse(r.result);ORIG=plan;construirEstados(plan);render();}catch(err){alert('No pude leer el plan: '+err.message);}};r.readAsText(f);});
  $('#reset').addEventListener('click',function(){if(!ORIG)return;plan=ORIG;construirEstados(plan);render();});
  $('#download').addEventListener('click',descargar);
  if(plan)construirEstados(plan);render();
})();
`;
function construirHTML(plan) {
    const datos = JSON.stringify(plan).replace(/</g, '\\u003c');
    return '<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>Emparejar portadas — plan</title><style>' + CSS_HTML + '</style></head><body>'
        + BODY_HTML + '<script>window.PLAN=' + datos + ';</script><script>' + APP_JS + '</script></body></html>';
}

export { construirHTML };

// ── Arranque ─────────────────────────────────────────────────────────────────
const __args = process.argv.slice(2);
const EJECUTAR = __args.includes('--ejecutar');
const COVERS = __args.find((a) => !a.startsWith('--'));
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    if (!COVERS) { console.error('Uso: node scripts/emparejar-portadas.js "<carpeta Covers>" [--ejecutar]'); process.exit(1); }
    const covers = path.resolve(COVERS);
    (EJECUTAR ? ejecutar(covers) : generar(covers)).catch((e) => { console.error('ERROR FATAL:', e); process.exit(1); });
}
