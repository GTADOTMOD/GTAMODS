# Builds RUGR Setup: RUGR's own files, built from this repo, zipped into one exe with a release.json
# that lists each file's size and SHA-256.
#
#   powershell -ExecutionPolicy Bypass -File installer\build-release.ps1 [-Work <folder>] [-Companion <pumpv-companion.exe>]
#
# -Work is where it builds, outside cloud-synced folders (such as OneDrive), so node_modules, bin and obj stay out of them.
# -Companion reuses a pumpv-companion.exe already built from the same source, instead of building it again.
#
# It needs Node.js 20 or newer, the .NET SDK and mod\lib\iFruit Jailbreak.dll: the official 6.0 release from
# gta5-mods.com. RUGR compiles against it, and Setup carries it for players who don't have it yet. Script Hook V
# and ScriptHookVDotNet aren't in here: Setup downloads them from their own pages while it installs. The result
# is installer\dist\RUGR-Setup-<version>.exe and a .sha256 file beside it.
param(
    [string]$Work = (Join-Path $env:TEMP 'rugr-release'),
    [string]$Companion = ''
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$version = (Get-Content -Raw (Join-Path $repo 'companion\package.json') | ConvertFrom-Json).version
$ifruit = Join-Path $repo 'mod\lib\iFruit Jailbreak.dll'
if (-not (Test-Path -LiteralPath $ifruit)) { throw "Put iFruit Jailbreak.dll in mod\lib first (see mod\lib\README.md)." }
# Only the author's own build goes out: iFruit Jailbreak 6.0, scripts\iFruit Jailbreak.dll from its gta5-mods.com zip.
$ifruitVersion = '6.0'
$ifruitSha = 'da5d6c39941feee66f7f23f20c44a9868e514ce8b39538879756b91c28b93e43'
if ((Get-FileHash -LiteralPath $ifruit -Algorithm SHA256).Hash.ToLowerInvariant() -ne $ifruitSha) {
    throw "mod\lib\iFruit Jailbreak.dll isn't the official iFruit Jailbreak $ifruitVersion. Put the one from its gta5-mods.com zip there."
}

function Step($text) { Write-Host "== $text" -ForegroundColor Magenta }
function Run($exe, [string[]]$arguments, $where) {
    Push-Location $where
    try {
        & $exe @arguments
        if ($LASTEXITCODE -ne 0) { throw "$exe $($arguments -join ' ') failed ($LASTEXITCODE)" }
    } finally { Pop-Location }
}

Step "Copying the sources to $Work"
New-Item -ItemType Directory -Force $Work | Out-Null
robocopy (Join-Path $repo 'mod') (Join-Path $Work 'mod') /MIR /XD bin obj /NFL /NDL /NJH /NJS /NP | Out-Null
robocopy (Join-Path $repo 'companion') (Join-Path $Work 'companion') /MIR /XD node_modules dist dist-exe /NFL /NDL /NJH /NJS /NP | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

Step "Building the mod (PumpV.dll)"
Run dotnet @('build', 'PumpV.csproj', '-c', 'Release', '-nologo', '-v', 'q') (Join-Path $Work 'mod')

Step "Building the phone window (PumpPhone)"
Run dotnet @('build', 'PumpPhone.csproj', '-c', 'Release', '-nologo', '-v', 'q') (Join-Path $Work 'mod\phone')

if ($Companion) {
    Step "Using the companion at $Companion"
} else {
    Step "Building the companion (pumpv-companion.exe)"
    Run npm @('ci', '--no-audit', '--no-fund') (Join-Path $Work 'companion')
    Run npm @('run', 'package') (Join-Path $Work 'companion')
    $Companion = Join-Path $Work 'companion\dist-exe\pumpv-companion.exe'
}

Step "Collecting RUGR's files"
$mod = Join-Path $Work 'mod\bin\Release\net48'
$phone = Join-Path $Work 'mod\phone\bin\Release\net48'
# Where each file goes, from the GTA V folder. Keep = the player's own copy wins (their settings).
$files = [System.Collections.Generic.List[object]]::new()
$files.Add(@{ Path = 'scripts/PumpV.dll'; From = Join-Path $mod 'PumpV.dll' })
$files.Add(@{ Path = 'scripts/PumpV.ini'; From = Join-Path $repo 'mod\PumpV.ini'; Keep = $true })
$files.Add(@{ Path = 'scripts/PumpV/pumpv-companion.exe'; From = $Companion })
foreach ($name in 'PumpPhone.exe', 'PumpPhone.exe.config', 'phone.html', 'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll') {
    $files.Add(@{ Path = "PumpPhone/$name"; From = Join-Path $phone $name })
}
Get-ChildItem -File (Join-Path $phone 'art') | Sort-Object Name | ForEach-Object {
    $files.Add(@{ Path = "PumpPhone/art/$($_.Name)"; From = $_.FullName })
}

Step "Zipping them with release.json"
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$zipPath = Join-Path $Work 'payload.zip'
Remove-Item -LiteralPath $zipPath -ErrorAction SilentlyContinue
$release = [ordered]@{ product = 'RUGR'; version = $version; files = @() }
$zip = [System.IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
    foreach ($f in $files) {
        if (-not (Test-Path -LiteralPath $f.From)) { throw "Missing $($f.From)" }
        [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $f.From, "files/$($f.Path)", [System.IO.Compression.CompressionLevel]::Optimal)
        $entry = [ordered]@{
            path = $f.Path
            sha256 = (Get-FileHash -LiteralPath $f.From -Algorithm SHA256).Hash.ToLowerInvariant()
            size = (Get-Item -LiteralPath $f.From).Length
        }
        if ($f.Keep) { $entry.keep = $true }
        $release.files += $entry
    }
    [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $ifruit, 'deps/iFruit Jailbreak.dll', [System.IO.Compression.CompressionLevel]::Optimal)
    $release.ifruit = [ordered]@{
        path = 'deps/iFruit Jailbreak.dll'
        version = $ifruitVersion
        sha256 = $ifruitSha
        size = (Get-Item -LiteralPath $ifruit).Length
    }
    $json = $release | ConvertTo-Json -Depth 4
    $entry = $zip.CreateEntry('release.json')
    $writer = New-Object System.IO.StreamWriter($entry.Open(), (New-Object System.Text.UTF8Encoding($false)))
    $writer.Write($json)
    $writer.Dispose()
} finally { $zip.Dispose() }

Step "Building RUGR Setup $version"
Run dotnet @('build', (Join-Path $PSScriptRoot 'RugrSetup.csproj'), '-c', 'Release', '-nologo', '-v', 'q', "-p:PayloadZip=$zipPath", "-p:Version=$version", "-p:OutDir=$(Join-Path $Work 'setup')\") $PSScriptRoot

$dist = Join-Path $PSScriptRoot 'dist'
New-Item -ItemType Directory -Force $dist | Out-Null
$out = Join-Path $dist "RUGR-Setup-$version.exe"
Copy-Item -LiteralPath (Join-Path $Work 'setup\RUGR-Setup.exe') -Destination $out -Force
$hash = (Get-FileHash -LiteralPath $out -Algorithm SHA256).Hash.ToLowerInvariant()
Set-Content -LiteralPath "$out.sha256" -Value "$hash  RUGR-Setup-$version.exe" -Encoding ascii
$size = [math]::Round((Get-Item -LiteralPath $out).Length / 1MB, 1)
Write-Host ""
Write-Host "RUGR Setup $version  ->  $out  ($size MB)"
Write-Host "SHA-256  $hash"
