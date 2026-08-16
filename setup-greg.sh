#!/usr/bin/env bash
# Greg setup for Linux (and macOS) — the counterpart to setup-greg.ps1.
#
# Same design as the Windows one, and the design follows Greg's own boot screen
# rather than a normal installer: he degrades on purpose, so with nothing but
# Node he still runs on the cloud voice and browser speech, and the POST screen
# says so in amber. This is therefore NOT all-or-nothing. It walks up as many
# tiers as you ask for and then RE-SURVEYS and reports what is actually true,
# including the parts that failed. An installer that claims a success it did not
# have is this project's oldest failure wearing a lab coat.
#
# --dry-run prints the plan and installs nothing. That is how this was written
# and tested — including on Git Bash, where no package manager is found and every
# tier reports "manual", which is itself a path worth exercising.
#
# WHAT THIS DOES NOT DO: it does not port the five Windows-only features (screen
# vision, cursor tracking, now-playing, media keys, the system voice). Those shell
# out to PowerShell and are off on Linux by design — Greg says which at startup.
# See docs/linux.md. This script sets up the parts that DO cross over: the brain,
# the offline ears and the offline voice.
set -uo pipefail
cd "$(dirname "$0")"

# ---------------------------------------------------------------- arguments --
DRY_RUN=0; ALL=0; MINIMAL=0; SMALL_CARD=0; CLONE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --all)        ALL=1 ;;
    --minimal)    MINIMAL=1 ;;
    --small-card) SMALL_CARD=1 ;;
    --clone)      CLONE=1 ;;
    -h|--help)
      echo "Usage: ./setup-greg.sh [--dry-run] [--all] [--minimal] [--small-card] [--clone]"
      echo "  --dry-run     show the plan, install nothing"
      echo "  --all         take every tier without asking (still skips the cloned voice)"
      echo "  --minimal     Node only; Greg runs on the cloud voice and browser speech"
      echo "  --small-card  Mini Greg: write config.json from the mini profile, skip the eyes"
      echo "  --clone       also build the cloned voice (~6 GB; needs a recording you supply)"
      exit 0 ;;
    *) echo "unknown option: $arg (try --help)"; exit 1 ;;
  esac
done

CHAT_MODEL="gemma4:e4b"
VISION_MODEL="qwen2.5vl:7b"
MIN_NODE=20

# ------------------------------------------------------------------ colours --
# Only when stdout is a terminal, so a redirected log is plain text.
if [ -t 1 ]; then
  C_RESET=$'\033[0m'; C_GRAY=$'\033[90m'; C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'; C_RED=$'\033[31m'; C_CYAN=$'\033[36m'; C_WHITE=$'\033[97m'
else
  C_RESET=""; C_GRAY=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_CYAN=""; C_WHITE=""
fi
say()  { printf '%b%s%b\n' "${2:-$C_GRAY}" "$1" "$C_RESET"; }
rule() { say "$(printf '%.0s-' {1..64})" "$C_GRAY"; }

# Every outcome goes through here, so the summary cannot disagree with what
# happened. "skipped" and "failed" are different facts and never merged.
RESULTS=()
record() { RESULTS+=("$1|$2|$3"); }  # key | state | detail

have() { command -v "$1" >/dev/null 2>&1; }

# ------------------------------------------------------------------- privilege
# Package-manager installs and Ollama's install.sh need root. Prefer sudo when we
# are not already root; if there is no sudo either, installs will be reported as
# manual rather than failing halfway.
if [ "$(id -u)" -eq 0 ]; then SUDO=""
elif have sudo; then SUDO="sudo"
else SUDO=""; fi

# ------------------------------------------------------------- package manager
# Detected once. PM_INSTALL is the command prefix; the caller appends packages.
PM=""; PM_INSTALL=""
detect_pm() {
  if   have apt-get; then PM="apt";    PM_INSTALL="$SUDO apt-get install -y"
  elif have dnf;     then PM="dnf";    PM_INSTALL="$SUDO dnf install -y"
  elif have pacman;  then PM="pacman"; PM_INSTALL="$SUDO pacman -S --noconfirm"
  elif have zypper;  then PM="zypper"; PM_INSTALL="$SUDO zypper install -y"
  elif have brew;    then PM="brew";   PM_INSTALL="brew install"   # macOS, no sudo
  else PM=""; fi
}
detect_pm

# The distro's package name for a thing that is named differently across them.
pkg() {
  case "$1:$PM" in
    node:pacman)   echo "nodejs npm" ;;
    node:*)        echo "nodejs" ;;
    python:apt)    echo "python3 python3-venv python3-pip" ;;
    python:pacman) echo "python python-pip" ;;
    python:brew)   echo "python" ;;
    python:*)      echo "python3 python3-pip" ;;
    *)             echo "$1" ;;
  esac
}

# A python3 that can build a venv. python3 alone is not enough on Debian/Ubuntu,
# where the venv module is a separate package — the failure is a clear message at
# venv-creation time, so we surface the need rather than guessing.
PY="python3"; have python3 || PY=""

# --------------------------------------------------------------------- survey
NODE_MAJOR=0
if have node; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"; fi

ollama_has() { have ollama && ollama list 2>/dev/null | grep -q "$1"; }

GPU=0
if have nvidia-smi && nvidia-smi >/dev/null 2>&1; then GPU=1; fi

# Is the sidecar venv actually usable for a package, or merely present? Mirrors
# the Windows CloneVenvState check: a venv folder is created BEFORE its packages
# go in, so "the folder exists" is not "it works".
venv_has() {  # dir module
  local py="$1/bin/python"
  [ -x "$py" ] && "$py" -c "import $2" >/dev/null 2>&1
}
clone_venv_state() {
  local py=".venv-clone/bin/python"
  [ -x "$py" ] || { echo "none"; return; }
  if "$py" -c "import chatterbox.tts, perth; print(perth.PerthImplicitWatermarker is not None)" 2>/dev/null | grep -q True
  then echo "ready"; else echo "broken"; fi
}

show_survey() {
  say ""; say "What this machine already has" "$C_WHITE"; rule
  local rows=(
    "Node.js|$( [ "$NODE_MAJOR" -ge "$MIN_NODE" ] && echo "v$NODE_MAJOR" || { [ "$NODE_MAJOR" -gt 0 ] && echo "v$NODE_MAJOR, too old (need $MIN_NODE+)" || echo "not found"; } )"
    "Python 3|$( [ -n "$PY" ] && echo "found" || echo "not found" )"
    "Ollama|$( have ollama && echo "found" || echo "not found" )"
    "  $CHAT_MODEL|$( ollama_has "$CHAT_MODEL" && echo "pulled" || echo "not pulled" )"
    "  $VISION_MODEL|$( ollama_has "$VISION_MODEL" && echo "pulled" || echo "not pulled" )"
    "faster-whisper|$( venv_has .venv faster_whisper && echo "installed (.venv)" || echo "not installed" )"
    "piper-tts|$( venv_has .venv piper && echo "installed (.venv)" || echo "not installed" )"
    "NVIDIA GPU|$( [ "$GPU" -eq 1 ] && echo "present" || echo "none detected" )"
    "package manager|$( [ -n "$PM" ] && echo "$PM" || echo "MISSING - installs must be manual" )"
  )
  for r in "${rows[@]}"; do
    local name="${r%%|*}" val="${r#*|}" col="$C_YELLOW"
    case "$val" in *"not "*|*MISSING*|*"none "*|*"too old"*) col="$C_YELLOW" ;; *) col="$C_GREEN" ;; esac
    printf '  %b%-18s %s%b\n' "$col" "$name" "$val" "$C_RESET"
  done
  rule
}

# --------------------------------------------------------------------- prompts
# defaultYes=1 tiers arrive under --all; the cloned voice passes 0 so "take
# everything" does not quietly start a 6 GB download that needs a recording.
ask() {  # question size [defaultYes]
  local dflt="${3:-1}"
  [ "$ALL" -eq 1 ]     && { [ "$dflt" -eq 1 ]; return; }
  [ "$MINIMAL" -eq 1 ] && return 1
  [ "$DRY_RUN" -eq 1 ] && return 0
  local suffix; [ "$dflt" -eq 1 ] && suffix="[Y/n]" || suffix="[y/N]"
  local ans; read -r -p "  $1 ($2) $suffix " ans
  [ -z "$ans" ] && { [ "$dflt" -eq 1 ]; return; }
  [[ "$ans" =~ ^[Yy] ]]
}

# ---------------------------------------------------------------------- actions
pm_install() {  # packages label
  if [ -z "$PM" ]; then record "$2" "manual" "no package manager"; say "  $2 needs a package manager we could not find. Install it by hand and run this again." "$C_RED"; return 1; fi
  if [ "$DRY_RUN" -eq 1 ]; then say "  would install $2 ($PM: $1)" "$C_CYAN"; record "$2" "planned" "$PM $1"; return 0; fi
  say "  installing $2 ..." "$C_CYAN"
  if $PM_INSTALL $1; then record "$2" "installed" "$PM $1"; say "  $2 installed." "$C_GREEN"; return 0
  else record "$2" "failed" "$PM exit $?"; say "  $2 FAILED. Install it by hand and run this again." "$C_RED"; return 1; fi
}

pull_model() {  # model
  if [ "$DRY_RUN" -eq 1 ]; then say "  would pull $1" "$C_CYAN"; record "$1" "planned" "ollama pull"; return 0; fi
  if ! have ollama; then record "$1" "deferred" "ollama not on PATH yet"; say "  Ollama was just installed and is not on this shell's PATH yet." "$C_YELLOW"; say "  Open a new terminal and run: ollama pull $1" "$C_YELLOW"; return 0; fi
  say "  pulling $1 - this is the big one, leave it running ..." "$C_CYAN"
  if ollama pull "$1"; then record "$1" "installed" "ollama pull"; say "  $1 pulled." "$C_GREEN"
  else record "$1" "failed" "ollama pull failed"; say "  $1 FAILED." "$C_RED"; fi
}

# venv pip install into an existing venv dir.
venv_pip() {  # dir "packages" label [indexUrl]
  if [ "$DRY_RUN" -eq 1 ]; then say "  would pip install $2 into $1" "$C_CYAN"; record "$3" "planned" "pip $2"; return 0; fi
  local extra=(); [ -n "${4:-}" ] && extra=(--index-url "$4")
  say "  installing $3 ..." "$C_CYAN"
  if "$1/bin/python" -m pip install --upgrade "${extra[@]}" $2; then record "$3" "installed" "$2"; say "  $3 installed." "$C_GREEN"; return 0
  else record "$3" "failed" "pip failed"; say "  $3 FAILED." "$C_RED"; return 1; fi
}

# Create the shared sidecar venv (.venv) once, for whisper and piper. lib/platform.js
# looks for exactly this path, so nothing has to be written into config.json.
ensure_sidecar_venv() {
  [ -x ".venv/bin/python" ] && return 0
  if [ -z "$PY" ]; then record "python3" "manual" "not installed"; say "  No python3, so no offline ears or voice. Install it and run this again." "$C_YELLOW"; return 1; fi
  if [ "$DRY_RUN" -eq 1 ]; then say "  would create .venv on python3" "$C_CYAN"; return 0; fi
  say "  creating .venv on python3 ..." "$C_CYAN"
  if ! "$PY" -m venv .venv; then
    record ".venv" "failed" "venv creation"
    say "  Could not create .venv. On Debian/Ubuntu the venv module is a separate" "$C_RED"
    say "  package: $SUDO apt-get install python3-venv, then run this again." "$C_RED"
    return 1
  fi
  return 0
}

# --------------------------------------------------------------------- tiers
do_node() {
  if [ "$NODE_MAJOR" -ge "$MIN_NODE" ]; then record "Node.js" "already" "v$NODE_MAJOR"; say "  Node.js v$NODE_MAJOR - already good." "$C_GREEN"; return; fi
  pm_install "$(pkg node)" "Node.js" || return
  # Distro Node is often older than 20 (Debian stable especially). Re-check and
  # say so plainly rather than letting Greg fail later in a way that points
  # nowhere near the version.
  if [ "$DRY_RUN" -eq 0 ] && have node; then
    local m; m="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
    if [ "$m" -lt "$MIN_NODE" ]; then
      record "Node.js" "too old" "v$m from $PM"
      say "  Installed Node v$m, but Greg needs $MIN_NODE+. Your distro's is too old." "$C_YELLOW"
      say "  Use NodeSource (https://github.com/nodesource/distributions) or nvm, then re-run." "$C_YELLOW"
    fi
  fi
}

do_brain() {
  if have ollama; then record "Ollama" "already" "found"; say "  Ollama - already installed." "$C_GREEN"
  else
    if [ "$DRY_RUN" -eq 1 ]; then say "  would install Ollama (curl -fsSL https://ollama.com/install.sh | sh)" "$C_CYAN"; record "Ollama" "planned" "install.sh"
    else
      say "  installing Ollama (official install.sh) ..." "$C_CYAN"
      if curl -fsSL https://ollama.com/install.sh | sh; then record "Ollama" "installed" "install.sh"; say "  Ollama installed." "$C_GREEN"
      else record "Ollama" "failed" "install.sh"; say "  Ollama install FAILED. See https://ollama.com/download/linux" "$C_RED"; return; fi
    fi
  fi
  if ollama_has "$CHAT_MODEL"; then record "$CHAT_MODEL" "already" "pulled"; say "  $CHAT_MODEL - already pulled." "$C_GREEN"; return; fi
  pull_model "$CHAT_MODEL"
}

do_ears() {
  ensure_sidecar_venv || return
  if venv_has .venv faster_whisper; then record "faster-whisper" "already" "importable"; say "  faster-whisper - already installed." "$C_GREEN"
  else venv_pip .venv "faster-whisper" "faster-whisper"; fi
  # CUDA only where there is a card. On a CPU-only machine these are a gigabyte
  # of nothing and Whisper runs on the CPU quite happily.
  if [ "$GPU" -eq 1 ]; then
    if ask "GPU acceleration for the ears?" "1 GB"; then
      venv_pip .venv "nvidia-cublas-cu12 nvidia-cudnn-cu12 nvidia-cuda-runtime-cu12" "CUDA runtime for Whisper"
    else record "CUDA runtime for Whisper" "skipped" "declined"; fi
  fi
}

do_voice() {
  ensure_sidecar_venv || { record "piper-tts" "skipped" "no venv"; return; }
  if venv_has .venv piper; then record "piper-tts" "already" "importable"; say "  piper-tts - already installed." "$C_GREEN"; return; fi
  venv_pip .venv "piper-tts" "piper-tts"   # voices download on first use
}

# Is there an Ollama to pull into — present, or installed/planned earlier this run?
ollama_usable() {
  have ollama && return 0
  local r
  for r in "${RESULTS[@]}"; do
    [[ "$r" == "Ollama|installed|"* || "$r" == "Ollama|planned|"* ]] && return 0
  done
  return 1
}

do_eyes() {
  if ! ollama_usable; then record "$VISION_MODEL" "skipped" "no Ollama"; say "  No Ollama, so nothing to give him eyes with." "$C_YELLOW"; return; fi
  if ollama_has "$VISION_MODEL"; then record "$VISION_MODEL" "already" "pulled"; say "  $VISION_MODEL - already pulled." "$C_GREEN"; return; fi
  pull_model "$VISION_MODEL"
}

do_mini_config() {
  local src="config.mini.example.json" dst="config.json"
  if [ ! -f "$src" ]; then record "mini profile" "failed" "$src missing"; say "  $src not found - re-clone, or restore that file." "$C_RED"; return; fi
  if [ -f "$dst" ]; then record "mini profile" "skipped" "config.json exists"; say "  config.json already exists and has NOT been touched. See docs/mini.md." "$C_YELLOW"; return; fi
  if [ "$DRY_RUN" -eq 1 ]; then record "mini profile" "would" "write config.json"; say "  would write config.json from $src" "$C_CYAN"; return; fi
  cp "$src" "$dst"; record "mini profile" "written" "from mini profile"; say "  wrote config.json from $src" "$C_GREEN"
}

# The cloned voice. Mirrors setup-greg.ps1's DoClone: setuptools pinned below 81
# (perth still imports pkg_resources), torch FIRST from the CUDA index (a plain
# chatterbox install pulls a CPU-only torch and silently replaces a CUDA one),
# then chatterbox, then re-pin and verify perth actually loaded.
do_clone() {
  say ""; say "The cloned voice" "$C_WHITE"; rule
  say "  This one cannot finish on its own, and it is honest to say so up front:" "$C_YELLOW"
  say "  cloning needs about 10 seconds of a real person's recording, saved as" "$C_YELLOW"
  say "  voices/greg-reference.wav. Nothing ships one. See the README first." "$C_YELLOW"; say ""

  local state; state="$(clone_venv_state)"
  if [ "$state" = "ready" ]; then record "cloned voice" "already" ".venv-clone works"; say "  .venv-clone already works - leaving it alone." "$C_GREEN"; return; fi
  if [ "$state" = "broken" ]; then
    say "  .venv-clone exists but does not work - an install that stopped partway." "$C_YELLOW"
    if [ "$DRY_RUN" -eq 1 ]; then say "  would delete .venv-clone and rebuild it" "$C_CYAN"; record "cloned voice" "planned" "rebuild"; return; fi
    if ask "Delete .venv-clone and build it again?" "a few GB" 1; then rm -rf .venv-clone; else record "cloned voice" "skipped" "kept half-finished venv"; say "  Left alone. The cloned voice will not work until rebuilt." "$C_YELLOW"; return; fi
  fi
  if [ -z "$PY" ]; then record "cloned voice" "blocked" "no python3"; say "  Needs python3 (3.10 to 3.13). None found." "$C_RED"; return; fi
  if [ "$DRY_RUN" -eq 1 ]; then say "  would create .venv-clone, then a CUDA torch, then chatterbox-tts" "$C_CYAN"; record "cloned voice" "planned" "venv + torch cu126 + chatterbox"; return; fi

  say "  creating .venv-clone ..." "$C_CYAN"
  "$PY" -m venv .venv-clone || { record "cloned voice" "failed" "venv creation"; say "  venv creation FAILED." "$C_RED"; return; }
  local vpy=".venv-clone/bin/python"

  say "  pinning setuptools below 81 (perth still imports pkg_resources) ..." "$C_CYAN"
  "$vpy" -m pip install "setuptools<81" || { record "cloned voice" "failed" "setuptools"; say "  setuptools FAILED." "$C_RED"; return; }

  # torch first, from PyTorch's CUDA index. Which torch depends on the Python:
  # chatterbox asks ==2.6.0 below 3.14 and >=2.9.0 at 3.14+.
  local minor; minor="$("$vpy" -c 'import sys; print(sys.version_info.minor)')"
  local torch_spec="torch==2.6.0"; [ "$minor" -ge 14 ] && torch_spec="torch>=2.9.0"
  say "  installing $torch_spec from PyTorch's CUDA index (about 2.6 GB) ..." "$C_CYAN"
  "$vpy" -m pip install "$torch_spec" --index-url "https://download.pytorch.org/whl/cu126" \
    || { record "cloned voice" "failed" "torch"; say "  torch FAILED." "$C_RED"; return; }

  say "  installing chatterbox-tts ..." "$C_CYAN"
  "$vpy" -m pip install chatterbox-tts || { record "cloned voice" "failed" "chatterbox"; say "  chatterbox FAILED." "$C_RED"; return; }

  "$vpy" -m pip install --quiet "setuptools<81"
  if "$vpy" -c "import perth; print(perth.PerthImplicitWatermarker is not None)" 2>/dev/null | grep -q True; then
    record "cloned voice" "installed" ".venv-clone"
    say "  cloned voice installed. It still needs voices/greg-reference.wav." "$C_GREEN"
  else
    record "cloned voice" "failed" "perth watermarker unavailable"
    say "  Installed, but perth's watermarker did not load - usually setuptools 81+ removing pkg_resources." "$C_RED"
  fi
}

# --------------------------------------------------------------------- summary
summary() {
  say ""; say "What Greg will actually do" "$C_WHITE"; rule
  # Re-detect rather than trusting the plan — the boot screen reports what
  # loaded, and a setup that reports its intentions is the same lie one step up.
  NODE_MAJOR=0; have node && NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"

  if [ "$DRY_RUN" -eq 1 ]; then
    say "  DRY RUN - nothing was installed." "$C_CYAN"
    for r in "${RESULTS[@]}"; do printf '  %b%-28s %s%b\n' "$C_CYAN" "${r%%|*}" "$(x="${r#*|}"; echo "${x%%|*}")" "$C_RESET"; done
    rule; say "  Run it again without --dry-run to do any of it." "$C_CYAN"; return
  fi

  local lines=(
    "Brain|$( ollama_has "$CHAT_MODEL" && echo "$CHAT_MODEL, on your machine" || { have ollama && echo "Ollama is here but no model is pulled" || echo "no Ollama - fallback replies only"; } )|$( ollama_has "$CHAT_MODEL" && echo 1 || echo 0 )"
    "Ears|$( venv_has .venv faster_whisper && echo "Whisper, offline" || echo "browser speech recognition - needs internet" )|$( venv_has .venv faster_whisper && echo 1 || echo 0 )"
    "Voice|$( venv_has .venv piper && echo "Piper, offline" || echo "cloud voice - needs internet" )|$( venv_has .venv piper && echo 1 || echo 0 )"
    "Eyes|$( ollama_has "$VISION_MODEL" && echo "$VISION_MODEL" || echo "not fitted" )|$( ollama_has "$VISION_MODEL" && echo 1 || echo 0 )"
  )
  for l in "${lines[@]}"; do
    local name="${l%%|*}" rest="${l#*|}"; local val="${rest%%|*}" ok="${rest##*|}"
    local col="$C_YELLOW"; [ "$ok" = "1" ] && col="$C_GREEN"
    printf '  %b%-8s %s%b\n' "$col" "$name" "$val" "$C_RESET"
  done

  local any_failed=0
  for r in "${RESULTS[@]}"; do case "$r" in *"|failed|"*) any_failed=1 ;; esac; done
  if [ "$any_failed" -eq 1 ]; then
    rule; say "  These did NOT work:" "$C_RED"
    for r in "${RESULTS[@]}"; do case "$r" in *"|failed|"*) say "    ${r%%|*} - ${r##*|}" "$C_RED" ;; esac; done
    say "  Greg will still start. He will just be missing that piece." "$C_YELLOW"
  fi
  rule; say ""
  say "  The five Windows-only features (screen, cursor, now-playing, media keys," "$C_GRAY"
  say "  the system voice) are off on Linux by design. Greg says so at startup." "$C_GRAY"
  say "  Now run: ./start-greg.sh" "$C_WHITE"
}

# ------------------------------------------------------------------------ main
say ""; say "Greg setup for $(uname -s)" "$C_WHITE"
say "Nothing here is required. Greg runs without any of it, on a cloud voice and" "$C_GRAY"
say "the browser's own speech recognition, and his startup screen says so." "$C_GRAY"

show_survey

if [ -z "$PM" ] && [ "$DRY_RUN" -eq 0 ]; then
  say "" ; say "No supported package manager found (apt, dnf, pacman, zypper, brew)." "$C_RED"
  say "Installs will be reported as manual. The README lists the pieces by hand." "$C_YELLOW"
fi

say ""; say "Choosing what to install" "$C_WHITE"; rule
do_node
[ "$SMALL_CARD" -eq 1 ] && do_mini_config

if [ "$MINIMAL" -eq 1 ]; then
  say "  --minimal: stopping after Node." "$C_CYAN"
else
  if ask "A real brain, running locally?" "9.6 GB"; then do_brain; else record "brain" "skipped" "declined"; fi
  if ask "Hear you offline?"            "200 MB"; then do_ears;  else record "ears"  "skipped" "declined"; fi
  if ask "Speak offline?"               "100 MB"; then do_voice; else record "voice" "skipped" "declined"; fi
  if [ "$SMALL_CARD" -eq 1 ]; then
    record "eyes" "skipped" "--small-card: will not fit beside the cloned voice"
    say "  --small-card: skipping $VISION_MODEL. See docs/mini.md." "$C_CYAN"
  elif ask "Let him see your screen?" "5.9 GB"; then do_eyes; else record "eyes" "skipped" "declined"; fi
fi

# The cloned voice, only when asked. Defaults to no, and --all skips it: it is
# 6 GB and cannot finish without a recording the user supplies.
if [ "$CLONE" -eq 1 ]; then do_clone
elif [ "$MINIMAL" -eq 1 ]; then record "cloned voice" "skipped" "--minimal"
elif ask "Clone a real person's voice? Needs a recording you supply" "6 GB" 0; then do_clone
else record "cloned voice" "skipped" "declined"; fi

summary
