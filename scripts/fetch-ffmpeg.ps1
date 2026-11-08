# Downloads the pinned FFmpeg build PiFiles bundles (LGPL, shared DLLs) into src-tauri/ffmpeg.
# The binaries (~150 MB) are git-ignored; run this once after cloning:
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
$ErrorActionPreference = "Stop"

$Tag    = "autobuild-2026-09-30-13-08"
$Name   = "ffmpeg-n9.0.2-17-g2a571b6068-win64-lgpl-shared-9.0"
$Sha256 = "7157177b8a6cb2174c1650ba8c71b363f2c78cba5330f88c4c02cf5b2b880646"
$Url    = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$Tag/$Name.zip"

$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root "src-tauri\ffmpeg"
$Tmp  = Join-Path ([IO.Path]::GetTempPath()) "pifiles-ffmpeg"

if (Test-Path (Join-Path $Dest "ffmpeg.exe")) { Write-Host "FFmpeg already present in $Dest"; exit 0 }

New-Item -ItemType Directory -Force $Tmp | Out-Null
$Zip = Join-Path $Tmp "$Name.zip"
Write-Host "Downloading $Url (77 MB)..."

$MaxAttempts = 5
for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
        if ($attempt -gt 1) {
            Write-Host "Download attempt $attempt of $MaxAttempts..."
        }
        if (Test-Path $Zip) { Remove-Item $Zip -Force }

        if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
            & curl.exe --retry 3 --retry-connrefused --retry-delay 2 -fSL $Url -o $Zip
            if ($LASTEXITCODE -ne 0) {
                throw "curl failed with exit code $LASTEXITCODE"
            }
        } else {
            Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing
        }

        $Actual = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
        if ($Actual -ne $Sha256) {
            throw "Checksum mismatch: expected $Sha256, got $Actual"
        }
        break
    } catch {
        if ($attempt -eq $MaxAttempts) {
            throw "Failed to download and verify FFmpeg after $MaxAttempts attempts: $_"
        }
        Write-Warning "Download/verification failed: $_. Retrying in $($attempt * 3) seconds..."
        Start-Sleep -Seconds ($attempt * 3)
    }
}

Expand-Archive $Zip -DestinationPath $Tmp -Force
$Bin = Join-Path $Tmp "$Name\bin"
New-Item -ItemType Directory -Force $Dest | Out-Null
Copy-Item (Join-Path $Bin "ffmpeg.exe"), (Join-Path $Bin "ffprobe.exe") $Dest
Copy-Item (Join-Path $Bin "*.dll") $Dest
Copy-Item (Join-Path $Tmp "$Name\LICENSE.txt") (Join-Path $Dest "LICENSE-FFmpeg.txt")
Remove-Item $Tmp -Recurse -Force
Write-Host "FFmpeg ready in $Dest"
