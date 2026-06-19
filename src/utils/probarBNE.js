import { obtenerFichaCompletaPorISBN } from './bneClientExtended.js';

async function test() {
  const isbnTarget = '9788491041795';
  console.log(`Lanzando consulta semántica avanzada para el ISBN: ${isbnTarget}...\n`);

  try {
    const ficha = await obtenerFichaCompletaPorISBN(isbnTarget);

    if (ficha) {
      console.log('====== FICHA DE CATALOGACIÓN EXTRAÍDA DE LA BNE ======\n');
      console.log(`[Título / Responsabilidad]: ${ficha.tituloPrincipal}`);
      console.log(`[Mención de Autoría]:       ${ficha.mencionResponsabilidad}`);
      console.log(`[Edición]:                  ${ficha.edicion}`);
      console.log(`[Descripción física]:       ${ficha.descripcionFisica}`);
      console.log(`[CDU]:                      ${ficha.cdu}`);
      console.log(`[Identificadores]:          ISBN: ${ficha.isbn} | Depósito Legal: ${ficha.depositoLegal}`);
      console.log(`[Datos de publicación]:     ${ficha.datosPublicacion.lugar} : ${ficha.datosPublicacion.editorial} , ${ficha.datosPublicacion.anio}`);
      console.log(`[Serie]:                    ${ficha.serie}`);
      console.log(`[Otro título]:              ${ficha.otroTitulo}`);
      console.log(`\n[ID Interno del Recurso]:   ${ficha.registroBNE}`);
      console.log('\n======================================================');
    } else {
      console.log('No se encontraron registros extendidos para este ISBN.');
    }
  } catch (err) {
    console.error('Error al ejecutar el script de pruebas:', err);
  }
}

test();
