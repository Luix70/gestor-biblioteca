#!/bin/bash
# ---------------------------------------------------------------------------
# actualizar-GestorBiblioteca.sh — Actualiza Gestor Biblioteca en el Synology desde main.
#
# Colócalo en /volume1/docker/  (NO dentro de GestorBiblioteca, para que el
# propio script no se sobrescriba durante el rsync) y ejecútalo así:
#
#     bash /volume1/docker/actualizar-GestorBiblioteca.sh
#
# Repo privado: exporta un token antes de lanzarlo ->  GITHUB_TOKEN=ghp_xxx bash ...
#
# Qué hace, en orden:
#   1. Descarga main.tar.gz de GitHub (wget+tar; sin git, sin Alpine).
#   2. Sincroniza el código en GestorBiblioteca PRESERVANDO .env y node_modules.
#   3. down -v  (para + elimina el volumen anónimo de node_modules, que es el
#      que "ensombrecía" módulos viejos tras rebuilds — sharp/undici@7).
#   4. up -d --build  (reinstala dependencias limpias dentro de la imagen).
# ---------------------------------------------------------------------------
set -euo pipefail

# Binarios de Docker de Synology no siempre están en el PATH de un shell no interactivo.
export PATH="$PATH:/usr/local/bin:/usr/bin"

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

# --- 2. Sincronizar el código (preservando .env y node_modules) -----------
# --delete elimina del destino lo que ya no exista en el repo (módulos borrados).
echo "==> Sincronizando código en $APP_DIR"
rsync -a --delete \
    --exclude='.env' \
    --exclude='node_modules' \
    --exclude='.git' \
    "$SRC_DIR"/ "$APP_DIR"/

# --- 3 y 4. Parar, eliminar volumen anónimo y reconstruir -----------------
cd "$APP_DIR"
echo "==> Parando contenedor y eliminando volumen de node_modules"
$COMPOSE down -v

echo "==> Reconstruyendo e iniciando (esto reinstala dependencias; en el Atom tarda un poco)"
$COMPOSE up -d --build

# --- Limpieza y estado ----------------------------------------------------
rm -rf "$STAGE"

echo "==> Estado del contenedor:"
$COMPOSE ps
echo "==> Últimas líneas de log:"
$COMPOSE logs --tail=40

echo "==> Listo. Sigue el arranque con:  docker-compose -f $APP_DIR/docker-compose.yml logs -f"
