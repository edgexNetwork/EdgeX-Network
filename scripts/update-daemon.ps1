# Daemon-mode updater (Windows). Replaces the wallet binary for the headless
# daemon launch mode (edgex-wallet daemon).
#
# The daemon runs as a background service and holds the binary; this script
# stops it first, runs the shared update core, and reminds the caller to bring
# the service back up. User data (EDX_DATA, wallet.vault, chain.db) is
# preserved.
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Ask the daemon to shut down cleanly; stop the process if it keeps running.
Get-Process -Name "dexcoin", "dexcoin-wallet", "edgex-wallet" -ErrorAction SilentlyContinue |
    Stop-Process -Force -ErrorAction SilentlyContinue
# Give the daemon time to flush and release the binary before replacement.
Start-Sleep -Seconds 2

& "$ScriptDir\update-common.ps1"

Write-Host ""
Write-Host "Daemon update complete. Restart the daemon with: edgex-wallet daemon" -ForegroundColor Green
Write-Host "(If the daemon is managed by a service supervisor, start it there instead.)"
