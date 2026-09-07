# TUI-mode updater (Windows). Replaces the wallet binary for the full-screen
# TUI launch mode (edgex-wallet start).
#
# The TUI owns the terminal, so this script asks the user to close it first,
# then runs the shared update core. Run it from a separate terminal while the
# TUI is still open for a guided upgrade.
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

Write-Host "TUI-mode update: close the wallet TUI window before continuing." -ForegroundColor Yellow
$null = Read-Host "Press Enter when the TUI has been closed, or Ctrl+C to abort"

& "$ScriptDir\update-common.ps1"

Write-Host ""
Write-Host "TUI update complete. Restart with: edgex-wallet" -ForegroundColor Green
