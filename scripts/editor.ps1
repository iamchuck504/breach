# Abre el EDITOR DE MAPAS de BREACH (solo DEV).
# Si el dev server de Vite (puerto 5200) no esta corriendo, lo arranca
# minimizado y espera a que responda; luego abre Brave directo en el editor
# (?editor=1 salta el menu). Lo usa el acceso directo del escritorio.
param([switch]$NoBrowser)

$root = Split-Path -Parent $PSScriptRoot
$port = 5200
$url = "http://127.0.0.1:$port/?editor=1"
$logDir = Join-Path $env:TEMP 'BreachEditor'
$outLog = Join-Path $logDir 'server.log'
$errLog = Join-Path $logDir 'server-error.log'

function Test-Editor {
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200
  } catch { return $false }
}

if (-not (Test-Editor)) {
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if (-not $npm) {
    if (-not $NoBrowser) {
      (New-Object -ComObject WScript.Shell).Popup(
        'No se encontro npm. Instala Node.js o agrega npm al PATH.', 0,
        'BREACH Editor', 16) | Out-Null
    }
    exit 1
  }

  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  $process = Start-Process -FilePath $npm.Source `
    -ArgumentList @('run', 'dev', '--', '--host', '127.0.0.1', '--strictPort') `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput $outLog -RedirectStandardError $errLog

  for ($i = 0; $i -lt 80; $i++) {
    Start-Sleep -Milliseconds 250
    if (Test-Editor) { break }
    if ($process.HasExited) { break }
  }
}

if (-not (Test-Editor)) {
  $details = if (Test-Path $errLog) {
    (Get-Content $errLog -Tail 8 -ErrorAction SilentlyContinue) -join "`n"
  } else { 'El servidor termino antes de responder.' }
  if (-not $NoBrowser) {
    (New-Object -ComObject WScript.Shell).Popup(
      "No se pudo iniciar el editor local.`n`n$details`n`nLog: $logDir", 0,
      'BREACH Editor', 16) | Out-Null
  }
  exit 1
}

if ($NoBrowser) { Write-Output $url; exit 0 }

$brave = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
if (Test-Path $brave) { Start-Process -FilePath $brave -ArgumentList $url }
else { Start-Process $url }
