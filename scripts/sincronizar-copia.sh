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
# ─── EL FICHERO CENTINELA: PRESENCIA **E IDENTIDAD** DEL DISCO ───────────────────────────────────────────
# Hace DOS trabajos, y los dos son imprescindibles:
#
#  1. PRESENCIA. NO basta con comprobar que existe la carpeta de destino. Si el disco USB no está conectado,
#     su punto de montaje puede seguir existiendo como carpeta VACÍA, y entonces rsync escribiría el TERABYTE
#     ENTERO en el disco interno del NAS, llenando volume3. Sin centinela, el script sale sin tocar nada.
#
#  2. IDENTIDAD. DSM NO da un punto de montaje estable a los USB: monta en /volumeUSB1/usbshare,
#     /volumeUSB2/usbshare2, /volumeUSB2/usbshare2-2… y al desconectar y volver a conectar asigna OTRO si el
#     anterior sigue ocupado (ese sufijo «-2» es exactamente eso). Cablear la ruta es, por tanto, inútil.
#     Así que el script NO tiene una ruta fija: BUSCA el centinela por todos los montajes y usa el disco que
#     lo tenga. El disco de copia es «el que lleva la marca», esté donde esté montado hoy.
#
# Créalo UNA VEZ, con el disco conectado (ajusta la ruta a donde te lo haya montado DSM):
#     touch /volumeUSB2/usbshare2-2/.copia-biblioteca-ok
#
# Todo lo demás (carpeta CDU, registro, apartados) cuelga del disco encontrado, así que también le sigue.
#

set -u

# ─── Configuración (sobreescribible por variables de entorno) ────────────────────────────────────────────
ORIGEN="${BK_ORIGEN:-/volume3/BIBLIOTECA DIGITAL/CDU}"
API="${BK_API:-http://localhost:3000/api/ocupado}"

# Nombre del centinela (solo el nombre: la RUTA se descubre, ver cabecera).
NOMBRE_CENTINELA="${BK_CENTINELA:-.copia-biblioteca-ok}"

# Dónde buscarlo. Son PATRONES de shell, no rutas: cubren los montajes que usa DSM para USB y eSATA, con
# cualquier numeración (usbshare, usbshare2, usbshare2-2…). Añade patrones si tu caso es otro.
RUTAS_BUSQUEDA="${BK_RUTAS_BUSQUEDA:-/volumeUSB*/* /volumeSATA*/* /volumeExt*/*}"

# Ruta FIJA del disco, opcional: si la das, no se busca nada (útil para probar, o para copiar a un destino
# que no sea un USB — otro NAS montado, por ejemplo). Aun así se exige el centinela dentro.
DISCO_FIJO="${BK_DISCO:-}"

# Subcarpeta del disco donde se deja la copia.
SUBCARPETA="${BK_SUBCARPETA:-CDU}"

# Destino NTFS (recomendado: así el disco se lee en cualquier PC) o ext4.
#   ntfs → no se intenta copiar permisos/propietario, que NTFS no entiende, y se tolera 1s de desfase en las
#          marcas de tiempo (evita recopiar ficheros idénticos una y otra vez).
#   ext4 → copia fiel (-a).
MODO_DESTINO="${BK_MODO_DESTINO:-ntfs}"

# Qué hacer con lo que se borró del origen. Por la máxima «nunca perder información», por defecto NO se
# borra: se aparta a una carpeta con fecha. Pon BK_BORRAR=1 para un espejo exacto (más simple, menos red).
BORRAR="${BK_BORRAR:-0}"

CERROJO="${BK_CERROJO:-/tmp/sincronizar-copia.lock}"

# Estas TRES cuelgan del disco que se descubra, así que se rellenan más abajo (no pueden tener una ruta fija
# por el mismo motivo que el destino: el punto de montaje cambia). El registro vive EN EL DISCO a propósito,
# para que la copia viaje con su propio historial.
DESTINO=""
DIR_APARTADOS=""
LOG=""

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
# Escribe por pantalla (DSM recoge la salida de la tarea y puede enviártela por correo) y, EN CUANTO se sepa
# cuál es el disco, también a su registro. Antes de descubrirlo, LOG está vacío y solo sale por pantalla.
log() {
    linea="$(date '+%Y-%m-%d %H:%M:%S')  $*"
    echo "$linea"
    [ -n "$LOG" ] && echo "$linea" >> "$LOG" 2>/dev/null
    return 0
}

salir() { rmdir "$CERROJO" 2>/dev/null || true; exit "$1"; }

# ─── 1. Cerrojo: nunca dos copias a la vez ───────────────────────────────────────────────────────────────
# `mkdir` es atómico en POSIX, así que sirve de mutex sin depender de flock (que en BusyBox puede no estar).
# Importante: la primera copia puede durar horas y la tarea está programada cada hora; sin esto se solaparían.
if ! mkdir "$CERROJO" 2>/dev/null; then
    if [ -d "$CERROJO" ]; then
        log "⏭️  Ya hay una copia en curso ($CERROJO). Salgo."
        exit 0
    fi
    # `mkdir` falló pero el cerrojo NO existe: el problema es otro (ruta inexistente, disco lleno, sin
    # permisos…). Distinguirlo importa: si lo tratáramos como «ya en curso», la copia no se haría NUNCA y
    # el aviso diría algo falso. Se avisa y se sale con error, para que DSM lo marque como tarea fallida.
    log "❌ No se pudo crear el cerrojo $CERROJO (¿existe su carpeta padre?). No arranco."
    exit 1
fi
trap 'rmdir "$CERROJO" 2>/dev/null || true' EXIT INT TERM

# ─── 2. ¿Están el origen y la herramienta? ───────────────────────────────────────────────────────────────
if [ ! -d "$ORIGEN" ]; then
    log "❌ No existe el origen: $ORIGEN"
    salir 1
fi

# Comprobación explícita: sin esto, un rsync ausente daría «command not found» dentro de la tubería y el
# script podría darlo por bueno. Una copia de seguridad que dice que sí y no hace nada es peor que ninguna.
if ! command -v rsync >/dev/null 2>&1; then
    log "❌ rsync no está disponible en este sistema. No arranco."
    salir 1
fi

# ─── 3. ¿DÓNDE está el disco hoy? (búsqueda por centinela, ver cabecera) ─────────────────────────────────
# DSM no da un punto de montaje estable a los USB, así que no se cablea ninguna ruta: se busca el disco que
# lleva la marca. Los patrones se expanden SIN comillas a propósito (es lo que los convierte en glob); las
# rutas que no existan se descartan con el -d.
discos_encontrados=""
n_discos=0

if [ -n "$DISCO_FIJO" ]; then
    candidatos="$DISCO_FIJO"
else
    candidatos="$RUTAS_BUSQUEDA"
fi

for patron in $candidatos; do
    for dir in $patron; do
        [ -d "$dir" ] || continue                        # glob sin coincidencias → queda literal, se descarta
        [ -f "$dir/$NOMBRE_CENTINELA" ] || continue      # está montado, pero no es NUESTRO disco
        discos_encontrados="$discos_encontrados$dir
"
        n_discos=$((n_discos + 1))
    done
done

if [ "$n_discos" -eq 0 ]; then
    # Silencioso a propósito: es el caso NORMAL con el disco desconectado, y la tarea corre a menudo. Si esto
    # se registrara, el log se llenaría de ruido. Solo se ve al ejecutarlo a mano.
    echo "⏭️  Disco de copia no presente (no se encontró «$NOMBRE_CENTINELA» en: $candidatos). Salgo sin hacer nada."
    salir 0
fi

if [ "$n_discos" -gt 1 ]; then
    # Deliberadamente NO se elige uno: si hay dos discos marcados (p. ej. rotas dos copias y has enchufado
    # las dos), adivinar podría escribir en el que no toca. Mejor parar y que lo decida el usuario.
    log "❌ Hay $n_discos discos con el centinela; no adivino cuál. Desconecta el que no toque, o fija BK_DISCO:"
    echo "$discos_encontrados" | while IFS= read -r d; do [ -n "$d" ] && log "     $d"; done
    salir 1
fi

DISCO="$(echo "$discos_encontrados" | head -n 1)"

# Todo cuelga del disco encontrado, así que le sigue allá donde DSM decida montarlo.
DESTINO="${BK_DESTINO:-$DISCO/$SUBCARPETA}"
DIR_APARTADOS="${BK_DIR_APARTADOS:-$DISCO/_retirados}"
LOG="${BK_LOG:-$DISCO/copia-biblioteca.log}"

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
log "   Disco:   $DISCO   (localizado por «$NOMBRE_CENTINELA»; el punto de montaje que asigna DSM varía)"
log "   Destino: $DESTINO  [$MODO_DESTINO]"
log "   Borrado: $MODO_BORRADO"
[ "$SIMULAR" -eq 1 ] && log "   ⚠️  SIMULACIÓN: no se escribe nada"

INICIO="$(date +%s)"

# OJO CON EL CÓDIGO DE SALIDA: `rsync … | tee` devuelve el código de TEE (0 casi siempre), NO el de rsync —
# un rsync que falle del todo se reportaría como «terminada sin incidencias». Como sh no tiene PIPESTATUS,
# rsync escribe su código en un fichero desde dentro de la tubería. Así se conserva la salida EN VIVO (útil
# en una copia de horas lanzada a mano) y además se sabe de verdad cómo terminó.
ESTADO_TMP="${TMPDIR:-/tmp}/sincronizar-copia.estado.$$"
{ rsync "$@" "$ORIGEN/" "$DESTINO/"; echo $? > "$ESTADO_TMP"; } 2>&1 | tee -a "$LOG"
CODIGO="$(cat "$ESTADO_TMP" 2>/dev/null || echo 1)"
rm -f "$ESTADO_TMP"

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
