# Capture ONLY Greg's window. A DEVELOPMENT TOOL, not part of Greg.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File grab-window.ps1 -Out shot.png
#
# It exists because looking at the thing you built is the one check this project
# could never make. Six sessions shipped visual work verified by rendering
# offscreen and reading pixels back, which proves the renderer and not the
# window. This proves the window.
#
# The traps here are all recorded in CLAUDE.md, from the session this defeated:
#
#   - Process.MainWindowHandle is wrong for Chrome. One chrome.exe owns many
#     windows and the "main" one it reports was 330 px away from the window
#     actually titled Greg. Use EnumWindows.
#   - EnumWindows finds several windows matching "Greg" - app windows, the
#     console, an Explorer folder, and two minimised at -32000.
#   - CopyFromScreen takes VIRTUAL-screen coordinates, and the virtual origin on
#     this machine is not (0, 0).
#   - Whatever you capture is somebody's real desktop. This crops to the window
#     rect and never writes a full-desktop image at all.
#
# ASCII only: PowerShell 5.1 reads a .ps1 as ANSI without a BOM, and a UTF-8 dash
# in a comment derails the parser lines later.

param([Parameter(Mandatory = $true)][string]$Out)

$ErrorActionPreference = "Stop"

# DPI awareness FIRST, before any drawing or window call.
#
# Without it the process gets virtualized coordinates: a 4K panel at 225 percent
# scaling is reported as 1707x960. GetWindowRect then hands back
# logical pixels while CopyFromScreen reads physical ones, so the capture lands
# somewhere near the window and takes a picture of the desktop beside it. That is
# exactly the failure CLAUDE.md records from the session this defeated, and the
# cause was never identified at the time.
$dpi = @'
using System;
using System.Runtime.InteropServices;
public class Dpi {
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
  public static void Aware() {
    // -4 is PER_MONITOR_AWARE_V2. Falls back for older Windows.
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch {}
    try { SetProcessDPIAware(); } catch {}
  }
}
'@
Add-Type -TypeDefinition $dpi
[Dpi]::Aware()

Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public class WinFind {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);

  public delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public class Win { public string Title; public int X, Y, W, H; public bool Minimised; }

  public static List<Win> Find(string needle) {
    var found = new List<Win>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      int len = GetWindowTextLength(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowText(h, sb, sb.Capacity);
      string title = sb.ToString();
      if (title.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) return true;
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      found.Add(new Win {
        Title = title, X = r.Left, Y = r.Top,
        W = r.Right - r.Left, H = r.Bottom - r.Top,
        Minimised = IsIconic(h)
      });
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing

$all = [WinFind]::Find("Greg")

Write-Output "--- every visible window matching 'Greg' ---"
foreach ($w in $all) {
  Write-Output ("  {0,-42} {1,6},{2,-6} {3}x{4}{5}" -f $w.Title.Substring(0, [Math]::Min(42, $w.Title.Length)), $w.X, $w.Y, $w.W, $w.H, $(if ($w.Minimised) { "  MINIMISED" } else { "" }))
}

# The app window, not the console and not a folder: not minimised, sane size,
# and taller than it is wide is a strong signal here - the face column is tall.
$best = $all |
  Where-Object { -not $_.Minimised -and $_.X -gt -30000 -and $_.W -gt 200 -and $_.H -gt 200 } |
  Sort-Object -Property @{ Expression = { $_.H } } -Descending |
  Select-Object -First 1

if (-not $best) { throw "no on-screen window titled Greg - is his window open and not minimised?" }

Write-Output ""
Write-Output ("chosen: '{0}' at {1},{2} size {3}x{4}" -f $best.Title, $best.X, $best.Y, $best.W, $best.H)

# Straight from the screen into a bitmap the size of the window. No full-desktop
# image is ever created, so there is nothing of the rest of the screen to leak.
$bmp = New-Object System.Drawing.Bitmap $best.W, $best.H
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($best.X, $best.Y, 0, 0, (New-Object System.Drawing.Size($best.W, $best.H)))
$g.Dispose()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()

Write-Output ("saved {0}x{1}" -f $best.W, $best.H)
