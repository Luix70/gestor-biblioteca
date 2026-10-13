/**
 * POLÍTICA DE IA de un trabajo en segundo plano (13-oct): qué IA puede usar todo lo que corra dentro de él.
 *
 *   'todas'   → la rotación normal (gratis primero, la de pago como último recurso) — lo de siempre;
 *   'gratis'  → solo proveedores gratuitos: si están saturados, la llamada falla y el trabajo lo deja para luego;
 *   'ninguna' → ninguna llamada de IA: el trabajo hace solo lo que puede sin ella.
 *
 * En vez de pasar un parámetro por cada función que acaba llamando a la IA (las campañas llegan a ella por caminos
 * largos: enriquecer-a-fondo → extraerConPlantilla → conVision…), la política va en el CONTEXTO asíncrono
 * (AsyncLocalStorage): `conPoliticaIA(modo, fn)` la fija para todo lo que se ejecute dentro de fn, y las tres
 * puertas de la IA la respetan (vision.js·conVision y conTexto, gemini.js·conGemini). Fuera de un contexto, todo
 * sigue como antes.
 *
 * Cada llamada que la política deja sin IA se ANOTA (`bloqueos`): así el motor de campañas sabe que un documento
 * se quedó sin procesar por la política —aunque la función que llamó a la IA se tragara el error— y no lo sella
 * como hecho (si no, la campaña «terminaría» sin haber hecho nada).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const MODOS_IA = ['todas', 'gratis', 'ninguna'];
const almacen = new AsyncLocalStorage();

/** Ejecuta fn con la política `modo` para toda la IA que se llame dentro. Devuelve lo que devuelva fn. */
export function conPoliticaIA(modo, fn) {
  const politica = { modo: MODOS_IA.includes(modo) ? modo : 'todas', bloqueos: 0 };
  return almacen.run(politica, fn);
}

/** La política en vigor ({ modo, bloqueos }) o null si no hay ninguna (comportamiento normal). */
export function politicaIA() {
  return almacen.getStore() || null;
}

/** ¿Puede usarse un proveedor de este tier ('free' | 'paid')? */
export function tierPermitido(tier) {
  const p = politicaIA();
  if (!p || p.modo === 'todas') return true;
  if (p.modo === 'ninguna') return false;
  return tier === 'free';
}

/** Error de «la política no deja IA para esta llamada»; lo anota en la política en vigor. */
export function errorSinIA(detalle = '') {
  const p = politicaIA();
  if (p) p.bloqueos++;
  const e = new Error(`IA no disponible con la política «${p?.modo}»${detalle ? `: ${detalle}` : ''}`);
  e.codigo = 'IA_NO_DISPONIBLE';
  return e;
}

/** Anota que una llamada falló con todos los proveedores permitidos (con 'gratis': las gratis saturadas). */
export function anotarSinIA() {
  const p = politicaIA();
  if (p && p.modo !== 'todas') p.bloqueos++;
}
