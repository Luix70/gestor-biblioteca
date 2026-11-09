/**
 * DETECTAR CAPÍTULOS COLADOS — libros que se catalogaron capítulo a capítulo (uno por documento) y que deben ser
 * UN documento: un PDF cosido con índice y los capítulos como adjunto (utils/unir-capitulos.js).
 *
 * Grupos (gruposDeCapitulos): PDFs pequeños (≤150 págs.) que comparten
 *   · una OBRA cuyos tomos son todos pequeños y con nombre de capítulo («Theory of Machines»: Ch-0 Index…chp-26), o
 *   · un ISBN sin ser versiones del mismo fichero («Elements of Photonics»: V2CH9, V2CH10, V2CH16), o
 *   · el título del libro + la misma serie de nombres, ingeridos a la vez (menos seguro: no se une con --ejecutar).
 *
 * Por defecto LISTA y crea (o actualiza) una SELECCIÓN por grupo, «Capítulos por unir: <título> (N)», para revisarlo
 * en el panel y unirlo con «📑 Unir capítulos». --ejecutar une SOLO los grupos seguros (obra / ISBN). Haz COPIA DE
 * SEGURIDAD de la base antes (D:\Bibliobak\CopiaBase.ps1).
 *
 *   sudo docker exec -t gestor-biblioteca node scripts/detectar-capitulos.js                    (lista + selecciones)
 *   sudo docker exec -t gestor-biblioteca node scripts/detectar-capitulos.js --sin-selecciones  (solo lista)
 *   sudo docker exec -t gestor-biblioteca node scripts/detectar-capitulos.js --ejecutar         (une los seguros)
 */
import 'dotenv/config';
import '../src/utils/log-script.js';   // marca de tiempo en pantalla + registro en logs/scripts (estándar)
import '../src/config.js';
import { conectarDB } from '../src/database.js';
import { progreso } from '../src/utils/progreso-cli.js';
import { gruposDeCapitulos, seleccionDeGrupo, unirCapitulos } from '../src/utils/unir-capitulos.js';

const args = process.argv.slice(2);
const EJECUTAR = args.includes('--ejecutar');
const SELECCIONES = !args.includes('--sin-selecciones');

const db = await conectarDB();

console.log(`📑 Buscando libros catalogados capítulo a capítulo${EJECUTAR ? ' · se UNIRÁN los grupos seguros' : ' (seco)'}…`);
let p = null;
const grupos = await gruposDeCapitulos(db, {
    alProgreso: (i, total, fase) => { if (!p) p = progreso(total, `Revisando ${fase}`); p.paso(); },
});
if (p) p.fin();

const seguros = grupos.filter((g) => g.seguro);
console.log(`\n${grupos.length} grupo(s): ${seguros.length} seguro(s), ${grupos.length - seguros.length} por revisar.\n`);
for (const g of grupos) {
    console.log(`📖 «${String(g.titulo).slice(0, 70)}» · ${g.ids.length} capítulos · ${g.paginas || '?'} págs. · ${g.motivo}${g.seguro ? '' : ' (por revisar)'}`);
    console.log(`     ${g.nombres.slice(0, 8).join(' · ')}${g.nombres.length > 8 ? ` … (+${g.nombres.length - 8})` : ''}`);
}

if (SELECCIONES && grupos.length) {
    const ps = progreso(grupos.length, 'Selecciones');
    for (const g of grupos) { await seleccionDeGrupo(db, g); ps.paso(g.titulo); }
    console.log(`\n📌 ${grupos.length} selección(es) «Capítulos por unir: …» creadas o actualizadas (${ps.fin()}).`);
}

if (EJECUTAR && seguros.length) {
    let unidos = 0, fallos = 0;
    const pe = progreso(seguros.length, 'Uniendo');
    for (const g of seguros) {
        pe.paso(g.titulo);
        const r = await unirCapitulos(db, g.ids).catch((e) => ({ ok: false, motivo: e.message }));
        if (r.ok) { unidos++; pe.nota(`✅ «${String(g.titulo).slice(0, 50)}»: ${g.ids.length} capítulos → ${r.paginas || '?'} págs.${r.isbn ? ` · ISBN ${r.isbn}` : ''}`); }
        else { fallos++; pe.nota(`⚠️  «${String(g.titulo).slice(0, 50)}»: ${r.motivo}`); }
    }
    console.log(`\n=== Unidos ${unidos} libro(s), ${fallos} sin unir (${pe.fin()}) ===`);
} else if (!EJECUTAR && seguros.length) {
    console.log('\n▶ Revisa las selecciones en el panel, o ejecuta con --ejecutar para unir los seguros (haz COPIA DE SEGURIDAD de la BD antes).');
}
process.exit(0);
