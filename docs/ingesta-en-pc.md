# Ingesta en el PC (el NAS solo sirve y almacena)

Mueve el **catalogado pesado** al PC Windows (más potente) y deja el **NAS** como servidor 24/7
(API + panel + búsqueda) y como almacenamiento. Así la ingesta ya no compite por la RAM/CPU del Atom
y **el NAS deja de congelarse**. La BD (**MongoDB Atlas**, en la nube) es la fuente de la verdad
compartida: el PC cataloga, el NAS sirve, ambos ven lo mismo.

> **REGLA DE ORO: un solo watcher a la vez.** El del PC SÍ; el del NAS NO. Dos watchers se pisan en el Inbox.

---

## 1. NAS → modo servidor (apaga su ingesta)

En el NAS, añade al `.env` de la app y reinicia:

```
echo "DESACTIVAR_VIGILANTE=1" | sudo tee -a /volume1/docker/GestorBiblioteca/.env
cd /volume1/docker/GestorBiblioteca
sudo COMPOSE_HTTP_TIMEOUT=300 DOCKER_CLIENT_TIMEOUT=300 docker-compose up -d
```

El NAS sigue con API + panel + búsqueda (tu panel móvil/NFC 24/7), pero **ya no cataloga**. Compruébalo:
el interruptor del Vigilante en el panel debe salir desactivado.

---

## 2. PC → requisitos

- **Docker Desktop** con backend **WSL2** activado (Settings → General → *Use the WSL 2 based engine*, y
  Settings → Resources → WSL Integration → activa tu distro Ubuntu).
- Una distro **WSL2** (p. ej. Ubuntu): `wsl --install -d Ubuntu` desde PowerShell si no la tienes.

Todo lo que sigue se hace **dentro de WSL2** (terminal Ubuntu), porque el montaje SMB por `cifs` es lo
más fiable para acceder al almacenamiento del NAS desde el contenedor.

---

## 3. PC → el código

Clónalo dentro de WSL2 (más rápido que compilar desde `/mnt/d`):

```bash
git clone https://github.com/Luix70/gestor-biblioteca.git ~/gestor-biblioteca
cd ~/gestor-biblioteca
```
(Para actualizar en el futuro: `git pull` y repite el `up -d --build`.)

---

## 4. PC → secretos (.env.pc)

Copia el `.env` del NAS a este repo como **`.env.pc`** (trae Atlas + claves de IA + `ADMIN_PWD`). Si lo
copias del NAS, **quita** cualquier `DESACTIVAR_VIGILANTE` (el PC debe catalogar; de todos modos el compose
lo fuerza a 0). Plantilla en [`.env.pc.example`](../.env.pc.example).

```bash
cp .env.pc.example .env.pc && nano .env.pc      # o pega aquí el .env del NAS
```

---

## 5. PC → Fichero local (NO por SMB)

El `Fichero` (OL+BNE, SQLite con `better-sqlite3`) y el índice `busqueda.db` deben estar en **disco local**
del PC: SQLite sobre una unidad de red da bloqueos y latencia. Copia una vez `fichero.db` del NAS:

```bash
mkdir -p ~/gestor-biblioteca/datos-pc/Fichero
# desde el NAS por scp, o cópialo por el Explorador a \\wsl$\Ubuntu\home\<user>\gestor-biblioteca\datos-pc\Fichero
scp usuario@NAS_IP:"/volume3/BIBLIOTECA DIGITAL/Fichero/fichero.db" ~/gestor-biblioteca/datos-pc/Fichero/
```
(`busqueda.db` se creará solo al lado, es el índice local del PC.)

---

## 6. PC → montar el almacenamiento del NAS (SMB/cifs)

```bash
sudo apt update && sudo apt install -y cifs-utils
sudo mkdir -p /mnt/biblioteca
# Ajusta NAS_IP, el nombre del recurso compartido y las credenciales. dir_mode/file_mode permisivos
# porque el contenedor escribe como root; es una LAN de confianza.
sudo mount -t cifs "//NAS_IP/BIBLIOTECA DIGITAL" /mnt/biblioteca \
  -o username=USUARIO,password=CLAVE,uid=0,gid=0,file_mode=0777,dir_mode=0777,iocharset=utf8,vers=3.0
ls /mnt/biblioteca      # debes ver Inbox, CDU, Cuarentena, Reintentos, Recycling
```
> El recurso «BIBLIOTECA DIGITAL» es la carpeta compartida de Synology (en volumen3). Confirma el nombre
> exacto y que el usuario tiene **permiso de escritura**.

Para que el montaje sobreviva a reinicios de WSL, añádelo a `/etc/fstab` o a un pequeño script de arranque
(opcional; ver notas al final).

---

## 7. PC → arrancar la ingesta

```bash
cd ~/gestor-biblioteca
docker compose -f docker-compose.pc.yml up -d --build
docker logs -f gestor-biblioteca-pc        # sigue el catalogado; Ctrl+C para dejar de mirar
```
- Progreso también en el **panel del PC**: http://localhost:4000 (ver mensajes por documento).
- Deja caer los ficheros a catalogar en el **Inbox del NAS** (`\\NAS\BIBLIOTECA DIGITAL\Inbox`): el PC los
  detecta por polling, los cataloga, escribe el registro en Atlas y copia los ficheros al árbol CDU del NAS.

Para **parar** la ingesta (p. ej. al terminar): `docker compose -f docker-compose.pc.yml down` (o para el
contenedor desde Docker Desktop). El NAS sigue sirviendo con normalidad.

---

## Notas y cabos sueltos

- **Un solo watcher:** verifica que el NAS tiene `DESACTIVAR_VIGILANTE=1`. Nunca los dos catalogando.
- **Índice de búsqueda del NAS:** lo que catalogue el PC no actualiza el `busqueda.db` del NAS (mientras,
  la búsqueda del panel cae a Mongo, no se rompe). Reindexa en el NAS de vez en cuando desde el panel
  (Búsqueda → Reindexar) o `node scripts/reindexar-busqueda.js`.
- **Actualizar el código del PC:** `git pull` + `docker compose -f docker-compose.pc.yml up -d --build`.
- **Montaje persistente (opcional):** para no montar el SMB a mano cada vez, añade una línea a `/etc/fstab`
  con las mismas opciones (usa un fichero de credenciales con `credentials=/root/.smbnas` en vez de la clave
  en claro), o crea la unidad de red en Windows y móntala en WSL con `drvfs`.
- **Ancho de banda:** los ficheros viajan PC→LAN→NAS al copiarse al árbol CDU. En Gigabit sobra.
- **La app en el PC también levanta la API** (además del watcher): es inofensivo; usa el panel que prefieras
  (el del NAS para el día a día, el del PC para ver la ingesta en marcha).
