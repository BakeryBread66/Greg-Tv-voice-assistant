# Press a media key, the way a keyboard would.
#
# Windows routes these to whichever application currently owns media playback,
# so with Spotify open they land on Spotify without Greg needing to know
# anything about it — no account, no API, no setup. That's the point: this works
# on a free account and before any of the Spotify integration is configured.
#
# The trade is that it can only drive what's already queued. Playing a specific
# song needs the Web API; see lib/spotify.js.

param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("playpause", "next", "previous", "stop", "volumeup", "volumedown", "mute")]
  [string]$Key
)

$ErrorActionPreference = "Stop"

# Virtual-key codes for the media keys on a keyboard.
$CODES = @{
  playpause  = 0xB3
  next       = 0xB0
  previous   = 0xB1
  stop       = 0xB2
  volumeup   = 0xAF
  volumedown = 0xAE
  mute       = 0xAD
}

# SendKeys can't reach these, so go through the Win32 call a real keypress uses.
Add-Type -Name Keyboard -Namespace Greg -MemberDefinition @'
[DllImport("user32.dll")]
public static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, System.UIntPtr extraInfo);
'@

$code = [byte]$CODES[$Key]
$KEYUP = [uint32]2

# Down then up. Sending only the down event leaves the key logically held.
[Greg.Keyboard]::keybd_event($code, 0, 0, [System.UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[Greg.Keyboard]::keybd_event($code, 0, $KEYUP, [System.UIntPtr]::Zero)

Write-Output "sent $Key"
