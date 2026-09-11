$ErrorActionPreference = 'Stop'
$version = '15.2.0'
$asset = "ripgrep-$version-x86_64-pc-windows-msvc.zip"
$base = "https://github.com/BurntSushi/ripgrep/releases/download/$version"
$destination = Join-Path $PSScriptRoot '../src-tauri/resources/search'
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$archive = Join-Path $destination $asset
if (!(Test-Path -LiteralPath $archive)) { Invoke-WebRequest "$base/$asset" -OutFile $archive -UseBasicParsing }
$checksum = (Invoke-WebRequest "$base/$asset.sha256" -UseBasicParsing).Content
if ($checksum -is [byte[]]) { $checksum = [Text.Encoding]::UTF8.GetString($checksum) }
$expected = [regex]::Match($checksum, '(?i)\b[0-9a-f]{64}\b').Value
if (!$expected) { throw "Invalid upstream checksum: $checksum" }
if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne $expected) { throw 'ripgrep checksum mismatch' }
Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force
$extracted = Join-Path $destination "ripgrep-$version-x86_64-pc-windows-msvc"
Copy-Item -LiteralPath (Join-Path $extracted 'rg.exe') -Destination $destination
Copy-Item -LiteralPath (Join-Path $extracted 'COPYING'), (Join-Path $extracted 'LICENSE-MIT'), (Join-Path $extracted 'UNLICENSE') -Destination $destination
Set-Content -LiteralPath (Join-Path $destination 'VERSION.txt') -Value "$version`nSHA256 archive: $expected`n$base/$asset"
Remove-Item -LiteralPath $archive
Write-Output "Packaged ripgrep $version (verified SHA256)"
