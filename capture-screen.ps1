# Greg's eyes: one screenshot, downscaled, saved as PNG.
#
# Node runs this on demand when the look_at_screen tool fires. The image goes to
# the local model and nowhere else — same rule as the microphone.
#
# Downscaling is not just about speed. A 4K screenshot is mostly wasted detail to
# a vision model, and the smaller image is the difference between a few seconds
# and quite a lot of them.

# MaxWidth 0 means "don't downscale" — that's what saving a screenshot for the
# user wants, as opposed to feeding one to a vision model.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$MaxWidth = 1280,
  [string]$Display = "primary"
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

# "all" spans every monitor as one image; "primary" is just the main one.
if ($Display -eq "all") {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
} else {
  $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
}

$shot = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($shot)
$graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$graphics.Dispose()

if ($MaxWidth -gt 0 -and $shot.Width -gt $MaxWidth) {
  $scale = $MaxWidth / $shot.Width
  $width = [int]($shot.Width * $scale)
  $height = [int]($shot.Height * $scale)

  $small = New-Object System.Drawing.Bitmap $width, $height
  $resizer = [System.Drawing.Graphics]::FromImage($small)
  # Bicubic rather than the default: on-screen text turns to mush otherwise, and
  # reading text off the screen is most of what this is for.
  $resizer.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $resizer.DrawImage($shot, 0, 0, $width, $height)
  $resizer.Dispose()

  $shot.Dispose()
  $shot = $small
}

# PNG, not JPEG: compression artefacts land hardest on small text.
$shot.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)

# The image size, then WHERE on the virtual desktop it was taken from. The second
# is what lets Greg say whether his own window was in shot — the browser reports
# its position in these same coordinates, and on a multi-monitor machine "the
# primary screen" is very often not the one he is sitting on.
Write-Output "$($shot.Width)x$($shot.Height)"
Write-Output "bounds=$($bounds.X),$($bounds.Y),$($bounds.Width),$($bounds.Height)"
$shot.Dispose()
