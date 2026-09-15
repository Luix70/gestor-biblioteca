/**
 * GENERADOR DE GUÍAS (agente de estructura, FASE 2).
 *
 * Convierte la interpretación del agente («esta carpeta es una serie», «esta es materia 512»…) en `_guia.json`,
 * el formato que el vigilante YA obedece. Así el agente no toca el motor de ingesta: deja instrucciones en el
 * mismo idioma que el Inspector del panel.
 *
 * QUÉ ESCRIBE. Primero según lo que CONTIENE (manda, porque decide la ruta de ingesta):
 *   audiolibro / coleccion-audiolibros / transmedia / software / libro-material → la acción del mismo nombre.
 *   libro-desglosado  → accion:'desglose' (el principal, el orden y los títulos los añade afinar-guias).
 *   revistas          → perfil.tipo_probable:'revista' + perfil.cabecera + sin_coleccion (+ issn, si afinar-guias
 *                       lo confirma).
 *   comics            → perfil.tipo_probable:'comic', además de lo que diga la organización.
 * Si no es nada de eso, según cómo está ORGANIZADA:
 *   serie / coleccion → perfil.coleccion (el nombre CANÓNICO: «Cultural Memory in the Present», no el de la
 *                       carpeta). Los libros de debajo la heredan aunque haya carpetas de materia en medio.
 *   editorial         → perfil.editorial_probable + sin_coleccion (la editorial ya es un dato del libro).
 *   materia           → perfil.materia_cdu + sin_coleccion (la materia es su CDU, no una colección).
 *   cajon / raiz      → sin_coleccion.
 *   obra              → accion:'obra' + perfil.obra.
 *   mixta             → NADA: se deja la regla por defecto.
 *
 * SALVAGUARDAS:
 *   · NUNCA pisa una guía del USUARIO (hecha en el Inspector): solo reescribe las que llevan origen:'agente' (y,
 *     cuando la inspección se lanza desde el panel, también las 'panel': las que aprobaste allí).
 *   · Las carpetas DUDOSAS (confianza < UMBRAL_CONFIANZA) no se escriben salvo que se pida: son decisiones
 *     tuyas, no deducciones («¿quiero "University Press Collection" como colección?»).
 *   · No guía los DESCENDIENTES de una obra ni de una unidad: la obra ya reúne todo lo de debajo como tomos, y
 *     guiar sus partes por separado las convertiría en obras sueltas (los libros I-XIII de Euclides); a una
 *     unidad (audiolibro, software…) le pasaría lo mismo: se recorrería por dentro y se partiría.
 */
import path from 'node:path';
import { leerGuia, escribirGuia, guiaEsSignificativa } from './guia-ingesta.js';
import { tituloCabecera, periodoDeTexto } from './revistas.js';

export const UMBRAL_CONFIANZA = 0.6;
const ORIGEN = 'agente';

/**
 * Sanea la CDU que propone la IA para una carpeta de materia. Solo corrige lo que se SABE que está mal:
 *   · Divisiones 95-99: NO EXISTEN en la CDU (quedaron vacías). Lo que llega ahí es DEWEY — medido: el agente
 *     devolvió «97» para «American History» (Dewey 970 = historia de Norteamérica). → 94, historia general.
 *   · Clase 9 con tres cifras seguidas y sin auxiliar: patrón Dewey («941» = Gran Bretaña; la CDU usaría
 *     94(410)). → se deja en la división (94), que es correcta aunque menos fina.
 * Por qué importa: la fase 3 PRECISA la CDU de un libro con la de su carpeta cuando es más fina en la misma rama,
 * así que un «941» convertiría un «94» correcto en un código que no es CDU.
 */
export function sanearCduMateria(cdu) {
    const c = String(cdu || '').trim();
    if (!c || !/^[0-9(]/.test(c)) return null;
    if (/^9[5-9]/.test(c)) return '94';
    if (/^9\d{2}/.test(c) && !c.includes('(')) return c.slice(0, 2);
    return c;
}

// CONTENIDOS que son una UNIDAD → la acción de guía que fuerza su ruta de ingesta en el vigilante. Una unidad se
// ingiere ENTERA, así que manda sobre la organización (una carpeta de audiolibro no es «colección» de pistas).
const ACCION_POR_CONTENIDO = {
    software: 'software',
    'libro-material': 'libro-material',
    audiolibro: 'audiolibro',
    'coleccion-audiolibros': 'coleccion-audiolibros',
    transmedia: 'transmedia',
    'libro-desglosado': 'desglose',
};
export const CONTENIDOS_UNIDAD = new Set(Object.keys(ACCION_POR_CONTENIDO));

/** Guía para UNA carpeta interpretada, o null si no hay nada que decir de ella. */
export function guiaDesdeInterpretacion(i, nombreCarpeta) {
    const nombre = (i.nombre_canonico && String(i.nombre_canonico).trim()) || nombreCarpeta;

    // 0) PARTE de lo que contiene su madre (CD1, «Audio», los años de una revista): no lleva guía propia; la
    //    madre decide (y lo que herede de ella le llega por perfilHeredado).
    if (i.tipo === 'parte') return null;
    // Un CAJÓN nunca es una unidad ni una cabecera, diga lo que diga la IA de su contenido. Medido: ponía a
    // «Programas», «Audiolibros» y «Revistas» (cajones) el contenido de sus hijas — «Programas» habría ingerido
    // TODOS sus programas como UN solo software, y la cabecera genérica «Revistas» sacó de Wikidata el ISSN de otra
    // publicación. La RAÍZ no entra aquí a propósito: «Muy Historia/» soltada con sus años dentro SÍ es la revista;
    // una raíz que agrupa varias unidades la desarma planGuias (desarmarContenedores).
    if (i.tipo === 'cajon') return { perfil: { sin_coleccion: true, origen: ORIGEN } };

    // 1) UNIDAD (audiolibro, software, libro desglosado…): su acción y nada más. El detalle de un desglose
    //    (libro principal, orden de lectura, títulos) lo añade después afinar-guias, que necesita ver los ficheros.
    if (ACCION_POR_CONTENIDO[i.contenido]) return { accion: ACCION_POR_CONTENIDO[i.contenido], perfil: { origen: ORIGEN } };

    // 2) REVISTAS: la agrupación es la CABECERA, no la carpeta. Por eso `sin_coleccion` (si no, la regla «carpeta con
    //    2+ documentos = colección» crearía una colección de LIBROS con el nombre de la carpeta, «HIV 2019»), y la
    //    cabecera va en su campo propio, que solo se aplica a los documentos que resulten ser revista. El ISSN lo
    //    añade afinar-guias SOLO si lo confirma una fuente fiable. La pista de tipo es débil: un ISBN o un CIP del
    //    propio fichero siguen mandando (discriminador).
    if (i.contenido === 'revistas') {
        const cabecera = (i.nombre_canonico && String(i.nombre_canonico).trim()) || tituloCabecera(nombreCarpeta);
        // CDU de la PUBLICACIÓN: servicio-ingesta la da a los números que no traen una (casi todos), y la cabecera
        // nace con ella. Sin esto, 2DArtist 2012 entró entero con 000. Se sanea igual que la de materia (95-99…).
        const cdu = sanearCduMateria(i.cdu);
        // PERIODO de la tirada: los años del nombre de la carpeta mandan (son del usuario y no se equivocan de
        // cifra); si no los lleva, los que dedujo la IA de los nombres de fichero. Al ingerir cada número, su año
        // se contrasta con él (revistas · afinarFechaNumero).
        const periodo = periodoDeTexto(nombreCarpeta) || (i.anio ? { desde: Math.min(i.anio, i.anio_hasta || i.anio), hasta: Math.max(i.anio, i.anio_hasta || i.anio) } : null);
        return {
            perfil: {
                tipo_probable: 'revista',
                ...(cabecera ? { cabecera } : {}),
                ...(i.periodicidad ? { periodicidad: i.periodicidad } : {}),
                ...(cdu ? { materia_cdu: cdu } : {}),
                ...(periodo ? { periodo } : {}),
                ...(i.numeracion ? { numeracion: i.numeracion } : {}),
                sin_coleccion: true,
                origen: ORIGEN,
            },
        };
    }

    // 3) ORGANIZACIÓN (colección, serie, editorial, materia…), como hasta ahora. Los cómics añaden su pista de tipo.
    const g = guiaPorOrganizacion(i, nombre);
    if (i.contenido === 'comics') {
        if (g) { g.perfil = { ...(g.perfil || {}), tipo_probable: 'comic' }; return g; }
        return { perfil: { tipo_probable: 'comic', origen: ORIGEN } };
    }
    return g;
}

function guiaPorOrganizacion(i, nombre) {
    switch (i.tipo) {
        case 'serie':
        case 'coleccion':
            return { perfil: { coleccion: nombre, origen: ORIGEN } };
        case 'editorial':
            return { perfil: { editorial_probable: (i.editorial && String(i.editorial).trim()) || nombre, sin_coleccion: true, origen: ORIGEN } };
        case 'materia': {
            const cdu = sanearCduMateria(i.cdu);
            return { perfil: { ...(cdu ? { materia_cdu: cdu } : {}), sin_coleccion: true, origen: ORIGEN } };
        }
        case 'cajon':
        case 'raiz':
            return { perfil: { sin_coleccion: true, origen: ORIGEN } };
        case 'obra':
            return { accion: 'obra', perfil: { obra: nombre, origen: ORIGEN } };
        default:
            return null;   // mixta u otro: la regla por defecto sabe más que una guía a medias
    }
}

/**
 * PLAN de guías para un árbol ya interpretado. No escribe nada: dice qué haría y por qué.
 *
 * @param raizAbs          ruta absoluta del árbol
 * @param esqueleto        salida de esqueletoArbol
 * @param interpretacion   salida de interpretarEstructura
 * @param opciones.incluirDudosas  escribir también las de confianza baja
 * @returns {Promise<Array<{ruta, tipo, confianza, guia, estado, motivo}>>}
 *   estado: 'nueva' | 'actualizar' | 'respetada' | 'dudosa' | 'omitida'
 */
// Acciones que convierten una carpeta en UNA unidad que se ingiere entera (sus hijas no llevan guía propia).
const ACCIONES_UNIDAD = new Set(['obra', ...Object.values(ACCION_POR_CONTENIDO)]);

const madreDe = (ruta) => (ruta.includes('/') ? ruta.slice(0, ruta.lastIndexOf('/')) : '.');

/**
 * Una UNIDAD que contiene OTRAS unidades no es una unidad: es un contenedor. «English Readers» (transmedia) con
 * varias lecturas graduadas dentro, cada una transmedia, ingerido como UNA unidad fundiría todas las lecturas en un
 * registro. Se le quita el contenido de unidad (queda su organización: colección, cajón…) y cada hija se ingiere
 * por su cuenta. Las hijas de tipo «parte» (CD1, «Audio») NO cuentan: son la propia unidad.
 * La colección de audiolibros es el caso especial: sus hijas SON audiolibros por definición; deja de serlo si
 * alguna hija es otra cosa (una carpeta mixta con novelas en EPUB se la habría tragado).
 */
// Nombres de carpeta que son PARTE de algo y no una obra: «CD1», «Disco 2», «Audio», «Extras», «Parte 3»… Red local
// para cuando la IA no marca el tipo «parte» — medido: un audiolibro con «CD1/» y «CD2/» marcadas como audiolibro
// se desarmaba como si fueran dos audiolibros distintos.
const RE_NOMBRE_PARTE = /^(cd|disco|disc|disk|dvd|parte?|part|tomo|audio|mp3|pistas|tracks?|extras?|bonus|material|anexos?|scans?|covers?)[\s_.-]*\d{0,3}$/i;
const esParte = (c) => c.tipo === 'parte' || RE_NOMBRE_PARTE.test(c.ruta.split('/').pop().trim());

function desarmarContenedores(porRuta) {
    const todas = [...porRuta.values()];
    const bajo = (c, d) => d.ruta !== c.ruta && (c.ruta === '.' || d.ruta.startsWith(c.ruta + '/'));
    // Lo que cuelga de una parte también es la unidad («CD1/Pistas»): se excluye con la parte.
    const partes = todas.filter(esParte);
    const dentroDeParte = (d) => partes.some((p) => d.ruta === p.ruta || d.ruta.startsWith(p.ruta + '/'));
    for (const c of todas) {
        if (!CONTENIDOS_UNIDAD.has(c.contenido)) continue;
        const desc = todas.filter((d) => bajo(c, d) && !dentroDeParte(d));
        const contenedor = c.contenido === 'coleccion-audiolibros'
            ? desc.filter((d) => madreDe(d.ruta) === c.ruta).some((h) => h.contenido && h.contenido !== 'audiolibro')
            : desc.some((d) => CONTENIDOS_UNIDAD.has(d.contenido));
        if (contenedor) c.contenido = null;
    }
}

/**
 * Una carpeta cuyas hijas son TODAS números de la MISMA revista es esa revista, aunque la IA la haya dejado sin
 * contenido (solo ve subcarpetas). Medido: «Muy Historia» con «2020/» y «2021/» salió como SERIE sin contenido, y
 * su guía de colección «Muy Historia» se habría heredado hacia abajo: al catalogar, la colección de LIBROS de ese
 * nombre se crea antes que la cabecera y la usurpa (queda tipo libro). Se promueve aquí, en código, porque no
 * puede depender de que el prompt acierte. Solo con una cabecera COMÚN a todas las hijas.
 */
function promoverTiradasDeRevista(porRuta) {
    const hijas = new Map();
    for (const c of porRuta.values()) {
        if (c.ruta === '.') continue;
        const madre = madreDe(c.ruta);
        if (!hijas.has(madre)) hijas.set(madre, []);
        hijas.get(madre).push(c);
    }
    // Varias vueltas: en «Revista / Años / 2020» la madre solo se puede promover cuando «Años» ya lo está.
    for (let vuelta = 0, cambio = true; cambio && vuelta < 6; vuelta++) {
        cambio = false;
        for (const [madre, hs] of hijas) {
            const c = porRuta.get(madre);
            if (!c || (c.contenido && c.contenido !== 'libros')) continue;
            if (!hs.every((h) => h.contenido === 'revistas')) continue;
            const cabeceras = new Set(hs.map((h) => String(h.nombre_canonico || '').trim().toLowerCase()).filter(Boolean));
            if (cabeceras.size !== 1) continue;
            c.contenido = 'revistas';
            c.nombre_canonico = hs.find((h) => h.nombre_canonico).nombre_canonico;
            c.periodicidad = c.periodicidad || hs[0].periodicidad || null;
            c.cdu = c.cdu || hs.find((h) => h.cdu)?.cdu || null;
            // La tirada abarca los años de todas sus hijas; y si todas numeran igual sus ficheros, ella también.
            const anios = hs.flatMap((h) => [h.anio, h.anio_hasta]).filter(Boolean);
            if (!c.anio && anios.length) { c.anio = Math.min(...anios); c.anio_hasta = Math.max(...anios); }
            const numeraciones = new Set(hs.map((h) => h.numeracion || null));
            if (!c.numeracion && numeraciones.size === 1) c.numeracion = [...numeraciones][0];
            cambio = true;
        }
    }
}

// `origenesReescribibles`: de quién son las guías que este plan puede reescribir. La inspección automática solo
// reescribe las suyas ('agente'); la del panel también las que TÚ aprobaste en el panel ('panel'), porque es tu
// decisión repetirla. Las hechas a mano en el Inspector (sin origen) no se tocan nunca.
export async function planGuias(raizAbs, esqueleto, interpretacion, { incluirDudosas = false, origenesReescribibles = [ORIGEN] } = {}) {
    const porRuta = new Map(interpretacion.carpetas.map((c) => [c.ruta, { ...c }]));
    promoverTiradasDeRevista(porRuta);
    desarmarContenedores(porRuta);

    // 1.ª pasada: qué le toca a cada carpeta por sí misma.
    const plan = [];
    for (const c of esqueleto.carpetas) {
        const i = porRuta.get(c.ruta);
        const abs = c.ruta === '.' ? raizAbs : path.join(raizAbs, ...c.ruta.split('/'));
        const nombre = c.ruta === '.' ? path.basename(raizAbs) : c.ruta.split('/').pop();
        const base = { ruta: c.ruta, abs, tipo: i?.tipo || null, contenido: i?.contenido || null, confianza: i?.confianza ?? null };

        if (!i) { plan.push({ ...base, guia: null, estado: 'omitida', motivo: 'la IA no la interpretó' }); continue; }

        const guia = guiaDesdeInterpretacion(i, nombre);
        if (!guia) {
            const motivo = i.tipo === 'parte' ? 'es parte de su carpeta madre' : `tipo «${i.tipo}»: se deja la regla por defecto`;
            plan.push({ ...base, guia: null, estado: 'omitida', motivo });
            continue;
        }

        const actual = await leerGuia(abs);
        const reescribible = origenesReescribibles.includes(actual?.perfil?.origen);
        if (actual && guiaEsSignificativa(actual) && !reescribible) {
            const deQuien = actual.perfil?.origen === 'panel' ? 'la aprobaste en el panel' : 'ya tiene una guía tuya (Inspector)';
            plan.push({ ...base, guia, estado: 'respetada', accionUsuario: actual.accion, motivo: `${deQuien}: no se toca` });
            continue;
        }
        if (i.confianza < UMBRAL_CONFIANZA && !incluirDudosas) {
            plan.push({ ...base, guia, estado: 'dudosa', motivo: i.razon || 'confianza baja: decisión tuya' });
            continue;
        }
        plan.push({ ...base, guia, estado: actual && reescribible ? 'actualizar' : 'nueva', motivo: null });
    }

    // 2.ª pasada: lo que cuelga de una OBRA o UNIDAD (audiolibro, software, desglose…) no se guía (ver cabecera):
    // la unidad se ingiere entera, y una guía en una hija haría que el vigilante la recorriera por dentro y la
    // partiera. Pero SOLO si esa unidad se va a aplicar de verdad (se escribe, o es una guía tuya): una unidad
    // DUDOSA no se escribe, sigue la regla de siempre, y no debe dejar sin guía a sus hijas — medido: una carpeta
    // «Audiolibros» dudosa silenciaba al audiolibro claro que tenía dentro. Una OBRA en la raíz no cuenta (antes
    // tampoco): la raíz entera como obra suele ser una lectura floja del árbol.
    const efectivas = plan.filter((p) => {
        const accion = p.estado === 'respetada' ? p.accionUsuario : p.guia?.accion;
        const aplicada = p.estado === 'nueva' || p.estado === 'actualizar' || p.estado === 'respetada';
        return aplicada && ACCIONES_UNIDAD.has(accion) && !(accion === 'obra' && p.ruta === '.');
    }).map((p) => p.ruta);
    const bajoUnidad = (ruta) => efectivas.some((u) => ruta !== u && (u === '.' || ruta.startsWith(u + '/')));
    for (const p of plan) {
        if (p.estado === 'respetada' || !bajoUnidad(p.ruta)) continue;
        p.guia = null;
        p.estado = 'omitida';
        p.motivo = 'forma parte de una obra o unidad';
    }
    return plan;
}

/** Resumen legible de una guía («revistas de «2DArtist» (ISSN …) · CDU 741 · sin colección»), para el CLI y el panel. */
export function resumenGuia(g) {
    if (!g) return '';
    const p = g.perfil || {};
    const ACC = { audiolibro: 'audiolibro', 'coleccion-audiolibros': 'colección de audiolibros', transmedia: 'transmedia',
        software: 'software', 'libro-material': 'libro con material', desglose: 'libro desglosado' };
    const NUMERACION = { mes: 'ficheros = meses', numero: 'ficheros = nº', fecha: 'ficheros con fecha' };
    const m = p.muestra;
    return [g.accion === 'obra' && `obra «${p.obra}»`, ACC[g.accion],
        g.desglose && (g.desglose.principal ? `libro entero «${g.desglose.principal}»` : `${(g.desglose.orden || []).length} partes a coser`),
        p.tipo_probable === 'revista' && `revistas de «${p.cabecera || '?'}»${p.cabecera_verificada ? ' (leído en la portada)' : ''}${p.issn ? ` (ISSN ${p.issn})` : ''}`,
        p.tipo_probable === 'comic' && 'cómics',
        p.coleccion && `colección «${p.coleccion}»`,
        p.editorial_probable && `editorial «${p.editorial_probable}»`, p.materia_cdu && `CDU ${p.materia_cdu}`,
        p.idioma_probable && `idioma ${p.idioma_probable}`,
        p.periodicidad && p.periodicidad,
        p.periodo && (p.periodo.desde === p.periodo.hasta ? `año ${p.periodo.desde}` : `años ${p.periodo.desde}-${p.periodo.hasta}`),
        NUMERACION[p.numeracion],
        m && (m.numero || m.mes) && `muestra: nº ${m.numero || '?'}${m.mes ? ` = ${m.mes}/${m.anio || '?'}` : ''}`,
        p.sin_coleccion && 'sin colección'].filter(Boolean).join(' · ');
}

/** Escribe las guías del plan con estado 'nueva' o 'actualizar'. Devuelve cuántas escribió. */
export async function escribirGuias(plan) {
    let n = 0;
    for (const p of plan) {
        if (p.estado !== 'nueva' && p.estado !== 'actualizar') continue;
        await escribirGuia(p.abs, p.guia);
        n++;
    }
    return n;
}
