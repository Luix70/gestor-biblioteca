// Generación de registros MARC 21 (serialización MARCXML del esquema MARC21/slim de la LoC)
// a partir del documento bibliográfico interno. Mapea nuestros campos a los campos MARC estándar.

const LANG3 = { es: 'spa', en: 'eng', fr: 'fre', de: 'ger', it: 'ita', pt: 'por', ca: 'cat', gl: 'glg', eu: 'baq', la: 'lat', ru: 'rus', nl: 'dut' };
const lang3 = (c) => LANG3[String(c || '').toLowerCase()] || 'und';

const esc = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const noVacio = (v) => v !== null && v !== undefined && String(v).trim() !== '';

function controlfield(tag, val) {
    return noVacio(val) ? `  <controlfield tag="${tag}">${esc(val)}</controlfield>` : '';
}

function datafield(tag, ind1, ind2, subcampos) {
    const sf = subcampos
        .filter(([, v]) => noVacio(v))
        .map(([code, v]) => `    <subfield code="${code}">${esc(v)}</subfield>`)
        .join('\n');
    if (!sf) return '';
    return `  <datafield tag="${tag}" ind1="${ind1}" ind2="${ind2}">\n${sf}\n  </datafield>`;
}

// Cabecera (leader) de 24 posiciones, válida para material textual (libro/revista).
function leader(esRevista) {
    const L = Array(24).fill(' ');
    '00000'.split('').forEach((c, i) => L[i] = c); // 00-04 longitud (placeholder)
    L[5] = 'n';                 // estado del registro: nuevo
    L[6] = 'a';                 // tipo: material textual
    L[7] = esRevista ? 's' : 'm'; // nivel: seriada / monografía
    L[9] = 'a';                 // codificación de caracteres: Unicode
    L[10] = '2'; L[11] = '2';   // recuentos de indicadores/subcampos
    '00000'.split('').forEach((c, i) => L[12 + i] = c); // 12-16 dirección base de datos (placeholder)
    L[18] = 'i';                // forma de catalogación: ISBD
    '4500'.split('').forEach((c, i) => L[20 + i] = c);
    return L.join('');
}

// Campo de control 008 (40 posiciones): fija año (07-10) e idioma (35-37).
function control008(doc) {
    const F = Array(40).fill(' ');
    F[6] = 's'; // tipo de fecha: única
    const year = /^\d{4}$/.test(String(doc.año_edicion)) ? String(doc.año_edicion) : '    ';
    for (let i = 0; i < 4; i++) F[7 + i] = year[i] || ' ';
    const l3 = lang3(doc.idioma);
    for (let i = 0; i < 3; i++) F[35 + i] = l3[i];
    return F.join('');
}

/**
 * Convierte el documento (con autores/editorial por NOMBRE) a un registro MARCXML (MARC 21).
 */
export function aMARCXML(doc) {
    const esRevista = doc.tipo_recurso === 'revista';
    const autores = Array.isArray(doc.autores) ? doc.autores.filter(a => typeof a === 'string') : [];
    const editorial = typeof doc.editorial === 'string' ? doc.editorial : null;
    const sor = autores.join('; ');
    const año = /^\d{4}$/.test(String(doc.año_edicion)) ? String(doc.año_edicion) : null;
    const enlace = doc.portada || doc.ruta_base || null;

    const campos = [
        controlfield('001', doc._id ? String(doc._id) : ''),
        controlfield('008', control008(doc)),
        datafield('020', ' ', ' ', [['a', doc.isbn]]),                       // ISBN
        datafield('022', ' ', ' ', [['a', doc.issn]]),                       // ISSN
        datafield('041', ' ', ' ', [['a', lang3(doc.idioma)]]),              // idioma
        datafield('080', ' ', ' ', [['a', doc.cdu]]),                        // CDU (UDC)
        (autores.length && !esRevista) ? datafield('100', '1', ' ', [['a', autores[0]]]) : '', // autor principal
        datafield('245', (autores.length && !esRevista) ? '1' : '0', '0', [['a', doc.titulo], ['c', sor || null]]), // título
        datafield('264', ' ', '1', [['b', editorial], ['c', año]]),          // publicación
        datafield('490', '0', ' ', [['a', typeof doc.coleccion_nombre === 'string' ? doc.coleccion_nombre : null], ['v', doc.coleccion_numero]]), // mención de serie/colección
        datafield('520', ' ', ' ', [['a', doc.sinopsis]]),                   // sinopsis/resumen
        ...(Array.isArray(doc.palabras_clave) ? doc.palabras_clave.map(k => datafield('653', ' ', ' ', [['a', k]])) : []), // materias libres
        ...autores.slice(1).map(a => datafield('700', '1', ' ', [['a', a]])), // coautores
        datafield('856', '4', ' ', [['u', enlace]]),                         // recurso electrónico
    ].filter(Boolean);

    return `<?xml version="1.0" encoding="UTF-8"?>
<record xmlns="http://www.loc.gov/MARC21/slim">
  <leader>${esc(leader(esRevista))}</leader>
${campos.join('\n')}
</record>
`;
}
