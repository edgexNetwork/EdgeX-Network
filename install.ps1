$ErrorActionPreference = 'Stop'
# Speed up Invoke-WebRequest (skip progress rendering)
$ProgressPreference = 'SilentlyContinue'
# PS 5.1 may default to TLS 1.0; GitHub requires TLS 1.2+
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

# 1. Detect Windows architecture
$RawArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
switch ($RawArch.ToUpper()) {
    "AMD64" { $Arch = "x64" }
    "ARM64" { $Arch = "arm64" }
    default {
        Write-Error "Unsupported architecture: $RawArch"
        exit 1
    }
}

# 2. Define paths
$TargetArchive = "dexcoin-wallet-win-$Arch.zip"
$DownloadUrl   = "https://github.com/edgexNetwork/EdgeX-Network/releases/latest/download/$TargetArchive"
$InstallDir    = "$env:LOCALAPPDATA\dexcoin"
$TempZip       = "$env:TEMP\$TargetArchive"

# 3. Stop running instances to avoid file locks
$Process = Get-Process -Name "dexcoin", "dexcoin-wallet" -ErrorAction SilentlyContinue
if ($Process) {
    Write-Warning "dexcoin is currently running. Stopping process to update..."
    $Process | Stop-Process -Force
}

# 4. Create install dir and remove stale files
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Get-ChildItem -Path $InstallDir -Force | Remove-Item -Recurse -Force

# 5. Download archive
Write-Host "Downloading $TargetArchive..." -ForegroundColor Cyan
Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempZip -UseBasicParsing

# 6. Extract to install dir
Write-Host "Extracting files..." -ForegroundColor Cyan
Expand-Archive -Path $TempZip -DestinationPath $InstallDir -Force

# 7. Rename dexcoin-wallet-win-*.exe to dexcoin.exe
$ExtractedExe = Get-ChildItem -Path $InstallDir -Filter "dexcoin-wallet-win-*.exe" | Select-Object -First 1
if ($ExtractedExe) {
    Move-Item -Path $ExtractedExe.FullName -Destination "$InstallDir\dexcoin.exe" -Force
}
else {
    Write-Error "dexcoin-wallet-win-*.exe not found in archive."
    exit 1
}

# 8. Clean up temp file
Remove-Item -Path $TempZip -Force -ErrorAction SilentlyContinue

# 9. Add install dir to user PATH
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (($UserPath -split ';') -notcontains $InstallDir) {
    $NewPath = if ([string]::IsNullOrEmpty($UserPath)) { $InstallDir } else { "$UserPath;$InstallDir" }
    [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    $env:Path += ";$InstallDir"
    Write-Host "Added $InstallDir to PATH." -ForegroundColor Green
}

Write-Host "Success! Restart your terminal and run 'dexcoin' to get started." -ForegroundColor Green