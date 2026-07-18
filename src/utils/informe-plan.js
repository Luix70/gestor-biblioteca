/**
 * INFORME DEL PLAN DE INGESTA (HTML) — «¿se ha importado todo según el plan?».
 *
 * El dry-run dice qué VA a pasar. Esto es la otra mitad: COTEJA cada cosa planeada contra el catálogo real y
 * te dice si de verdad entró. Sin esto, para comprobar una ingesta de 121 unidades hay que ir mirando el
 * catálogo a mano — y con ese esfuerzo nadie comprueba nada, que es como se pierden cosas sin enterarse.
 *
 * El cotejo es por NOMBRE DE FICHERO (`biblioteca.nombre_archivo`), que es lo que sobrevive a la ingesta: el
 * título se normaliza, la ruta cambia, pero el nombre del fichero original se conserva a propósito.
 *
 * Tres estados por entrada, y el importante es el tercero:
 *   ✔ dentro     — todos sus ficheros están en el catálogo.
 *   ◐ a medias   — entraron algunos; se listan los que faltan.
 *   ✗ fuera      — no entró ninguno.
 * Las unidades que aún no se han ejecutado salen como «pendiente» (es un plan, no un fallo).
 */
import { CSS_INFORME } from './informe-integridad.js';

const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => new Intl.NumberFormat('es-ES').format(n || 0);

/**
 * @param {object} plan  lo devuelto por `planificarInbox()` (sus entradas llevan `ficheros[]`).
 * @param {object} opts
 * @param {Map<string,{_id,titulo}>} opts.catalogados  nombre_archivo → doc encontrado en `biblioteca`.
 * @param {boolean} opts.ejecutado  true = ya se ingirió (se juzga); false = aún es un plan (se informa).
 * @param {string}  opts.base       URL del panel, para enlazar cada documento a su ficha.
 */
export function informePlanHtml(plan, { catalogados = new Map(), ejecutado = false, base = '' } = {}) {
    const fecha = new Date(plan?.ts || Date.now()).toLocaleString('es-ES');
    const h = [];

    // Estado de cada entrada según cuántos de sus ficheros aparecen ya en el catálogo.
    const evaluar = (e) => {
        const fich = Array.isArray(e.ficheros) ? e.ficheros : [];
        if (!fich.length) return { clase: 'na', etq: '—', dentro: [], faltan: [] };
        const dentro = fich.filter((f) => catalogados.has(f));
        const faltan = fich.filter((f) => !catalogados.has(f));
        if (!faltan.length) return { clase: 'ok', etq: '✔ dentro', dentro, faltan };
        if (dentro.length) return { clase: 'medio', etq: '◐ a medias', dentro, faltan };
        return { clase: 'no', etq: ejecutado ? '✗ NO entró' : '· pendiente', dentro, faltan };
    };

    const entradas = (plan?.unidades || []).map((e) => ({ e, ev: evaluar(e) }));
    const tot = { ok: 0, medio: 0, no: 0, na: 0 };
    for (const { ev } of entradas) tot[ev.clase]++;
    // Ficheros, no unidades: es el número que de verdad dice si se perdió algo.
    let fTot = 0, fDentro = 0;
    for (const { e } of entradas) for (const f of (e.ficheros || [])) { fTot++; if (catalogados.has(f)) fDentro++; }

    h.push('<!doctype html><html lang="es"><head><meta charset="utf-8">');
    h.push('<meta name="viewport" content="width=device-width,initial-scale=1">');
    h.push(`<title>Plan de ingesta · ${escH(fecha)}</title><style>${CSS_INFORME}`);
    h.push(`.ok{color:var(--ok)}.no{color:var(--warn)}.medio{color:var(--warn)}
            .est{font-weight:600;white-space:nowrap}
            .barra{height:10px;border-radius:6px;background:var(--card2);overflow:hidden;margin:10px 0 4px}
            .barra>i{display:block;height:100%;background:var(--ok)}</style></head><body>`);
    h.push('<h1>📋 Plan de ingesta · comprobación</h1>');
    h.push(`<div class="sub">${escH(fecha)} · ${num(plan?.resumen?.unidades || 0)} unidad(es) planeadas`
        + ` · ${ejecutado ? 'cotejado contra el catálogo' : 'aún no ejecutado (previsión)'}</div>`);

    // ── Resumen: lo primero, el % de ficheros que están dentro ──
    const pct = fTot ? Math.round((fDentro / fTot) * 100) : 0;
    h.push('<div class="card">');
    h.push(`<div class="barra"><i style="width:${pct}%"></i></div>`);
    h.push(`<b>${num(fDentro)} de ${num(fTot)} ficheros en el catálogo (${pct}%)</b>`);
    h.push('<table style="margin-top:12px">');
    h.push(`<tr><td>✔ Entradas completas</td><td class="n ok">${num(tot.ok)}</td></tr>`);
    h.push(`<tr><td>◐ A medias (entró parte)</td><td class="n ${tot.medio ? 'medio' : ''}">${num(tot.medio)}</td></tr>`);
    h.push(`<tr><td>${ejecutado ? '✗ No entraron' : '· Pendientes'}</td><td class="n ${ejecutado && tot.no ? 'no' : ''}">${num(tot.no)}</td></tr>`);
    h.push(`<tr><td>— Sin ficheros propios (carpeta/colección)</td><td class="n">${num(tot.na)}</td></tr>`);
    h.push('</table>');
    if (ejecutado && (tot.no || tot.medio))
        h.push('<div class="expl" style="margin-top:12px"><b>Ojo:</b> lo marcado ✗ o ◐ es lo que hay que mirar. '
            + 'Un fichero que no está en el catálogo NO se ha borrado: sigue en el Inbox o en la Papelera.</div>');
    if (!ejecutado)
        h.push('<div class="expl" style="margin-top:12px">Todavía no se ha ingerido: esto es la PREVISIÓN. '
            + 'Vuelve a generar el informe después de activar el Vigilante para comprobar qué entró de verdad.</div>');
    h.push('</div>');

    // ── Detalle, agrupado por carpeta (como lo ve el usuario en el Inbox) ──
    const porCarpeta = new Map();
    for (const x of entradas) {
        const k = x.e.carpeta || '(raíz del Inbox)';
        if (!porCarpeta.has(k)) porCarpeta.set(k, []);
        porCarpeta.get(k).push(x);
    }
    for (const [carpeta, items] of porCarpeta) {
        const malas = items.filter((x) => x.ev.clase === 'no' || x.ev.clase === 'medio').length;
        // Las carpetas con algo pendiente/fallido nacen ABIERTAS: son las que hay que mirar.
        h.push(`<details${(ejecutado && malas) || items.length <= 12 ? ' open' : ''}>`);
        h.push(`<summary>📁 ${escH(carpeta)} <span class="sub">(${items.length})</span>`
            + (malas && ejecutado ? ` <span class="tag man">${malas} a revisar</span>` : '') + '</summary><div class="body">');
        h.push('<ol class="items">');
        for (const { e, ev } of items) {
            const fichas = ev.dentro.map((f) => {
                const d = catalogados.get(f);
                return base && d?._id
                    ? `<a href="${escH(base)}/?doc=${escH(String(d._id))}" target="_blank" rel="noopener">${escH(f)}</a>`
                    : escH(f);
            });
            h.push(`<li><span class="est ${ev.clase}">${ev.etq}</span> <b>${escH(e.titulo || '(sin título)')}</b>`
                + ` <span class="sub">[${escH(e.tipo || '')}]</span>`
                + `<div class="campos"><div>${escH(e.efecto || '')}</div>`
                + (fichas.length ? `<div><span class="k">en el catálogo</span></div><ul class="grp">${fichas.map((x) => `<li class="mono">${x}</li>`).join('')}</ul>` : '')
                + (ev.faltan.length ? `<div><span class="k">${ejecutado ? 'NO están' : 'pendientes'}</span></div><ul class="grp">${ev.faltan.map((f) => `<li class="mono">${escH(f)}</li>`).join('')}</ul>` : '')
                + '</div></li>');
        }
        h.push('</ol></div></details>');
    }

    h.push('<div class="foot">Gestor de Biblioteca · Plan de ingesta</div></body></html>');
    return h.join('\n');
}
