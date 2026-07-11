#!/bin/bash
# ---------------------------------------------------------------------------
# actualizar-GestorBiblioteca.sh — Actualiza Gestor Biblioteca en el Synology (main, o la rama
# que pases como 1.er argumento, p. ej. para probar antes de fusionar).
#
# Colócalo en /volume1/docker/  (NO dentro de GestorBiblioteca, para que el
# propio script no se sobrescriba durante el rsync) y ejecútalo así:
#
#     bash /volume1/docker/actualizar-GestorBiblioteca.sh
#
# Requiere ROOT (los ficheros del app y los datos los crea el contenedor como root):
#
#     sudo bash /volume1/docker/actualizar-GestorBiblioteca.sh
#
# Repo privado: exporta un token antes de lanzarlo ->  sudo GITHUB_TOKEN=ghp_xxx bash ...
#
# Qué hace, en orden:
#   1. Resuelve el SHA del commit (API) y descarga archive/<SHA>.tar.gz (inmutable, sin caché de rama;
#      wget+tar, sin git). Fallback al tarball de rama si la API no responde. Escribe un fichero VERSION.
#   2. down -v: para el contenedor (libera los montajes Inbox/CDU/... ) y elimina el
#      volumen anónimo de node_modules, que "ensombrecía" módulos viejos (sharp/undici@7).
#   3. Sincroniza el código PRESERVANDO .env, node_modules y los datos del host.
#   4. up -d --build  (reinstala dependencias limpias dentro de la imagen).
# ---------------------------------------------------------------------------
set -euo pipefail

# Anclar el CWD a un directorio estable ANTES de cualquier otra cosa.
# Protege contra el caso en que la ejecución anterior dejó el shell dentro de
# $STAGE y luego lo borró: bash arranca con un $PWD inexistente y todos los
# getcwd() subsiguientes fallan con "cannot access parent directories".
cd /volume1/docker

# Binarios de Docker de Synology no siempre están en el PATH de un shell no interactivo.
export PATH="$PATH:/usr/local/bin:/usr/bin"

# Sin root no se pueden sobrescribir los ficheros (los creó el contenedor) ni gestionar
# los puntos de montaje de datos. Fallar pronto con una instrucción clara.
if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: ejecuta este script como root:  sudo bash $0" >&2
    exit 1
fi

# --- Configuración --------------------------------------------------------
REPO="Luix70/gestor-biblioteca"
# Rama a desplegar: 1.er argumento, o la variable DEPLOY_BRANCH, o 'main' por defecto.
#   sudo bash actualizar-GestorBiblioteca.sh                          → main (producción)
#   sudo bash actualizar-GestorBiblioteca.sh feature/mi-rama          → esa rama (para PROBAR)
# Aviso: desplegar una rama y luego volver a 'main' hace que rsync --delete retire del NAS
# lo que solo estaba en la rama (es lo esperado: vuelves a producción).
BRANCH="${1:-${DEPLOY_BRANCH:-main}}"
APP_DIR="/volume1/docker/GestorBiblioteca"
STAGE="/volume1/docker/.gestor-deploy-tmp"
TARBALL_URL="https://github.com/${REPO}/archive/refs/heads/${BRANCH}.tar.gz"
COMPOSE="docker-compose"   # Synology = Compose v1 (con guion)

echo "==> Actualizando Gestor Biblioteca desde ${REPO}@${BRANCH}"

# --- Comprobaciones previas (fallar antes de tocar nada) ------------------
if [ ! -d "$APP_DIR" ]; then
    echo "ERROR: no existe $APP_DIR. ¿Primera instalación? Despliega manualmente la primera vez." >&2
    exit 1
fi
if [ ! -f "$APP_DIR/.env" ]; then
    echo "ERROR: falta $APP_DIR/.env (secretos). Abortando para no construir sin credenciales." >&2
    exit 1
fi

# --- 1. Resolver el COMMIT y descargar SU tarball (inmutable, sin caché de rama) ----------
# El tarball de RAMA (archive/refs/heads/<rama>.tar.gz) lo CACHEA GitHub y puede servir código VIEJO
# durante minutos tras un push (causa de "he desplegado y sigue lo anterior"). Resolvemos el SHA del commit y
# bajamos archive/<SHA>.tar.gz (contenido inmutable, no cacheado "viejo"): así el despliegue trae SIEMPRE lo
# último. Si no se puede resolver, se cae al tarball de rama (comportamiento anterior).
rm -rf "$STAGE"
mkdir -p "$STAGE"

echo "==> Resolviendo el commit de ${BRANCH}…"
SHA=""

# MÉTODO 1 (preferido): git ls-remote. Usa el PROTOCOLO git, NO la API REST → sin límite de tasa (la API
# anónima corta a 60 peticiones/hora por IP: reintentar el deploy la agota y wget devuelve un 403 = «código
# 8»), sin User-Agent y sin parsear JSON. Devuelve «<sha>\trefs/heads/<rama>»; se coge la 1.ª columna. Repo
# PÚBLICO → anónimo; si hay token (repo privado), se incrusta en la URL. GIT_TERMINAL_PROMPT=0 evita que se
# quede colgado pidiendo credenciales si algo va mal.
if command -v git >/dev/null 2>&1; then
    if [ -n "${GITHUB_TOKEN:-}" ]; then LS_URL="https://${GITHUB_TOKEN}@github.com/${REPO}.git"
    else LS_URL="https://github.com/${REPO}.git"; fi
    SHA="$(GIT_TERMINAL_PROMPT=0 git ls-remote "$LS_URL" "refs/heads/${BRANCH}" 2>/dev/null | head -n1 | cut -f1 | tr -cd '0-9a-f')"
    case "$SHA" in *[!0-9a-f]*) SHA="" ;; esac
    [ "${#SHA}" -eq 40 ] || SHA=""
    [ -n "$SHA" ] && echo "==> Commit resuelto (git ls-remote): ${SHA}"
fi

# MÉTODO 2 (respaldo, solo si no hay git o ls-remote falló): la API REST. La respuesta va a un fichero para
# poder DIAGNOSTICAR. Se añade User-Agent (por si un GitHub estricto lo exige) y Authorization solo con token.
# Extracción del SHA A PRUEBA de shells viejos: sin `sed -E`/`grep -o`/intervalos `\{40\}`. La API devuelve el
# JSON MINIFICADO en UNA línea con VARIOS "sha" (commit, árbol, padres, BLOB de cada fichero); un `sed .*"sha"`
# es greedy → cogería el ÚLTIMO. Por eso se trocea por comas/llaves (`tr ',{' '\n'`) para aislar el "sha" del
# commit (1.er campo) y se VALIDA que sean 40 hex.
API_URL="https://api.github.com/repos/${REPO}/commits/${BRANCH}"
RESPUESTA="$STAGE/commit.json"
WGET_RC=0
if [ -z "$SHA" ]; then
    if [ -n "${GITHUB_TOKEN:-}" ]; then
        wget -q --header="User-Agent: actualizar-GestorBiblioteca" --header="Authorization: token ${GITHUB_TOKEN}" -O "$RESPUESTA" "$API_URL" || WGET_RC=$?
    else
        wget -q --header="User-Agent: actualizar-GestorBiblioteca" -O "$RESPUESTA" "$API_URL" || WGET_RC=$?
    fi
    if [ "$WGET_RC" -eq 0 ] && [ -s "$RESPUESTA" ]; then
        SHA="$(tr ',{' '\n' < "$RESPUESTA" | grep '"sha"' | head -n1 | sed -e 's/.*"sha"[[:space:]]*:[[:space:]]*"//' -e 's/".*//' | tr -cd '0-9a-f')"
        case "$SHA" in *[!0-9a-f]*) SHA="" ;; esac
        [ "${#SHA}" -eq 40 ] || SHA=""
    fi
    [ -n "$SHA" ] && echo "==> Commit resuelto (API): ${SHA}"
fi

if [ -n "$SHA" ]; then
    TARBALL_URL="https://github.com/${REPO}/archive/${SHA}.tar.gz"
else
    echo "==> AVISO: no se pudo resolver el SHA; uso el tarball de RAMA, que GitHub CACHEA."
    echo "    ⚠ El despliegue puede traer código VIEJO (minutos de retraso tras un push)."
    if ! command -v git >/dev/null 2>&1; then
        echo "    Nota: no hay 'git' en el NAS; se intentó solo la API. Instala git para la vía robusta (sin límite de tasa)."
    fi
    if [ "$WGET_RC" -ne 0 ]; then
        echo "    Motivo (API): wget código $WGET_RC. El 8 = respuesta de ERROR HTTP (casi siempre 403 por LÍMITE"
        echo "                  de tasa de la API anónima: 60/hora por IP). git ls-remote no tiene ese límite."
    elif [ ! -s "$RESPUESTA" ]; then
        echo "    Motivo (API): respondió vacío."
    else
        echo "    Motivo (API): respondió sin un SHA. Primeros 300 bytes:"
        head -c 300 "$RESPUESTA"
        echo
    fi
fi

# --- 1b. Nº de SERIE incremental (v1.<n>) --------------------------------------------------
# Número de build legible que SUBE con cada commit, para VER en la app qué versión corre sin adivinar. Es el
# nº de commits de la rama, que se saca de la cabecera `Link` del endpoint de commits (con per_page=1, la
# página "last" == total de commits). BEST-EFFORT: si el wget del NAS no sabe volcar cabeceras (`-S`) o la
# API no responde, SERIE queda vacío y no pasa nada — la app mostrará el SHA. Ojo: NO se usa `-q` junto a
# `-S` (el modo silencioso también calla las cabeceras).
SERIE=""
COUNT_URL="https://api.github.com/repos/${REPO}/commits?sha=${BRANCH}&per_page=1"
if [ -n "${GITHUB_TOKEN:-}" ]; then
    HDRS="$(wget -S -O /dev/null --header="Authorization: token ${GITHUB_TOKEN}" "$COUNT_URL" 2>&1 || true)"
else
    HDRS="$(wget -S -O /dev/null "$COUNT_URL" 2>&1 || true)"
fi
# El fragmento con rel="last" trae «…&page=<N>>; rel="last"»: se trocea por comas, se aísla ese fragmento y
# se extrae el número de página (= nº de commits). `tr` final deja solo dígitos.
SERIE="$(printf '%s' "$HDRS" | tr ',' '\n' | grep 'rel="last"' | sed -e 's/.*[?&]page=//' -e 's/>.*//' | tr -cd '0-9')"
if [ -n "$SERIE" ]; then
    echo "==> Nº de serie (commits en ${BRANCH}): ${SERIE}  → v1.${SERIE}"
else
    echo "==> AVISO: no se pudo leer el nº de serie (la app mostrará el SHA). No es grave."
fi

echo "==> Descargando ${TARBALL_URL}"
if [ -n "${GITHUB_TOKEN:-}" ]; then
    wget --header="Authorization: token ${GITHUB_TOKEN}" -qO "$STAGE/src.tar.gz" "$TARBALL_URL"
else
    wget -qO "$STAGE/src.tar.gz" "$TARBALL_URL"
fi

tar -xzf "$STAGE/src.tar.gz" -C "$STAGE"
SRC_DIR="$(find "$STAGE" -maxdepth 1 -type d -name 'gestor-biblioteca-*' | head -n1)"
if [ -z "$SRC_DIR" ] || [ ! -f "$SRC_DIR/package.json" ]; then
    echo "ERROR: el tarball no contiene un árbol válido (no se encontró package.json)." >&2
    exit 1
fi
echo "==> Código extraído en $SRC_DIR"

# --- 2. Parar el contenedor ANTES de sincronizar -------------------------
# Imprescindible: con el contenedor en marcha, Inbox/CDU/Cuarentena/Reintentos son
# puntos de montaje OCUPADOS dentro de $APP_DIR y bloquean el rsync. Además, down -v
# elimina el volumen anónimo de node_modules (el que ensombrecía dependencias viejas).
cd "$APP_DIR"
echo "==> Parando contenedor y eliminando volumen de node_modules"
$COMPOSE down -v

# --- 3. Sincronizar el código -------------------------------------------
# --delete borra del destino lo que ya no exista en el repo (módulos eliminados), PERO
# se excluyen (anclados con '/' a la raíz del transfer) los ficheros y carpetas del host
# que NUNCA están en el repo y no deben tocarse: secretos, dependencias y datos/montajes
# (Docker recrea Inbox/CDU/... al levantar).
echo "==> Sincronizando código en $APP_DIR"
rsync -a --delete \
    --exclude='/.env' \
    --exclude='/node_modules' \
    --exclude='/.git' \
    --exclude='/VERSION' \
    --exclude='/Inbox' \
    --exclude='/CDU' \
    --exclude='/Cuarentena' \
    --exclude='/Reintentos' \
    --exclude='/Recycling' \
    --exclude='/Fichero' \
    --exclude='/logs' \
    --exclude='/temp' \
    "$SRC_DIR"/ "$APP_DIR"/

# Sello de versión: la app lo lee al arrancar y muestra «v1.<serie> · commit <sha>». Formato de VERSION:
# «<sha> <rama> <serie>» (la serie puede faltar). Se escribe TRAS el rsync (que lo excluye) y ANTES del
# build, para que quede dentro de la imagen (COPY . .).
echo "${SHA:-desconocido} ${BRANCH} ${SERIE:-}" > "$APP_DIR/VERSION"

# --- 4. Reconstruir e iniciar -------------------------------------------
echo "==> Reconstruyendo e iniciando (esto reinstala dependencias; en el Atom tarda un poco)"
$COMPOSE up -d --build

# --- Limpieza y estado ----------------------------------------------------
rm -rf "$STAGE"

echo "==> Estado del contenedor:"
$COMPOSE ps

# Logs en vivo: muestra las últimas líneas y SIGUE el arranque. Ctrl+C para salir;
# el contenedor seguirá corriendo (logs -f no lo detiene).
echo "==> Logs en vivo (Ctrl+C para salir; el contenedor seguirá corriendo):"
$COMPOSE logs -f --tail=40
