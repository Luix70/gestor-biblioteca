/**
 * DETECTOR DE PATRONES EN NOMBRES DE FICHERO → MAPEO A CAMPOS.
 *
 * Muchas colecciones se ingieren con TODOS los ficheros siguiendo un mismo esquema de nombre. Ejemplos reales:
 *   · «L035-(1914) Tacitus I Dialogue on Oratory Agricola Germania [Peterson]»
 *       código de colección (LO/L → «Loeb Classical Library») + nº · (año) · texto · [traductor a ignorar]
 *   · «9780674001565.Harvard_UP.Law_and_Social_Norms.Eric_A._Posner.Jan.2000»
 *       ISBN · editorial · título · autor · mes · año (posicional por «.»)
 *
 * Este módulo (funciones PURAS, sin IO) hace dos cosas:
 *   1) detectarPatron(nombres)      → propone un `patron` (marcadores + separador + posiciones) mirando la
 *                                      carpeta entera, con sugerencia de campo por parte y muestras.
 *   2) extraerCamposPorPatron(n, p) → aplica un `patron` a UN nombre y devuelve los campos, VALIDANDO cada uno
 *                                      (un ISBN que no valida, o un «autor» que parece una fecha, se DESCARTA).
 *
 * Filosofía (la fija el usuario): ORIENTATIVO y FLEXIBLE. El patrón nunca fuerza un dato inverosímil; y como el
 * resultado alimenta la fusión CONSERVADORA de la ingesta, el ISBN pivota (las APIs resuelven título/autor
 * reales) y lo demás rellena huecos. Reutiliza los validadores que ya existen (validarISBN con checksum,
 * esAutorArtefacto —que ya rechaza un año suelto como autor—, esTituloArtefacto, mesANumero).
 *
 * Forma del `patron` (lo que se guarda en _guia.json → guia.patron):
 *   {
 *     sep: '.'|' - '|'_'|'·'|' ',          // separador del RESTO (tras quitar marcadores)
 *     guionBajoEspacio: true,               // '_' → ' ' en los segmentos de texto
 *     isbn: true,  anio: true,  mes: true,  // extraer esos marcadores (a isbn / año_edicion / mes_publicacion)
 *     corchetes: 'ignorar'|'autor'|'titulo'|'editorial'|null,   // qué hacer con [texto]
 *     codigo: null | { campo:'coleccion'|'editorial', alias:{ 'LO':'Loeb Classical Library' }, numero:true },
 *     posiciones: { '0': { campo:'editorial', alias:{ 'Harvard UP':'Harvard University Press' } }, '1': {...} }
 *   }
 * Campos válidos de destino: ignorar · isbn · anio · mes · editorial · coleccion · coleccion_numero · titulo · autor
 */
import { validarISBN } from './identificadores.js';
import { esAutorArtefacto, esTituloArtefacto, mesANumero } from './parsear-nombre.js';

export const CAMPOS_PATRON = ['ignorar', 'isbn', 'anio', 'mes', 'editorial', 'coleccion', 'coleccion_numero', 'titulo', 'autor'];

// Año PLAUSIBLE de edición (no existe un validador dedicado; el resto del código usa (?:19|20)\d{2}, aquí se
// abre a 1400-2099 para incunables/clásicos como los Loeb). Un «año» fuera de rango se descarta.
export const esAnioPlausible = (n) => Number.isInteger(n) && n >= 1400 && n <= 2099;

const sinExt = (nombre) => String(nombre || '').replace(/\.[^.\s]{1,5}$/, '').trim();
const RE_ISBN = /\b(97[89][\s\-]?(?:\d[\s\-]?){9}\d|\d[\s\-]?(?:\d[\s\-]?){8}[\dXx])\b/;          // 13 o 10 «díg.»
const RE_ANIO_PAR = /\((1[4-9]\d{2}|20\d{2})\)/;                                                   // (1914)
const RE_ANIO = /\b(1[4-9]\d{2}|20\d{2})\b/;                                                       // 1914 suelto
const RE_CORCH = /\[([^\]]+)\]/;                                                                   // [Peterson]
const RE_CODIGO = /([A-Za-z]{1,4})[\s\-_]?0*(\d{1,4})\b/;                                           // L035 · LO045 (SIN ancla)
const SEPARADORES = ['.', ' - ', ' — ', ' · ', '·', '_', '-', ' '];
// Separadores «fuertes» de campo (mejor candidatos que «_», «-» o espacio, que suelen ir DENTRO de un campo).
const FUERZA_SEP = { '.': 3, ' - ': 4, ' — ': 4, ' · ': 4, '·': 2, '_': 1, '-': 1, ' ': 0 };

// Normaliza un segmento de texto (opcional: '_' → espacio, colapsa espacios/puntuación suelta de los bordes).
function limpiarSegmento(s, guionBajoEspacio) {
    let t = String(s || '');
    if (guionBajoEspacio) t = t.replace(/_/g, ' ');
    return t.replace(/\s+/g, ' ').replace(/^[\s.,;:_·\-]+|[\s.,;:_·\-]+$/g, '').trim();
}

// Aplica una tabla de ALIAS (código → valor real) a un valor, insensible a mayúsculas/espacios/guiones bajos.
function aplicarAlias(valor, alias) {
    if (!alias || typeof alias !== 'object') return valor;
    const clave = String(valor || '').trim().toLowerCase().replace(/[_\s]+/g, ' ');
    for (const [k, v] of Object.entries(alias)) {
        if (String(k).trim().toLowerCase().replace(/[_\s]+/g, ' ') === clave && String(v || '').trim()) return String(v).trim();
    }
    return valor;
}

// Localiza los MARCADORES en un nombre y devuelve { isbn, anio, mes, corchetes, codigo, numero, resto }.
// `resto` = el nombre con los marcadores QUITADOS (lo que luego se parte por el separador).
function localizarMarcadores(nombre) {
    let resto = ' ' + sinExt(nombre) + ' ';
    const out = { isbn: null, anio: null, mes: null, corchetes: null, codigo: null, numero: null };

    const isbnM = resto.match(RE_ISBN);
    if (isbnM) { const v = validarISBN(isbnM[0]); if (v) { out.isbn = v; resto = resto.replace(isbnM[0], ' '); } }

    const codM = resto.match(new RegExp('^\\s*' + RE_CODIGO.source));       // solo al INICIO (tras el padding)
    if (codM) { out.codigo = codM[1]; out.numero = String(parseInt(codM[2], 10)); resto = resto.replace(codM[0], ' '); }

    const anioP = resto.match(RE_ANIO_PAR);
    if (anioP) { out.anio = +anioP[1]; resto = resto.replace(anioP[0], ' '); }
    else { const a = resto.match(RE_ANIO); if (a && esAnioPlausible(+a[1])) { out.anio = +a[1]; resto = resto.replace(a[0], ' '); } }

    const corM = resto.match(RE_CORCH);
    if (corM) { out.corchetes = corM[1].trim(); resto = resto.replace(corM[0], ' '); }

    // Mes suelto (Jan, enero…): se busca token a token para no confundir con parte de una palabra.
    for (const tok of resto.split(/[\s.\-_·]+/)) {
        const m = mesANumero(tok);
        if (m) { out.mes = m; resto = resto.replace(new RegExp('\\b' + tok.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b'), ' '); break; }
    }

    // Limpia separadores colgantes que dejan los marcadores al quitarse (p. ej. el «-» tras «L035-»).
    out.resto = resto.replace(/\s+/g, ' ').replace(/^[\s.,;:_·\-–—]+|[\s.,;:_·\-–—]+$/g, '').trim();
    return out;
}

// Parte el `resto` por un separador dado en segmentos de texto NO vacíos. `sep` null = NO partir (todo el resto
// es UN segmento). Con `gbe` (guionBajoEspacio: «_» son espacios), un «.» seguido de «_» es una INICIAL dentro
// del campo (p. ej. «Eric_A._Posner»), no un separador → se parte por «.» que NO va seguido de «_».
function partirResto(resto, sep, gbe = false) {
    if (sep == null) { const t = String(resto || '').trim(); return t ? [t] : []; }
    let trozos;
    if (sep === '.' && gbe) trozos = String(resto).split(/\.(?!_)/);
    else if (sep === ' ') trozos = String(resto).split(/\s+/);
    else trozos = String(resto).split(sep);
    return trozos.map((t) => t.trim()).filter(Boolean);
}

// Elige el SEPARADOR del resto: el que da un nº de segmentos más CONSISTENTE (misma cuenta en la mayoría) y > 1,
// prefiriendo separadores «fuertes» de campo. `excluir` quita candidatos (p. ej. «_»/espacio cuando son espacios
// dentro del campo). Si ninguno cuaja, devuelve sep=null (un solo segmento = el resto).
function elegirSeparador(restos, excluir = [], gbe = false) {
    let mejor = { sep: null, score: -1, cuenta: 1 };
    for (const sep of SEPARADORES) {
        if (excluir.includes(sep)) continue;
        const cuentas = restos.map((r) => partirResto(r, sep, gbe).length).filter((n) => n > 0);
        if (!cuentas.length) continue;
        const moda = cuentas.sort((a, b) => cuentas.filter((x) => x === a).length - cuentas.filter((x) => x === b).length).pop();
        if (moda < 2) continue;                                   // un solo trozo no es un patrón posicional
        const consistentes = cuentas.filter((n) => n === moda).length / cuentas.length;
        const score = consistentes * 100 + (FUERZA_SEP[sep] || 0) * 3 + Math.min(moda, 8); // consistencia ≫ fuerza ≫ nº campos
        if (score > mejor.score) mejor = { sep, score, cuenta: moda };
    }
    return mejor;
}

// Heurística de SUGERENCIA de campo para un segmento posicional, según sus valores de muestra.
function sugerirCampoPosicion(valores) {
    const v = valores.filter(Boolean);
    if (!v.length) return 'ignorar';
    const casan = (re) => v.filter((x) => re.test(x)).length / v.length;
    // Editorial: siglas «_UP», «UP», «Press», «Verlag», «Ediciones/Editorial …».
    if (casan(/(?:^|[\s_])(UP|Press|Verlag|Editions?|Ediciones|Editorial|Books|Univ)\b/i) >= 0.5) return 'editorial';
    // Autor: parece «Nombre Apellido» (2-4 palabras capitalizadas, con iniciales «A.»), poco frecuente que sea título.
    if (casan(/^[A-ZÁÉÍÓÚÑ][\wáéíóúñ.'-]*([ _][A-ZÁÉÍÓÚÑ][\wáéíóúñ.'-]*){1,3}$/) >= 0.6) return 'autor';
    return 'titulo';
}

/**
 * DETECTA un patrón mirando la carpeta entera. `nombres` = nombres de fichero (con extensión).
 * Devuelve { patron, segmentos, muestras }:
 *   · patron: propuesta editable (ver forma arriba).
 *   · segmentos: [{ pos, sugerencia, valores:[muestra], codigos:[distintos] }] para pintar la tabla del editor.
 *   · muestras: los primeros nombres (para la vista previa en vivo).
 */
export function detectarPatron(nombres) {
    const lista = (Array.isArray(nombres) ? nombres : []).map(sinExt).filter(Boolean);
    if (lista.length < 2) return null;                            // hace falta más de un fichero para inferir

    const marcs = lista.map(localizarMarcadores);
    const frac = (pred) => marcs.filter(pred).length / marcs.length;
    const guionBajoEspacio = frac((m) => /_/.test(m.resto)) >= 0.5;

    // Si «_» son espacios dentro del campo, ni «_» ni el espacio pueden ser separadores DE CAMPO → se excluyen.
    const sepSel = elegirSeparador(marcs.map((m) => m.resto), guionBajoEspacio ? ['_', ' '] : [], guionBajoEspacio);
    const sep = sepSel.sep;

    // Segmentos posicionales: valores por posición (hasta la moda de cuenta).
    const nCols = sepSel.cuenta;
    const porPos = Array.from({ length: nCols }, () => []);
    for (const m of marcs) {
        const seg = partirResto(m.resto, sep, guionBajoEspacio);
        if (seg.length !== nCols) continue;                       // solo los que casan la cuenta modal
        seg.forEach((s, i) => porPos[i].push(limpiarSegmento(s, guionBajoEspacio)));
    }
    const segmentos = porPos.map((valores, pos) => ({
        pos, valores: valores.slice(0, 5), sugerencia: sugerirCampoPosicion(valores),
    }));

    // Marcadores presentes en la mayoría → activarlos por defecto.
    const patron = {
        sep, guionBajoEspacio,
        isbn: frac((m) => m.isbn) >= 0.5,
        anio: frac((m) => m.anio != null) >= 0.5,
        mes: frac((m) => m.mes != null) >= 0.5,
        corchetes: frac((m) => m.corchetes) >= 0.5 ? 'ignorar' : null,      // por defecto se IGNORA (traductor…)
        codigo: frac((m) => m.codigo) >= 0.5
            ? { campo: 'coleccion', alias: {}, numero: frac((m) => m.numero != null) >= 0.5 }
            : null,
        posiciones: {},
    };
    // Mapea cada posición a su sugerencia (salvo 'ignorar', que se deja sin asignar para que el usuario decida).
    segmentos.forEach((s) => { if (s.sugerencia && s.sugerencia !== 'ignorar') patron.posiciones[String(s.pos)] = { campo: s.sugerencia, alias: {} }; });

    // Códigos distintos vistos (para que el usuario mapee «LO» → «Loeb Classical Library»).
    const codigos = [...new Set(marcs.map((m) => m.codigo).filter(Boolean))];

    return { patron, segmentos, codigos, muestras: lista.slice(0, 6) };
}

/**
 * APLICA un `patron` a UN nombre de fichero y devuelve los campos extraídos, VALIDANDO cada uno. Nunca lanza;
 * devuelve solo lo verosímil. Campos posibles: { titulo, autores, isbn, año_edicion, editorial, coleccion_nombre,
 * coleccion_numero, mes_publicacion }. Un campo que no supera su validación se OMITE (no se inventa).
 */
export function extraerCamposPorPatron(nombre, patron) {
    const out = {};
    if (!patron || typeof patron !== 'object') return out;
    const m = localizarMarcadores(nombre);
    const gbe = patron.guionBajoEspacio !== false;

    // ── Marcadores ──
    if (patron.isbn && m.isbn) out.isbn = m.isbn;                                 // ya validado (checksum) en localizar
    if (patron.anio && m.anio != null && esAnioPlausible(m.anio)) out.año_edicion = m.anio;
    if (patron.mes && m.mes != null) out.mes_publicacion = m.mes;
    if (patron.codigo && m.codigo) {
        const nombreVal = String(aplicarAlias(m.codigo, patron.codigo.alias) || '').trim();
        if (nombreVal && !/^\d+$/.test(nombreVal)) {                              // el código expandido no puede ser un número
            if (patron.codigo.campo === 'editorial') out.editorial = nombreVal;
            else out.coleccion_nombre = nombreVal;
        }
        if (patron.codigo.numero !== false && m.numero != null) out.coleccion_numero = m.numero;
    }
    if (patron.corchetes && patron.corchetes !== 'ignorar' && m.corchetes) {
        asignarCampo(out, patron.corchetes, m.corchetes, { gbe });
    }

    // ── Posiciones del resto ──
    const seg = partirResto(m.resto, patron.sep === undefined ? ' ' : patron.sep, gbe);
    for (const [idx, regla] of Object.entries(patron.posiciones || {})) {
        const i = Number(idx);
        if (!regla || !regla.campo || regla.campo === 'ignorar' || !(i in seg)) continue;
        asignarCampo(out, regla.campo, seg[i], { gbe, alias: regla.alias });
    }
    return out;
}

// Asigna un valor a un campo del resultado, con la VALIDACIÓN propia de cada campo (descarta lo inverosímil).
// `bruto` es el segmento SIN limpiar (para poder ver los «__» de título/subtítulo antes de pasar «_»→espacio).
function asignarCampo(out, campo, bruto, { gbe = true, alias = null } = {}) {
    const limpio = () => aplicarAlias(limpiarSegmento(bruto, gbe), alias);
    switch (campo) {
        case 'isbn': { const ok = validarISBN(limpio()); if (ok) out.isbn = ok; break; }  // solo si pasa checksum
        case 'anio': { const n = parseInt(limpio(), 10); if (esAnioPlausible(n)) out.año_edicion = n; break; }
        case 'mes': { const v = limpio(); const mm = mesANumero(v) || (/^\d{1,2}$/.test(v) && +v >= 1 && +v <= 12 ? +v : 0); if (mm) out.mes_publicacion = mm; break; }
        case 'editorial': { const v = limpio(); if (v) out.editorial = v; break; }        // libre (aliaseable)
        case 'coleccion': { const v = limpio(); if (v && !/^\d+$/.test(v)) out.coleccion_nombre = v; break; }
        case 'coleccion_numero': { const n = String(bruto).match(/\d{1,4}/); if (n) out.coleccion_numero = String(parseInt(n[0], 10)); break; }
        case 'titulo': {
            // «__» (con guionBajoEspacio) separa TÍTULO :: SUBTÍTULO; «_» son espacios normales.
            const partes = gbe ? String(bruto).split(/_{2,}/) : [String(bruto)];
            const tit = limpiarSegmento(partes[0], gbe);
            if (tit && !esTituloArtefacto(tit) && (tit.match(/[a-záéíóúñü]/gi) || []).length >= 2) {
                out.titulo = tit;
                if (partes.length > 1) { const sub = limpiarSegmento(partes.slice(1).join(' '), gbe); if (sub && !esTituloArtefacto(sub)) out.subtitulo = sub; }
            }
            break;
        }
        case 'autor': { const v = limpio(); if (v && !esAutorArtefacto(v)) out.autores = [...(out.autores || []), v]; break; } // «Jan 2002» → descartado
        default: break;
    }
}
