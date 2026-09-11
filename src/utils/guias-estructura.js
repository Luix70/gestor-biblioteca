/**
 * GENERADOR DE GUÍAS (agente de estructura, FASE 2).
 *
 * Convierte la interpretación del agente («esta carpeta es una serie», «esta es materia 512»…) en `_guia.json`,
 * el formato que el vigilante YA obedece. Así el agente no toca el motor de ingesta: deja instrucciones en el
 * mismo idioma que el Inspector del panel.
 *
 * QUÉ ESCRIBE, según lo que ES cada carpeta:
 *   serie / coleccion → perfil.coleccion (el nombre CANÓNICO: «Cultural Memory in the Present», no el de la
 *                       carpeta). Los libros de debajo la heredan aunque haya carpetas de materia en medio.
 *   editorial         → perfil.editorial_probable + sin_coleccion (la editorial ya es un dato del libro).
 *   materia           → perfil.materia_cdu + sin_coleccion (la materia es su CDU, no una colección).
 *   cajon / raiz      → sin_coleccion.
 *   obra              → accion:'obra' + perfil.obra.
 *   mixta             → NADA: se deja la regla por defecto.
 *
 * SALVAGUARDAS:
 *   · NUNCA pisa una guía del USUARIO (hecha en el Inspector): solo reescribe las que llevan origen:'agente'.
 *   · Las carpetas DUDOSAS (confianza < UMBRAL_CONFIANZA) no se escriben salvo que se pida: son decisiones
 *     tuyas, no deducciones («¿quiero "University Press Collection" como colección?»).
 *   · No guía los DESCENDIENTES de una obra: la obra ya reúne todo lo de debajo como tomos, y guiar sus partes
 *     por separado las convertiría en obras sueltas (los libros I-XIII de Euclides).
 */
import path from 'node:path';
import { leerGuia, escribirGuia, guiaEsSignificativa } from './guia-ingesta.js';

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

/** Guía para UNA carpeta interpretada, o null si no hay nada que decir de ella. */
export function guiaDesdeInterpretacion(i, nombreCarpeta) {
    const nombre = (i.nombre_canonico && String(i.nombre_canonico).trim()) || nombreCarpeta;
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
export async function planGuias(raizAbs, esqueleto, interpretacion, { incluirDudosas = false } = {}) {
    const porRuta = new Map(interpretacion.carpetas.map((c) => [c.ruta, c]));

    // Carpetas bajo una obra: no se guían (ver cabecera).
    const obras = interpretacion.carpetas.filter((c) => c.tipo === 'obra' && c.ruta !== '.').map((c) => c.ruta + '/');
    const bajoObra = (ruta) => obras.some((o) => ruta.startsWith(o));

    const plan = [];
    for (const c of esqueleto.carpetas) {
        const i = porRuta.get(c.ruta);
        const abs = c.ruta === '.' ? raizAbs : path.join(raizAbs, ...c.ruta.split('/'));
        const nombre = c.ruta === '.' ? path.basename(raizAbs) : c.ruta.split('/').pop();
        const base = { ruta: c.ruta, abs, tipo: i?.tipo || null, confianza: i?.confianza ?? null };

        if (!i) { plan.push({ ...base, guia: null, estado: 'omitida', motivo: 'la IA no la interpretó' }); continue; }
        if (bajoObra(c.ruta)) { plan.push({ ...base, guia: null, estado: 'omitida', motivo: 'forma parte de una obra' }); continue; }

        const guia = guiaDesdeInterpretacion(i, nombre);
        if (!guia) { plan.push({ ...base, guia: null, estado: 'omitida', motivo: `tipo «${i.tipo}»: se deja la regla por defecto` }); continue; }

        const actual = await leerGuia(abs);
        if (actual && guiaEsSignificativa(actual) && actual.perfil?.origen !== ORIGEN) {
            plan.push({ ...base, guia, estado: 'respetada', motivo: 'ya tiene una guía tuya (Inspector): no se toca' });
            continue;
        }
        if (i.confianza < UMBRAL_CONFIANZA && !incluirDudosas) {
            plan.push({ ...base, guia, estado: 'dudosa', motivo: i.razon || 'confianza baja: decisión tuya' });
            continue;
        }
        plan.push({ ...base, guia, estado: actual?.perfil?.origen === ORIGEN ? 'actualizar' : 'nueva', motivo: null });
    }
    return plan;
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
