/**
 * INSPECCIÓN CON IA A DEMANDA desde el panel: Entrada → «🧭 Guiar la ingesta» → botón «🤖 IA» de una carpeta.
 *
 * Lo mismo que `scripts/inspeccionar-estructura.js`, en dos pasos como el «🧩 Patrón»:
 *   1) PROPONER (en segundo plano: un árbol grande son varias llamadas y minutos) → esqueleto, interpretación, plan
 *      de guías y afinado (ISSN comprobado, orden de los desgloses). No escribe nada.
 *   2) APLICAR las guías que elijas en el panel (las dudosas vienen desmarcadas), y la marca de «inspeccionada»
 *      si la carpeta es de primer nivel del Inbox, para que el vigilante no la vuelva a inspeccionar.
 *
 * Mientras tanto la carpeta de primer nivel queda RESERVADA (inspeccion-auto · reservarCarpeta): el vigilante no la
 * ingiere ni la inspecciona por su cuenta hasta que apliques o descartes (o caduque la reserva).
 * Un trabajo a la vez: la IA es de pago y el vigilante también la usa.
 */
import { esqueletoArbol, interpretarEstructura } from './agente-estructura.js';
import { planGuias, escribirGuias, resumenGuia, UMBRAL_CONFIANZA } from './guias-estructura.js';
import { afinarPlan } from './afinar-guias.js';
import { registrarInspeccion, reservarCarpeta, liberarCarpeta } from './inspeccion-auto.js';

let trabajo = null;   // { sub, abs, reserva, fase, inicio, fin, error, resultado:{esq,r,plan,notas}, descartar }

/**
 * Lanza la inspección de `abs` (ruta absoluta; `sub` = relativa al Inbox, para el panel). `reserva` = su carpeta de
 * primer nivel del Inbox. Si ya hay una propuesta de ESA carpeta y no se pide `repetir`, se reutiliza (no se gasta
 * otra llamada por reabrir el panel).
 */
export function lanzarInspeccionManual({ abs, sub, reserva, repetir = false }) {
    if (trabajo && !trabajo.fin) {
        return trabajo.sub === sub ? { ok: true, enCurso: true } : { ok: false, motivo: `Ya hay una inspección en curso («${trabajo.sub}»). Espera a que termine.` };
    }
    if (trabajo && trabajo.sub === sub && trabajo.resultado && !repetir) return { ok: true, existente: true };
    if (trabajo) liberarCarpeta(trabajo.reserva);   // la propuesta anterior (de otra carpeta) queda descartada

    const t = { sub, abs, reserva, fase: 'esqueleto', inicio: Date.now(), fin: null, error: null, resultado: null, descartar: false };
    trabajo = t;
    reservarCarpeta(reserva);
    (async () => {
        try {
            const esq = await esqueletoArbol(abs);
            t.carpetas = esq.carpetas.length;
            t.fase = 'ia';
            const r = await interpretarEstructura(esq);   // paciencia de CLI: estás esperando el resultado
            if (!r.carpetas.length) throw new Error(r.aviso || 'la IA no interpretó ninguna carpeta');
            t.fase = 'afinado';
            // Todas las guías posibles, dudosas incluidas, y AFINADAS: así ves el ISSN o el orden de un desglose
            // también de las que decidas marcar a mano. Cuáles se escriben lo eliges tú (aplicarInspeccionManual).
            const plan = await planGuias(abs, esq, r, { incluirDudosas: true, origenesReescribibles: ['agente', 'panel'] });
            const notas = await afinarPlan(plan, esq);
            t.resultado = { esq, r, plan, notas };
        } catch (e) {
            t.error = e.message;
            liberarCarpeta(reserva);
        } finally {
            t.fin = Date.now();
            if (t.descartar) { liberarCarpeta(reserva); if (trabajo === t) trabajo = null; }
        }
    })();
    return { ok: true, lanzado: true };
}

const FASES = { esqueleto: 'Leyendo el árbol…', ia: 'La IA está interpretando el árbol…', afinado: 'Comprobando ISSN y capítulos…' };

/** Estado para el sondeo del panel. Con la propuesta ya lista, la devuelve fila a fila. */
export function estadoInspeccionManual() {
    if (!trabajo) return { activo: false };
    const t = trabajo;
    const base = {
        activo: true, sub: t.sub, enCurso: !t.fin, fase: t.fase, faseTexto: FASES[t.fase] || t.fase,
        segundos: Math.round(((t.fin || Date.now()) - t.inicio) / 1000), carpetas: t.carpetas || null, error: t.error,
    };
    if (!t.resultado) return base;
    const { esq, r, plan, notas } = t.resultado;
    const porRuta = new Map(r.carpetas.map((c) => [c.ruta, c]));
    return {
        ...base,
        resultado: {
            raiz: esq.raiz, carpetas: esq.carpetas.length, recortado: !!esq.recortado, sinVer: esq.sin_ver || 0,
            llamadas: r.llamadas, aviso: r.aviso || null, notas,
            filas: plan.map((p) => ({
                ruta: p.ruta,
                nivel: p.ruta === '.' ? 0 : p.ruta.split('/').length,
                tipo: p.tipo, contenido: p.contenido,
                confianza: p.confianza,
                dudosa: p.confianza != null && p.confianza < UMBRAL_CONFIANZA,
                razon: porRuta.get(p.ruta)?.razon || null,
                estado: p.estado,          // nueva | actualizar | respetada | omitida
                motivo: p.motivo,
                escribible: p.estado === 'nueva' || p.estado === 'actualizar',
                resumen: resumenGuia(p.guia),
            })),
        },
    };
}

/** Escribe las guías de las carpetas elegidas (rutas relativas al árbol inspeccionado) y deja la marca. */
export async function aplicarInspeccionManual({ sub, rutas = [] }) {
    const t = trabajo;
    if (!t || t.sub !== sub || !t.resultado) return { ok: false, motivo: 'No hay una propuesta de esa carpeta (vuelve a inspeccionarla).' };
    const { esq, r, plan, notas } = t.resultado;
    const elegidas = new Set(rutas);
    const aEscribir = plan.filter((p) => (p.estado === 'nueva' || p.estado === 'actualizar') && elegidas.has(p.ruta));
    // Origen 'panel': las APROBASTE tú. La inspección automática las respeta como tuyas (si una subcarpeta se revisó
    // aquí, la de arriba se inspeccionará entera cuando le toque, pero no le reescribirá esto); una nueva
    // inspección desde el panel sí puede actualizarlas, porque repetirla es decisión tuya.
    for (const p of aEscribir) p.guia = { ...p.guia, perfil: { ...(p.guia.perfil || {}), origen: 'panel' } };
    const escritas = await escribirGuias(aEscribir);

    // La marca, solo en una carpeta de PRIMER nivel del Inbox: es la unidad con la que trabaja el vigilante.
    let marcada = false;
    if (t.abs === t.reserva) {
        const dudosas = plan.filter((p) => p.guia && !elegidas.has(p.ruta) && p.confianza != null && p.confianza < UMBRAL_CONFIANZA)
            .map((p) => ({ ruta: p.ruta, tipo: p.tipo, contenido: p.contenido, motivo: 'dudosa: no marcada en el panel' }));
        await registrarInspeccion(t.abs, { esq, r, escritas: aEscribir, notas, dudosas, segundos: Math.round((t.fin - t.inicio) / 1000), origen: 'panel' });
        marcada = true;
    }
    liberarCarpeta(t.reserva);
    trabajo = null;
    return { ok: true, escritas, marcada };
}

/** Descarta la propuesta (o la inspección en curso) y libera la carpeta para el vigilante. */
export function descartarInspeccionManual({ sub }) {
    const t = trabajo;
    if (!t || t.sub !== sub) return { ok: true };
    if (!t.fin) { t.descartar = true; return { ok: true, pendiente: true }; }   // termina y se descarta sola
    liberarCarpeta(t.reserva);
    trabajo = null;
    return { ok: true };
}
