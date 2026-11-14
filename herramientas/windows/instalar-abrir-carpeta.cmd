@echo off
rem Instala (o con -Desinstalar quita) el boton "Abrir carpeta" del panel en este PC. Doble clic.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalar-abrir-carpeta.ps1" %*
echo.
pause
