# Installs the latest streamFree release on Windows.
#
#   irm https://raw.githubusercontent.com/iamvinbas/streamFree/main/install.ps1 | iex
#
# Installs into %LOCALAPPDATA%\streamFree and adds it to your user PATH.
# The download is checked against the release's SHA-256 checksum.
$ErrorActionPreference = 'Stop'

$repo = 'iamvinbas/streamFree'
$asset = 'streamfree-x86_64-pc-windows-msvc.zip'
$base = "https://github.com/$repo/releases/latest/download"
$dir = Join-Path $env:LOCALAPPDATA 'streamFree'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("streamfree-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $tmp | Out-Null

try {
  Write-Host "Downloading $asset ..."
  Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $tmp $asset)
  Invoke-WebRequest "$base/$asset.sha256" -OutFile (Join-Path $tmp "$asset.sha256")
  $expected = (Get-Content (Join-Path $tmp "$asset.sha256")).Split(' ')[0].Trim().ToLower()
  $actual = (Get-FileHash (Join-Path $tmp $asset) -Algorithm SHA256).Hash.ToLower()
  if ($expected -ne $actual) { throw "checksum mismatch (expected $expected, got $actual)" }

  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Expand-Archive (Join-Path $tmp $asset) -DestinationPath $dir -Force

  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -eq $dir })) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$dir", 'User')
    Write-Host "Added $dir to your PATH (open a new terminal to use it)."
  }
  Write-Host "Installed streamFree to $dir\streamfree.exe"
  Write-Host 'Run: streamfree'
} finally {
  Remove-Item -Recurse -Force $tmp
}
