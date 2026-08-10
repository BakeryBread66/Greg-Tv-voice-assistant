# Greg's fallback voice: Windows' own speech synthesis.
#
# Every Windows machine has this. No install, no download, no network - which is
# the entire point of it being here: without it, a failure of the local voice
# sends the text to Microsoft's servers, and "nothing you say leaves this
# machine" stops being true in exactly the moment nobody is watching.
#
# The text arrives as a FILE rather than as an argument. It comes from a language
# model, and pasting model output into a PowerShell command line is how you end
# up executing it - a single quote in "the cafe's menu" would be enough to break
# the quoting even without anyone trying.
#
# ASCII ONLY, deliberately. Windows PowerShell 5.1 reads a .ps1 as ANSI unless it
# finds a byte-order mark, so a UTF-8 em dash in a comment arrives as two bytes
# of mojibake and can derail the parser several lines later. The first version of
# this file failed with "Missing closing '}'" pointing at a block that was
# perfectly balanced. Keep punctuation plain here.

param(
  [string]$TextFile = "",
  [string]$Out = "",
  [string]$Voice = "",
  [int]$Rate = 0,         # -10 (slowest) to 10 (fastest); 0 is normal
  [switch]$List           # print the installed voice names and exit
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Speech

# Listing lives here rather than in an inline -Command for the same reason the
# text arrives as a file: a script block full of braces has to survive Node's
# argument quoting on the way through, and it does not. Nothing complicated goes
# on a command line.
if ($List) {
  $probe = New-Object System.Speech.Synthesis.SpeechSynthesizer
  $probe.GetInstalledVoices() | ForEach-Object { Write-Output $_.VoiceInfo.Name }
  $probe.Dispose()
  exit 0
}

if (-not $TextFile -or -not $Out) { throw "need -TextFile and -Out, or -List" }

$text = Get-Content -Path $TextFile -Raw -Encoding UTF8
if ([string]::IsNullOrWhiteSpace($text)) { throw "nothing to say" }

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer

# Named voice if one was asked for and it exists; otherwise whatever Windows
# considers its default. Asking for a voice that is not installed throws, and
# going mute because a config file names a voice from another machine would be a
# poor trade for a fallback whose whole job is to be the thing that still works.
if ($Voice) {
  $installed = @($synth.GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name })
  if ($installed -contains $Voice) {
    $synth.SelectVoice($Voice)
  }
  else {
    $have = $installed -join ", "
    Write-Error "voice '$Voice' is not installed. Have: $have"
  }
}

$synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$synth.SetOutputToWaveFile($Out)
$synth.Speak($text)
$synth.Dispose()

# 22050 Hz 16-bit mono - the same shape Piper returns, so nothing downstream has
# to learn a new format.
Write-Output "ok"
