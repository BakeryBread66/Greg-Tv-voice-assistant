# Builds Greg.exe from launcher\Greg.cs, and puts Greg in the Start menu and on
# the desktop.
#
# The compiler is the one inside Windows itself - .NET Framework 4's csc.exe,
# present on every Windows 10 and 11 - so nothing is downloaded, and no binary
# is ever committed to the repository. What you run is what you can read.
# Because it is built on this machine it also carries no "downloaded from the
# internet" mark, which is what makes SmartScreen stop an unsigned program.
#
# ASCII ONLY, for the reason setup-greg.ps1 gives: Windows PowerShell 5.1 reads
# a .ps1 without a byte order mark as ANSI.
#
# setup-greg.ps1 runs this. To run it on its own:
#   powershell -NoProfile -ExecutionPolicy Bypass -File launcher\build.ps1
# or double-click setup-greg.bat and pass -Launcher.

[CmdletBinding()]
param(
  # Build Greg.exe but leave the Start menu and the desktop alone.
  [switch]$NoShortcuts,
  # Say what would happen, change nothing.
  [switch]$DryRun
)

$ErrorActionPreference = "Continue"
$here = $PSScriptRoot
$root = Split-Path -Parent $here
$src  = Join-Path $here "Greg.cs"
$ico  = Join-Path $here "greg.ico"
$out  = Join-Path $root "Greg.exe"

function Say([string]$text, [string]$colour = "Gray") { Write-Host $text -ForegroundColor $colour }

if (-not (Test-Path $src)) { Say "  launcher\Greg.cs is missing - re-clone, or restore it." "Red"; exit 1 }

# Framework64 first; the 32-bit one builds the same AnyCPU program.
$csc = $null
foreach ($fw in @("Framework64", "Framework")) {
  $candidate = Join-Path $env:WINDIR "Microsoft.NET\$fw\v4.0.30319\csc.exe"
  if (Test-Path $candidate) { $csc = $candidate; break }
}
if (-not $csc) {
  Say "  No C# compiler found. It ships with the .NET Framework 4, which is part of" "Red"
  Say "  Windows 10 and 11 - if it is missing, turn it on in 'Windows features'." "Red"
  Say "  start-greg.bat still works in the meantime." "Yellow"
  exit 1
}

if ($DryRun) {
  Say "  would build $out" "Cyan"
  Say "    with $csc" "Cyan"
  if (-not $NoShortcuts) { Say "  would add Greg to the Start menu and the desktop" "Cyan" }
  exit 0
}

# A running Greg.exe holds its own file open, and the compiler's complaint about
# that ("cannot open for writing") names neither the program nor the fix.
$running = @(Get-Process -Name "Greg" -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $out })
if ($running.Count -gt 0) {
  Say "  Greg.exe is running. Stop Greg from his tray icon, then run this again." "Yellow"
  exit 1
}

$refs = @("System.Windows.Forms.dll", "System.Drawing.dll", "System.Web.Extensions.dll", "System.Management.dll")
$argv = @("/nologo", "/target:winexe", "/optimize+", "/out:$out")
if (Test-Path $ico) { $argv += "/win32icon:$ico" }
foreach ($r in $refs) { $argv += "/reference:$r" }
$argv += $src

Say "  building Greg.exe ..." "Cyan"
& $csc @argv
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $out)) {
  Say "  Greg.exe did NOT build. The compiler's reason is above." "Red"
  Say "  start-greg.bat still works in the meantime." "Yellow"
  exit 1
}
Say "  built $out" "Green"

if ($NoShortcuts) { exit 0 }

# WScript.Shell is the COM object Windows itself uses for .lnk files. It is not
# VBScript, which Windows is retiring; only the object shares the name.
try {
  $shell = New-Object -ComObject WScript.Shell
  foreach ($place in @("Programs", "Desktop")) {
    $dir = [Environment]::GetFolderPath($place)
    if (-not $dir -or -not (Test-Path $dir)) { continue }
    $lnk = $shell.CreateShortcut((Join-Path $dir "Greg.lnk"))
    $lnk.TargetPath = $out
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = "$out,0"
    $lnk.Description = "Greg, the voice assistant that runs on this PC"
    $lnk.Save()
  }
  Say "  Greg is in the Start menu and on your desktop." "Green"
} catch {
  Say "  Built, but the shortcuts could not be made: $($_.Exception.Message)" "Yellow"
  Say "  Greg.exe works from the Greg folder all the same." "Yellow"
}
exit 0
