# Shared Windows update core used by the three launch-mode updater scripts
# (update-tui.ps1, update-console.ps1, update-daemon.ps1).
#
# Behaviour
# - "dev" mode ($env:UPDATE_MODE = "dev"): the target version is read from a
#   local `version` file and the archive is taken from EDX_UPDATE_ARCHIVE
#   (default: dexcoin-wallet-win-<arch>.zip in the current directory). This
#   mirrors the wallet's -dev flag, which reads the same local version file.
# - "prod" mode ($env:UPDATE_MODE = "prod", the default): the latest release
#   archive is downloaded from the GitHub release channel.
#
# The script never touches user data: EDX_DATA/, dexcoin.conf, *.vault and
# chain.db are preserved. Only the program binary under the install directory
# is replaced.
#
# Environment:
#   UPDATE_MODE          dev | prod (default prod)
#   EDX_UPDATE_ARCHIVE   dev mode: path or URL of the local archive
#   EDX_INSTALL_DIR      override the default install directory

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# PS 5.1 may default to TLS 1.0; GitHub requires TLS 1.2+
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# Detect Windows architecture.
$RawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($RawArch.ToUpper()) {
    "AMD64" { $Arch = "x64" }
    "ARM64" { $Arch = "arm64" }
    default {
        Write-Error "Unsupported architecture: $RawArch"
        exit 1
    }
}

$InstallDir = if ($env:EDX_INSTALL_DIR) { $env:EDX_INSTALL_DIR } else { "$env:LOCALAPPDATA\dexcoin" }
$Mode = if ($env:UPDATE_MODE) { $env:UPDATE_MODE } else { "prod" }

if ($Mode -eq "dev") {
    if (-not (Test-Path "version")) {
        Write-Error "Dev update needs a local 'version' file next to the working directory."
        exit 1
    }
    $ArchivePath = if ($env:EDX_UPDATE_ARCHIVE) { $env:EDX_UPDATE_ARCHIVE } else { ".\dexcoin-wallet-win-$Arch.zip" }
    $IsUrl = $ArchivePath -match "^https?://"
    if (-not $IsUrl -and -not (Test-Path $ArchivePath)) {
        Write-Error "Dev archive not found at $ArchivePath"
        exit 1
    }
}
else {
    $TargetArchive = "dexcoin-wallet-win-$Arch.zip"
    $ArchivePath = "https://github.com/edgexNetwork/EdgeX-Network/releases/latest/download/$TargetArchive"
    $IsUrl = $true
}

# Create install dir and remove stale program binaries (preserve EDX_DATA,
# dexcoin.conf, wallet files and chain.db).
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Get-ChildItem -Path $InstallDir -Filter "dexcoin*.exe" -Force -ErrorAction SilentlyContinue |
    Remove-Item -Force

$TempZip = "$env:TEMP\dexcoin-update-$Arch.zip"
if ($IsUrl) {
    Write-Host "Downloading archive..." -ForegroundColor Cyan
    Invoke-WebRequest -Uri $ArchivePath -OutFile $TempZip -UseBasicParsing
}
else {
    Copy-Item -Path $ArchivePath -Destination $TempZip -Force
}

Write-Host "Extracting files..." -ForegroundColor Cyan
Expand-Archive -Path $TempZip -DestinationPath $InstallDir -Force
Remove-Item -Path $TempZip -Force -ErrorAction SilentlyContinue

$ExtractedExe = Get-ChildItem -Path $InstallDir -Filter "dexcoin-wallet-win-*.exe" | Select-Object -First 1
if ($ExtractedExe) {
    Move-Item -Path $ExtractedExe.FullName -Destination "$InstallDir\dexcoin.exe" -Force
}
else {
    Write-Error "dexcoin-wallet-win-*.exe not found in archive."
    exit 1
}

Write-Host "Program installed at $InstallDir\dexcoin.exe" -ForegroundColor Green
