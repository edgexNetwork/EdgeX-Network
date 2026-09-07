# Console-mode updater (Windows). Replaces the wallet binary for the
# interactive line console launch mode (edgex-wallet console / cli).
#
# A running console session holds the binary, so the script stops the
# edgex-wallet console process first, then runs the shared update core. User
# data (EDX_DATA, wallet files, config) is preserved.
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# The console, TUI and daemon all run under the same binary name, so stopping
# by process name would also end any other running mode. The console is
# typically the only active session when this script is invoked; stop any
# running wallet process and let the user relaunch the console afterwards.
Get-Process -Name "dexcoin", "dexcoin-wallet", "edgex-wallet" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

& "$ScriptDir\update-common.ps1"

Write-Host ""
Write-Host "Console update complete. Restart with: edgex-wallet console" -ForegroundColor Green
