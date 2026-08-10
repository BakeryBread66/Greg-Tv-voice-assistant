# Where the mouse actually is, on the whole desktop.
#
# The browser only knows the pointer while it is inside its own window, so Greg's
# head froze at whatever angle it held as the cursor crossed the edge. Windows
# knows where it went. Node spawns this, reads the stream, and serves the latest
# position to the face.
#
# A loop rather than a call per reading: spawning PowerShell costs ~300 ms and
# reading the position costs 11, so the process has to stay up to be worth having.

Add-Type -AssemblyName System.Windows.Forms

# 25 Hz. The head eases toward its target rather than snapping, so a faster
# stream buys nothing visible and costs CPU for as long as the watcher runs.
$intervalMs = 40
$last = ''

while ($true) {
    $p = [System.Windows.Forms.Cursor]::Position
    $line = "$($p.X),$($p.Y)"

    # Don't write when nothing moved. A still mouse is the common case, and this
    # keeps an idle watcher almost free.
    if ($line -ne $last) {
        [Console]::Out.WriteLine($line)
        [Console]::Out.Flush()
        $last = $line
    }

    Start-Sleep -Milliseconds $intervalMs
}
