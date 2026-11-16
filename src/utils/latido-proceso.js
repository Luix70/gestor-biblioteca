/**
 * LATIDO DE UN PROCESO DE FONDO — qué está haciendo ahora (PreProceso), para que se vea si trabaja o está bloqueado.
 *
 * Petición del usuario (16-nov): «el preprocesador no deja registro en el log; ¿podemos saber si está activo o
 * bloqueado?». Medido: la inspección con IA de «Science» estuvo 14 minutos sin escribir una línea. Ahora:
 *   · cada FASE se anuncia en el log al empezar (la consola ya pone la marca de tiempo);
 *   · mientras dura, un LATIDO cada `latidoMin` repite qué hace y desde cuándo;
 *   · el estado se escribe también en un fichero (`_ESTADO PREPROCESO.txt` en la carpeta), legible desde el
 *     Explorador sin abrir el log.
 * (No confundir con utils/actividad.js, que es el semáforo de la copia de seguridad.)
 */
import fs from 'node:fs/promises';

const MAX_HISTORIA = 25;

export function crearLatido(nombre, { fichero = null, latidoMin = 5 } = {}) {
    const estado = { fase: null, desde: null, detalle: null };
    const historia = [];   // últimas fases, con su hora
    let reloj = null;

    const hora = (t) => new Date(t).toLocaleTimeString('es-ES');
    const minutos = (t) => Math.round((Date.now() - t) / 60000);
    const anotar = (texto) => {
        historia.push(`${new Date().toLocaleString('es-ES')} · ${texto}`);
        if (historia.length > MAX_HISTORIA) historia.shift();
    };

    async function escribirFichero() {
        if (!fichero) return;
        const lineas = [
            `${nombre} · actualizado ${new Date().toLocaleString('es-ES')}`,
            '',
            estado.fase
                ? `ACTIVO: ${estado.fase}${estado.detalle ? ` — ${estado.detalle}` : ''} (desde las ${hora(estado.desde)}, ${minutos(estado.desde)} min)`
                : 'EN REPOSO: nada que preparar ahora.',
            '',
            'Últimas fases:',
            ...historia.map((h) => `  ${h}`),
            '',
            `Si «actualizado» se queda más de ${latidoMin * 3} min atrás estando ACTIVO, algo se ha colgado: mira el log.`,
        ];
        await fs.writeFile(fichero, lineas.join('\n') + '\n').catch(() => {});
    }

    function latir() {
        if (!estado.fase) return;
        console.log(`  ⏳ ${nombre}: sigue — ${estado.fase}${estado.detalle ? ` — ${estado.detalle}` : ''} (${minutos(estado.desde)} min en esta fase)`);
        escribirFichero();
    }

    return {
        /** Empieza una fase: se anuncia en el log y en el fichero, y arranca el latido. */
        fase(texto) {
            estado.fase = texto;
            estado.desde = Date.now();
            estado.detalle = null;
            anotar(texto);
            console.log(`  🧰 ${nombre}: ${texto}`);
            if (!reloj) {
                reloj = setInterval(latir, Math.max(1, latidoMin) * 60000);
                reloj.unref();
            }
            escribirFichero();
        },
        /** Detalle de la fase en curso (no escribe en el log: sale en el latido y en el fichero). */
        detalle(texto) { estado.detalle = texto; },
        /** Trabajo terminado: reposo (una línea en el log solo si había fase). */
        reposo(resumen = '') {
            if (estado.fase) {
                console.log(`  💤 ${nombre}: en reposo${resumen ? ` — ${resumen}` : ''}.`);
                anotar(`en reposo${resumen ? ` — ${resumen}` : ''}`);
            }
            estado.fase = null;
            estado.detalle = null;
            if (reloj) { clearInterval(reloj); reloj = null; }
            escribirFichero();
        },
        get activo() { return Boolean(estado.fase); },
    };
}
