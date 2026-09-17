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
#     Configuración de la tarea → «Enviar detalles de ejecución por correo electrónico» + «solo si la tarea
#     finaliza de forma anómala»: es la vía de CORREO más sencilla del aviso de poco espacio (ver más abajo).
#
#   A mano:
#     sudo /volume1/docker/GestorBiblioteca/scripts/sincronizar-copia.sh                 (copia)
#     sudo /volume1/docker/GestorBiblioteca/scripts/sincronizar-copia.sh --simular       (dry-run: no escribe)
#     sudo /volume1/docker/GestorBiblioteca/scripts/sincronizar-copia.sh --forzar        (ignora «ocupado»)
#     sudo /volume1/docker/GestorBiblioteca/scripts/sincronizar-copia.sh --probar-aviso  (solo prueba el aviso
#                                                                          de poco espacio; no copia nada)
#
# ─── QUÉ DEJA EN EL DISCO ────────────────────────────────────────────────────────────────────────────────
#   copia-biblioteca.log          registro LEGIBLE: un bloque por copia, con su resumen (qué se copió, cuánto,
#                                 cuánto espacio queda). Es el que hay que mirar.
#   copia-biblioteca-detalle.log  la salida COMPLETA de rsync de cada copia (estadísticas crudas y errores),
#                                 para cuando haya que investigar algo.
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
# Todo lo demás (carpeta CDU, registros, apartados) cuelga del disco encontrado, así que también le sigue.
#
# ─── AVISO DE POCO ESPACIO EN EL DISCO DE COPIA ──────────────────────────────────────────────────────────
# Tras cada copia se mide el espacio libre del disco. Por debajo de BK_AVISO_LIBRE_PCT (10 %) el resumen lo
# destaca y se AVISA, como mucho una vez cada BK_AVISO_CADA_HORAS (24 h, para no mandar un correo por copia):
#   1. CORREO DIRECTO, si das un destinatario (BK_CORREO=tu@correo) y el NAS tiene un programa de correo
#      configurado (ssmtp, msmtp o sendmail).
#   2. NOTIFICACIÓN DEL ESCRITORIO de DSM (synodsmnotify), si existe: la verás al entrar en DSM.
#   3. Si el correo directo no fue posible, el script SALE CON CÓDIGO BK_SALIDA_AVISO (3) tras una copia
#      buena. Con la tarea configurada para «enviar detalles por correo solo si finaliza de forma anómala»,
#      DSM te manda este mismo registro por correo con la configuración de correo de DSM (Panel de control →
#      Notificación → Correo electrónico), sin configurar nada más. BK_SALIDA_AVISO=0 lo desactiva.
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

# Tolerancia al comparar fechas de modificación, en segundos (rsync `--modify-window`).
#
# POR QUÉ 2 Y NO 1: rsync decide si un fichero cambió por TAMAÑO + FECHA. Si la copia de partida se hizo con
# otra herramienta, sus fechas pueden no ser idénticas al milisegundo. Medido sobre la copia real que dejó
# TeraCopy (111 ficheros de muestra): tamaño idéntico en TODOS, pero desfases de 0,5 a 1,5 s (mediana 1,03).
# Con ventana 1 coincidía solo el 50% → rsync habría retransferido MEDIA COPIA (~600 GB, ~6 h por USB 2.0)
# sin ninguna necesidad, y además habría empujado todas esas versiones viejas a _retirados, gastando otro
# tanto de disco. Con ventana 2 coincide el 100%.
# El riesgo de agrandarla es despreciable aquí: haría falta un fichero modificado dentro de la misma ventana
# de 2 s Y con el tamaño exacto anterior para que pasara desapercibido.
VENTANA_MTIME="${BK_VENTANA_MTIME:-2}"

# Qué hacer con lo que se borró del origen. Por la máxima «nunca perder información», por defecto NO se
# borra: se aparta a una carpeta con fecha. Pon BK_BORRAR=1 para un espejo exacto (más simple, menos red).
BORRAR="${BK_BORRAR:-0}"

# Caducidad de _retirados, en días. Necesaria porque rsync NO entiende de movimientos: cuando el Conformador
# reclasifica un documento y su carpeta cambia de rama, rsync ve «desapareció la ruta vieja» + «hay una ruta
# nueva», y la vieja acaba en _retirados. Sin poda, cada reclasificación deja ahí una copia COMPLETA del
# documento y la carpeta crece sin fin. 0 = no podar nunca (te encargas tú).
RETENCION_DIAS="${BK_RETENCION_DIAS:-180}"

# Aviso de poco espacio (ver cabecera).
UMBRAL_LIBRE_PCT="${BK_AVISO_LIBRE_PCT:-10}"
AVISO_CADA_HORAS="${BK_AVISO_CADA_HORAS:-24}"
CORREO="${BK_CORREO:-}"
SALIDA_AVISO="${BK_SALIDA_AVISO:-3}"

CERROJO="${BK_CERROJO:-/tmp/sincronizar-copia.lock}"

# Estas cuelgan del disco que se descubra, así que se rellenan más abajo (no pueden tener una ruta fija por el
# mismo motivo que el destino: el punto de montaje cambia). Los registros viven EN EL DISCO a propósito, para
# que la copia viaje con su propio historial.
DESTINO=""
DIR_APARTADOS=""
LOG=""
LOG_DETALLE=""

SIMULAR=0
FORZAR=0
PROBAR_AVISO=0
for arg in "$@"; do
    case "$arg" in
        --simular)      SIMULAR=1 ;;
        --forzar)       FORZAR=1 ;;
        --probar-aviso) PROBAR_AVISO=1 ;;
        *) echo "Opción desconocida: $arg (usa --simular, --forzar o --probar-aviso)"; exit 2 ;;
    esac
done

# ─── Escritura del registro ──────────────────────────────────────────────────────────────────────────────
# Todo sale por pantalla (DSM recoge la salida de la tarea y puede mandarla por correo) y, EN CUANTO se sepa
# cuál es el disco, también a su registro. Antes de descubrirlo, LOG está vacío y solo sale por pantalla.
log() {
    linea="$(date '+%Y-%m-%d %H:%M:%S')  $*"
    echo "$linea"
    [ -n "$LOG" ] && echo "$linea" >> "$LOG" 2>/dev/null
    return 0
}

# Una línea SIN marca de tiempo (separadores y líneas en blanco entre bloques).
log_suelto() {
    echo "$*"
    [ -n "$LOG" ] && echo "$*" >> "$LOG" 2>/dev/null
    return 0
}

# LEGIBILIDAD DEL REGISTRO (petición del usuario, 17-sep): con todo seguido, las copias se confundían entre sí y
# con las estadísticas crudas de rsync. Cada copia empieza con espacio y un separador doble bien visible, sus
# pasos van numerados, y el resumen va en su propio bloque. La salida cruda de rsync va a otro fichero.
SEPARADOR_COPIA="════════════════════════════════════════════════════════════════════════════════════════"
SEPARADOR_RESUMEN="────────────────────────────────────────────────────────────────────────────────────────"

cabecera_copia() {
    log_suelto ""
    log_suelto ""
    log_suelto "$SEPARADOR_COPIA"
    log "COPIA DE LA BIBLIOTECA$1"
    log_suelto "$SEPARADOR_COPIA"
}
paso() { log_suelto ""; log "▸ $*"; }

# Un aviso de UNA línea (copia aplazada, disco ausente…) también se separa del bloque anterior.
aviso_suelto() { log_suelto ""; log "$*"; }

salir() { rmdir "$CERROJO" 2>/dev/null || true; exit "$1"; }

# ─── Formato de cifras (awk: portable, también en el BusyBox de DSM) ─────────────────────────────────────
# 612767 → «612.767»
fmt_miles() {
    awk -v n="$1" 'BEGIN {
        s = sprintf("%.0f", n); r = ""
        while (length(s) > 3) { r = "." substr(s, length(s) - 2) r; s = substr(s, 1, length(s) - 3) }
        print s r
    }'
}
# bytes → «12,66 GB»
fmt_tam() {
    awk -v b="$1" 'BEGIN {
        split("B KB MB GB TB", u, " "); i = 1
        while (b >= 1024 && i < 5) { b /= 1024; i++ }
        s = (i <= 2) ? sprintf("%.0f %s", b, u[i]) : sprintf("%.2f %s", b, u[i])
        sub(/\./, ",", s); print s
    }'
}
# bytes → «12.963» (MB enteros, con miles): lo que pidió el usuario ver de un vistazo.
fmt_mb() { fmt_miles "$(awk -v b="$1" 'BEGIN { printf "%.0f", b / 1048576 }')"; }

# ─── Espacio del disco de copia ──────────────────────────────────────────────────────────────────────────
# `df -P` (POSIX) no parte la línea aunque el nombre del dispositivo sea largo; `-k` = bloques de 1 KB.
# Deja en ESP_TOTAL_KB / ESP_USADO_KB / ESP_LIBRE_KB / ESP_LIBRE_PCT (entero) lo medido.
medir_espacio() {
    set -- $(df -Pk "$DISCO" 2>/dev/null | awk 'NR == 2 { print $2, $3, $4 }')
    ESP_TOTAL_KB="${1:-0}"
    ESP_USADO_KB="${2:-0}"
    ESP_LIBRE_KB="${3:-0}"
    ESP_LIBRE_PCT=0
    [ "$ESP_TOTAL_KB" -gt 0 ] 2>/dev/null && ESP_LIBRE_PCT=$(( ESP_LIBRE_KB * 100 / ESP_TOTAL_KB ))
    return 0
}
texto_espacio() {
    echo "$(fmt_tam $((ESP_LIBRE_KB * 1024))) libres de $(fmt_tam $((ESP_TOTAL_KB * 1024))) (${ESP_LIBRE_PCT} % libre · usado $(fmt_tam $((ESP_USADO_KB * 1024))))"
}

# CUÁNTO DURA lo que queda, al ritmo reciente. Cada copia buena apunta «fecha usado_kb» en un historial EN EL
# DISCO; se compara con el apunte más antiguo de los últimos 14 días. Es una estimación (un día de ingesta
# masiva la dispara), pero da la escala: «≈ 2 años» y «≈ 9 días» piden cosas muy distintas.
HISTORIAL_ESPACIO=""
estimar_dias() {
    [ -f "$HISTORIAL_ESPACIO" ] || return 0
    awk -v ahora="$(date +%s)" -v usado="$ESP_USADO_KB" -v libre="$ESP_LIBRE_KB" '
        $1 >= ahora - 14 * 86400 && (t0 == "" || $1 < t0) { t0 = $1; u0 = $2 }
        END {
            if (t0 == "") exit
            dias = (ahora - t0) / 86400
            if (dias < 1 || usado <= u0) exit
            ritmo = (usado - u0) / dias
            quedan = libre / ritmo
            gbdia = sprintf("%.1f", ritmo / 1048576); sub(/\./, ",", gbdia)
            if (quedan > 730) printf "≈ más de 2 años al ritmo de los últimos %.0f días (%s GB/día)", dias, gbdia
            else if (quedan < 1) printf "≈ menos de 1 día al ritmo de los últimos %.0f días (%s GB/día)", dias, gbdia
            else printf "≈ %.0f días al ritmo de los últimos %.0f días (%s GB/día)", quedan, dias, gbdia
        }' "$HISTORIAL_ESPACIO" 2>/dev/null
}
apuntar_espacio() {
    [ "$SIMULAR" -eq 1 ] && return 0
    printf '%s %s\n' "$(date +%s)" "$ESP_USADO_KB" >> "$HISTORIAL_ESPACIO" 2>/dev/null || return 0
    # Solo hacen falta las últimas semanas.
    tail -n 90 "$HISTORIAL_ESPACIO" > "$HISTORIAL_ESPACIO.tmp" 2>/dev/null && mv "$HISTORIAL_ESPACIO.tmp" "$HISTORIAL_ESPACIO" 2>/dev/null
    return 0
}

# ─── Aviso de poco espacio (ver cabecera) ────────────────────────────────────────────────────────────────
AVISO_POR_SALIDA=0

enviar_correo() {   # $1 asunto, $2 cuerpo
    [ -n "$CORREO" ] || return 1
    for prog in ssmtp msmtp sendmail /usr/sbin/sendmail /usr/bin/ssmtp; do
        command -v "$prog" >/dev/null 2>&1 || continue
        printf 'To: %s\nSubject: %s\nContent-Type: text/plain; charset=UTF-8\n\n%s\n' "$CORREO" "$1" "$2" \
            | "$prog" -t >/dev/null 2>&1 && return 0
    done
    return 1
}

notificar_dsm() {   # $1 título, $2 mensaje
    for prog in /usr/syno/bin/synodsmnotify synodsmnotify; do
        command -v "$prog" >/dev/null 2>&1 || [ -x "$prog" ] || continue
        "$prog" @administrators "$1" "$2" >/dev/null 2>&1 && return 0
    done
    return 1
}

# Comprueba el espacio medido y, si está por debajo del umbral, avisa (como mucho una vez cada
# AVISO_CADA_HORAS). $1 = «forzar» para la prueba (--probar-aviso), que se salta el umbral y el intervalo.
comprobar_aviso_espacio() {
    marca_aviso="$DISCO/.aviso-espacio"
    if [ "$ESP_LIBRE_PCT" -ge "$UMBRAL_LIBRE_PCT" ] && [ "${1:-}" != "forzar" ]; then
        rm -f "$marca_aviso" 2>/dev/null   # recuperado: la próxima vez que baje se avisa en seguida
        return 0
    fi

    log "   ⚠️  POCO ESPACIO EN EL DISCO DE COPIA: $(texto_espacio) — el umbral de aviso es ${UMBRAL_LIBRE_PCT} %."

    ahora="$(date +%s)"
    ultima="$(cat "$marca_aviso" 2>/dev/null || echo 0)"
    case "$ultima" in ''|*[!0-9]*) ultima=0 ;; esac
    horas=$(( (ahora - ultima) / 3600 ))
    if [ "${1:-}" != "forzar" ] && [ "$ultima" -gt 0 ] && [ "$horas" -lt "$AVISO_CADA_HORAS" ]; then
        log "      (ya se avisó hace ${horas} h; el siguiente aviso, pasadas ${AVISO_CADA_HORAS} h)"
        return 0
    fi

    asunto="Copia de la biblioteca: queda ${ESP_LIBRE_PCT} % libre en el disco de copia"
    cuerpo="El disco de copia ($DISCO) tiene $(texto_espacio).
$(estimar_dias)

Cuando se llene, la copia dejará de completarse. Opciones: liberar espacio en _retirados (se poda sola a los ${RETENCION_DIAS} días; BK_RETENCION_DIAS la acorta) o pasar a un disco mayor.

Registro: $LOG"

    avisado=""
    if enviar_correo "$asunto" "$cuerpo"; then
        avisado="correo a $CORREO"
    fi
    if notificar_dsm "Copia de la biblioteca" "Queda ${ESP_LIBRE_PCT} % libre en el disco de copia ($(fmt_tam $((ESP_LIBRE_KB * 1024))))."; then
        avisado="${avisado:+$avisado + }notificación de DSM"
    fi
    case "$avisado" in
        *correo*) ;;
        *)  # Sin correo directo: que lo mande DSM, saliendo con un código «anómalo» al final (ver cabecera).
            if [ "$SALIDA_AVISO" -ne 0 ] 2>/dev/null; then
                AVISO_POR_SALIDA=1
                avisado="${avisado:+$avisado + }correo del Programador de DSM (salida con código $SALIDA_AVISO)"
            fi ;;
    esac
    if [ -n "$avisado" ]; then
        log "      Aviso: $avisado."
        # La prueba (--probar-aviso) no deja marca: si no, un aviso de verdad en las 24 h siguientes se callaría.
        [ "$SIMULAR" -eq 0 ] && [ "${1:-}" != "forzar" ] && printf '%s\n' "$ahora" > "$marca_aviso" 2>/dev/null
    else
        log "      No hay forma de avisar: ni BK_CORREO con un programa de correo, ni DSM, ni BK_SALIDA_AVISO."
    fi
    return 0
}

# ─── A. Cerrojo: nunca dos copias a la vez ───────────────────────────────────────────────────────────────
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

# ─── B. ¿Están el origen y la herramienta? ───────────────────────────────────────────────────────────────
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

# ─── C. ¿DÓNDE está el disco hoy? (búsqueda por centinela, ver cabecera) ─────────────────────────────────
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
LOG_DETALLE="${BK_LOG_DETALLE:-$DISCO/copia-biblioteca-detalle.log}"
HISTORIAL_ESPACIO="$DISCO/.espacio-copia.hist"

# ─── C bis. Solo probar el aviso de poco espacio (--probar-aviso) ─────────────────────────────────────────
# Para comprobar que el correo / la notificación llegan SIN esperar a que el disco se llene de verdad.
if [ "$PROBAR_AVISO" -eq 1 ]; then
    cabecera_copia " — PRUEBA DEL AVISO DE POCO ESPACIO (no se copia nada)"
    medir_espacio
    log "   Disco: $DISCO · $(texto_espacio)"
    comprobar_aviso_espacio forzar
    [ "$AVISO_POR_SALIDA" -eq 1 ] && { log "   Salgo con código $SALIDA_AVISO para que el Programador de DSM mande este registro por correo."; salir "$SALIDA_AVISO"; }
    salir 0
fi

# ─── D. ¿Está la casa trabajando? ────────────────────────────────────────────────────────────────────────
# No es cuestión de corrección —la ingesta escribe a `.tmp-…` y solo hace `rename` tras verificar, así que un
# fichero en su sitio siempre está completo—, sino de no cargar el Atom con las dos tareas a la vez.
# Si la API no responde, se SIGUE: una app caída es, por definición, una app que no está ingiriendo.
#
# PERO NUNCA SE QUEDA SIN HACER. La tarea solo tiene dos franjas al día y en cada una comprueba UNA vez: una
# ingesta de miles de libros o un backfill de sinopsis de 20 horas la tendrían bloqueada en las dos, y se
# pasaría un día entero —o más— sin copia. Como esperar no es cuestión de corrección, si la última copia BUENA
# es más vieja que BK_MAX_ESPERA_HORAS se hace igualmente, con la casa trabajando: irá más lenta, pero se hace.
# El umbral (20 h) es menor que las 24 h entre dos medianoches a propósito: se mide desde el ARRANQUE de la
# copia buena, y una copia que tarde media hora dejaría la del día siguiente justo por debajo de 24 h.
MAX_ESPERA_HORAS="${BK_MAX_ESPERA_HORAS:-20}"
MARCA_ULTIMA="$DISCO/.ultima-copia-ok"
AHORA="$(date +%s)"
NOTA_OCUPADO=""

if [ "$FORZAR" -eq 0 ]; then
    RESP="$(curl -s --max-time 5 "$API" 2>/dev/null || true)"
    case "$RESP" in
        *'"ocupado":true'*)
            ULTIMA="$(cat "$MARCA_ULTIMA" 2>/dev/null || echo 0)"
            case "$ULTIMA" in ''|*[!0-9]*) ULTIMA=0 ;; esac   # marca ausente o corrupta → «nunca»
            HORAS=$(( (AHORA - ULTIMA) / 3600 ))
            if [ "$HORAS" -lt "$MAX_ESPERA_HORAS" ]; then
                aviso_suelto "⏭️  Copia APLAZADA: el gestor está ocupado y la última copia buena es de hace ${HORAS} h (máx. ${MAX_ESPERA_HORAS} h). Lo intento en la próxima pasada."
                salir 0
            fi
            if [ "$ULTIMA" -eq 0 ]; then
                NOTA_OCUPADO="⚠️  El gestor está ocupado, pero no consta ninguna copia buena anterior: se hace igualmente."
            else
                NOTA_OCUPADO="⚠️  El gestor está ocupado, pero la última copia buena fue hace ${HORAS} h (máx. ${MAX_ESPERA_HORAS} h): se hace igualmente."
            fi
            ;;
    esac
fi

# ─── REGISTRO, paso 1: cabecera de la copia + preparación ───────────────────────────────────────────────────────────────
if [ "$BORRAR" = "1" ]; then
    MODO_BORRADO="espejo exacto (lo borrado en el origen se borra en la copia)"
    APARTADOS_HOY=""
else
    APARTADOS_HOY="$DIR_APARTADOS/$(date '+%Y-%m-%d')"
    MODO_BORRADO="conservador (lo retirado del origen se aparta a $APARTADOS_HOY)"
fi

cabecera_copia "$([ "$SIMULAR" -eq 1 ] && echo " — SIMULACIÓN (no se escribe nada)")"
paso "1. Preparación"
log "   Origen:   $ORIGEN"
log "   Disco:    $DISCO   (localizado por «$NOMBRE_CENTINELA»; el punto de montaje que asigna DSM varía)"
log "   Destino:  $DESTINO  [$MODO_DESTINO]"
log "   Borrado:  $MODO_BORRADO"
medir_espacio
ESP_ANTES_LIBRE_KB="$ESP_LIBRE_KB"
log "   Espacio:  $(texto_espacio)"
[ -n "$NOTA_OCUPADO" ] && log "   $NOTA_OCUPADO"

# ─── REGISTRO, paso 2: REPLICAR LOS MOVIMIENTOS ANTES DE SINCRONIZAR ────────────────────────────────────────────────────
# rsync no distingue un MOVIMIENTO de un borrado + un alta: retransferiría el documento entero (y en
# local-a-local usa --whole-file, así que no hay delta que lo abarate). Con una media que tenderá a ~240 MB
# por documento, una campaña de reclasificación de 10.000 docs son ~2,4 TB: casi un día por USB 2.0.
#
# Pero la aplicación SÍ sabe que fue un movimiento y lo anota en `.movimientos-copia.log` (ver
# src/utils/diario-movimientos.js). Aquí se replica cada uno con un `mv` DENTRO del disco de copia: un rename
# en el mismo sistema de ficheros, coste constante pese el documento 4 KB o 2 GB. Luego rsync se lo encuentra
# todo colocado y no transfiere nada.
#
# ES UNA OPTIMIZACIÓN, NO UNA DEPENDENCIA: lo que no se pueda replicar lo arregla rsync copiando, como antes.
# La marca de posición vive EN EL DISCO, así que cada disco sabe por dónde iba (soporta rotar varios discos).
paso "2. Movimientos replicados dentro de la copia (sin volver a transferir)"
DIARIO="$ORIGEN/.movimientos-copia.log"
MARCA="$DISCO/.movimientos-aplicados"
MOVIDOS=0
FALLIDOS=0

if [ "$SIMULAR" -eq 1 ]; then
    log "   (simulación: no se replican)"
elif [ ! -f "$DIARIO" ]; then
    log "   Sin diario de movimientos: nada que replicar."
else
    ULTIMA="$(cat "$MARCA" 2>/dev/null || echo '')"
    ultima_vista="$ULTIMA"

    # Las marcas de tiempo son ISO-8601 en UTC, de longitud fija, así que comparar como TEXTO equivale a
    # comparar cronológicamente. Se procesa en orden de fichero, que es el de escritura.
    # (El `while` lee de un fichero, no de una tubería: así MOVIDOS/FALLIDOS no se quedan en una subshell.)
    while IFS="$(printf '\t')" read -r sello viejo nuevo; do
        [ -n "$sello" ] && [ -n "$viejo" ] && [ -n "$nuevo" ] || continue
        # Ya aplicado en una pasada anterior.
        if [ -n "$ULTIMA" ]; then
            [ "$sello" \> "$ULTIMA" ] || continue
        fi
        ultima_vista="$sello"

        de="$DESTINO/$viejo"
        a="$DESTINO/$nuevo"
        # Si el origen no está en la copia (documento aún no respaldado) o el destino ya existe (movimiento ya
        # replicado, o rsync se adelantó), no se toca nada: rsync resolverá lo que falte.
        [ -e "$de" ] || continue
        [ -e "$a" ] && continue

        if mkdir -p "$(dirname "$a")" 2>/dev/null && mv "$de" "$a" 2>/dev/null; then
            MOVIDOS=$((MOVIDOS + 1))
        else
            FALLIDOS=$((FALLIDOS + 1))
        fi
    done < "$DIARIO"

    if [ "$MOVIDOS" -gt 0 ] || [ "$FALLIDOS" -gt 0 ]; then
        log "   ↔️  $(fmt_miles "$MOVIDOS") carpeta(s) movida(s)$([ "$FALLIDOS" -gt 0 ] && echo "; $FALLIDOS no se pudieron (rsync las resolverá copiando)")."
    else
        log "   Ninguno pendiente."
    fi
    # Se avanza la marca aunque alguno fallara: rsync deja la copia correcta igualmente, y así no se reintenta
    # eternamente un movimiento imposible.
    [ -n "$ultima_vista" ] && printf '%s\n' "$ultima_vista" > "$MARCA" 2>/dev/null
fi

# ─── REGISTRO, paso 3: opciones de rsync ──────────────────────────────────────────────────────────────────
mkdir -p "$DESTINO" 2>/dev/null || true

# `--stats` SIN `--human-readable`: las cifras llegan en bytes y ficheros exactos, que el resumen formatea (con
# «67.31G» habría que adivinar la unidad y se perdería precisión).
set -- --stats

# `--partial`: si la copia se corta (apagón, desconexión), la siguiente RETOMA el fichero a medias en vez de
# empezarlo de cero. En una primera copia de ~1,2 TB por USB 2.0 (unas 11 horas) esto no es un lujo.
set -- "$@" --partial

if [ "$MODO_DESTINO" = "ntfs" ]; then
    # -r recursivo, -l enlaces, -t marcas de tiempo. NADA de permisos/propietario/grupo: NTFS no los tiene y
    # rsync llenaría el log de errores en cada fichero.
    set -- "$@" -rlt --modify-window="$VENTANA_MTIME" --no-perms --no-owner --no-group
else
    set -- "$@" -a
fi

# Exclusiones:
#   .tmp-*   temporales de una ingesta EN VUELO (el fichero definitivo llega por `rename`; el temporal sobra)
#   @eaDir   miniaturas e índices de Synology: se regeneran solas, no son datos
#   #recycle / .DS_Store / Thumbs.db: basura de papelera y de clientes
#   .movimientos-copia.log: diario de movimientos, propio del origen (el destino lleva su propia marca)
#   sync.ffs_*: base de datos y cerrojo que FreeFileSync deja dentro del árbol; no son datos de la biblioteca
set -- "$@" --exclude '.tmp-*' --exclude '@eaDir' --exclude '#recycle' --exclude '.DS_Store' --exclude 'Thumbs.db' \
            --exclude '.movimientos-copia.log' --exclude 'sync.ffs_*'

if [ "$BORRAR" = "1" ]; then
    set -- "$@" --delete
else
    # Lo retirado del origen NO se pierde: se aparta a _retirados/<fecha>/ conservando su ruta.
    set -- "$@" --delete --backup --backup-dir="$APARTADOS_HOY"
fi

[ "$SIMULAR" -eq 1 ] && set -- "$@" --dry-run

# PROGRESO EN VIVO, pero solo cuando hay una persona mirando. Sin `-v` rsync no dice nada hasta el final, y
# una copia de horas se vuelve indistinguible de una colgada. `--info=progress2` da un porcentaje global con
# velocidad y tiempo restante, PERO lo pinta con retornos de carro: por eso se activa solo si la salida es una
# terminal (`-t 1`) — al lanzarlo el Programador de DSM no lo es — y esas líneas se filtran del registro de
# detalle. Se comprueba antes que el rsync de esta máquina admita `--info` (es de rsync 3.1+): si no, se sigue
# sin progreso en vez de romper la copia con una opción inválida.
if [ -t 1 ] && rsync --info=help >/dev/null 2>&1; then
    set -- "$@" --info=progress2
fi

# Lo apartado HOY antes de empezar (la tanda del día acumula las dos copias diarias): la diferencia con lo que
# haya al final es lo que ha apartado ESTA copia.
contar_apartados() {
    if [ -n "$APARTADOS_HOY" ] && [ -d "$APARTADOS_HOY" ]; then
        printf '%s %s\n' "$(find "$APARTADOS_HOY" -type f 2>/dev/null | wc -l)" "$(du -sk "$APARTADOS_HOY" 2>/dev/null | awk '{ print $1 }')"
    else
        echo "0 0"
    fi
}
APARTADOS_ANTES="$(contar_apartados)"

# ─── REGISTRO, paso 3 (sigue): la copia ─────────────────────────────────────────────────────────────────────────────────────────
paso "3. Copia de lo nuevo y lo cambiado (rsync)"
log "   En marcha… (la salida completa de rsync queda en $(basename "$LOG_DETALLE"))"

INICIO="$(date +%s)"

# OJO CON EL CÓDIGO DE SALIDA: `rsync … | tee` devuelve el código de TEE (0 casi siempre), NO el de rsync —
# un rsync que falle del todo se reportaría como «terminada sin incidencias». Como sh no tiene PIPESTATUS,
# rsync escribe su código en un fichero desde dentro de la tubería. Así se conserva la salida EN VIVO (útil
# en una copia de horas lanzada a mano) y además se sabe de verdad cómo terminó.
ESTADO_TMP="${TMPDIR:-/tmp}/sincronizar-copia.estado.$$"
SALIDA_TMP="${TMPDIR:-/tmp}/sincronizar-copia.salida.$$"
{ rsync "$@" "$ORIGEN/" "$DESTINO/"; echo $? > "$ESTADO_TMP"; } 2>&1 | tee "$SALIDA_TMP"
CODIGO="$(cat "$ESTADO_TMP" 2>/dev/null || echo 1)"
rm -f "$ESTADO_TMP"

FIN="$(date +%s)"
SEGUNDOS=$(( FIN - INICIO ))
MINUTOS=$(( SEGUNDOS / 60 ))

# La salida cruda, al registro de DETALLE (sin las líneas de progreso de una ejecución a mano, que llevan
# retornos de carro y serían miles).
{
    echo ""
    echo "$SEPARADOR_COPIA"
    echo "$(date -d "@$INICIO" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date '+%Y-%m-%d %H:%M:%S')  rsync (código $CODIGO)$([ "$SIMULAR" -eq 1 ] && echo " — SIMULACIÓN")"
    echo "$SEPARADOR_COPIA"
    tr '\r' '\n' < "$SALIDA_TMP" | grep -v -E 'to-chk=|ir-chk=|xfr#|^[[:space:]]*[0-9][0-9.,]*[KMGT]?B?[[:space:]]+[0-9]+%'
} >> "$LOG_DETALLE" 2>/dev/null

# Cifras de las estadísticas de rsync. Valen las dos variantes: rsync 3.0 («Number of files transferred: 2822»)
# y 3.1+ («Number of regular files transferred: 2,822», con separadores y un desglose entre paréntesis).
stat_rsync() {
    awk -F': ' -v clave="$1" '$1 == clave { v = $2; sub(/ .*/, "", v); gsub(/,/, "", v); print v; exit }' "$SALIDA_TMP"
}
N_ENTRADAS="$(stat_rsync 'Number of files')"
N_COPIADOS="$(stat_rsync 'Number of regular files transferred')"
[ -z "$N_COPIADOS" ] && N_COPIADOS="$(stat_rsync 'Number of files transferred')"
BYTES_TOTAL="$(stat_rsync 'Total file size')"
BYTES_COPIADOS="$(stat_rsync 'Total transferred file size')"

# Errores de rsync (todo lo que no son estadísticas): se cuentan y se enseñan los primeros en el registro
# legible; el resto, en el de detalle.
ERRORES_TMP="${TMPDIR:-/tmp}/sincronizar-copia.errores.$$"
tr '\r' '\n' < "$SALIDA_TMP" | grep -E '^rsync:|^rsync error|failed|Permission denied|No space left' > "$ERRORES_TMP" 2>/dev/null
N_ERRORES="$(wc -l < "$ERRORES_TMP" | tr -d ' ')"
rm -f "$SALIDA_TMP"

if [ "${N_ERRORES:-0}" -gt 0 ]; then
    log "   ⚠️  rsync informó de ${N_ERRORES} problema(s). Los primeros:"
    head -n 5 "$ERRORES_TMP" | while IFS= read -r l; do log "      $l"; done
fi
rm -f "$ERRORES_TMP"
log "   Terminado en ${MINUTOS} min (código de rsync: $CODIGO)."

APARTADOS_DESPUES="$(contar_apartados)"

# ─── REGISTRO, paso 4: podar _retirados ─────────────────────────────────────────────────────────────────────────────────
# Solo si la copia fue bien: si rsync falló, no tocamos la red de seguridad. Se usa `find -mtime` (portable,
# también en el BusyBox de DSM) en vez de aritmética de fechas, que varía entre implementaciones de `date`.
paso "4. Limpieza de _retirados (se conservan ${RETENCION_DIAS} días)"
PODADAS=0
if [ "$RETENCION_DIAS" -gt 0 ] && { [ "$CODIGO" -eq 0 ] || [ "$CODIGO" -eq 24 ]; } && [ "$SIMULAR" -eq 0 ]; then
    if [ -d "$DIR_APARTADOS" ]; then
        for viejo in $(find "$DIR_APARTADOS" -mindepth 1 -maxdepth 1 -type d -mtime +"$RETENCION_DIAS" 2>/dev/null); do
            rm -rf "$viejo" 2>/dev/null && PODADAS=$((PODADAS + 1))
        done
    fi
    if [ "$PODADAS" -gt 0 ]; then
        log "   🧹 Podadas $PODADAS tanda(s) con más de $RETENCION_DIAS días."
    else
        log "   Nada que podar."
    fi
elif [ "$SIMULAR" -eq 1 ]; then
    log "   (simulación: no se poda)"
elif [ "$RETENCION_DIAS" -le 0 ]; then
    log "   Poda desactivada (BK_RETENCION_DIAS=0)."
else
    log "   No se poda: la copia no terminó bien y _retirados es la red de seguridad."
fi

# ─── REGISTRO: RESUMEN ──────────────────────────────────────────────────────────────────────────────────────────
medir_espacio
if [ "$CODIGO" -eq 0 ] || [ "$CODIGO" -eq 24 ]; then
    [ "$SIMULAR" -eq 0 ] && apuntar_espacio
fi

log_suelto ""
log_suelto "$SEPARADOR_RESUMEN"
log "RESUMEN$([ "$SIMULAR" -eq 1 ] && echo " (simulación: cifras de lo que HARÍA)")"
log_suelto "$SEPARADOR_RESUMEN"

if [ "$CODIGO" -eq 0 ]; then
    log "   Resultado:    ✅ sin incidencias · ${MINUTOS} min"
elif [ "$CODIGO" -eq 24 ]; then
    log "   Resultado:    ✅ bien · ${MINUTOS} min (algún fichero se movió durante la copia; se recoge en la siguiente)"
else
    log "   Resultado:    ⚠️  rsync terminó con código $CODIGO tras ${MINUTOS} min — revisa $(basename "$LOG_DETALLE")"
fi

if [ -n "$N_COPIADOS" ] && [ -n "$BYTES_COPIADOS" ]; then
    velocidad=""
    [ "$SEGUNDOS" -gt 0 ] && [ "$BYTES_COPIADOS" -gt 0 ] 2>/dev/null \
        && velocidad=" · $(awk -v b="$BYTES_COPIADOS" -v s="$SEGUNDOS" 'BEGIN { v = sprintf("%.1f", b / s / 1048576); sub(/\./, ",", v); print v }') MB/s"
    log "   Copiados:     $(fmt_miles "$N_COPIADOS") ficheros · $(fmt_mb "$BYTES_COPIADOS") MB ($(fmt_tam "$BYTES_COPIADOS"))${velocidad}"
else
    log "   Copiados:     (rsync no dio estadísticas; mira $(basename "$LOG_DETALLE"))"
fi

log "   Movidos:      $(fmt_miles "$MOVIDOS") carpeta(s) dentro de la copia, sin retransferir$([ "$FALLIDOS" -gt 0 ] && echo " ($FALLIDOS fallidos)")"

if [ -n "$APARTADOS_HOY" ]; then
    set -- $APARTADOS_ANTES
    ap_antes_n="$1"; ap_antes_kb="${2:-0}"
    set -- $APARTADOS_DESPUES
    ap_n=$(( $1 - ap_antes_n )); ap_kb=$(( ${2:-0} - ap_antes_kb ))
    [ "$ap_n" -lt 0 ] && ap_n=0
    [ "$ap_kb" -lt 0 ] && ap_kb=0
    log "   Apartados:    $(fmt_miles "$ap_n") ficheros · $(fmt_mb $((ap_kb * 1024))) MB a _retirados/$(basename "$APARTADOS_HOY") (borrados o sustituidos en el origen)"
fi
[ "$PODADAS" -gt 0 ] && log "   Podados:      $PODADAS tanda(s) antigua(s) de _retirados"

if [ -n "$N_ENTRADAS" ] && [ -n "$BYTES_TOTAL" ]; then
    log "   Biblioteca:   $(fmt_miles "$N_ENTRADAS") ficheros y carpetas · $(fmt_tam "$BYTES_TOTAL")"
fi

usados_ahora=$(( ESP_ANTES_LIBRE_KB - ESP_LIBRE_KB ))
log "   Disco copia:  $(texto_espacio)"
[ "$usados_ahora" -gt 0 ] && log "                 esta copia ha ocupado $(fmt_tam $((usados_ahora * 1024)))"
estimacion="$(estimar_dias)"
[ -n "$estimacion" ] && log "                 $estimacion"

comprobar_aviso_espacio

log_suelto "$SEPARADOR_RESUMEN"

# Marca de «última copia BUENA» (ver D, «casa trabajando»): se guarda la hora de ARRANQUE, no la de
# fin, para que una copia larga no deje la siguiente franja por debajo del umbral. Solo si la copia fue de
# verdad (no una simulación).
marcar_copia_buena() {
    [ "$SIMULAR" -eq 1 ] && return 0
    printf '%s\n' "$AHORA" > "$MARCA_ULTIMA" 2>/dev/null || true
}

if [ "$CODIGO" -eq 0 ] || [ "$CODIGO" -eq 24 ]; then
    # El 24 de rsync («ficheros desaparecidos durante la copia») es ESPERABLE en una biblioteca viva —el
    # Conformador mueve carpetas mientras copiamos— y aquí se da por bueno. Si se propagara, el Programador de DSM
    # marcaría la tarea como anómala y mandaría un correo cada vez: el aviso dejaría de significar nada.
    marcar_copia_buena
    if [ "$AVISO_POR_SALIDA" -eq 1 ]; then
        log "Copia buena, pero salgo con código $SALIDA_AVISO para que el Programador de DSM mande este registro por correo (poco espacio)."
        salir "$SALIDA_AVISO"
    fi
    salir 0
else
    salir "$CODIGO"
fi
