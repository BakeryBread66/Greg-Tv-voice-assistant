# Checks a built dist\Greg-Setup.exe end to end, in a scratch folder: install,
# the bundled Node loading Greg's native module, an update over a user's files,
# the refusals, and both kinds of uninstall. No shortcuts, no Settings > Apps
# entry, nothing outside the scratch folder - so it is safe to run on a PC that
# has Greg installed for real.
#
# It does not start Greg: a started Greg reaches for Ollama, the network and,
# on a PC with Python, his old engines. What it cannot check is the part a
# person sees - the windows, the shortcuts, Settings > Apps - and that is
# handed over, not claimed.
#
# ASCII ONLY, for the reason setup-greg.ps1 gives.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File installer\check.ps1

[CmdletBinding()]
param(
  # Defaults to dist\Greg-Setup.exe ($PSScriptRoot is empty in a param default on 5.1).
  [string]$Setup = ""
)

$ErrorActionPreference = "Continue"
if (-not $Setup) { $Setup = Join-Path (Split-Path -Parent $PSScriptRoot) "dist\Greg-Setup.exe" }
if (-not (Test-Path $Setup)) { Write-Host "  No $Setup - run installer\build.ps1 first." -ForegroundColor Red; exit 1 }

$scratch = Join-Path ([IO.Path]::GetTempPath()) ("greg-setup-check-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
$dir = Join-Path $scratch "Greg"
$log = Join-Path $scratch "setup.log"
New-Item -ItemType Directory -Force $scratch | Out-Null
$script:failed = 0

function Check([string]$what, [bool]$ok, [string]$detail = "") {
  if ($ok) { Write-Host "  ok    $what" -ForegroundColor Green }
  else { Write-Host "  FAIL  $what $detail" -ForegroundColor Red; $script:failed++ }
}

function Run([string]$exe, [string[]]$argv) {
  # Start-Process joins its arguments with spaces and quotes none of them.
  $quoted = @($argv | ForEach-Object { if ($_ -match " ") { '"' + $_ + '"' } else { $_ } })
  $p = Start-Process -FilePath $exe -ArgumentList $quoted -Wait -PassThru
  return $p.ExitCode
}

function Install() { return (Run $Setup @("/quiet", "/dir=$dir", "/noshortcuts", "/noapps", "/log=$log")) }
function Uninstall([bool]$all) {
  $argv = @("/quiet", "/log=$log")
  if ($all) { $argv += "/deletedata" }
  $code = Run (Join-Path $dir "uninstall.exe") $argv
  # uninstall.exe removes itself a moment after it exits.
  for ($i = 0; $i -lt 40 -and (Test-Path (Join-Path $dir "uninstall.exe")); $i++) { Start-Sleep -Milliseconds 250 }
  Start-Sleep -Milliseconds 500
  return $code
}

function Hashes() {
  $h = @{}
  foreach ($f in $userFiles) { $h[$f] = (Get-FileHash -Algorithm SHA256 (Join-Path $dir $f)).Hash }
  return $h
}

Write-Host "  checking $Setup" -ForegroundColor Cyan
Write-Host "  in $scratch" -ForegroundColor DarkGray

# ------------------------------------------------------------------ install --

Check "installs (exit 0)" ((Install) -eq 0)
foreach ($f in @("server.js", "Greg.exe", "uninstall.exe", "runtime\node.exe", "runtime\LICENSE", "node_modules\sherpa-onnx-node\package.json", ".greg-install")) {
  Check "has $f" (Test-Path (Join-Path $dir $f))
}
foreach ($f in @("config.json", "memory.json", ".env", "test", "bench", "installer", "notes", "CLAUDE.md")) {
  Check "does not have $f" (-not (Test-Path (Join-Path $dir $f)))
}

# The bundled Node, loading the two modules that are not plain JavaScript files
# Greg wrote: sherpa-onnx's native addon, and the Claude SDK.
$node = Join-Path $dir "runtime\node.exe"
Push-Location $dir
$smoke = & $node --input-type=module -e "import { createRequire } from 'node:module'; const r = createRequire(process.cwd() + '/'); r('sherpa-onnx-node'); await import('@anthropic-ai/sdk'); console.log('loaded ' + process.version);" 2>&1
Pop-Location
Check "bundled Node loads sherpa-onnx and the Claude SDK" ($LASTEXITCODE -eq 0) "$smoke"

# ------------------------------------------------------------------- update --

# What Greg makes as he runs, and what a person adds.
$userFiles = @("config.json", "memory.json", ".env", "engines\models\fake.bin", "voices\fake.onnx", "channels\mine\channel.json")
foreach ($f in $userFiles) {
  $path = Join-Path $dir $f
  New-Item -ItemType Directory -Force (Split-Path -Parent $path) | Out-Null
  Set-Content -Path $path -Value ("user data " + [Guid]::NewGuid()) -Encoding Ascii
}
$before = Hashes

# A file an older Greg had and this one does not.
$stale = Join-Path $dir "lib\retired\old.js"
New-Item -ItemType Directory -Force (Split-Path -Parent $stale) | Out-Null
Set-Content -Path $stale -Value "old" -Encoding Ascii
Add-Content -Path (Join-Path $dir ".greg-install") -Value "file=lib\retired\old.js" -Encoding Ascii

Check "updates over itself (exit 0)" ((Install) -eq 0)
Check "update removed the file the new version dropped" (-not (Test-Path $stale))
Check "update removed the folder that left empty" (-not (Test-Path (Split-Path -Parent $stale)))
$after = Hashes
foreach ($f in $userFiles) { Check "update kept $f unchanged" ($before[$f] -eq $after[$f]) }

# ----------------------------------------------------------------- refusals --

$busy = Start-Process -FilePath $node -ArgumentList @("-e", "setTimeout(()=>{},60000)") -PassThru -WindowStyle Hidden
Start-Sleep -Milliseconds 800
Check "refuses to update while Greg's Node runs (exit 2)" ((Install) -eq 2)
Check "refuses to uninstall while Greg's Node runs (exit 2)" ((Run (Join-Path $dir "uninstall.exe") @("/quiet", "/log=$log")) -eq 2)
Stop-Process -Id $busy.Id -Force
Start-Sleep -Milliseconds 500

$foreign = Join-Path $scratch "someone-elses"
New-Item -ItemType Directory -Force $foreign | Out-Null
Set-Content -Path (Join-Path $foreign "keep.txt") -Value "not Greg's" -Encoding Ascii
Check "refuses a folder with someone else's files (exit 2)" ((Run $Setup @("/quiet", "/dir=$foreign", "/noshortcuts", "/noapps", "/log=$log")) -eq 2)
Check "and left it exactly as it was" (@(Get-ChildItem -Force $foreign).Count -eq 1)
$root = [IO.Path]::GetPathRoot($scratch)
Check "refuses a whole drive (exit 2)" ((Run $Setup @("/quiet", "/dir=$root", "/noshortcuts", "/noapps", "/log=$log")) -eq 2)

# ---------------------------------------------------------------- uninstall --

Check "uninstalls, keeping the user's files (exit 0)" ((Uninstall $false) -eq 0)
$left = @(Get-ChildItem -Force -Recurse -File $dir | ForEach-Object { $_.FullName.Substring($dir.Length + 1) } | Sort-Object)
$expected = @($userFiles + ".greg-install" | Sort-Object)
Check "only the user's files are left, and a note saying so" ((Compare-Object $left $expected) -eq $null) ("left: " + ($left -join ", "))
$kept = Hashes
foreach ($f in $userFiles) { Check "uninstall kept $f unchanged" ($before[$f] -eq $kept[$f]) }

Check "installs again into the folder it kept (exit 0)" ((Install) -eq 0)
Check "and the user's files are still there" (Test-Path (Join-Path $dir "memory.json"))

Check "uninstalls with /deletedata (exit 0)" ((Uninstall $true) -eq 0)
Check "and the folder is gone" (-not (Test-Path $dir))

# -------------------------------------------------------------------- done --

Write-Host ""
if ($script:failed -eq 0) {
  Write-Host "  All checks passed." -ForegroundColor Green
  Remove-Item -Recurse -Force $scratch
} else {
  Write-Host "  $($script:failed) check(s) FAILED. Scratch folder and log kept: $scratch" -ForegroundColor Red
  if (Test-Path $log) { Get-Content $log | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
}
Write-Host "  Not checked here, for a person to see: the install and uninstall windows," -ForegroundColor DarkGray
Write-Host "  the Start menu and desktop shortcuts, Settings > Apps, and Greg starting." -ForegroundColor DarkGray
exit $script:failed
