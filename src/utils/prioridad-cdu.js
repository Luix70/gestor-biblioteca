/**
 * PRIORIDAD DE LA CDU según QUIÉN la decidió (regla del usuario, sep. 2026):
 *
 *   4 · manual     la fijaste tú (edición en la ficha, formulario de subida) → manda sobre todo.
 *   3 · impresa    impresa en la PÁGINA DE CRÉDITOS del propio libro (ficha catalográfica / CIP): la
 *                  determinaron el autor y la editorial.
 *   2 · bne / bnf  la de la Biblioteca Nacional (o la BnF): catalogada y revisada por bibliotecarios.
 *   1 · clasificador   deducida: equivalencia Dewey/LCC (tabla o caché aprendida), o IA (texto o visión).
 *
 * Una CDU de rango MAYOR O IGUAL puede sustituir a la actual (y aplicarse aunque suponga MOVER la carpeta); una
 * de rango menor, nunca. Todas las vías que cambian una CDU (ingesta, Conformador, «Extraer ISBN», Enriquecedor)
 * pasan por aquí, para que el criterio sea uno.
 *
 * `cdu_fuente` se guarda en el documento desde sep. 2026. Para los documentos ANTERIORES (sin ese campo): si una
 * alerta dice que la fijó el CIP impreso de un escaneo, es «impresa»; si está marcada `cdu_manual`, «manual»; lo
 * demás salió del clasificador o de una fuente desconocida → rango 1 (como indicó el usuario: la de la BNE debe
 * tener preferencia sobre lo que vino de la IA o de la equivalencia Dewey/LCC).
 */
import { reubicarPorCdu, carpetaDeDoc } from '../mantenimiento/util-mantenimiento.js';
import { indexarDoc } from './indice-busqueda.js';
import { regenerarSidecarsDoc } from './registro.js';
import { modernizarCDU } from './cdu-moderna.js';

export const RANGO_CDU = { manual: 4, impresa: 3, bne: 2, bnf: 2, clasificador: 1 };

/** Rango de una etiqueta de fuente (las del clasificador son variadas: 'cache:lcc', 'api:dewey', 'ia'…). */
export function rangoFuente(fuente) {
    const f = String(fuente || '').toLowerCase();
    if (f in RANGO_CDU) return RANGO_CDU[f];
    return RANGO_CDU.clasificador;
}

/** De dónde salió la CDU ACTUAL de un documento (ver la nota de arriba para los anteriores a sep. 2026). */
export function fuenteCduDoc(doc) {
    if (!doc) return 'clasificador';
    if (doc.cdu_manual) return 'manual';
    if (doc.cdu_fuente) return String(doc.cdu_fuente);
    if ((doc.alertas_agente || []).some((a) => /CDU fijada desde el CIP impreso[^:]*\(CIP impreso\)/.test(a))) return 'impresa';
    return 'clasificador';
}

/** ¿Una CDU vacía o el cajón genérico? (entonces cualquier fuente la puede sustituir) */
export const cduVacia = (cdu) => ['', '0', '00', '000'].includes(String(cdu ?? '').trim());

/**
 * ¿Puede una CDU de `fuenteNueva` sustituir a la actual del documento? Sí si la actual está vacía/genérica, o
 * si la nueva es de rango MAYOR O IGUAL (a igual rango, la más reciente refresca: la BNE corrige su registro).
 */
export function puedeSustituirCdu(doc, cduNueva, fuenteNueva) {
    if (!cduNueva || cduVacia(cduNueva)) return false;
    if (String(doc?.cdu || '').trim() === String(cduNueva).trim()) return false;
    if (cduVacia(doc?.cdu)) return true;
    return rangoFuente(fuenteNueva) >= rangoFuente(fuenteCduDoc(doc));
}

/**
 * Entre varias CDU candidatas [{cdu, fuente}], la de MAYOR rango (a igualdad, la primera: la del fichero).
 * Para decidir en la ingesta, donde aún no hay carpeta que mover.
 */
export function mejorCdu(candidatas) {
    let mejor = null;
    for (const c of candidatas) {
        if (!c || !c.cdu || cduVacia(c.cdu)) continue;
        if (!mejor || rangoFuente(c.fuente) > rangoFuente(mejor.fuente)) mejor = c;
    }
    return mejor;
}

/**
 * APLICA una CDU a un documento YA catalogado si la prioridad lo permite, MOVIENDO su carpeta al árbol nuevo
 * (reubicarPorCdu: verificación de la copia; si el destino está ocupado por otro documento, carpeta propia con
 * sufijo). NO la marca como manual: queda con su fuente, y una de rango mayor podrá sustituirla después.
 * Regenera los sidecars y el índice. Los tomos de una obra no se tocan (comparten la CDU de la obra).
 * @returns {Promise<{aplicada:boolean, motivo?:string, de?:string, a?:string}>}
 */
export async function aplicarCduConPrioridad(db, doc, cduNueva, fuenteNueva, { aplicar = true } = {}) {
    cduNueva = modernizarCDU(cduNueva);   // última red: nunca se aplica una CDU en notación antigua
    if (doc.obra) return { aplicada: false, motivo: 'tomo de obra: comparte la CDU de la obra' };
    if (!puedeSustituirCdu(doc, cduNueva, fuenteNueva)) {
        return { aplicada: false, motivo: `la CDU actual (${doc.cdu}, ${fuenteCduDoc(doc)}) tiene prioridad sobre ${cduNueva} (${fuenteNueva})` };
    }
    if (!aplicar) return { aplicada: true, de: doc.cdu, a: cduNueva, seco: true };
    const reub = await reubicarPorCdu(doc, cduNueva);
    const set = { ...(reub?.set || { cdu: cduNueva }), cdu_fuente: fuenteNueva, fecha_actualizacion: new Date() };
    const alerta = `CDU ${doc.cdu || '∅'} → ${cduNueva} (${fuenteNueva}: prioridad sobre ${fuenteCduDoc(doc)}).`
        + (reub?.alertas?.length ? ' ' + reub.alertas.join(' ') : '');
    await db.collection('biblioteca').updateOne({ _id: doc._id }, { $set: set, $push: { alertas_agente: alerta } });
    const nuevo = { ...doc, ...set };
    await regenerarSidecarsDoc(db, nuevo, carpetaDeDoc(nuevo)).catch(() => {});
    await indexarDoc(db, doc._id).catch(() => {});
    return { aplicada: true, de: doc.cdu, a: cduNueva };
}
