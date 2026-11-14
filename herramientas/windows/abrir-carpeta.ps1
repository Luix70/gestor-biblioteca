# ABRIR CARPETA - lo que se ejecuta al pulsar "Abrir carpeta" en la ficha del panel.
#
# El panel es una pagina web: el navegador no le deja abrir el Explorador. Por eso se registra en este PC un tipo
# de enlace propio, gestorbib:, igual que mailto: abre el correo. Al pulsar un enlace
#   gestorbib:abrir?ruta=<ruta de red del fichero o de la carpeta, codificada>
# Windows ejecuta este script con ese enlace, y el script abre el Explorador:
#   - si la ruta es un FICHERO, en su carpeta con el fichero seleccionado (nunca lo abre ni lo ejecuta);
#   - si es una CARPETA, en ella.
#
# Seguridad: cualquier pagina web podria escribir un enlace gestorbib:. Por eso solo se aceptan rutas que empiezan
# por uno de los prefijos de prefijos.txt (la carpeta CDU del NAS) y sin "..", y nunca se abre un fichero.
# Lo instala instalar-abrir-carpeta.cmd (en %LOCALAPPDATA%\GestorBiblioteca).

param([string]$Enlace = '')

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Web
Add-Type -AssemblyName PresentationFramework

function Avisar([string]$texto) {
    [System.Windows.MessageBox]::Show($texto, 'Gestor Biblioteca - Abrir carpeta') | Out-Null
}

try {
    # gestorbib:abrir?ruta=...  (algunos navegadores anaden // o una barra final)
    $consulta = ($Enlace -replace '^[a-zA-Z]+:/*', '' -replace '^abrir/?', '')
    $consulta = $consulta.TrimStart('?')
    $ruta = $null
    foreach ($par in $consulta -split '&') {
        $kv = $par -split '=', 2
        if ($kv.Count -eq 2 -and $kv[0] -eq 'ruta') { $ruta = [System.Web.HttpUtility]::UrlDecode($kv[1]) }
    }
    if (-not $ruta) { Avisar "El enlace no trae ninguna ruta:`n$Enlace"; exit 1 }
    $ruta = $ruta.Trim().Trim('"').Replace('/', '\')

    # Solo rutas bajo los prefijos permitidos, y sin subir de carpeta.
    $archivoPrefijos = Join-Path $PSScriptRoot 'prefijos.txt'
    $prefijos = @()
    if (Test-Path -LiteralPath $archivoPrefijos) {
        $prefijos = Get-Content -LiteralPath $archivoPrefijos -Encoding UTF8 | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith('#') }
    }
    $permitida = $false
    foreach ($p in $prefijos) {
        if ($ruta.StartsWith($p, [System.StringComparison]::OrdinalIgnoreCase)) { $permitida = $true }
    }
    if (-not $permitida -or $ruta -match '(^|\\)\.\.(\\|$)') {
        Avisar "Ruta no permitida:`n$ruta`n`nSolo se abren carpetas bajo:`n$($prefijos -join "`n")`n`n(Se cambian en $archivoPrefijos)"
        exit 1
    }

    if (Test-Path -LiteralPath $ruta -PathType Leaf) {
        # Un fichero: su carpeta, con el fichero seleccionado. /select no abre ni ejecuta el fichero.
        Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$ruta`""
    } elseif (Test-Path -LiteralPath $ruta -PathType Container) {
        Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$ruta`""
    } else {
        # No esta (o no hay acceso a la red): se intenta la carpeta que la contiene.
        $carpeta = Split-Path -Parent $ruta
        if ($carpeta -and (Test-Path -LiteralPath $carpeta -PathType Container)) {
            Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$carpeta`""
        } else {
            Avisar "No se encuentra:`n$ruta`n`nComprueba que el NAS esta accesible desde este PC (abre la ruta a mano en el Explorador una vez para que pida la contrasena)."
            exit 1
        }
    }
} catch {
    Avisar "No se pudo abrir la carpeta:`n$($_.Exception.Message)"
    exit 1
}
