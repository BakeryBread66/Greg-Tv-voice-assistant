# Builds dist\Greg-Setup.exe: Greg, his node_modules, the Node.js runtime and a
# built Greg.exe, in one file that installs without an administrator prompt.
# installer\Setup.cs says what it does on the other end.
#
# What goes in, and where it comes from:
#   Greg's files   git's own list of them (tracked, plus new files git is not
#                  told to ignore), so nothing .gitignore keeps private can be
#                  picked up - and installer\never-ship.txt is checked on top.
#                  Tests, benches, .github and this folder stay behind.
#   node_modules   a clean "npm ci" from package-lock.json, integrity-checked by
#                  npm, with install scripts off (none of Greg's need them).
#   Node.js        node.exe and its LICENSE from the official zip, pinned below
#                  to the SHA-256 nodejs.org publishes for it. Downloaded once
#                  into installer\cache, checked every build.
#   Greg.exe       built by launcher\build.ps1 from the Greg.cs being shipped.
#
# The compiler is the one inside Windows, as for Greg.exe, so the only things
# this downloads are Node's zip (once) and whatever npm does not have cached.
#
# ASCII ONLY, for the reason setup-greg.ps1 gives.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\build.ps1

[CmdletBinding()]
param(
  # Keep installer\work afterwards, to look at exactly what was packed.
  [switch]$KeepWork
)

# Not "Stop": see setup-greg.ps1. Every native command's exit code is checked.
$ErrorActionPreference = "Continue"

$NODE_VERSION = "24.14.1"
$NODE_SHA256  = "6e50ce5498c0cebc20fd39ab3ff5df836ed2f8a31aa093cecad8497cff126d70"
$NODE_ZIP     = "node-v$NODE_VERSION-win-x64.zip"
$NODE_URL     = "https://nodejs.org/dist/v$NODE_VERSION/$NODE_ZIP"

# Paths from Greg's folder that are never packed. They are not private - they
# are simply not Greg: they need the repository, a model or a developer.
$LEAVE_OUT = @("test/", "bench/", ".github/", "installer/", ".gitattributes", ".gitignore")

$here    = $PSScriptRoot
$root    = Split-Path -Parent $here
$cache   = Join-Path $here "cache"
$work    = Join-Path $here "work"
$payload = Join-Path $work "payload"
$dist    = Join-Path $root "dist"
$out     = Join-Path $dist "Greg-Setup.exe"

function Say([string]$text, [string]$colour = "Gray") { Write-Host $text -ForegroundColor $colour }
function Fail([string]$text) { Say "  $text" "Red"; exit 1 }

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

# ------------------------------------------------------------------ tools --

$csc = $null
foreach ($fw in @("Framework64", "Framework")) {
  $candidate = Join-Path $env:WINDIR "Microsoft.NET\$fw\v4.0.30319\csc.exe"
  if (Test-Path $candidate) { $csc = $candidate; break }
}
if (-not $csc) { Fail "No C# compiler found (.NET Framework 4's csc.exe)." }
if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git is needed: the list of Greg's files is git's." }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { Fail "npm is needed, to install node_modules from package-lock.json." }

# -------------------------------------------------------------- the files --

# Raw UTF-8 from git, NUL-separated, so no file name is quoted or mangled.
$prevEncoding = [Console]::OutputEncoding
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$listed = (& git -C $root ls-files -z --cached --others --exclude-standard) -join ""
$gitCode = $LASTEXITCODE
$commit = (& git -C $root rev-parse --short HEAD)
$dirty = (& git -C $root status --porcelain)
[Console]::OutputEncoding = $prevEncoding
if ($gitCode -ne 0) { Fail "git could not list Greg's files." }

$files = @()
foreach ($f in ($listed -split [char]0)) {
  if (-not $f) { continue }
  $skip = $false
  foreach ($p in $LEAVE_OUT) { if ($f -eq $p -or ($p.EndsWith("/") -and $f.StartsWith($p))) { $skip = $true; break } }
  if ($skip) { continue }
  # Deleted from the working tree but not yet from git: it is not shipping.
  if (-not (Test-Path -LiteralPath (Join-Path $root $f))) { continue }
  $files += $f
}

$neverShip = @(Get-Content (Join-Path $here "never-ship.txt") | ForEach-Object { $_.Trim() } | Where-Object { $_ -and -not $_.StartsWith("#") })
function Forbidden([string]$relative) {
  $r = $relative.Replace("\", "/")
  foreach ($p in $neverShip) {
    if ($r -eq $p) { return $p }
    if ($p.EndsWith("/") -and $r.StartsWith($p)) { return $p }
  }
  return $null
}

$package = (Get-Content (Join-Path $root "package.json") -Raw | ConvertFrom-Json)
$version = $package.version
if ($dirty) {
  $commit = "$commit+changes"
  Say "  Building from the working tree, which has changes not yet committed." "Yellow"
  Say "  The installer will say $commit, so nobody mistakes it for the commit." "Yellow"
}

Say "  Greg $version ($commit): $($files.Count) files" "Cyan"

if (Test-Path $work) { Remove-Item -Recurse -Force $work }
New-Item -ItemType Directory -Force $payload | Out-Null
foreach ($f in $files) {
  $bad = Forbidden $f
  if ($bad) { Fail "$f matches '$bad' in never-ship.txt. It must not be tracked by git; nothing was built." }
  $to = Join-Path $payload $f
  New-Item -ItemType Directory -Force (Split-Path -Parent $to) | Out-Null
  Copy-Item -LiteralPath (Join-Path $root $f) -Destination $to
}

# ------------------------------------------------------------ node_modules --

Say "  npm ci (from package-lock.json) ..." "Cyan"
Push-Location $payload
& npm.cmd ci --omit=dev --ignore-scripts --no-audit --no-fund --prefer-offline --loglevel=error
$npmCode = $LASTEXITCODE
Pop-Location
if ($npmCode -ne 0) { Fail "npm ci failed (exit $npmCode). Its reason is above." }

# ------------------------------------------------------------------- Node --

New-Item -ItemType Directory -Force $cache | Out-Null
$zip = Join-Path $cache $NODE_ZIP
if (-not (Test-Path $zip)) {
  Say "  downloading $NODE_ZIP (about 36 MB) from nodejs.org ..." "Cyan"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $part = "$zip.part"
  try {
    (New-Object Net.WebClient).DownloadFile($NODE_URL, $part)
  } catch {
    Fail "Could not download $NODE_URL : $($_.Exception.Message)"
  }
  Move-Item -Force $part $zip
}
$hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
if ($hash -ne $NODE_SHA256) {
  Fail "$zip is not the file nodejs.org published (SHA-256 $hash). Delete it and build again."
}

$runtime = Join-Path $payload "runtime"
New-Item -ItemType Directory -Force $runtime | Out-Null
$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  foreach ($name in @("node.exe", "LICENSE")) {
    $entry = $archive.GetEntry("node-v$NODE_VERSION-win-x64/$name")
    if (-not $entry) { Fail "$NODE_ZIP has no $name in it." }
    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $runtime $name), $true)
  }
} finally {
  $archive.Dispose()
}

# --------------------------------------------------------------- Greg.exe --

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $payload "launcher\build.ps1") -NoShortcuts
if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $payload "Greg.exe"))) { Fail "Greg.exe did not build." }

# -------------------------------------------------------------- installer --

$icon = Join-Path $root "launcher\greg.ico"
$refs = @("System.Windows.Forms.dll", "System.Drawing.dll", "System.Management.dll", "System.IO.Compression.dll")

function Compile([string]$target, [long]$payloadBytes, [string]$payloadZip) {
  # The numbers Setup.cs needs to know before it opens its payload. Every
  # value is ASCII by construction: a version, a hash, a number, two URLs.
  $info = @(
    "namespace GregSetup {",
    "  static class BuildInfo {",
    "    public const string Version = `"$version`";",
    "    public const string Commit = `"$commit`";",
    "    public const string Label = `"$version ($commit)`";",
    "    public const string NodeVersion = `"$NODE_VERSION`";",
    "    public const long PayloadBytes = $payloadBytes;",
    "    public const string Publisher = `"BakeryBread66`";",
    "    public const string Homepage = `"https://github.com/BakeryBread66/Greg-Tv-voice-assistant`";",
    "  }",
    "}"
  )
  $infoFile = Join-Path $work "BuildInfo.cs"
  Set-Content -Path $infoFile -Value $info -Encoding Ascii

  $argv = @("/nologo", "/target:winexe", "/optimize+", "/out:$target", "/win32icon:$icon", "/resource:$icon,greg.ico")
  foreach ($r in $refs) { $argv += "/reference:$r" }
  if ($payloadZip) { $argv += "/resource:$payloadZip,payload.zip" }
  $argv += (Join-Path $here "Setup.cs")
  $argv += $infoFile
  & $csc @argv
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path $target)) { Fail "$(Split-Path -Leaf $target) did not build. The compiler's reason is above." }
}

# The uninstaller first: it is part of the payload the installer carries.
Compile (Join-Path $payload "uninstall.exe") 0 $null

# The last word on what ships: every file actually in the payload, including
# what npm and the builds added.
$bytes = 0
$count = 0
foreach ($item in (Get-ChildItem -LiteralPath $payload -Recurse -Force -File)) {
  $relative = $item.FullName.Substring($payload.Length + 1)
  $bad = Forbidden $relative
  if ($bad) { Fail "$relative matches '$bad' in never-ship.txt. Nothing was built." }
  $bytes += $item.Length
  $count++
}

Say "  packing $count files ($([math]::Round($bytes / 1MB)) MB) ..." "Cyan"
$packed = Join-Path $work "payload.zip"
[System.IO.Compression.ZipFile]::CreateFromDirectory($payload, $packed, [System.IO.Compression.CompressionLevel]::Optimal, $false)

New-Item -ItemType Directory -Force $dist | Out-Null
if (Test-Path $out) { Remove-Item -Force $out }
Compile $out $bytes $packed

$sha = (Get-FileHash -Algorithm SHA256 $out).Hash.ToLowerInvariant()
Set-Content -Path "$out.sha256" -Value "$sha  Greg-Setup.exe" -Encoding Ascii
if (-not $KeepWork) { Remove-Item -Recurse -Force $work }

Say ""
Say "  built $out" "Green"
Say "    Greg $version ($commit), Node $NODE_VERSION" "Gray"
Say "    $([math]::Round((Get-Item $out).Length / 1MB)) MB, installs $([math]::Round($bytes / 1MB)) MB" "Gray"
Say "    SHA-256 $sha" "Gray"
exit 0
