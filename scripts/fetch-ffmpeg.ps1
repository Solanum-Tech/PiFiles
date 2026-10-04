# Downloads the pinned FFmpeg build PiFiles bundles (LGPL, shared DLLs) into src-tauri/ffmpeg.
# The binaries (~150 MB) are git-ignored; run this once after cloning:
#   powershell -ExecutionPolicy Bypass -File scripts/fetch-ffmpeg.ps1
$ErrorActionPreference = "Stop"

$Tag    = "autobuild-2026-09-29-13-10"
$Name   = "ffmpeg-n9.0.2-14-gebafaee10a-win64-lgpl-shared-9.0"
$Sha256 = "3acc157a5b9628bdc360c93a1267280c425e9d39cf689fd24cd208d3e5b5d9e2"
$Url    = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$Tag/$Name.zip"

$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root "src-tauri\ffmpeg"
$Tmp  = Join-Path ([IO.Path]::GetTempPath()) "pifiles-ffmpeg"

if (Test-Path (Join-Path $Dest "ffmpeg.exe")) { Write-Host "FFmpeg already present in $Dest"; exit 0 }

New-Item -ItemType Directory -Force $Tmp | Out-Null
$Zip = Join-Path $Tmp "$Name.zip"
Write-Host "Downloading $Url (77 MB)..."
Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing

$Actual = (Get-FileHash $Zip -Algorithm SHA256).Hash.ToLower()
if ($Actual -ne $Sha256) { throw "Checksum mismatch: expected $Sha256, got $Actual" }

Expand-Archive $Zip -DestinationPath $Tmp -Force
$Bin = Join-Path $Tmp "$Name\bin"
New-Item -ItemType Directory -Force $Dest | Out-Null
Copy-Item (Join-Path $Bin "ffmpeg.exe"), (Join-Path $Bin "ffprobe.exe") $Dest
Copy-Item (Join-Path $Bin "*.dll") $Dest
Copy-Item (Join-Path $Tmp "$Name\LICENSE.txt") (Join-Path $Dest "LICENSE-FFmpeg.txt")
Remove-Item $Tmp -Recurse -Force
Write-Host "FFmpeg ready in $Dest"
