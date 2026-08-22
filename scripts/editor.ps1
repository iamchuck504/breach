# Abre el EDITOR DE MAPAS de BREACH (solo DEV).
# Si el dev server de Vite (puerto 5200) no esta corriendo, lo arranca
# minimizado y espera a que responda; luego abre Brave directo en el editor
# (?editor=1 salta el menu). Lo usa el acceso directo del escritorio.
$root = Split-Path -Parent $PSScriptRoot
$port = 5200
$url = "http://localhost:$port/?editor=1"

function Test-Port {
  try {
    $c = New-Object Net.Sockets.TcpClient
    $c.Connect('127.0.0.1', $port)
    $ok = $c.Connected
    $c.Close()
    return $ok
  } catch { return $false }
}

if (-not (Test-Port)) {
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' `
    -WorkingDirectory $root -WindowStyle Minimized
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    if (Test-Port) { break }
  }
}

$brave = 'C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe'
if (Test-Path $brave) { Start-Process -FilePath $brave -ArgumentList $url }
else { Start-Process $url }
