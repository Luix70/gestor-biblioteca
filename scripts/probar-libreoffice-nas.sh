#!/bin/sh
# PROBAR LIBREOFFICE EN EL NAS (3-nov) sin tocar la aplicación.
#
# Por qué: para convertir .doc/.rtf a PDF dentro del contenedor (y así coser libros por capítulos sin el PC) hace
# falta saber si LibreOffice funciona en el Atom D525 (sin SSE4) y con el kernel antiguo del NAS. Este script lo
# averigua en un contenedor DESECHABLE con la misma base que la app (node:18-bullseye-slim y archive.debian.org):
# instala LibreOffice, convierte unas muestras reales, mide el tiempo y se borra. La app no se entera.
#
# Uso:   sudo sh /volume1/docker/GestorBiblioteca/scripts/probar-libreoffice-nas.sh
# Deja:  /volume1/docker/GestorBiblioteca/temp/prueba-libreoffice/  (muestras, PDF y registro.txt)
set -u
APP=/volume1/docker/GestorBiblioteca
LIBROS="/volume3/BIBLIOTECA DIGITAL/World Tracker Library/College Books"
DIR="$APP/temp/prueba-libreoffice"
rm -rf "$DIR"
mkdir -p "$DIR/muestras" "$DIR/pdf"

# Muestras: dos .doc del formato antiguo que Word bloquea, dos .doc normales y un .rtf.
for f in "West's Business Law/AppendixB.doc" "An Introduction to Islam/ch01.doc" \
         "Strunk/STRUcp02.doc" "Sociology- Understanding a Diverse Society/andersen_Ch03.doc" \
         "Coaching for Character/CliffordCh2.rtf"; do
  cp "$LIBROS/$f" "$DIR/muestras/" 2>/dev/null || echo "no está: $f"
done
ls -l "$DIR/muestras"

docker run --rm -v "$DIR:/t" node:18-bullseye-slim sh -c '
  printf "%s\n" "deb http://archive.debian.org/debian bullseye main" \
    "deb http://archive.debian.org/debian-security bullseye-security main" > /etc/apt/sources.list
  rm -f /etc/apt/sources.list.d/*
  printf "Acquire::Check-Valid-Until \"false\";\n" > /etc/apt/apt.conf.d/99archivo
  echo "== CPU"; grep -m1 "model name" /proc/cpuinfo; grep -m1 -o "sse4_2\|avx" /proc/cpuinfo || echo "(sin sse4_2 ni avx)"
  echo "== instalando (tarda)"; t0=$(date +%s)
  apt-get update -qq >/dev/null 2>&1
  apt-get install -y -qq --no-install-recommends libreoffice-writer-nogui fonts-dejavu-core poppler-utils >/tmp/apt.log 2>&1 \
    || { echo "FALLO apt"; tail -20 /tmp/apt.log; exit 1; }
  echo "instalado en $(( $(date +%s) - t0 )) s · ocupa $(du -sh /usr/lib/libreoffice | cut -f1)"
  soffice --version
  echo "== convirtiendo"
  for f in /t/muestras/*; do
    t1=$(date +%s)
    soffice -env:UserInstallation=file:///tmp/perfil --headless --norestore --convert-to pdf --outdir /t/pdf "$f" >/tmp/lo.log 2>&1
    pdf="/t/pdf/$(basename "${f%.*}").pdf"
    if [ -s "$pdf" ]; then
      echo "OK  $(basename "$f") · $(pdfinfo "$pdf" | grep Pages | tr -s " ") · $(( $(date +%s) - t1 )) s"
    else
      echo "MAL $(basename "$f") · $(( $(date +%s) - t1 )) s"; tail -5 /tmp/lo.log
    fi
  done
' 2>&1 | tee "$DIR/registro.txt"
echo "Registro en $DIR/registro.txt"
