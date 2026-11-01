<#
  CONVERTIR A PDF LAS PARTES .doc DE LOS LIBROS DESGLOSADOS (1-nov). Se ejecuta en el PC: en el NAS no hay Word.

  qpdf solo cose PDF, asi que un libro partido en capitulos .doc, sin el libro entero, espera en el Inbox sin
  catalogar (vigilante: materializarDesgloseGuiado). Este script recorre el Inbox, busca las carpetas con guia
  «desglose» sin libro principal y deja al lado de cada .doc/.docx/.rtf su .pdf con el mismo nombre. El .doc no se
  toca: al coser, viaja con el resto de originales a «Desglose/».

  Las macros quedan desactivadas: son ficheros descargados.
  Reanudable: lo ya convertido se salta. Una parte que falle se lista y no para el resto.

  Word bloquea de fabrica los .doc de formato muy antiguo (Centro de confianza; 5 libros de World Tracker Library). Con
  -Soffice <ruta de soffice.com> esos pasan por LibreOffice, sin tocar la configuracion de Word. LibreOffice no hace
  falta instalarlo: "msiexec /a LibreOffice.msi /qn TARGETDIR=<carpeta>" solo extrae sus ficheros.

    powershell -ExecutionPolicy Bypass -File scripts\convertir-partes-word.ps1              (seco)
    powershell -ExecutionPolicy Bypass -File scripts\convertir-partes-word.ps1 -Ejecutar
    Opciones: -Inbox U:\Inbox  -Solo "texto del nombre de la carpeta"  -Soffice <ruta de soffice.com>
#>
param(
  [string]$Inbox = 'U:\Inbox',
  [string]$Solo = '',
  [string]$Soffice = '',
  [switch]$Ejecutar
)
$ErrorActionPreference = 'Stop'
$ExtConvertibles = @('.doc', '.docx', '.rtf')
$SubcarpetasPartes = '^(chapters?|cap[ií]tulos?|caps|parts?|partes?|sections?|secciones?|split|pdfs?|unidades|units?|lessons?|lecciones|temas)$'

function Hora { Get-Date -Format 'HH:mm:ss' }

# Los documentos de la carpeta y de sus subcarpetas de partes, como hace partesDeDesglose en la ingesta.
function Get-PartesPendientes([string]$dir, $guia) {
  $subs = @($guia.desglose.orden | Where-Object { $_ -match '/' } | ForEach-Object { ($_ -split '/')[0] } | Select-Object -Unique)
  $rutas = @(Get-ChildItem -LiteralPath $dir -File -Force)
  foreach ($d in Get-ChildItem -LiteralPath $dir -Directory -Force) {
    if ($subs -contains $d.Name -or $d.Name -match $SubcarpetasPartes) { $rutas += Get-ChildItem -LiteralPath $d.FullName -File -Force }
  }
  foreach ($f in $rutas) {
    if ($ExtConvertibles -notcontains $f.Extension.ToLower()) { continue }
    if ($f.Name -match '^[.~]') { continue }
    $pdf = [IO.Path]::ChangeExtension($f.FullName, '.pdf')
    if (-not (Test-Path -LiteralPath $pdf)) { $f }
  }
}

Write-Host "[$(Hora)] Buscando guias de desglose en $Inbox ..."
$pendientes = New-Object System.Collections.ArrayList
foreach ($g in Get-ChildItem -LiteralPath $Inbox -Recurse -Force -File -Filter '_guia.json' -ErrorAction SilentlyContinue) {
  try { $guia = Get-Content -LiteralPath $g.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Write-Warning "guia ilegible: $($g.FullName)"; continue }
  # Con libro entero no se cose nada, y con solo_orden los .doc son copias de lo que ya esta en PDF.
  if ($guia.accion -ne 'desglose' -or $guia.desglose.principal -or $guia.desglose.solo_orden) { continue }
  $carpeta = $g.Directory.FullName
  if ($Solo -and $g.Directory.Name -notlike "*$Solo*") { continue }
  $partes = @(Get-PartesPendientes $carpeta $guia)
  if ($partes.Count) {
    Write-Host ("  {0,4} partes  {1}" -f $partes.Count, $g.Directory.Name)
    foreach ($p in $partes) { [void]$pendientes.Add($p) }
  }
}
Write-Host "[$(Hora)] Total por convertir: $($pendientes.Count)"
if (-not $Ejecutar) { Write-Host 'SECO: no se ha convertido nada. Repite con -Ejecutar.'; exit 0 }
if (-not $pendientes.Count) { exit 0 }

$word = New-Object -ComObject Word.Application
$fallos = New-Object System.Collections.ArrayList
$reloj = [Diagnostics.Stopwatch]::StartNew()
try {
  $word.Visible = $false
  $word.DisplayAlerts = 0              # wdAlertsNone
  $word.AutomationSecurity = 3         # msoAutomationSecurityForceDisable: sin macros
  $hechas = 0
  foreach ($f in $pendientes) {
    $hechas++
    $eta = if ($hechas -gt 1) { [TimeSpan]::FromSeconds($reloj.Elapsed.TotalSeconds / ($hechas - 1) * ($pendientes.Count - $hechas + 1)).ToString('hh\:mm\:ss') } else { '?' }
    Write-Host ("[{0}] {1}/{2} (queda {3}) {4}\{5}" -f (Hora), $hechas, $pendientes.Count, $eta, $f.Directory.Name, $f.Name)
    $pdf = [IO.Path]::ChangeExtension($f.FullName, '.pdf')
    $doc = $null
    try {
      # FileName, ConfirmConversions, ReadOnly, AddToRecentFiles, PasswordDocument (con clave falsa, un documento
      # protegido da error en vez de quedarse esperando en un dialogo).
      $doc = $word.Documents.Open([ref]$f.FullName, [ref]$false, [ref]$true, [ref]$false, [ref]'sin-clave')
      $doc.ExportAsFixedFormat($pdf, 17)   # wdExportFormatPDF
    } catch {
      [void]$fallos.Add([pscustomobject]@{ Fichero = $f; Motivo = $_.Exception.Message })
      if (Test-Path -LiteralPath $pdf) { Remove-Item -LiteralPath $pdf -Force }
    } finally {
      if ($doc) { $doc.Close([ref]0) | Out-Null }   # wdDoNotSaveChanges
    }
  }
} finally {
  $word.Quit([ref]0) | Out-Null
  [void][Runtime.InteropServices.Marshal]::ReleaseComObject($word)
}
if ($fallos.Count -and $Soffice) {
  # Perfil propio y desechable, con las macros desactivadas de forma explicita.
  $perfil = Join-Path $env:TEMP 'convertir-partes-lo'
  New-Item -ItemType Directory -Force (Join-Path $perfil 'user') | Out-Null
  @'
<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
</oor:items>
'@ | Out-File -Encoding utf8 (Join-Path $perfil 'user\registrymodifications.xcu')
  $url = 'file:///' + ($perfil -replace '\\', '/')
  $restantes = New-Object System.Collections.ArrayList
  $hechas = 0
  foreach ($x in $fallos) {
    $hechas++
    $f = $x.Fichero
    Write-Host ("[{0}] LibreOffice {1}/{2} {3}\{4}" -f (Hora), $hechas, $fallos.Count, $f.Directory.Name, $f.Name)
    & $Soffice "-env:UserInstallation=$url" --headless --norestore --convert-to pdf --outdir $f.Directory.FullName $f.FullName 2>&1 | Out-Null
    if (-not (Test-Path -LiteralPath ([IO.Path]::ChangeExtension($f.FullName, '.pdf')))) { [void]$restantes.Add($x) }
  }
  Remove-Item -LiteralPath $perfil -Recurse -Force -ErrorAction SilentlyContinue
  $fallos = $restantes
}
Write-Host "[$(Hora)] Convertidas: $($pendientes.Count - $fallos.Count) - fallidas: $($fallos.Count)"
foreach ($x in $fallos) { Write-Warning "$($x.Fichero.FullName): $($x.Motivo)" }
if ($fallos.Count) { exit 1 }
