# Builds the Microsoft Store package (MSIX) for PiFiles from an already-built pifiles.exe.
#
# The Store re-signs the package with Microsoft's certificate, so it is left unsigned here.
# The identity values come from Partner Center > your app > Product management > Product identity.
#
#   powershell -ExecutionPolicy Bypass -File scripts/package-msix.ps1 `
#     -Version 0.2.0 -IdentityName "12345SolanumTech.PiFiles" `
#     -Publisher "CN=XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX" -PublisherDisplayName "Solanum Tech"
#
# Build the exe first with the Store distribution so the in-app updater stands down:
#   $env:PIFILES_DISTRIBUTION = "msstore"; npx tauri build --no-bundle
param(
  [Parameter(Mandatory)][string]$Version,               # 1.2.3 (a pre-release suffix is dropped)
  [Parameter(Mandatory)][string]$IdentityName,
  [Parameter(Mandatory)][string]$Publisher,
  [Parameter(Mandatory)][string]$PublisherDisplayName,
  [string]$Exe = "src-tauri/target/release/pifiles.exe",
  [string]$FfmpegDir = "src-tauri/ffmpeg",
  [string]$Icons = "src-tauri/icons",
  [string]$OutDir = "src-tauri/target/release/msix"
)
$ErrorActionPreference = "Stop"

# MSIX versions are four numbers, and the Store requires the last one to be 0.
$core = ($Version -replace '^v', '') -replace '[-+].*$', ''
if ($core -notmatch '^\d+\.\d+\.\d+$') { throw "Version '$Version' isn't X.Y.Z" }
$msixVersion = "$core.0"

foreach ($p in @($Exe, $FfmpegDir, $Icons)) { if (-not (Test-Path $p)) { throw "Not found: $p" } }
if (-not (Test-Path (Join-Path $FfmpegDir "ffmpeg.exe"))) { throw "FFmpeg missing in $FfmpegDir (run scripts/fetch-ffmpeg.ps1)" }

# makeappx.exe from the newest installed Windows SDK.
$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" -ErrorAction SilentlyContinue |
  Sort-Object { [version]($_.Directory.Parent.Name) } -Descending | Select-Object -First 1
if (-not $makeappx) { throw "makeappx.exe not found (install the Windows 10/11 SDK)" }

# Layout: the app, FFmpeg next to it (where PiFiles looks for it), logos, manifest.
$layout = Join-Path $OutDir "layout"
if (Test-Path $layout) { Remove-Item $layout -Recurse -Force }
New-Item -ItemType Directory -Force (Join-Path $layout "Assets"), (Join-Path $layout "ffmpeg") | Out-Null
Copy-Item $Exe (Join-Path $layout "pifiles.exe")
Copy-Item (Join-Path $FfmpegDir "*") (Join-Path $layout "ffmpeg") -Recurse
foreach ($logo in "StoreLogo.png", "Square44x44Logo.png", "Square150x150Logo.png", "Square71x71Logo.png") {
  Copy-Item (Join-Path $Icons $logo) (Join-Path $layout "Assets\$logo")
}

$x = { param($s) [Security.SecurityElement]::Escape($s) }
$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<Package
  xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  xmlns:uap="http://schemas.microsoft.com/appx/manifest/uap/windows10"
  xmlns:rescap="http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  IgnorableNamespaces="uap rescap">
  <Identity Name="$(& $x $IdentityName)" Publisher="$(& $x $Publisher)" Version="$msixVersion" ProcessorArchitecture="x64" />
  <Properties>
    <DisplayName>PiFiles</DisplayName>
    <PublisherDisplayName>$(& $x $PublisherDisplayName)</PublisherDisplayName>
    <Logo>Assets\StoreLogo.png</Logo>
  </Properties>
  <Dependencies>
    <TargetDeviceFamily Name="Windows.Desktop" MinVersion="10.0.17763.0" MaxVersionTested="10.0.26100.0" />
  </Dependencies>
  <Resources>
    <Resource Language="en-us" />
  </Resources>
  <Applications>
    <Application Id="PiFiles" Executable="pifiles.exe" EntryPoint="Windows.FullTrustApplication">
      <uap:VisualElements DisplayName="PiFiles" Description="Fast, private file manager with instant search and media management"
        BackgroundColor="transparent" Square150x150Logo="Assets\Square150x150Logo.png" Square44x44Logo="Assets\Square44x44Logo.png">
        <uap:DefaultTile Square71x71Logo="Assets\Square71x71Logo.png" />
      </uap:VisualElements>
    </Application>
  </Applications>
  <Capabilities>
    <!-- A desktop file manager runs with full trust (whole file system, shell integration). -->
    <rescap:Capability Name="runFullTrust" />
  </Capabilities>
</Package>
"@
Set-Content -Path (Join-Path $layout "AppxManifest.xml") -Value $manifest -Encoding UTF8

$out = Join-Path $OutDir "PiFiles_${core}_x64.msix"
& $makeappx.FullName pack /d $layout /p $out /o /h SHA256 | Out-Host
if ($LASTEXITCODE -ne 0) { throw "makeappx failed ($LASTEXITCODE)" }
Write-Host "MSIX: $out (version $msixVersion, unsigned - the Store signs it)"
