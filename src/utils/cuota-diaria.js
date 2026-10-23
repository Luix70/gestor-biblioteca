/**
 * Reinicio de las CUOTAS DIARIAS gratuitas de Google (Gemini, Google Books): medianoche, hora del Pacífico.
 * Se usa para dejar de insistir mientras una cuota diaria está agotada (buscador-google-books, campañas con IA).
 */

const MARGEN_MS = 5 * 60000;   // unos minutos de margen tras la medianoche

/** Desfase (ms) de la hora del Pacífico respecto a UTC en el instante `t` (−7 h en verano, −8 h en invierno). */
function desfasePacifico(t) {
  const partes = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(t)).map((p) => [p.type, p.value]));
  const comoUTC = Date.UTC(+partes.year, +partes.month - 1, +partes.day, +partes.hour, +partes.minute, +partes.second);
  return comoUTC - Math.floor(t / 1000) * 1000;
}

/**
 * Próxima medianoche del Pacífico (con margen), en ms epoch. Con el cambio de hora real: medido en el log (oct-2026),
 * la cuota de Gemini volvía a las 9:00 de España (07:00 UTC, horario de verano del Pacífico), no a las 08:05 UTC que
 * se usaba fijo. Si Intl no tuviera la zona, cae a ese 08:05 UTC (cubre los dos horarios, con hasta 1 h de retraso).
 */
export function reinicioCuotaPacifico() {
  const ahora = Date.now();
  try {
    const desfase = desfasePacifico(ahora);
    const local = new Date(ahora + desfase);   // «reloj de pared» del Pacífico, leído con getUTC*
    let medianoche = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1) - desfase;
    // Si entre hoy y mañana cambia la hora, el desfase de la medianoche es otro: se corrige con el de ese instante.
    medianoche += desfase - desfasePacifico(medianoche);
    return medianoche + MARGEN_MS;
  } catch {
    const ahoraD = new Date(ahora);
    const t = new Date(Date.UTC(ahoraD.getUTCFullYear(), ahoraD.getUTCMonth(), ahoraD.getUTCDate(), 8, 5));
    if (t.getTime() <= ahora) t.setUTCDate(t.getUTCDate() + 1);
    return t.getTime();
  }
}
