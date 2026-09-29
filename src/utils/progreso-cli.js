/**
 * PROGRESO EN CONSOLA — requisito del usuario para TODO proceso sobre lotes de documentos: una línea que avanza en
 * su sitio con `etiqueta · hechos/total (pct) · faltan ~ETA · transcurrido`, nunca una consola muda («la diferencia
 * puede ser de minutos o de horas»). Las líneas relevantes (resultados, errores) se escriben con `nota()`, que
 * borra la de progreso antes y la repinta después, para que no se mezclen.
 *
 *   const p = progreso(total, 'Recolocando');
 *   for (…) { p.paso(titulo); … p.nota('✅ …'); }
 *   p.fin();
 */
const fmt = (ms) => {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s >= 3600) return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
    if (s >= 60) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
    return `${s}s`;
};

export function progreso(total, etiqueta = 'Procesando') {
    const t0 = Date.now();
    let hechos = 0, ultimo = '', ultimaPintura = 0;
    const linea = () => {
        const pct = total ? Math.floor((100 * hechos) / total) : 0;
        const eta = hechos > 0 && total ? fmt(((Date.now() - t0) / hechos) * (total - hechos)) : '…';
        return `   ⏳ ${etiqueta} ${hechos}/${total || '?'}${total ? ` (${pct}%)` : ''} · faltan ~${eta} · ${fmt(Date.now() - t0)}${ultimo ? ` · ${ultimo}` : ''}`;
    };
    const pintar = (forzar = false) => {
        // Como mucho ~5 repintados por segundo (con decenas de miles de ítems, escribir en cada uno frena).
        if (!forzar && Date.now() - ultimaPintura < 200) return;
        ultimaPintura = Date.now();
        process.stdout.write(`\r\x1b[K${linea().slice(0, (process.stdout.columns || 160) - 1)}`);
    };
    return {
        /** Avanza uno (o `n`) y muestra, si se da, qué se está tratando. */
        paso(texto = '', n = 1) { hechos += n; ultimo = String(texto || '').slice(0, 50); pintar(); },
        /** Escribe una línea RELEVANTE (resultado, error) sin romper la de progreso. */
        nota(texto) { process.stdout.write(`\r\x1b[K${texto}\n`); pintar(true); },
        /** Borra la línea de progreso y devuelve el tiempo total. */
        fin() { process.stdout.write('\r\x1b[K'); return fmt(Date.now() - t0); },
        get hechos() { return hechos; },
    };
}
