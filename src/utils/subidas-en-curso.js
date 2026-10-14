/**
 * SUBIDAS EN CURSO (14-oct): qué está catalogando el servidor de lo que se subió desde el panel.
 *
 * La ingesta del Inbox se ve en el panel (el vigilante publica su actividad), pero una subida por POST /api/ingestar
 * se catalogaba sin avisar a nadie: con 184 ficheros en una sola subida, el servidor estuvo más de dos horas
 * catalogando y el panel no daba ninguna señal (el proxy había cortado la espera). Aquí cada subida se registra con su
 * avance; GET /api/estado lo devuelve y el panel lo pinta junto al vigilante.
 * En memoria: si el contenedor se reinicia, la subida se corta igualmente (sus temporales quedan en temp/).
 */
const subidas = new Map();   // id → { id, total, hechas, actual, inicio, errores }
let secuencia = 0;

/** Registra una subida que empieza a catalogarse. Devuelve su id. */
export function empezarSubida(total) {
  const id = ++secuencia;
  subidas.set(id, { id, total, hechas: 0, errores: 0, actual: null, inicio: Date.now() });
  return id;
}

/** Va a catalogar `nombre` (el fichero o la unidad en curso). */
export function catalogando(id, nombre) {
  const s = subidas.get(id);
  if (s) s.actual = nombre;
}

/** Terminó una unidad (bien o mal). */
export function unidadHecha(id, { ok = true } = {}) {
  const s = subidas.get(id);
  if (!s) return;
  s.hechas++;
  if (!ok) s.errores++;
}

/** La subida terminó entera. */
export function terminarSubida(id) {
  subidas.delete(id);
}

/** Para GET /api/estado: las subidas en curso, con su avance y el tiempo que les queda (estimado). */
export function estadoSubidas() {
  return [...subidas.values()].map((s) => {
    const transcurrido = Date.now() - s.inicio;
    const restante = s.hechas ? Math.round((transcurrido / s.hechas) * (s.total - s.hechas) / 1000) : null;
    return { ...s, transcurrido_s: Math.round(transcurrido / 1000), restante_s: restante };
  });
}
