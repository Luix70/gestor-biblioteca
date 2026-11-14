# INSTALAR "ABRIR CARPETA" EN ESTE PC (una vez por PC; no necesita administrador).
#
# Registra el tipo de enlace gestorbib: para el usuario actual (HKCU, no toca el resto del sistema) y copia
# abrir-carpeta.ps1 a %LOCALAPPDATA%\GestorBiblioteca. Desde entonces, el boton "Abrir carpeta" de una ficha del
# panel abre el Explorador en la carpeta del documento. La primera vez el navegador pregunta si permite abrir el
# enlace: marca "Permitir siempre".
#
#   Doble clic en instalar-abrir-carpeta.cmd                 (instalar)
#   instalar-abrir-carpeta.cmd -Desinstalar                  (quitarlo)
#   instalar-abrir-carpeta.cmd -Prefijo "\\otro\ruta\CDU"   (otra carpeta permitida; por defecto la del NAS)

param(
    [switch]$Desinstalar,
    [string[]]$Prefijo = @('\\172.16.0.250\biblioteca digital\CDU', 'U:\CDU')
)

$ErrorActionPreference = 'Stop'
$destino = Join-Path $env:LOCALAPPDATA 'GestorBiblioteca'
$clave = 'HKCU:\Software\Classes\gestorbib'

if ($Desinstalar) {
    if (Test-Path $clave) { Remove-Item -Path $clave -Recurse -Force }
    Write-Host 'Quitado el enlace gestorbib: de este PC.'
    Write-Host "(Los ficheros de $destino se dejan; puedes borrar la carpeta a mano.)"
    exit 0
}

# 1) El script que abre el Explorador, y la lista de carpetas permitidas.
New-Item -ItemType Directory -Force -Path $destino | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'abrir-carpeta.ps1') -Destination (Join-Path $destino 'abrir-carpeta.ps1') -Force
$lineas = @('# Carpetas que "Abrir carpeta" puede abrir (una por linea). Cualquier otra ruta se rechaza.') + $Prefijo
Set-Content -LiteralPath (Join-Path $destino 'prefijos.txt') -Value $lineas -Encoding UTF8

# 2) El enlace gestorbib: -> powershell oculto con ese script.
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$script = Join-Path $destino 'abrir-carpeta.ps1'
$comando = "`"$powershell`" -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" `"%1`""
New-Item -Path $clave -Force | Out-Null
Set-ItemProperty -Path $clave -Name '(default)' -Value 'URL:Gestor Biblioteca - abrir carpeta'
New-ItemProperty -Path $clave -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
New-Item -Path "$clave\shell\open\command" -Force | Out-Null
Set-ItemProperty -Path "$clave\shell\open\command" -Name '(default)' -Value $comando

Write-Host ''
Write-Host 'Listo: el boton "Abrir carpeta" del panel ya abre el Explorador en este PC.'
Write-Host "Carpetas permitidas: $($Prefijo -join ' | ')"
Write-Host 'La primera vez el navegador preguntara si permite abrir el enlace: marca "Permitir siempre".'
Write-Host ''
Write-Host 'Prueba ahora (debe abrirse el Explorador en la carpeta CDU):'
Write-Host "  start gestorbib:abrir?ruta=$([uri]::EscapeDataString($Prefijo[0]))"
