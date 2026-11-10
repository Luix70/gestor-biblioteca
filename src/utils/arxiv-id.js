/**
 * IDENTIFICADOR ARXIV — el pivote de los preprints de arxiv.org, como el ISBN lo es del libro y el DOI del artículo.
 * Módulo PURO (no importa nada): lo usan el detector de títulos-artefacto (parsear-nombre), el lector de PDF, el
 * orquestador, el enriquecedor y la reparación de lo ya catalogado (completar-arxiv).
 *
 * Por qué (10-nov): 49 documentos se catalogaron con la MARCA LATERAL que arXiv imprime en el margen de cada PDF
 * como título («arXiv:hep-th/9912205 v3   23 Aug 2005»). La fecha de esa marca los hizo pasar por números de
 * REVISTA (cada uno con su cabecera falsa «arXiv:hep-th/9912205 v3   23»), sin autores, con idioma «es» por defecto
 * y casi todos con CDU 000. Y la API de arXiv (gratis, sin clave) lo sabe todo de ellos: título, autores, resumen,
 * categorías, fecha, nº de páginas y, si salió en una revista, la referencia y el DOI.
 *
 * Formas del identificador:
 *   · ANTIGUA (1991 – marzo 2007): <archivo>[.<SUBCLASE>]/<AAMMnnn>     hep-th/9912205, math.QA/0202059
 *     La subclase («.QA») NO forma parte del identificador canónico (math/0202059): se quita al normalizar.
 *   · NUEVA (abril 2007 en adelante): <AAMM>.<nnnn>  (5 cifras desde 1501)   0806.1234, 1501.00001
 *   · Con versión opcional: …v3.
 */

// Archivos de la forma antigua (los únicos que pueden ir delante de «/AAMMnnn»). Del más largo al más corto para
// que la alternancia de la regex no se quede con un prefijo («math» antes que «math-ph»).
const ARCHIVOS = [
    'acc-phys', 'adap-org', 'alg-geom', 'ao-sci', 'astro-ph', 'atom-ph', 'bayes-an', 'chao-dyn', 'chem-ph', 'cmp-lg',
    'comp-gas', 'cond-mat', 'dg-ga', 'funct-an', 'gr-qc', 'hep-ex', 'hep-lat', 'hep-ph', 'hep-th', 'math-ph',
    'mtrl-th', 'nucl-ex', 'nucl-th', 'patt-sol', 'physics', 'plasm-ph', 'q-alg', 'q-bio', 'quant-ph', 'solv-int',
    'supr-con', 'math', 'nlin', 'cs',
].sort((a, b) => b.length - a.length);
const ALT_ARCHIVOS = ARCHIVOS.map((a) => a.replace(/[-.]/g, '\\$&')).join('|');

// Cuerpo del identificador (sin anclas), con grupos: 1 archivo · 2 subclase · 3 AAMMnnn  |  4 AAMM.nnnnn  ·  5 versión.
// Construido con new RegExp desde cadenas (las regex literales con « -]» se han corrompido alguna vez al editar).
const CUERPO = `(?:(${ALT_ARCHIVOS})(?:\\.([A-Za-z]{2}))?/(\\d{7})|(\\d{4}\\.\\d{4,5}))(?:\\s?(v\\d{1,2}))?`;
const MESES = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

/** ¿AAMM es un mes posible de la forma antigua (1991-2007) o de la nueva (2007 en adelante)? */
function aammValido(aamm, forma) {
    const aa = Number(aamm.slice(0, 2));
    const mm = Number(aamm.slice(2, 4));
    if (mm < 1 || mm > 12) return false;
    const anio = aa >= 91 ? 1900 + aa : 2000 + aa;
    if (forma === 'antigua') return anio >= 1991 && (anio < 2007 || (anio === 2007 && mm <= 3));
    const hoy = new Date();
    return (anio > 2007 || (anio === 2007 && mm >= 4)) && anio <= hoy.getFullYear() + 1;
}

/** Desde los grupos de una coincidencia de CUERPO → { id, version } validado, o null. */
function desdeGrupos(archivo, _subclase, numViejo, numNuevo, ver) {
    let id;
    if (archivo) {
        if (!aammValido(numViejo.slice(0, 4), 'antigua')) return null;
        id = `${archivo.toLowerCase()}/${numViejo}`;
    } else {
        const [aamm, sec] = numNuevo.split('.');
        if (!aammValido(aamm, 'nueva')) return null;
        // 4 cifras de secuencia hasta 1412, 5 desde 1501 (arXiv amplió la numeración en 2015).
        if ((Number(aamm) >= 1501) !== (sec.length === 5)) return null;
        id = numNuevo;
    }
    return { id, version: ver ? Number(ver.slice(1)) : null };
}

/**
 * Normaliza un identificador arXiv escrito de cualquier forma («arXiv:hep-th/9912205v3», «math.QA/0202059»,
 * «https://arxiv.org/abs/0806.1234v1», «0806.1234»). → { id, version } o null.
 */
export function normalizarArxiv(s) {
    const t = String(s || '').trim().replace(/^https?:\/\/(?:export\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/^arxiv:\s*/i, '');
    const m = t.match(new RegExp(`^${CUERPO}`, 'i'));
    return m ? desdeGrupos(m[1], m[2], m[3], m[4], m[5]) : null;
}

/**
 * ¿El TÍTULO es solo la marca de arXiv? («arXiv:hep-th/9912205 v3   23 Aug 2005», «arXiv:0806.1234v1 [physics.class-ph]
 * 6 Jun 2008», «math.CO/9902004», «gr-qc/9905020»). Devuelve el { id, version } si lo es; null si es un título real
 * (aunque mencione arXiv en medio). Lo usa esTituloArtefacto.
 */
export function arxivDeTitulo(titulo) {
    const t = String(titulo || '').trim();
    const re = new RegExp(`^(?:arxiv:\\s*)?${CUERPO}(?:\\s*\\[[\\w.-]+\\])?(?:\\s+\\d{1,2}\\s+(?:${MESES})[a-z]*\\.?\\s+(?:\\d{4}|\\d{2}))?\\s*$`, 'i');
    const m = t.match(re);
    return m ? desdeGrupos(m[1], m[2], m[3], m[4], m[5]) : null;
}

/**
 * El identificador PROPIO de un PDF, leído de su texto: la marca lateral que arXiv estampa en la primera página
 * («arXiv:hep-th/9912205v3 [hep-th] 23 Aug 2005»). Se exige la FECHA de la marca: las referencias del final citan
 * otros preprints como «arXiv:hep-th/9711200» y ninguno de esos es el documento. Pásale solo el texto de las
 * primeras páginas.
 */
export function arxivDeTexto(texto) {
    const re = new RegExp(`arxiv:\\s*${CUERPO}\\s*(?:\\[[\\w.-]+\\])?\\s+\\d{1,2}\\s+(?:${MESES})[a-z]*\\.?\\s+(?:\\d{4}|\\d{2})\\b`, 'i');
    const m = String(texto || '').match(re);
    return m ? desdeGrupos(m[1], m[2], m[3], m[4], m[5]) : null;
}

/**
 * El identificador en el NOMBRE DEL FICHERO: «0806.1234v1.pdf», «arXiv-1501.00001.pdf», «arxiv_hep-th_9912205.pdf»,
 * «hep-th9912205.pdf», «math.QA_0202059v2.pdf». Al descargar, la «/» de la forma antigua se vuelve «_», «-» o nada.
 * La forma nueva sin «arXiv» delante solo vale al PRINCIPIO del nombre (un «1234.5678» en medio puede ser otra cosa).
 */
export function arxivDeNombre(nombre) {
    const base = String(nombre || '').replace(/\.[a-z0-9]{2,4}$/i, '').trim();
    // Con la palabra arxiv delante, cualquiera de las dos formas.
    let m = base.match(new RegExp(`arxiv[\\s:._-]*${CUERPO.replace('/(\\d{7})', '[/_ -]?(\\d{7})')}(?!\\d)`, 'i'));
    if (m) return desdeGrupos(m[1], m[2], m[3], m[4], m[5]);
    // Forma antigua sin «arxiv»: el archivo conocido, separador opcional y las 7 cifras (no pegadas a más cifras).
    m = base.match(new RegExp(`(?:^|[^a-z])(${ALT_ARCHIVOS})(?:\\.([A-Za-z]{2}))?[/_ -]?(\\d{7})(?:\\s?(v\\d{1,2}))?(?!\\d)`, 'i'));
    if (m) return desdeGrupos(m[1], m[2], m[3], null, m[4]);
    // Forma nueva sin «arxiv»: solo al principio del nombre.
    m = base.match(/^(\d{4}\.\d{4,5})(v\d{1,2})?(?![\d.])/);
    return m ? desdeGrupos(null, null, null, m[1], m[2]) : null;
}

// ─── Categorías de arXiv → CDU ────────────────────────────────────────────────────────────────────────────────
// Tabla DETERMINISTA (como el crosswalk Dewey/LCC → CDU): sin IA. Conservadora: a la división que la categoría
// designa sin duda. Primero la categoría completa (math.AG), luego el archivo (math). La categoría la eligen el
// autor y los moderadores de arXiv: es la mejor pista de materia que trae el preprint.
const CDU_ARXIV = {
    // Física
    'hep-th': '539.12', 'hep-ph': '539.12', 'hep-ex': '539.12', 'hep-lat': '539.12',
    'nucl-th': '539.14', 'nucl-ex': '539.14',
    'gr-qc': '530.12',
    'quant-ph': '530.145',
    'math-ph': '530.1', 'math.MP': '530.1',
    'cond-mat': '538.9', 'cond-mat.supr-con': '538.945', 'supr-con': '538.945', 'mtrl-th': '538.9',
    'cond-mat.stat-mech': '536.7',
    'astro-ph': '52', 'astro-ph.CO': '524.8', 'astro-ph.GA': '524.6', 'astro-ph.EP': '523.4',
    'astro-ph.SR': '524.3', 'astro-ph.IM': '520', 'astro-ph.HE': '52',
    'physics': '53', 'physics.class-ph': '53', 'physics.gen-ph': '53', 'physics.hist-ph': '53(091)',
    'physics.optics': '535', 'physics.flu-dyn': '532', 'physics.plasm-ph': '533.9', 'plasm-ph': '533.9',
    'physics.atom-ph': '539.18', 'atom-ph': '539.18', 'physics.chem-ph': '544', 'chem-ph': '544',
    'physics.geo-ph': '550.3', 'physics.ao-ph': '551.5', 'ao-sci': '551.5', 'physics.bio-ph': '577.3',
    'physics.acc-ph': '621.384.6', 'acc-phys': '621.384.6', 'physics.space-ph': '52',
    'nlin': '517.93', 'chao-dyn': '517.93', 'solv-int': '517.93', 'patt-sol': '517.93', 'adap-org': '517.93',
    // Matemáticas
    'math': '51', 'math.GM': '51', 'math.HO': '51(091)',
    'math.AG': '512.7', 'alg-geom': '512.7', 'math.AC': '512.71', 'math.RA': '512.55', 'math.GR': '512.54',
    'math.RT': '512.5', 'math.QA': '512.5', 'q-alg': '512.5', 'math.CT': '512.58', 'math.KT': '512.66',
    'math.NT': '511', 'math.LO': '510.6', 'math.CO': '519.1',
    'math.AT': '515.14', 'math.GT': '515.16', 'math.GN': '515.12',
    'math.DG': '514.7', 'dg-ga': '514.7', 'math.SG': '514.7', 'math.MG': '514',
    'math.CA': '517.5', 'math.CV': '517.53', 'math.AP': '517.95', 'math.DS': '517.93',
    'math.FA': '517.98', 'funct-an': '517.98', 'math.OA': '517.98', 'math.SP': '517.984',
    'math.PR': '519.2', 'math.ST': '519.2', 'bayes-an': '519.2', 'stat': '519.2',
    'math.NA': '519.6', 'math.OC': '519.8', 'math.IT': '519.72',
    // Informática y otras
    'cs': '004', 'comp-gas': '004', 'cs.AI': '004.8', 'cs.LG': '004.85', 'stat.ML': '004.85',
    'cs.CL': "81'32", 'cmp-lg': "81'32", 'cs.CV': '004.93', 'cs.IT': '519.72',
    'q-bio': '57', 'q-fin': '336', 'econ': '33', 'eess': '621.3',
};

/** Nombre legible de cada ARCHIVO (va a palabras_clave: «High Energy Physics - Theory» se busca, «hep-th» no). */
const NOMBRE_ARCHIVO = {
    'hep-th': 'High Energy Physics - Theory', 'hep-ph': 'High Energy Physics - Phenomenology',
    'hep-ex': 'High Energy Physics - Experiment', 'hep-lat': 'High Energy Physics - Lattice',
    'nucl-th': 'Nuclear Theory', 'nucl-ex': 'Nuclear Experiment', 'gr-qc': 'General Relativity and Quantum Cosmology',
    'quant-ph': 'Quantum Physics', 'math-ph': 'Mathematical Physics', 'cond-mat': 'Condensed Matter',
    'astro-ph': 'Astrophysics', physics: 'Physics', nlin: 'Nonlinear Sciences', math: 'Mathematics',
    cs: 'Computer Science', stat: 'Statistics', 'q-bio': 'Quantitative Biology', 'q-fin': 'Quantitative Finance',
    econ: 'Economics', eess: 'Electrical Engineering and Systems Science',
};

/** CDU de un preprint por sus categorías (la principal primero). null si ninguna está en la tabla. */
export function cduDeArxiv(categorias = []) {
    for (const c of categorias) {
        if (CDU_ARXIV[c]) return CDU_ARXIV[c];
        const archivo = String(c).split('.')[0];
        if (CDU_ARXIV[archivo]) return CDU_ARXIV[archivo];
    }
    return null;
}

/** Materias legibles de las categorías (archivo → nombre), sin repetir. */
export function materiasDeArxiv(categorias = []) {
    return [...new Set(categorias.map((c) => NOMBRE_ARCHIVO[String(c).split('.')[0]]).filter(Boolean))];
}

// A partir de este nº de páginas, un preprint que no salió en ninguna revista es un LIBRO (apuntes de curso,
// monografías, tratados: los «Fields» de Siegel tienen 885, las notas de Carroll 238). Por debajo, o si se publicó
// en una revista, es un ARTÍCULO.
const LIBRO_MIN_PAGINAS = Number(process.env.ARXIV_LIBRO_MIN_PAGINAS) || 100;

/** 'libro' | 'articulo' para un preprint de arXiv. */
export function tipoArxiv({ paginas = null, enRevista = false } = {}) {
    return !enRevista && Number(paginas) >= LIBRO_MIN_PAGINAS ? 'libro' : 'articulo';
}

/** Nº de páginas del comentario del autor («plain TeX; 885 pages, 73 figures»). */
export function paginasDeComentario(comentario) {
    const m = String(comentario || '').match(/(\d{1,4})\s*(?:pages|pp\b|p\.)/i);
    return m ? Number(m[1]) : null;
}
