/**
 * ACTIVIDAD GLOBAL — ¿qué trabajo pesado está en marcha AHORA, además de la ingesta y el Conformador?
 *
 * Existe para el semáforo de la copia de seguridad (`GET /api/ocupado` → `scripts/sincronizar-copia.sh`). La
 * ingesta, las campañas de fondo y el mantenimiento comparten el cerrojo `procesando` del vigilante, y ese ya
 * lo miraba el semáforo. Pero los trabajos que se lanzan desde el PANEL —scripts como completar-sinopsis o
 * reparar-cdu-contaminada, y acciones en 2.º plano como «Extraer ISBN» o «Integridad»— llevan cada uno SU
 * propio estado y no tocan ese cerrojo: la copia no se enteraba de ellos.
 *
 * Cada módulo expone su estado con una convención DISTINTA (`en_curso`, `enCurso`, `activo`), así que se
 * normaliza aquí en vez de exigir a trece módulos que se pongan de acuerdo.
 *
 * Nunca lanza: un módulo roto no debe tumbar el semáforo (ni, con él, la decisión de hacer la copia).
 */
import { estadoIntegridad } from '../integridad.js';
import { estadoSaneador } from '../sanear-catalogo.js';
import { estadoCompletarSinopsis } from './completar-sinopsis.js';
import { estadoEjecutor } from './ejecutor-scripts.js';
import { estadoEmparejado } from './emparejar-portadas.js';
import { estadoReindexado } from './indice-busqueda.js';
import { estadoLoteISBN } from './lote-isbn.js';
import { estadoReclasificacion } from './reclasificar-editorial.js';
import { estadoReextraccion } from './reextraer-imagenes.js';
import { estadoReidentificacion } from './reidentificar-doc.js';
import { estadoSaneamiento } from './saneamiento.js';

const TRABAJOS = [
    ['Script del panel', estadoEjecutor],
    ['Integridad', estadoIntegridad],
    ['Saneado del catálogo', estadoSaneador],
    ['Buscar sinopsis', estadoCompletarSinopsis],
    ['Extraer ISBN', estadoReidentificacion],
    ['Reextraer imágenes', estadoReextraccion],
    ['Reindexar búsqueda', estadoReindexado],
    ['Emparejar portadas', estadoEmparejado],
    ['Búsqueda de ISBN en lote', estadoLoteISBN],
    ['Reclasificar editoriales', estadoReclasificacion],
    ['Saneamiento de Cuarentena', estadoSaneamiento],
];

/** Las tres convenciones que usan los módulos para decir «estoy trabajando». */
const enCurso = (e) => !!(e && (e.en_curso || e.enCurso || e.activo));

/** Nombres de los trabajos del panel en marcha (vacío si ninguno). El del ejecutor lleva el id del script. */
export function trabajosEnCurso() {
    const activos = [];
    for (const [nombre, estado] of TRABAJOS) {
        try {
            const e = estado();
            if (enCurso(e)) activos.push(e.id ? `${nombre}: ${e.id}` : nombre);
        } catch { /* un módulo con el estado roto no debe tumbar el semáforo */ }
    }
    return activos;
}
