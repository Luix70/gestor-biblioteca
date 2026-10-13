/**
 * GUION DEL SECO (13-oct): que un dry-run largo no se desperdicie.
 *
 * Muchos scripts de reparación recorren toda la base o el árbol (15-30 min) o gastan IA para DECIDIR qué hacer, y
 * después `--ejecutar` lo volvía a decidir todo desde cero: el doble de tiempo (y de IA). Con esta utilidad el seco
 * escribe un GUION —la lista de acciones que haría, con lo que vio de cada documento— y un `--ejecutar` lanzado
 * poco después con los MISMOS parámetros lo lee y solo APLICA esas acciones.
 *
 * Seguridad: cada acción lleva `antes` (los campos del documento tal como estaban en el seco). Quien ejecuta debe
 * comprobar que siguen igual antes de aplicarla (`sigueIgual`); si algo cambió entretanto (la ingesta, el
 * Conformador, una edición a mano), esa acción se vuelve a decidir o se salta, nunca se aplica a ciegas.
 * El guion caduca (24 h por defecto), se ignora si cambian los parámetros, y se archiva al ejecutarlo: un guion
 * solo se ejecuta una vez.
 *
 * Uso en un script:
 *   const guion = abrirGuion('afinar-cdu', { parametros: { limite: LIMITE } });
 *   let plan = EJECUTAR ? await guion.leer() : null;          // el del seco, si vale
 *   if (!plan) { …decidir… ; plan = { acciones, resumen } }
 *   if (!EJECUTAR) { await guion.guardar(plan.acciones, plan.resumen); … }
 *   else { for (const a of plan.acciones) { if (!sigueIgual(doc, a.antes)) …; aplicar(a) }; await guion.archivar(); }
 *
 * Las acciones deben ser JSON (los ObjectId, como texto). Se guardan en logs/guiones/<script>.json.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(RAIZ, 'logs', 'guiones');

const mismosParametros = (a, b) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/**
 * @param {string} script       nombre del script (también el del fichero)
 * @param {{parametros?:object, maxEdadHoras?:number}} opciones  parametros: los que cambian lo que se decide
 */
export function abrirGuion(script, { parametros = {}, maxEdadHoras = 24 } = {}) {
  const ruta = path.join(DIR, `${script}.json`);
  return {
    ruta,

    /**
     * El guion del último seco, si vale para esta ejecución: { acciones, resumen, fecha } o null (no hay, caducó o
     * los parámetros son otros). Dice por consola por qué lo usa o no.
     */
    async leer() {
      let g;
      try { g = JSON.parse(await fs.readFile(ruta, 'utf8')); } catch { return null; }
      const edadH = (Date.now() - new Date(g.fecha).getTime()) / 3600_000;
      if (!(edadH <= maxEdadHoras)) {
        console.log(`   (guion del seco de hace ${Math.round(edadH)} h: caducado, se vuelve a decidir todo)`);
        return null;
      }
      if (!mismosParametros(g.parametros, parametros)) {
        console.log('   (el guion del seco se hizo con otros parámetros: se vuelve a decidir todo)');
        return null;
      }
      console.log(`   📜 Usando el guion del seco de hace ${edadH < 1 ? `${Math.round(edadH * 60)} min` : `${edadH.toFixed(1)} h`}: ${g.acciones.length} acción(es); se comprueba cada documento antes de aplicarla.`);
      return g;
    },

    /** Guarda el guion del seco. */
    async guardar(acciones, resumen = {}) {
      await fs.mkdir(DIR, { recursive: true });
      await fs.writeFile(ruta, JSON.stringify({ script, fecha: new Date(), parametros, resumen, acciones }));
      console.log(`   📜 Guion guardado (${acciones.length} acción(es)): un --ejecutar con los mismos parámetros en las próximas ${maxEdadHoras} h lo aplicará sin volver a calcularlo.`);
    },

    /** Tras ejecutarlo: se archiva con la fecha (no se vuelve a usar, pero queda como registro). */
    async archivar() {
      const sello = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      await fs.rename(ruta, path.join(DIR, `${script}.ejecutado-${sello}.json`)).catch(() => {});
    },
  };
}

/**
 * ¿El documento sigue como lo vio el seco? Compara los campos de `antes` (valores JSON) con los actuales.
 * Un campo ausente y null/'' cuentan igual.
 */
export function sigueIgual(doc, antes = {}) {
  const norma = (v) => (v === undefined || v === null || v === '' ? null : JSON.stringify(v));
  return Object.entries(antes).every(([campo, valor]) => norma(doc?.[campo]) === norma(valor));
}
