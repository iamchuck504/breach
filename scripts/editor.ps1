# Abre el EDITOR DE MAPAS de BREACH (solo DEV).
# Si el dev server de Vite (puerto 5200) no esta corriendo, lo arranca
# minimizado y espera a que responda; luego abre Brave directo en el editor
# (?editor=1 salta el menu). Lo usa el acceso directo del escritorio.
param([switch]$NoBrowser, [int]$Port = 5200)

$editorRoot = Split-Path -Parent $PSScriptRoot
$url = "http://127.0.0.1:$Port/?editor=1"
$logDir = Join-Path $env:TEMP 'BreachEditor'
$outLog = Join-Path $logDir 'server.log'
$errLog = Join-Path $logDir 'server-error.log'

function Test-Editor {
  try {
    $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -eq 200 -and $response.Content -match '<title>BREACH</title>'
  } catch { return $false }
}

if (-not (Test-Editor)) {
  # Un proceso ajeno en 5200 no cuenta como editor. Fallar con una explicación
  # evita abrir silenciosamente otra aplicación bajo el acceso directo.
  $occupied = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if ($occupied) {
    if (-not $NoBrowser) {
      (New-Object -ComObject WScript.Shell).Popup(
        "El puerto $Port esta ocupado por otra aplicacion.`nCierra ese proceso y vuelve a abrir Breach Map Editor.", 0,
        'BREACH Editor', 16) | Out-Null
    }
    exit 1
  }

  $node = Get-Command node.exe -ErrorAction SilentlyContinue
  $vite = Join-Path $editorRoot 'node_modules\vite\bin\vite.js'
  if (-not $node -or -not (Test-Path $vite)) {
    if (-not $NoBrowser) {
      (New-Object -ComObject WScript.Shell).Popup(
        "Falta el runtime local del editor.`n`nVerifica Node.js y ejecuta npm install una vez en:`n$editorRoot", 0,
        'BREACH Editor', 16) | Out-Null
    }
    exit 1
  }

  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  Set-Content -LiteralPath $outLog -Value '' -ErrorAction SilentlyContinue
  Set-Content -LiteralPath $errLog -Value '' -ErrorAction SilentlyContinue
  $process = Start-Process -FilePath $node.Source `
    -ArgumentList @($vite, '--host', '127.0.0.1', '--port', "$Port", '--strictPort') `
    -WorkingDirectory $editorRoot -WindowStyle Hidden -PassThru `
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

# Usar el navegador predeterminado respeta la preferencia del usuario y evita
# depender de una ruta específica de Brave/Chrome.
Start-Process $url
