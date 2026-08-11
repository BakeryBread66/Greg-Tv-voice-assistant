# Greg setup: installs the pieces Greg can use, and says honestly which ones it
# managed.
#
# The design follows the boot screen rather than a normal installer. Greg
# degrades on purpose - with nothing but Node he still runs, on a cloud voice and
# the browser's own speech recognition, and the POST screen says so in amber. So
# this script is not all-or-nothing. It walks you up as many tiers as you ask for
# and then reports what is actually true, including the parts that failed. An
# installer that claims success it did not have is this project's oldest failure
# wearing a lab coat.
#
# ASCII ONLY, and that is load-bearing. Windows PowerShell 5.1 reads a .ps1 as
# ANSI unless it finds a byte order mark, so a UTF-8 dash in a COMMENT arrives as
# mojibake and derails the parser many lines later - the first version of
# speak-sapi.ps1 failed with "Missing closing '}'" pointing at a block that was
# perfectly balanced. Do not paste a typographic dash or a curly quote in here.
#
# Run it with -DryRun to see the plan without installing anything. That is how
# this was tested, and it is the flag to reach for when something has gone wrong.

[CmdletBinding()]
param(
  # Detect and print the plan, change nothing. Safe to run at any time.
  [switch]$DryRun,
  # Take every tier without asking, including the big model downloads.
  [switch]$All,
  # Node only. Greg runs, on the cloud voice and browser speech recognition.
  [switch]$Minimal,
  # The cloned voice. Off by default even under -All: it is about 6 GB and it
  # cannot finish without a voice recording you supply yourself.
  [switch]$Clone
)

# Deliberately NOT "Stop". Windows PowerShell 5.1 wraps a native executable's
# stderr in an ErrorRecord, so under Stop a probe as ordinary as `py -3.12
# --version` on a machine without 3.12 becomes a TERMINATING error and takes the
# whole script down before it has printed anything. That is not a hypothetical:
# it is what this script did on the machine it was written on, which is exactly
# the machine whose missing 3.12 it was written to detect. Exit codes are checked
# explicitly everywhere instead.
$ErrorActionPreference = "Continue"
Set-Location -Path $PSScriptRoot

# Run a native command purely for its exit code, with both streams discarded.
# Wrapped in one place so no probe has to remember the rule above.
function Quiet([string]$exe, [string[]]$argv) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "SilentlyContinue"
  try {
    & $exe @argv 2>$null | Out-Null
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

$CHAT_MODEL   = "gemma4:e4b"
$VISION_MODEL = "qwen2.5vl:7b"
$MIN_NODE     = 20

# What each tier is worth, in the words a person deciding would want. Sizes are
# downloads, because that is the thing somebody on a metered connection is
# actually choosing about.
$TIERS = @(
  @{ Key = "node";  Name = "Node.js";        Size = "30 MB";  Gives = "Greg runs at all" }
  @{ Key = "brain"; Name = "Ollama + $CHAT_MODEL"; Size = "9.6 GB"; Gives = "a real brain on your own machine" }
  @{ Key = "ears";  Name = "Python + faster-whisper"; Size = "200 MB"; Gives = "he hears you offline" }
  @{ Key = "voice"; Name = "piper-tts";      Size = "100 MB"; Gives = "he speaks offline" }
  @{ Key = "eyes";  Name = $VISION_MODEL;    Size = "5.9 GB"; Gives = "he can look at your screen" }
)

# ---------------------------------------------------------------- reporting --

$script:Results = @()

function Say([string]$text, [string]$colour = "Gray") {
  Write-Host $text -ForegroundColor $colour
}

function Rule() {
  Say ("-" * 64) "DarkGray"
}

# Every outcome goes through here, so the summary at the end cannot disagree with
# what happened. "skipped" and "failed" are different facts and are never merged.
function Record([string]$key, [string]$state, [string]$detail) {
  $script:Results += [pscustomobject]@{ Key = $key; State = $state; Detail = $detail }
}

# ---------------------------------------------------------------- detection --

function Have([string]$name) {
  $cmd = Get-Command $name -ErrorAction SilentlyContinue
  return ($null -ne $cmd)
}

function NodeMajor() {
  if (-not (Have "node")) { return 0 }
  $raw = & node --version
  if ($raw -match "^v(\d+)") { return [int]$Matches[1] }
  return 0
}

# A module is present if importing it exits clean. Output goes to $null rather
# than through 2>&1, which in 5.1 wraps native stderr in an ErrorRecord and sets
# $? to false even on a zero exit.
function PyHas([string]$module) {
  if (-not (Have "py")) { return $false }
  return ((Quiet "py" @("-3", "-c", "import $module")) -eq 0)
}

function OllamaHas([string]$model) {
  if (-not (Have "ollama")) { return $false }
  $list = & ollama list 2>$null | Out-String
  # The tag matters: "gemma4:e4b" and "gemma4:latest" are different downloads.
  return ($list -like "*$model*")
}

# The Python the clone venv needs - which is now almost any of them.
#
# This demanded 3.12 EXACTLY. That was true when it was written and is not now.
# chatterbox-tts 0.1.7 declares torch==2.6.0 below Python 3.14 and torch>=2.9.0
# at 3.14 and above, and PyTorch ships CUDA wheels from cp39 through cp314. So
# every Python from 3.10 to 3.14 can run the cloned voice, given the matching
# torch. 3.13 is included and is not the gap it looks like: torch 2.6.0 has
# cp313 wheels.
#
# Tested end to end on 3.14.4 with torch 2.13.0+cu126 - model loaded, CUDA seen,
# 2.12 seconds of non-silent audio generated. Most people already have a Python
# that works and were being told to go and install another one.
#
# Prefers the launcher's default, which is the interpreter Whisper and Piper
# already spawn: one fewer runtime on the machine and one fewer thing to explain.
function ClonePython() {
  # Newest FIRST is wrong here, and this is the correction that matters.
  #
  # spacy-pkuseg - pulled in by chatterbox - ships Windows wheels for cp39
  # through cp313 and NOT cp314. On 3.14 pip falls back to building it from
  # source, which needs Microsoft C++ Build Tools, several gigabytes that most
  # people do not have and should not need. It succeeded on the machine this was
  # tested on purely because that machine has Visual Studio build tools
  # installed, which is as clean an example of "works on my machine" as this
  # project has produced.
  #
  # So prefer a Python that has a prebuilt wheel, and treat 3.14 as the last
  # resort rather than the first choice. 3.14 genuinely works - the model loads
  # and speaks - it just costs a compiler to get there.
  foreach ($ver in @("3.13", "3.12", "3.11", "3.10")) {
    if (Have "py") {
      if ((Quiet "py" @("-$ver", "--version")) -eq 0) { return "py -$ver" }
    }
    if (Have "python$ver") { return "python$ver" }
    $flat = $ver.Replace(".", "")
    foreach ($g in @(
      "$env:LOCALAPPDATA\Programs\Python\Python$flat\python.exe",
      "$env:ProgramFiles\Python$flat\python.exe",
      "C:\Python$flat\python.exe"
    )) { if (Test-Path $g) { return $g } }
  }

  # Nothing with a wheel. 3.14 only, which means compiling spacy-pkuseg.
  foreach ($ver in @("3.14")) {
    if (Have "py") {
      if ((Quiet "py" @("-$ver", "--version")) -eq 0) { return "py -$ver" }
    }
    if (Have "python$ver") { return "python$ver" }
    $flat = $ver.Replace(".", "")
    foreach ($g in @(
      "$env:LOCALAPPDATA\Programs\Python\Python$flat\python.exe",
      "$env:ProgramFiles\Python$flat\python.exe",
      "C:\Python$flat\python.exe"
    )) { if (Test-Path $g) { return $g } }
  }

  # uv's managed runtimes, which the py launcher does not know about - the case
  # the previous version described in a comment and then gave up on anyway.
  if (Have "uv") {
    $found = & uv python find ">=3.10" 2>$null
    if ($LASTEXITCODE -eq 0 -and $found -and (Test-Path $found.Trim())) { return $found.Trim() }
  }

  return $null
}

function Survey() {
  $gpu = $false
  if (Have "nvidia-smi") {
    $gpu = ((Quiet "nvidia-smi" @("--query-gpu=name", "--format=csv,noheader")) -eq 0)
  }
  return [pscustomobject]@{
    Winget   = (Have "winget")
    NodeMajor= (NodeMajor)
    Py       = (Have "py")
    Ollama   = (Have "ollama")
    Chat     = (OllamaHas $CHAT_MODEL)
    Vision   = (OllamaHas $VISION_MODEL)
    Whisper  = (PyHas "faster_whisper")
    Piper    = (PyHas "piper")
    Gpu      = $gpu
    ClonePy  = (ClonePython)
    CloneVenv= (Test-Path ".venv-clone\Scripts\python.exe")
  }
}

function ShowSurvey($s) {
  Say ""
  Say "What this machine already has" "White"
  Rule
  $rows = @(
    @("Node.js",        $(if ($s.NodeMajor -ge $MIN_NODE) { "v$($s.NodeMajor)" } elseif ($s.NodeMajor -gt 0) { "v$($s.NodeMajor), too old (need $MIN_NODE+)" } else { "not found" })),
    @("Python launcher", $(if ($s.Py) { "found" } else { "not found" })),
    @("Ollama",          $(if ($s.Ollama) { "found" } else { "not found" })),
    @("  $CHAT_MODEL",   $(if ($s.Chat) { "pulled" } else { "not pulled" })),
    @("  $VISION_MODEL", $(if ($s.Vision) { "pulled" } else { "not pulled" })),
    @("faster-whisper",  $(if ($s.Whisper) { "installed" } else { "not installed" })),
    @("piper-tts",       $(if ($s.Piper) { "installed" } else { "not installed" })),
    @("NVIDIA GPU",      $(if ($s.Gpu) { "present" } else { "none detected" })),
    @("winget",          $(if ($s.Winget) { "available" } else { "MISSING - installs must be manual" }))
  )
  foreach ($r in $rows) {
    $ok = ($r[1] -notlike "*not *") -and ($r[1] -notlike "*MISSING*") -and ($r[1] -notlike "*none *") -and ($r[1] -notlike "*too old*")
    $colour = "Yellow"
    if ($ok) { $colour = "Green" }
    Write-Host ("  {0,-18} {1}" -f $r[0], $r[1]) -ForegroundColor $colour
  }
  Rule
}

# ------------------------------------------------------------------ actions --

function RunWinget([string]$id, [string]$label) {
  if ($DryRun) { Say "  would install $label (winget $id)" "Cyan"; Record $label "planned" "winget $id"; return }
  Say "  installing $label ..." "Cyan"
  & winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -eq 0) {
    Record $label "installed" "winget $id"
    Say "  $label installed." "Green"
  } else {
    Record $label "failed" "winget exit $LASTEXITCODE"
    Say "  $label FAILED (winget exit $LASTEXITCODE). Install it by hand and run this again." "Red"
  }
}

function RunPip([string]$packages, [string]$label, [string]$indexUrl) {
  if ($DryRun) { Say "  would pip install $packages" "Cyan"; Record $label "planned" "pip $packages"; return }
  Say "  installing $label ..." "Cyan"
  $args = @("-3", "-m", "pip", "install", "--upgrade")
  $args += $packages.Split(" ")
  if ($indexUrl) { $args += @("--index-url", $indexUrl) }
  & py @args
  if ($LASTEXITCODE -eq 0) {
    Record $label "installed" $packages
    Say "  $label installed." "Green"
  } else {
    Record $label "failed" "pip exit $LASTEXITCODE"
    Say "  $label FAILED (pip exit $LASTEXITCODE)." "Red"
  }
}

function PullModel([string]$model) {
  if ($DryRun) { Say "  would pull $model" "Cyan"; Record $model "planned" "ollama pull"; return }
  Say "  pulling $model - this is the big one, leave it running ..." "Cyan"
  & ollama pull $model
  if ($LASTEXITCODE -eq 0) {
    Record $model "installed" "ollama pull"
    Say "  $model pulled." "Green"
  } else {
    Record $model "failed" "ollama exit $LASTEXITCODE"
    Say "  $model FAILED (ollama exit $LASTEXITCODE)." "Red"
  }
}

# $defaultYes false is for a tier that should never arrive unasked. -All then
# still skips it, which is the documented behaviour for the cloned voice: it is
# large, it needs a Python the launcher often cannot see, and it cannot finish
# without a recording the user supplies. "Take everything" should not quietly
# start that.
function Ask([string]$question, [string]$size, [bool]$defaultYes = $true) {
  if ($All)     { return $defaultYes }
  if ($Minimal) { return $false }
  if ($DryRun)  { return $true }
  $suffix = if ($defaultYes) { "[Y/n]" } else { "[y/N]" }
  $answer = Read-Host "  $question ($size) $suffix"
  if ($answer -eq "") { return $defaultYes }
  return ($answer -match "^[Yy]")
}

# -------------------------------------------------------------------- tiers --

function DoNode($s) {
  if ($s.NodeMajor -ge $MIN_NODE) { Record "Node.js" "already" "v$($s.NodeMajor)"; Say "  Node.js v$($s.NodeMajor) - already good." "Green"; return }
  if (-not $s.Winget) {
    Record "Node.js" "manual" "no winget"
    Say "  Node.js is required and winget is not available. Get it from https://nodejs.org and run this again." "Red"
    return
  }
  RunWinget "OpenJS.NodeJS.LTS" "Node.js"
}

function DoBrain($s) {
  if (-not $s.Ollama) {
    if (-not $s.Winget) { Record "Ollama" "manual" "no winget"; Say "  Install Ollama from https://ollama.com and run this again." "Yellow"; return }
    RunWinget "Ollama.Ollama" "Ollama"
  } else {
    Record "Ollama" "already" "found"
    Say "  Ollama - already installed." "Green"
  }
  if ($s.Chat) { Record $CHAT_MODEL "already" "pulled"; Say "  $CHAT_MODEL - already pulled." "Green"; return }
  # Freshly installed Ollama is not on PATH in this shell yet.
  if (-not (Have "ollama") -and -not $DryRun) {
    Record $CHAT_MODEL "deferred" "ollama not on PATH yet"
    Say "  Ollama was just installed and is not on this shell's PATH yet." "Yellow"
    Say "  Open a new terminal and run: ollama pull $CHAT_MODEL" "Yellow"
    return
  }
  PullModel $CHAT_MODEL
}

function DoEars($s) {
  if (-not $s.Py) {
    if (-not $s.Winget) { Record "Python" "manual" "no winget"; Say "  Install Python from https://python.org and run this again." "Yellow"; return }
    RunWinget "Python.Python.3.12" "Python"
    if (-not $DryRun -and -not (Have "py")) {
      Record "faster-whisper" "deferred" "python not on PATH yet"
      Say "  Python was just installed. Open a new terminal and run this script again to finish the ears." "Yellow"
      return
    }
  }
  if ($s.Whisper) { Record "faster-whisper" "already" "importable"; Say "  faster-whisper - already installed." "Green" }
  else { RunPip "faster-whisper" "faster-whisper" $null }

  # CUDA only where there is a card to use it. On a machine with no NVIDIA GPU
  # these are a gigabyte of nothing, and Whisper runs on the CPU quite happily.
  if ($s.Gpu) {
    if (Ask "GPU acceleration for the ears?" "1 GB") {
      RunPip "nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12" "CUDA runtime for Whisper" $null
    } else { Record "CUDA runtime for Whisper" "skipped" "declined" }
  }
}

function DoVoice($s) {
  if (-not $s.Py) { Record "piper-tts" "skipped" "no Python"; Say "  No Python, so no local voice. He will use the cloud voice." "Yellow"; return }
  if ($s.Piper) { Record "piper-tts" "already" "importable"; Say "  piper-tts - already installed." "Green"; return }
  # Voices themselves download on first use, so there is nothing to fetch here.
  RunPip "piper-tts" "piper-tts" $null
}

# Is there an Ollama to pull a model into? Present already, or installed/planned
# earlier in this same run - the eyes tier runs after the brain tier, so "we are
# about to install it" is a legitimate yes.
#
# Asking `Have "ollama"` alone is not enough in either direction, which is the
# bug this replaced: under -DryRun nothing is ever installed, so the old guard
# was skipped entirely and the plan cheerfully offered to pull 5.9 GB onto a
# machine with no Ollama at all. Found by running the script with a stripped
# PATH, which is the only way to reach the bare-machine case from a machine that
# has everything.
function OllamaUsable($s) {
  if ($s.Ollama) { return $true }
  $planned = @($script:Results | Where-Object {
    $_.Key -eq "Ollama" -and ($_.State -eq "installed" -or $_.State -eq "planned")
  })
  return ($planned.Count -gt 0)
}

function DoEyes($s) {
  if (-not (OllamaUsable $s)) {
    Record $VISION_MODEL "skipped" "no Ollama"
    Say "  No Ollama, so there is nothing to give him eyes with." "Yellow"
    return
  }
  if ($s.Vision) { Record $VISION_MODEL "already" "pulled"; Say "  $VISION_MODEL - already pulled." "Green"; return }
  # Same deferral as the brain tier: a freshly installed Ollama is not on this
  # shell's PATH, and `ollama pull` would fail as command-not-found.
  if (-not (Have "ollama") -and -not $DryRun) {
    Record $VISION_MODEL "deferred" "ollama not on PATH yet"
    Say "  Open a new terminal and run: ollama pull $VISION_MODEL" "Yellow"
    return
  }
  PullModel $VISION_MODEL
}

function DoClone($s) {
  Say ""
  Say "The cloned voice" "White"
  Rule
  Say "  This one cannot finish on its own, and it is honest to say so up front:" "Yellow"
  Say "  cloning needs about 10 seconds of a real person's recording, saved as" "Yellow"
  Say "  voices/greg-reference.wav. Nothing ships one - that would be publishing" "Yellow"
  Say "  somebody's voice. See the README before you rely on this." "Yellow"
  Say ""
  # Already built? Then nothing about Python matters, and saying "blocked" over
  # a working install is simply wrong. This check sat BELOW the Python one, so
  # the machine Greg was written on — which has a working .venv-clone — reported
  # the cloned voice as blocked on every run.
  if ($s.CloneVenv) {
    Record "cloned voice" "already" ".venv-clone exists"
    Say "  .venv-clone already exists - leaving it alone." "Green"
    return
  }
  if (-not $s.ClonePy) {
    Record "cloned voice" "blocked" "no Python 3.10 or newer"
    Say "  Needs Python 3.10 or newer. None found: not on the py launcher," "Red"
    Say "  not on PATH, not under uv, and not in the usual install folders." "Red"
    Say "    winget install --id Python.Python.3.12 --exact" "Red"
    Say "  If you already have one, pass its full path in config.json as" "Red"
    Say "  clonedVoice.python and run this again." "Red"
    return
  }
  if ($DryRun) {
    Say "  would create .venv-clone on $($s.ClonePy), then install a CUDA torch, then chatterbox-tts" "Cyan"
    Record "cloned voice" "planned" "venv + torch cu126 + chatterbox"
    return
  }

  Say "  creating .venv-clone on $($s.ClonePy) ..." "Cyan"
  $pyParts = $s.ClonePy.Split(" ")
  if ($pyParts.Count -gt 1) { & $pyParts[0] $pyParts[1] -m venv .venv-clone }
  else { & $s.ClonePy -m venv .venv-clone }
  if ($LASTEXITCODE -ne 0) { Record "cloned voice" "failed" "venv creation"; Say "  venv creation FAILED." "Red"; return }

  $vpy = ".venv-clone\Scripts\python.exe"

  # setuptools BEFORE anything else, and pinned.
  #
  # resemble-perth - which chatterbox loads to watermark its output - does
  # `from pkg_resources import resource_filename`, and pkg_resources was REMOVED
  # in setuptools 81. A fresh install today gets setuptools 84, so perth's import
  # fails, its package __init__ swallows the ImportError and leaves
  # PerthImplicitWatermarker as None, and chatterbox dies on
  # `TypeError: 'NoneType' object is not callable` - naming neither setuptools
  # nor pkg_resources.
  #
  # This is not a Python-version problem and it is not new to 3.14. The venv on
  # this machine works only because it was built when setuptools was 78. Every
  # install after setuptools 81 shipped was broken, on every Python.
  Say "  pinning setuptools below 81 (perth still imports pkg_resources) ..." "Cyan"
  & $vpy -m pip install "setuptools<81"
  if ($LASTEXITCODE -ne 0) { Record "cloned voice" "failed" "setuptools"; Say "  setuptools FAILED." "Red"; return }

  # torch FIRST, from PyTorch's own index. Installing chatterbox-tts plainly
  # resolves torch from PyPI, whose Windows wheel is CPU-ONLY, and it replaces a
  # working CUDA torch silently. A +cu126 build satisfies the same pin, so
  # chatterbox then installs on top without touching it. CLAUDE.md records
  # 2.6 GB thrown away learning this.
  #
  # Which torch depends on the Python: chatterbox asks for ==2.6.0 below 3.14
  # and >=2.9.0 at 3.14 and above, and there is no 2.6.0 wheel for cp314.
  $minor = & $vpy -c "import sys; print(sys.version_info.minor)"

  # Say it BEFORE the 2.6 GB download, not after it fails.
  if ([int]$minor -ge 14) {
    Say "  Note: on Python 3.$minor, spacy-pkuseg has no prebuilt wheel and pip will" "Yellow"
    Say "  compile it. That needs Microsoft C++ Build Tools. If it fails at the end" "Yellow"
    Say "  with 'Failed building wheel for spacy-pkuseg', install Python 3.12 and" "Yellow"
    Say "  run this again - it has a wheel and nothing needs compiling:" "Yellow"
    Say "    winget install --id Python.Python.3.12 --exact" "Yellow"
    Say ""
  }

  $torchSpec = if ([int]$minor -ge 14) { "torch>=2.9.0" } else { "torch==2.6.0" }
  Say "  installing $torchSpec from PyTorch's CUDA index (about 2.6 GB) ..." "Cyan"
  & $vpy -m pip install $torchSpec --index-url "https://download.pytorch.org/whl/cu126"
  if ($LASTEXITCODE -ne 0) { Record "cloned voice" "failed" "torch"; Say "  torch FAILED." "Red"; return }

  Say "  installing chatterbox-tts ..." "Cyan"
  & $vpy -m pip install chatterbox-tts
  if ($LASTEXITCODE -ne 0) {
    Record "cloned voice" "failed" "chatterbox"
    Say "  chatterbox FAILED." "Red"
    # The overwhelmingly common cause, and the message pip gives for it names a
    # package nobody has heard of rather than the fix. Reported from a second
    # machine: "Failed building wheel for spacy-pkuseg".
    if ([int]$minor -ge 14) {
      Say "  If that ended with 'Failed building wheel for spacy-pkuseg', it is not" "Red"
      Say "  your fault and nothing is broken: that package has no wheel for Python" "Red"
      Say "  3.$minor, so pip tried to compile it and there is no C++ compiler here." "Red"
      Say "  The easy fix is a Python that has a wheel - 3.13 or 3.12:" "Red"
      Say "    winget install --id Python.Python.3.12 --exact" "Red"
      Say "  Then delete the .venv-clone folder and run this again." "Red"
    }
    return
  }

  # chatterbox depends on setuptools and pip may have pulled a new one back in
  # while resolving it. Re-pin and verify, because the failure this prevents is
  # silent until the first time somebody tries to speak.
  & $vpy -m pip install --quiet "setuptools<81"
  $ok = & $vpy -c "import perth; print(perth.PerthImplicitWatermarker is not None)" 2>$null
  if ($ok -notmatch "True") {
    Record "cloned voice" "failed" "perth watermarker unavailable"
    Say "  Installed, but perth's watermarker did not load - the cloned voice would" "Red"
    Say "  fail at startup. Usually setuptools 81+ removing pkg_resources." "Red"
    return
  }

  Record "cloned voice" "installed" ".venv-clone"
  Say "  cloned voice installed. It still needs voices/greg-reference.wav." "Green"
}

# ------------------------------------------------------------------ summary --

function Summary($before) {
  Say ""
  Say "What Greg will actually do" "White"
  Rule
  # Re-detect rather than trusting the plan. The whole point of the boot screen
  # is that it reports what loaded, not what was requested, and a setup script
  # that reports its intentions is the same lie one step earlier.
  $s = Survey

  if ($DryRun) {
    Say "  DRY RUN - nothing was installed." "Cyan"
    foreach ($r in $script:Results) {
      Write-Host ("  {0,-28} {1}" -f $r.Key, $r.State) -ForegroundColor Cyan
    }
    Rule
    Say "  Run it again without -DryRun to do any of it." "Cyan"
    return
  }

  $lines = @(
    @("Brain",  $(if ($s.Chat) { "$CHAT_MODEL, on your machine" } elseif ($s.Ollama) { "Ollama is here but no model is pulled" } else { "no Ollama - fallback replies only" }), $s.Chat),
    @("Ears",   $(if ($s.Whisper) { "Whisper, offline" } else { "browser speech recognition - needs internet" }), $s.Whisper),
    @("Voice",  $(if ($s.Piper) { "Piper, offline" } else { "cloud voice - needs internet" }), $s.Piper),
    @("Eyes",   $(if ($s.Vision) { "$VISION_MODEL" } else { "not fitted" }), $s.Vision)
  )
  foreach ($l in $lines) {
    $colour = "Yellow"
    if ($l[2]) { $colour = "Green" }
    Write-Host ("  {0,-8} {1}" -f $l[0], $l[1]) -ForegroundColor $colour
  }

  $failed = @($script:Results | Where-Object { $_.State -eq "failed" })
  if ($failed.Count -gt 0) {
    Rule
    Say "  These did NOT work:" "Red"
    foreach ($f in $failed) { Say ("    {0} - {1}" -f $f.Key, $f.Detail) "Red" }
    Say "  Greg will still start. He will just be missing that piece." "Yellow"
  }
  Rule
  Say ""
  Say "  Now double-click start-greg.bat." "White"
}

# --------------------------------------------------------------------- main --

Say ""
Say "Greg setup" "White"
Say "Nothing here is required. Greg runs without any of it, on a cloud voice and" "DarkGray"
Say "the browser's own speech recognition, and his startup screen says so." "DarkGray"

$survey = Survey
ShowSurvey $survey

if (-not $survey.Winget -and -not $DryRun) {
  Say "winget was not found, so nothing can be installed automatically." "Red"
  Say "winget ships with Windows 11 and recent Windows 10. Install the pieces by" "Yellow"
  Say "hand - the README lists them - or update App Installer from the Store." "Yellow"
}

Say ""
Say "Choosing what to install" "White"
Rule
DoNode $survey

if ($Minimal) {
  Say "  -Minimal: stopping after Node." "Cyan"
} else {
  if (Ask "A real brain, running locally?" "9.6 GB") { DoBrain $survey } else { Record "brain" "skipped" "declined" }
  if (Ask "Hear you offline?"            "200 MB") { DoEars  $survey } else { Record "ears"  "skipped" "declined" }
  if (Ask "Speak offline?"               "100 MB") { DoVoice $survey } else { Record "voice" "skipped" "declined" }
  if (Ask "Let him see your screen?"     "5.9 GB") { DoEyes  $survey } else { Record "eyes"  "skipped" "declined" }
}

# The cloned voice, which until now was reachable ONLY by passing -Clone.
#
# setup-greg.bat exists to be double-clicked — that is what its own comment says
# it is for — and a double-click passes no arguments, so the interactive path
# asked four questions and silently could not install this one at all. Reported
# by somebody on a second machine who ran the setup, saw no .venv-clone, and had
# no way to find out why. Every other tier has always had a prompt; this is the
# only one that did not.
#
# Still defaults to NO, and -All still skips it. That part was deliberate and
# stays: it is 6 GB and it cannot finish without a voice recording the user has
# to supply. Offering it is different from assuming it.
if ($Clone) {
  DoClone $survey
} elseif ($Minimal) {
  Record "cloned voice" "skipped" "-Minimal"
} elseif (Ask "Clone a real person's voice? Needs a recording you supply" "6 GB" $false) {
  DoClone $survey
} else {
  Record "cloned voice" "skipped" "declined"
}

Summary $survey
