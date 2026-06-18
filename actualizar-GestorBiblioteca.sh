#!/bin/bash
# ---------------------------------------------------------------------------
# actualizar-GestorBiblioteca.sh — Actualiza Gestor Biblioteca en el Synology desde main.
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
#   1. Descarga main.tar.gz de GitHub (wget+tar; sin git, sin Alpine).
#   2. down -v: para el contenedor (libera los montajes Inbox/CDU/... ) y elimina el
#      volumen anónimo de node_modules, que "ensombrecía" módulos viejos (sharp/undici@7).
#   3. Sincroniza el código PRESERVANDO .env, node_modules y los datos del host.
#   4. up -d --build  (reinstala dependencias limpias dentro de la imagen).
# ---------------------------------------------------------------------------
set -euo pipefail

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
BRANCH="main"
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

# --- 1. Descargar y extrae el tarball en una zona de staging --------------
echo "==> Descargando ${TARBALL_URL}"
rm -rf "$STAGE"
mkdir -p "$STAGE"

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
    --exclude='/Inbox' \
    --exclude='/CDU' \
    --exclude='/Cuarentena' \
    --exclude='/Reintentos' \
    --exclude='/temp' \
    "$SRC_DIR"/ "$APP_DIR"/

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
