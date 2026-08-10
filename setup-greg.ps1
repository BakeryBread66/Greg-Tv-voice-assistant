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
  # The cloned voice. Off by default even under -All: it is about 6 GB, it needs
  # a Python 3.12 that the launcher often cannot see, and it cannot finish
  # without a voice recording you supply yourself.
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

# The Python the clone venv needs. The launcher is NOT a reliable answer here:
# on the machine this was written on, `py -3.12` reports no matching runtime
# while a uv-managed 3.12.8 sits on disk and runs the venv perfectly well. So
# ask the launcher, and treat a no as "not reachable" rather than "not present".
function Py312Path() {
  if (-not (Have "py")) { return $null }
  if ((Quiet "py" @("-3.12", "--version")) -eq 0) { return "py -3.12" }
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
    Py312    = (Py312Path)
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

function Ask([string]$question, [string]$size) {
  if ($All)     { return $true }
  if ($Minimal) { return $false }
  if ($DryRun)  { return $true }
  $answer = Read-Host "  $question ($size) [Y/n]"
  return ($answer -eq "" -or $answer -match "^[Yy]")
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
  if (-not $s.Py312) {
    Record "cloned voice" "blocked" "no reachable Python 3.12"
    Say "  Needs Python 3.12 exactly - torch 2.6.0 has no wheels for 3.13+." "Red"
    Say "  The launcher cannot see a 3.12 on this machine. Install one with:" "Red"
    Say "    winget install --id Python.Python.3.12 --exact" "Red"
    return
  }
  if ($DryRun) {
    Say "  would create .venv-clone on $($s.Py312), then install torch 2.6.0+cu126, then chatterbox-tts" "Cyan"
    Record "cloned voice" "planned" "venv + torch cu126 + chatterbox"
    return
  }
  if ($s.CloneVenv) { Record "cloned voice" "already" ".venv-clone exists"; Say "  .venv-clone already exists - leaving it alone." "Green"; return }

  Say "  creating .venv-clone ..." "Cyan"
  & py -3.12 -m venv .venv-clone
  if ($LASTEXITCODE -ne 0) { Record "cloned voice" "failed" "venv creation"; Say "  venv creation FAILED." "Red"; return }

  $vpy = ".venv-clone\Scripts\python.exe"
  # torch FIRST, from PyTorch's own index. Installing chatterbox-tts plainly
  # resolves torch==2.6.0 from PyPI, whose Windows wheel is CPU-ONLY, and it
  # replaces a working CUDA torch silently. 2.6.0+cu126 satisfies the same pin,
  # so chatterbox then installs on top without touching it. CLAUDE.md records
  # 2.6 GB thrown away learning this.
  Say "  installing torch 2.6.0+cu126 (2.6 GB, from PyTorch's index) ..." "Cyan"
  & $vpy -m pip install "torch==2.6.0" --index-url "https://download.pytorch.org/whl/cu126"
  if ($LASTEXITCODE -ne 0) { Record "cloned voice" "failed" "torch"; Say "  torch FAILED." "Red"; return }

  Say "  installing chatterbox-tts ..." "Cyan"
  & $vpy -m pip install chatterbox-tts
  if ($LASTEXITCODE -ne 0) { Record "cloned voice" "failed" "chatterbox"; Say "  chatterbox FAILED." "Red"; return }

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

if ($Clone) { DoClone $survey }

Summary $survey
