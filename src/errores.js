/**
 * Taxonomía de errores del pipeline de ingesta.
 *
 * - ErrorInfraestructura: no se pudo alcanzar un recurso externo (APIs bibliográficas o
 *   MongoDB). Es TRANSITORIO → el recurso va a la carpeta Reintentos para reprocesar.
 * - ErrorIdentificacion: el recurso se procesó pero no se pudo identificar de forma mínima
 *   (sin título tras agotar archivo/APIs/IA). Requiere intervención → carpeta Cuarentena.
 */

export class ErrorInfraestructura extends Error {
    constructor(mensaje, causa) {
        super(mensaje);
        this.name = 'ErrorInfraestructura';
        this.tipo = 'infraestructura';
        this.causa = causa;
    }
}

export class ErrorIdentificacion extends Error {
    constructor(mensaje) {
        super(mensaje);
        this.name = 'ErrorIdentificacion';
        this.tipo = 'identificacion';
    }
}

/**
 * ErrorRecursoIlegible: el fichero está estructuralmente dañado y no se puede leer (p. ej. un
 * PDF con el xref roto / sin árbol de páginas). No se cataloga: el fichero va a Cuarentena bajo
 * la categoría 'ilegibles' para conseguir una copia mejor.
 */
export class ErrorRecursoIlegible extends Error {
    constructor(mensaje) {
        super(mensaje);
        this.name = 'ErrorRecursoIlegible';
        this.tipo = 'ilegible';
    }
}

/**
 * ErrorOmitir: el recurso NO se puede (ni se debe) procesar todavía, pero debe quedar INTACTO. Casos:
 * fichero con DRM (MOBI/AZW cifrado, no legible sin la clave del dispositivo), audio (audiolibros, aún sin
 * tratamiento) u otro formato sin lector. NO es un fallo ni una identificación imposible: no va a Cuarentena
 * ni se borra — se DEJA en el Inbox y el vigilante deposita un testigo `.noborrar` en su carpeta de más alto
 * nivel para que el recolector de basura la respete.
 */
export class ErrorOmitir extends Error {
    constructor(mensaje) {
        super(mensaje);
        this.name = 'ErrorOmitir';
        this.tipo = 'omitir';
    }
}

/**
 * Clasifica un error de axios: distingue un fallo de RED/transporte (sin respuesta del
 * servidor, timeout, DNS, 5xx, 429) de una respuesta legítima "no encontrado" (4xx).
 * Devuelve true si es un problema de infraestructura (reintentable).
 */
export function esErrorDeRed(error) {
    if (!error) return false;
    const codigosRed = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNRESET'];
    if (error.code && codigosRed.includes(error.code)) return true;
    if (!error.response) return true; // sin respuesta del servidor = no se pudo alcanzar
    const status = error.response.status;
    return status === 429 || (status >= 500 && status < 600);
}

/** ¿Es un error de conexión/operación de MongoDB? (reintentable) */
export function esErrorDeMongo(error) {
    if (!error) return false;
    const nombres = ['MongoNetworkError', 'MongoServerSelectionError', 'MongoTimeoutError', 'MongoNotConnectedError'];
    return nombres.includes(error.name) || /ECONNREFUSED|ETIMEDOUT|server selection|topology/i.test(error.message || '');
}
