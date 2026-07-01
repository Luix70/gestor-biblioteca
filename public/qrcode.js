/*
 * Generador de códigos QR — modo BYTE (UTF-8), nivel de corrección M, versiones 1..10.
 * SIN dependencias y OFFLINE (el panel es una PWA que funciona sin red en el NAS Atom).
 * Basado en el algoritmo estándar ISO/IEC 18004 (misma lógica que la librería de Project Nayuki, MIT).
 * Suficiente para URLs de compartir (~150 bytes → versión 8). Uso:
 *     var qr = qrGenerar("https://…?s=…");
 *     qr.size;            // nº de módulos por lado (incluye SOLO el símbolo, sin zona de silencio)
 *     qr.mod[y][x];       // 1 = módulo oscuro, 0 = claro
 */
var qrGenerar = (function () {
  'use strict';

  // Tabla de bloques para NIVEL M (versiones 1..10). Por versión: {ec:codewords de corrección por bloque,
  // g1:[nºbloques,datos/bloque], g2?:[nºbloques,datos/bloque]}. Valores del estándar QR (nivel M).
  var M_TBL = {
    1:  { ec: 10, g1: [1, 16] },
    2:  { ec: 16, g1: [1, 28] },
    3:  { ec: 26, g1: [1, 44] },
    4:  { ec: 18, g1: [2, 32] },
    5:  { ec: 24, g1: [2, 43] },
    6:  { ec: 16, g1: [4, 27] },
    7:  { ec: 18, g1: [4, 31] },
    8:  { ec: 22, g1: [2, 38], g2: [2, 39] },
    9:  { ec: 22, g1: [3, 36], g2: [2, 37] },
    10: { ec: 26, g1: [4, 43], g2: [1, 44] },
  };
  // Posiciones de los patrones de alineación por versión (coordenadas de centro, combinadas en rejilla).
  var ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34],
                7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };

  // ── Reed-Solomon en GF(2^8), polinomio primitivo 0x11D ──
  function rsMul(x, y) { var z = 0; for (var i = 7; i >= 0; i--) { z = (z << 1) ^ ((z >>> 7) * 0x11D); z ^= ((y >>> i) & 1) * x; } return z & 0xFF; }
  function rsDivisor(deg) { var r = []; for (var i = 0; i < deg - 1; i++) r.push(0); r.push(1); var root = 1; for (var i = 0; i < deg; i++) { for (var j = 0; j < r.length; j++) { r[j] = rsMul(r[j], root); if (j + 1 < r.length) r[j] ^= r[j + 1]; } root = rsMul(root, 2); } return r; }
  function rsRem(data, div) { var r = div.map(function () { return 0; }); for (var k = 0; k < data.length; k++) { var f = data[k] ^ r.shift(); r.push(0); for (var i = 0; i < div.length; i++) r[i] ^= rsMul(div[i], f); } return r; }

  // UTF-8
  function toBytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
      else if (c < 0xD800 || c >= 0xE000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
      else { i++; c = 0x10000 + (((c & 0x3FF) << 10) | (str.charCodeAt(i) & 0x3FF)); out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F)); }
    }
    return out;
  }

  function totalDatos(t) { return t.g1[0] * t.g1[1] + (t.g2 ? t.g2[0] * t.g2[1] : 0); }
  function pickVersion(len) {
    for (var v = 1; v <= 10; v++) {
      var total = totalDatos(M_TBL[v]);
      var cc = (v <= 9) ? 8 : 16;
      var cap = total - Math.ceil((4 + cc) / 8);
      if (len <= cap) return v;
    }
    return -1;
  }

  function generar(text) {
    var data = toBytes(String(text));
    var v = pickVersion(data.length);
    if (v < 0) throw new Error('QR: texto demasiado largo (' + data.length + ' bytes)');
    var t = M_TBL[v], totalData = totalDatos(t), cc = (v <= 9) ? 8 : 16;

    // ── Flujo de bits: modo byte (0100) + nº de bytes + bytes; terminador; relleno a byte; bytes de pad ──
    var bits = [];
    function push(val, n) { for (var i = n - 1; i >= 0; i--) bits.push((val >>> i) & 1); }
    push(0x4, 4); push(data.length, cc);
    for (var i = 0; i < data.length; i++) push(data[i], 8);
    var capBits = totalData * 8;
    for (var i = 0; i < 4 && bits.length < capBits; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    var codewords = [];
    for (var i = 0; i < bits.length; i += 8) { var b = 0; for (var j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; codewords.push(b); }
    var pad = [0xEC, 0x11], pi = 0;
    while (codewords.length < totalData) { codewords.push(pad[pi & 1]); pi++; }

    // ── Bloques + corrección de errores por bloque ──
    var blocks = [], ecLen = t.ec, idx = 0, gen = rsDivisor(ecLen);
    function addGroup(count, dcount) { for (var b = 0; b < count; b++) { var d = codewords.slice(idx, idx + dcount); idx += dcount; blocks.push({ d: d, ec: rsRem(d, gen) }); } }
    addGroup(t.g1[0], t.g1[1]); if (t.g2) addGroup(t.g2[0], t.g2[1]);
    // Entrelazado estándar (columna a columna) de datos y luego de EC
    var maxD = 0; for (var i = 0; i < blocks.length; i++) maxD = Math.max(maxD, blocks[i].d.length);
    var seq = [];
    for (var i = 0; i < maxD; i++) for (var b = 0; b < blocks.length; b++) if (i < blocks[b].d.length) seq.push(blocks[b].d[i]);
    for (var i = 0; i < ecLen; i++) for (var b = 0; b < blocks.length; b++) seq.push(blocks[b].ec[i]);
    var dataBits = []; for (var i = 0; i < seq.length; i++) for (var j = 7; j >= 0; j--) dataBits.push((seq[i] >>> j) & 1);

    // ── Matriz ──
    var size = 17 + 4 * v;
    var mod = [], fn = [];
    for (var r = 0; r < size; r++) { mod.push(new Array(size).fill(0)); fn.push(new Array(size).fill(0)); }
    function setFn(x, y, val) { if (x < 0 || y < 0 || x >= size || y >= size) return; mod[y][x] = val ? 1 : 0; fn[y][x] = 1; }
    function reserva(x, y) { if (x < 0 || y < 0 || x >= size || y >= size) return; fn[y][x] = 1; }

    // Patrones localizadores (3 esquinas) + separadores
    function finder(cx, cy) {
      for (var dy = -1; dy <= 7; dy++) for (var dx = -1; dx <= 7; dx++) {
        var d = Math.max(Math.abs(dx - 3), Math.abs(dy - 3));
        setFn(cx + dx, cy + dy, (d <= 1) || (d === 3));
      }
    }
    finder(0, 0); finder(size - 7, 0); finder(0, size - 7);

    // Patrones de sincronización (fila/columna 6)
    for (var i = 0; i < size; i++) { if (!fn[6][i]) setFn(i, 6, i % 2 === 0); if (!fn[i][6]) setFn(6, i, i % 2 === 0); }

    // Patrones de alineación (todas las combinaciones de posiciones SALVO las tres esquinas que solaparían
    // los localizadores; los que caen sobre la línea de sincronización SÍ se dibujan, según el estándar).
    var ap = ALIGN[v], last = ap.length - 1;
    for (var a = 0; a < ap.length; a++) for (var b = 0; b < ap.length; b++) {
      if ((a === 0 && b === 0) || (a === 0 && b === last) || (a === last && b === 0)) continue;
      var cx = ap[a], cy = ap[b];
      for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }

    // Módulo oscuro fijo + reserva de zonas de info de formato
    setFn(8, size - 8, true);
    for (var i = 0; i <= 8; i++) { reserva(i, 8); reserva(8, i); }
    for (var i = 0; i < 8; i++) { reserva(size - 1 - i, 8); reserva(8, size - 1 - i); }

    // Info de versión (v >= 7): BCH(18,6) gen 0x1F25
    if (v >= 7) {
      var rem = v; for (var i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      var vbits = (v << 12) | rem;
      for (var i = 0; i < 18; i++) { var bit = (vbits >>> i) & 1, aa = Math.floor(i / 3), bb = i % 3; setFn(aa, size - 11 + bb, bit); setFn(size - 11 + bb, aa, bit); }
    }

    // ── Colocación de datos en zigzag (saltando módulos de función) ──
    var di = 0;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;              // salta la columna de sincronización
      for (var vert = 0; vert < size; vert++) {
        for (var j = 0; j < 2; j++) {
          var x = right - j, upward = ((right + 1) & 2) === 0, y = upward ? size - 1 - vert : vert;
          if (!fn[y][x] && di < dataBits.length) { mod[y][x] = dataBits[di]; di++; }
        }
      }
    }

    // ── Máscaras: aplica cada una, puntúa (reglas 1,2,4) y elige la de menor penalización ──
    function maskFn(k, x, y) {
      switch (k) {
        case 0: return (x + y) % 2 === 0;
        case 1: return y % 2 === 0;
        case 2: return x % 3 === 0;
        case 3: return (x + y) % 3 === 0;
        case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
        case 5: return (x * y) % 2 + (x * y) % 3 === 0;
        case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
        case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
      }
    }
    function aplicarMascara(m, k) { for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) if (!fn[y][x] && maskFn(k, x, y)) m[y][x] ^= 1; }
    function penaliza(m) {
      var p = 0, dark = 0, n = size * size;
      // Regla 1: rachas ≥5 en filas y columnas
      for (var y = 0; y < size; y++) { var rc = -1, run = 0; for (var x = 0; x < size; x++) { if (m[y][x] === rc) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { rc = m[y][x]; run = 1; } } }
      for (var x = 0; x < size; x++) { var rc = -1, run = 0; for (var y = 0; y < size; y++) { if (m[y][x] === rc) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else { rc = m[y][x]; run = 1; } } }
      // Regla 2: bloques 2x2 del mismo color
      for (var y = 0; y < size - 1; y++) for (var x = 0; x < size - 1; x++) { var c = m[y][x]; if (c === m[y][x + 1] && c === m[y + 1][x] && c === m[y + 1][x + 1]) p += 3; }
      // Regla 4: proporción de oscuros lejos del 50%
      for (var y = 0; y < size; y++) for (var x = 0; x < size; x++) if (m[y][x]) dark++;
      p += Math.floor(Math.abs(dark * 20 / n - 10)) * 10;
      return p;
    }
    var best = null, bestK = 0, bestScore = Infinity;
    for (var k = 0; k < 8; k++) {
      var cand = mod.map(function (fila) { return fila.slice(); });
      aplicarMascara(cand, k);
      // Info de formato para ESTA máscara (nivel M = 00): BCH(15,5) gen 0x537, XOR 0x5412
      var d = (0 << 3) | k, rem2 = d; for (var i = 0; i < 10; i++) rem2 = (rem2 << 1) ^ ((rem2 >>> 9) * 0x537);
      var fbits = ((d << 10) | rem2) ^ 0x5412;
      colocarFormato(cand, fbits);
      var sc = penaliza(cand);
      if (sc < bestScore) { bestScore = sc; best = cand; bestK = k; }
    }
    function colocarFormato(m, fbits) {
      for (var i = 0; i <= 5; i++) m[i][8] = (fbits >>> i) & 1;
      m[7][8] = (fbits >>> 6) & 1; m[8][8] = (fbits >>> 7) & 1; m[8][7] = (fbits >>> 8) & 1;
      for (var i = 9; i < 15; i++) m[8][14 - i] = (fbits >>> i) & 1;
      for (var i = 0; i < 8; i++) m[8][size - 1 - i] = (fbits >>> i) & 1;
      for (var i = 8; i < 15; i++) m[size - 15 + i][8] = (fbits >>> i) & 1;
      m[size - 8][8] = 1;
    }
    return { size: size, mod: best, version: v, mask: bestK };
  }

  return generar;
})();

if (typeof module !== 'undefined' && module.exports) module.exports = qrGenerar;
