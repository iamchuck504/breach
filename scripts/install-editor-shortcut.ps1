# Instala/actualiza el acceso directo del editor offline de Breach.
param([string]$DesktopPath = [Environment]::GetFolderPath('Desktop'))

$editorRoot = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $PSScriptRoot 'editor.ps1'
$icon = Join-Path $PSScriptRoot 'breach-editor.ico'
$shortcutPath = Join-Path $DesktopPath 'Breach Map Editor.lnk'

if (-not (Test-Path -LiteralPath $launcher)) {
  throw "No se encontro el launcher: $launcher"
}
if (-not (Test-Path -LiteralPath $DesktopPath)) {
  throw "No se encontro el Escritorio: $DesktopPath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher`""
$shortcut.WorkingDirectory = $editorRoot
$shortcut.Description = 'Editor offline de mapas de Breach'
if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = "$icon,0" }
$shortcut.Save()

Write-Output $shortcutPath
