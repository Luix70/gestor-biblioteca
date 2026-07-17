/**
 * DRY-RUN del Inbox: qué HARÍA el vigilante con lo que hay ahora mismo, SIN catalogar, mover ni borrar nada.
 *
 *   node scripts/dry-run.js            → el plan por consola
 *   node scripts/dry-run.js --json     → el plan en JSON (para verlo con jq o guardarlo)
 *
 * En el NAS, dentro del contenedor:
 *   docker exec gestor-biblioteca node scripts/dry-run.js
 *
 * Llama a la MISMA función que decide de verdad (`vigilante.js · planificarInbox` → `listarUnidades`), no a un
 * simulador: si el plan miente, es que el vigilante hace eso. Y lo importante no es solo qué se va a catalogar
 * — es QUÉ SE VA A QUEDAR FUERA Y POR QUÉ, que es lo que no puedes averiguar mirando el resultado.
 */
import 'dotenv/config';
import '../src/config.js';
import { planificarInbox, INBOX } from '../src/vigilante.js';

// OJO: se escribe con process.stdout, NO con console.log. Importar el vigilante trae consigo
// `utils/consola-timestamp.js`, que SILENCIA los console.log/info que no lleven un marcador de titular
// (✅ ⚠ 📥…) salvo con LOG_VERBOSE=1 — el informe entero se tragaba sin dejar ni una línea ni un error.
// Y es lo correcto además: esto es la SALIDA del programa, no un log.
const escribir = (s = '') => process.stdout.write(s + '\n');

const JSON_OUT = process.argv.includes('--json');
const plan = await planificarInbox();

if (JSON_OUT) {
    escribir(JSON.stringify(plan, null, 2));
    process.exit(0);
}

const RAYA = '─'.repeat(78);
escribir(`\n${'═'.repeat(78)}`);
escribir('  DRY-RUN DEL INBOX — lo que PASARÍA. No se ha tocado nada.');
escribir('═'.repeat(78));
escribir(`  Inbox: ${INBOX}`);
escribir(`  ${plan.resumen.unidades} unidad(es) · ${plan.resumen.documentos}+ documento(s) · ${plan.resumen.excluidos} entrada(s) fuera\n`);

if (plan.unidades.length) {
    escribir(RAYA);
    escribir('  SE CATALOGARÍA');
    escribir(RAYA);
    // Agrupado por CARPETA de primer nivel: es como el usuario ve su Inbox, no como lo ve el vigilante.
    const porCarpeta = new Map();
    for (const u of plan.unidades) {
        const k = u.carpeta || '(sueltos en la raíz)';
        if (!porCarpeta.has(k)) porCarpeta.set(k, []);
        porCarpeta.get(k).push(u);
    }
    for (const [carpeta, us] of porCarpeta) {
        escribir(`\n  📁 ${carpeta}`);
        for (const u of us) {
            escribir(`     ${u.grave ? '⚠' : '·'} [${u.tipo}] ${u.titulo}`);
            escribir(`       ${u.efecto}`);
        }
    }
    escribir('');
}

// Lo que se pierde DENTRO de una carpeta que sí se procesa. Es lo más traicionero del informe: la carpeta se
// cataloga, tú la das por buena, y ahí dentro se queda un .tgz con tres libros. Por eso va aparte y al final.
const perdidos = plan.unidades.filter((u) => u.grave);
if (perdidos.length) {
    escribir(RAYA);
    escribir('  ⚠ SE PROCESA LA CARPETA, PERO ESTO NO ENTRA  ← lo que se pierde sin enterarte');
    escribir(RAYA);
    for (const u of perdidos) {
        escribir(`  ⚠ ${u.carpeta ? u.carpeta + ' → ' : ''}${u.titulo}`);
        escribir(`      ${u.motivo ? u.motivo + ': ' : ''}${u.efecto}`);
    }
    escribir('');
}

if (plan.excluidos.length) {
    escribir(RAYA);
    escribir('  NO SE CATALOGARÍA  ← lo que hay que mirar');
    escribir(RAYA);
    for (const x of plan.excluidos) {
        escribir(`  ${x.grave ? '⚠' : '·'} ${x.nombre}`);
        escribir(`      ${x.motivo}: ${x.detalle}`);
    }
    const graves = plan.excluidos.filter((x) => x.grave).length;
    if (graves) escribir(`\n  ⚠ ${graves} entrada(s) se quedarían fuera SIN una razón buena. Eso es un fallo: avisa.`);
    escribir('');
}

if (!plan.unidades.length && !plan.excluidos.length) escribir('  El Inbox está vacío.\n');
escribir('═'.repeat(78));
escribir('  Nada de esto ha ocurrido: es un simulacro. Activa el Vigilante para ejecutarlo.');
escribir(`${'═'.repeat(78)}\n`);
process.exit(0);
