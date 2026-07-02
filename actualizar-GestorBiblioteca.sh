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
# durante minutos tras un push (causa de "he desplegado y sigue lo anterior"). Resolvemos el SHA por la
# API y bajamos archive/<SHA>.tar.gz (contenido inmutable, no cacheado "viejo"): así el despliegue trae
# SIEMPRE lo último. Si la API no responde, se cae al tarball de rama (comportamiento anterior).
rm -rf "$STAGE"
mkdir -p "$STAGE"

API_URL="https://api.github.com/repos/${REPO}/commits/${BRANCH}"
echo "==> Resolviendo el commit de ${BRANCH}…"
if [ -n "${GITHUB_TOKEN:-}" ]; then
    SHA="$(wget --header="Authorization: token ${GITHUB_TOKEN}" -qO- "$API_URL" | grep -m1 '"sha"' | sed -E 's/.*"sha"[[:space:]]*:[[:space:]]*"([0-9a-f]+)".*/\1/' || true)"
else
    SHA="$(wget -qO- "$API_URL" | grep -m1 '"sha"' | sed -E 's/.*"sha"[[:space:]]*:[[:space:]]*"([0-9a-f]+)".*/\1/' || true)"
fi
if [ -n "${SHA:-}" ]; then
    TARBALL_URL="https://github.com/${REPO}/archive/${SHA}.tar.gz"
    echo "==> Commit resuelto: ${SHA}"
else
    echo "==> AVISO: no se pudo resolver el SHA (¿sin red/API?); uso el tarball de rama (puede venir cacheado)."
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

# Sello de versión: la app lo lee al arrancar y muestra «📦 Versión en ejecución: commit <sha>». Se escribe
# TRAS el rsync (que lo excluye) y ANTES del build, para que quede dentro de la imagen (COPY . .).
echo "${SHA:-desconocido} ${BRANCH}" > "$APP_DIR/VERSION"

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
