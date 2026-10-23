param(
    [string]$Dist = (Join-Path $PSScriptRoot '..\dist'),
    [string]$Publisher = 'CN=SignPath Foundation'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$version = (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version

$files = @(
    (Join-Path $Dist 'win-unpacked\Qingframe.exe'),
    (Join-Path $Dist "Qingframe-Setup-$version-x64.exe"),
    (Join-Path $Dist "Qingframe-Portable-$version-x64.exe")
)

foreach ($file in $files) {
    if (-not (Test-Path -LiteralPath $file)) {
        throw "Missing release binary: $file"
    }

    $signature = Get-AuthenticodeSignature -LiteralPath $file
    $subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '<none>' }
    Write-Host ("{0}: {1} | {2}" -f (Split-Path $file -Leaf), $signature.Status, $subject)

    if ($signature.Status -ne 'Valid') {
        throw "$file is not validly signed (status: $($signature.Status))"
    }
    if (-not $signature.SignerCertificate -or $signature.SignerCertificate.Subject -notmatch [regex]::Escape($Publisher)) {
        throw "$file is not signed by $Publisher"
    }
    if (-not $signature.TimeStamperCertificate) {
        throw "$file has no timestamp"
    }
}

$appUpdate = Join-Path $Dist 'win-unpacked\resources\app-update.yml'
if (-not (Test-Path -LiteralPath $appUpdate)) {
    throw "Missing app-update.yml: $appUpdate"
}
$appUpdateText = Get-Content -LiteralPath $appUpdate -Raw
if ($appUpdateText -notmatch 'publisherName:' -or $appUpdateText -notmatch 'SignPath Foundation') {
    throw "app-update.yml does not pin the SignPath Foundation publisher"
}

Write-Host 'All release binaries are validly signed by SignPath Foundation and timestamped.'
