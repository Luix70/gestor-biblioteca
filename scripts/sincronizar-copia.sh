#!/bin/sh
#
# COPIA DE SEGURIDAD DEL ÁRBOL CDU A UN DISCO USB EXTERNO.
#
# Se ejecuta EN EL NAS (no dentro del contenedor) desde el Programador de tareas de DSM, como `root`.
# No es un demonio: es un script barato que se despierta, mira si toca y casi siempre sale enseguida sin
# hacer nada. Por eso se puede programar cada hora sin coste. También se puede lanzar a mano cuando quieras.
#
#   Instalación (DSM → Panel de control → Programador de tareas → Crear → Tarea programada → Script definido):
#     Usuario: root      ← IMPRESCINDIBLE: hay carpetas que otros usuarios no pueden leer, y se saltarían
#     Comando: /volume1/docker/GestorBiblioteca/scripts/sincronizar-copia.sh
#
#   A mano:
#     sudo /volume1/docker/GestorBiblioteca/scripts/sincronizar-copia.sh          (copia)
#     sudo /volume1/docker/GestorBiblioteca/scripts/sincronizar-copia.sh --simular   (dry-run: no escribe)
#     sudo /volume1/docker/GestorBiblioteca/scripts/sincronizar-copia.sh --forzar    (ignora «ocupado»)
#
# ─── POR QUÉ ROOT ────────────────────────────────────────────────────────────────────────────────────────
# Parte del material entró de fuera con permisos restrictivos (ver `utils/permisos.js`). Con otro usuario,
# rsync se topa con «Permission denied» y SALTA esas carpetas SIN ERROR VISIBLE: la copia queda con huecos
# invisibles. Root lee todo. (`scripts/normalizar-permisos.js` arregla el origen; esto no depende de ello.)
#
# ─── POR QUÉ UN FICHERO CENTINELA ────────────────────────────────────────────────────────────────────────
# NO basta con comprobar que existe la carpeta de destino. Si el disco USB no está conectado, su punto de
# montaje puede seguir existiendo como carpeta VACÍA, y entonces rsync escribiría el TERABYTE ENTERO en el
# disco interno del NAS, llenando volume3. El centinela es un fichero que vive EN EL DISCO: si no aparece,
# el disco no está, y el script sale sin tocar nada. Créalo una vez, con el disco conectado:
#     touch /volumeUSB1/usbshare/.copia-biblioteca-ok
#

set -u

# ─── Configuración (sobreescribible por variables de entorno) ────────────────────────────────────────────
ORIGEN="${BK_ORIGEN:-/volume3/BIBLIOTECA DIGITAL/CDU}"
DESTINO="${BK_DESTINO:-/volumeUSB1/usbshare/CDU}"
CENTINELA="${BK_CENTINELA:-/volumeUSB1/usbshare/.copia-biblioteca-ok}"
API="${BK_API:-http://localhost:3000/api/ocupado}"

# Destino NTFS (recomendado: así el disco se lee en cualquier PC) o ext4.
#   ntfs → no se intenta copiar permisos/propietario, que NTFS no entiende, y se tolera 1s de desfase en las
#          marcas de tiempo (evita recopiar ficheros idénticos una y otra vez).
#   ext4 → copia fiel (-a).
MODO_DESTINO="${BK_MODO_DESTINO:-ntfs}"

# Qué hacer con lo que se borró del origen. Por la máxima «nunca perder información», por defecto NO se
# borra: se aparta a una carpeta con fecha. Pon BK_BORRAR=1 para un espejo exacto (más simple, menos red).
BORRAR="${BK_BORRAR:-0}"
DIR_APARTADOS="${BK_DIR_APARTADOS:-/volumeUSB1/usbshare/_retirados}"

LOG="${BK_LOG:-/volumeUSB1/usbshare/copia-biblioteca.log}"
CERROJO="${BK_CERROJO:-/tmp/sincronizar-copia.lock}"

SIMULAR=0
FORZAR=0
for arg in "$@"; do
    case "$arg" in
        --simular) SIMULAR=1 ;;
        --forzar)  FORZAR=1 ;;
        *) echo "Opción desconocida: $arg (usa --simular o --forzar)"; exit 2 ;;
    esac
done

# `log` escribe a la vez por pantalla (DSM recoge la salida y puede enviártela por correo) y al fichero de
# registro, que vive EN EL DISCO de copia para que viaje con ella.
log() {
    linea="$(date '+%Y-%m-%d %H:%M:%S')  $*"
    echo "$linea"
    echo "$linea" >> "$LOG" 2>/dev/null || true
}

salir() { rmdir "$CERROJO" 2>/dev/null || true; exit "$1"; }

# ─── 1. Cerrojo: nunca dos copias a la vez ───────────────────────────────────────────────────────────────
# `mkdir` es atómico en POSIX, así que sirve de mutex sin depender de flock (que en BusyBox puede no estar).
# Importante: la primera copia puede durar horas y la tarea está programada cada hora; sin esto se solaparían.
if ! mkdir "$CERROJO" 2>/dev/null; then
    log "⏭️  Ya hay una copia en curso ($CERROJO). Salgo."
    exit 0
fi
trap 'rmdir "$CERROJO" 2>/dev/null || true' EXIT INT TERM

# ─── 2. ¿Está el origen? ─────────────────────────────────────────────────────────────────────────────────
if [ ! -d "$ORIGEN" ]; then
    log "❌ No existe el origen: $ORIGEN"
    salir 1
fi

# ─── 3. ¿Está el disco de verdad? (centinela, ver cabecera) ──────────────────────────────────────────────
if [ ! -f "$CENTINELA" ]; then
    # Silencioso a propósito: es el caso NORMAL cuando el disco no está conectado, y la tarea corre a menudo.
    # Si se registrara, el log se llenaría de ruido. Solo se ve al ejecutarlo a mano.
    echo "⏭️  Disco de copia no presente (falta el centinela $CENTINELA). Salgo sin hacer nada."
    salir 0
fi

# ─── 4. ¿Está la casa trabajando? ────────────────────────────────────────────────────────────────────────
# No es cuestión de corrección —la ingesta escribe a `.tmp-…` y solo hace `rename` tras verificar, así que un
# fichero en su sitio siempre está completo—, sino de no cargar el Atom con las dos tareas a la vez.
# Si la API no responde, se SIGUE: una app caída es, por definición, una app que no está ingiriendo.
if [ "$FORZAR" -eq 0 ]; then
    RESP="$(curl -s --max-time 5 "$API" 2>/dev/null || true)"
    case "$RESP" in
        *'"ocupado":true'*)
            log "⏭️  El gestor está ocupado (ingesta o mantenimiento en curso). Lo intento en la próxima pasada."
            salir 0
            ;;
    esac
fi

# ─── 5. Construir las opciones de rsync ──────────────────────────────────────────────────────────────────
mkdir -p "$DESTINO" 2>/dev/null || true

set -- --human-readable --stats

# `--partial`: si la copia se corta (apagón, desconexión), la siguiente RETOMA el fichero a medias en vez de
# empezarlo de cero. En una primera copia de ~1,2 TB por USB 2.0 (unas 11 horas) esto no es un lujo.
set -- "$@" --partial

if [ "$MODO_DESTINO" = "ntfs" ]; then
    # -r recursivo, -l enlaces, -t marcas de tiempo. NADA de permisos/propietario/grupo: NTFS no los tiene y
    # rsync llenaría el log de errores en cada fichero.
    set -- "$@" -rlt --modify-window=1 --no-perms --no-owner --no-group
else
    set -- "$@" -a
fi

# Exclusiones:
#   .tmp-*   temporales de una ingesta EN VUELO (el fichero definitivo llega por `rename`; el temporal sobra)
#   @eaDir   miniaturas e índices de Synology: se regeneran solas, no son datos
#   #recycle / .DS_Store / Thumbs.db: basura de papelera y de clientes
set -- "$@" --exclude '.tmp-*' --exclude '@eaDir' --exclude '#recycle' --exclude '.DS_Store' --exclude 'Thumbs.db'

if [ "$BORRAR" = "1" ]; then
    set -- "$@" --delete
    MODO_BORRADO="espejo exacto (lo borrado en el origen se borra en la copia)"
else
    # Lo retirado del origen NO se pierde: se aparta a _retirados/<fecha>/ conservando su ruta.
    APARTADOS_HOY="$DIR_APARTADOS/$(date '+%Y-%m-%d')"
    set -- "$@" --delete --backup --backup-dir="$APARTADOS_HOY"
    MODO_BORRADO="conservador (lo retirado se aparta a $APARTADOS_HOY)"
fi

[ "$SIMULAR" -eq 1 ] && set -- "$@" --dry-run

# ─── 6. Adelante ─────────────────────────────────────────────────────────────────────────────────────────
log "── Copia de la biblioteca ─────────────────────────────"
log "   Origen:  $ORIGEN"
log "   Destino: $DESTINO  [$MODO_DESTINO]"
log "   Borrado: $MODO_BORRADO"
[ "$SIMULAR" -eq 1 ] && log "   ⚠️  SIMULACIÓN: no se escribe nada"

INICIO="$(date +%s)"
rsync "$@" "$ORIGEN/" "$DESTINO/" 2>&1 | tee -a "$LOG"
CODIGO=$?
FIN="$(date +%s)"
MINUTOS=$(( (FIN - INICIO) / 60 ))

# rsync 24 = «ficheros desaparecieron durante la copia». En una biblioteca viva (el Conformador mueve
# carpetas al reclasificar) es ESPERABLE y no es un fallo: lo que faltó se copia en la pasada siguiente.
if [ "$CODIGO" -eq 0 ]; then
    log "✅ Copia terminada sin incidencias en ${MINUTOS} min."
elif [ "$CODIGO" -eq 24 ]; then
    log "✅ Copia terminada en ${MINUTOS} min (algún fichero se movió durante el proceso; se recogerá en la siguiente)."
else
    log "⚠️  rsync terminó con código $CODIGO tras ${MINUTOS} min. Revisa $LOG."
fi

salir "$CODIGO"
