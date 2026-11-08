# Downloads the pinned mpv build PiFiles bundles into src-tauri/mpv with modern uosc UI.
$ErrorActionPreference = "Stop"

$Tag    = "2026-11-05"
$Name   = "mpv-x86_64-20261105-git-3138fc8eea.7z"
$Sha256 = "eeecf2e913b8936b06993e1e2fde6a5790247ac057c16306b82ff9f92d25ccfa"
$Url    = "https://github.com/zhongfly/mpv-winbuild/releases/download/$Tag/$Name"

$Root = Split-Path -Parent $PSScriptRoot
$Dest = Join-Path $Root "src-tauri\mpv"
$Tmp  = Join-Path ([IO.Path]::GetTempPath()) "pifiles-mpv"

New-Item -ItemType Directory -Force $Dest | Out-Null

if (-not (Test-Path (Join-Path $Dest "mpv.exe"))) {
    New-Item -ItemType Directory -Force $Tmp | Out-Null
    $Archive = Join-Path $Tmp $Name
    Write-Host "Downloading $Url (32 MB)..."
    Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing

    $Actual = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLower()
    if ($Actual -ne $Sha256) { throw "Checksum mismatch: expected $Sha256, got $Actual" }

    tar -xf $Archive -C $Dest mpv.exe mpv.com
    Remove-Item $Tmp -Recurse -Force
}

# Setup modern UI (uosc + thumbfast)
$PortConfig = Join-Path $Dest "portable_config"
$ScriptsDir = Join-Path $PortConfig "scripts"
$ScriptOpts = Join-Path $PortConfig "script-opts"
New-Item -ItemType Directory -Force $ScriptsDir | Out-Null
New-Item -ItemType Directory -Force $ScriptOpts | Out-Null

if (-not (Test-Path (Join-Path $ScriptsDir "uosc\main.lua"))) {
    Write-Host "Downloading uosc modern UI (5.13.0)..."
    $UoscZip = Join-Path ([IO.Path]::GetTempPath()) "uosc.zip"
    Invoke-WebRequest -Uri "https://github.com/tomasklaen/uosc/releases/download/5.13.0/uosc.zip" -OutFile $UoscZip -UseBasicParsing
    tar -xf $UoscZip -C $PortConfig
    Remove-Item $UoscZip -Force
}

if (-not (Test-Path (Join-Path $ScriptsDir "thumbfast.lua"))) {
    Write-Host "Downloading thumbfast..."
    Invoke-WebRequest -Uri "https://raw.githubusercontent.com/po5/thumbfast/master/thumbfast.lua" -OutFile (Join-Path $ScriptsDir "thumbfast.lua") -UseBasicParsing
}
Write-Host "mpv with modern UI ready in $Dest"
