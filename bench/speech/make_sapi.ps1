# The speech benchmark's clips in Windows' own two voices (David and Zira), to
# go beside make_corpus.py's six Piper voices. 16 kHz mono 16-bit, like the page.
# ASCII only: Windows PowerShell 5.1 reads a .ps1 without a BOM as ANSI.
#   powershell -NoProfile -ExecutionPolicy Bypass -File make_sapi.ps1

$dir = $PSScriptRoot
$phrases = Get-Content (Join-Path $dir "phrases.json") -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force (Join-Path $dir "clips") | Out-Null
Add-Type -AssemblyName System.Speech
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($v in @("Microsoft David Desktop", "Microsoft Zira Desktop")) {
  $tag = if ($v -like "*David*") { "sapi-david" } else { "sapi-zira" }
  for ($i = 0; $i -lt $phrases.Count; $i++) {
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SelectVoice($v)
    $s.SetOutputToWaveFile(("{0}\clips\{1}__{2:D2}.wav" -f $dir, $tag, $i), $fmt)
    $s.Speak($phrases[$i])
    $s.Dispose()
  }
  "$tag done"
}
