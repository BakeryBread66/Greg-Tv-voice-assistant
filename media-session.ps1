# What Windows itself thinks is playing, for anything at all.
#
# Greg's `whats_playing` needed the Spotify Web API and a live token. Windows
# already knows, for every app that registers transport controls — Spotify, a
# YouTube tab, VLC, a game's soundtrack — through
#
#   Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager
#
# No OAuth, no account, no Premium, and it keeps working with a dead token.
# It also carries the album art, which is the most television-looking thing
# available to put on a CRT.
#
# A loop rather than a call per reading, for the same reason as cursor-watch.ps1:
# starting PowerShell costs ~300 ms and the C# compile below costs a second more,
# so the process has to stay up to be worth having. Node spawns it when the
# now-playing channel is on and kills it when nothing is asking.
#
# One JSON object per line on stdout, written only when something has actually
# changed.

$ErrorActionPreference = 'Stop'

# Titles are routinely not ASCII. Without this they arrive at Node as mojibake.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]

# ---------------------------------------------------------------------------
# The WinRT async plumbing
#
# AsTask has several overloads. The one that takes a single IAsyncOperation`1 is
# generic over the result type, so it cannot be called directly from PowerShell —
# it has to be found by reflection and made generic per result type. This is the
# whole trick; everything else is ordinary property reads.
# ---------------------------------------------------------------------------

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
})[0]

function Await($operation, $resultType) {
    $method = $asTaskGeneric.MakeGenericMethod($resultType)
    $task = $method.Invoke($null, @($operation))
    if (-not $task.Wait(6000)) { throw 'the media session did not answer in time' }
    $task.Result
}

$managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]

# ---------------------------------------------------------------------------
# Album art
#
# The metadata above comes back as projected .NET objects. The thumbnail does
# not: OpenReadAsync returns an INTERFACE, and PowerShell hands that back as a
# bare System.__ComObject with no methods on it and no way to cast to one — every
# route through the pipeline (explicit cast, AsStreamForRead, passing it to
# DataReader, RandomAccessStream::CopyAsync) fails on the same wall.
#
# C# has no such problem, so the thumbnail read is compiled. It needs the Windows
# SDK metadata, which the metadata path above does NOT — so this is optional and
# its absence costs the picture, not the channel. Two traps if you touch it:
#
#   * Add-Type cannot -ReferencedAssemblies a .winmd (it tries Assembly.Load on
#     it first and that always fails), so csc.exe is driven directly.
#   * The winmd needs System.Runtime as well, or you get a bare CS0012 about
#     System.Attribute that says nothing about the real cause.
# ---------------------------------------------------------------------------

# Bumped when the C# below changes, so a cached build can never be stale.
$artDllVersion = 1
$artReady = $false

function Initialize-Art {
    $wrt = [AppDomain]::CurrentDomain.GetAssemblies() |
        Where-Object { $_.GetName().Name -eq 'System.Runtime.WindowsRuntime' } | Select-Object -First 1
    if (-not $wrt) { return $false }

    $cache = Join-Path $PSScriptRoot 'cache'
    if (-not (Test-Path $cache)) { $null = New-Item -ItemType Directory -Path $cache }
    $dll = Join-Path $cache "greg-media-art-v$artDllVersion.dll"

    if (-not (Test-Path $dll)) {
        # "Facade" also holds a Windows.WinMD and it is a type-forwarding stub,
        # not the real metadata — take the highest numbered SDK instead.
        $winmd = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\UnionMetadata\*\Windows.winmd' -ErrorAction SilentlyContinue |
            Where-Object { $_.Directory.Name -match '^\d' } |
            Sort-Object { [version]$_.Directory.Name } -Descending | Select-Object -First 1
        if (-not $winmd) { return $false }

        $sysRuntime = Get-ChildItem 'C:\Windows\Microsoft.Net\assembly\GAC_MSIL\System.Runtime\*\System.Runtime.dll' -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $sysRuntime) { return $false }

        $csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
        if (-not (Test-Path $csc)) { return $false }

        $source = Join-Path $cache "greg-media-art-v$artDllVersion.cs"
        $code = @'
using System;
using System.Threading.Tasks;
using Windows.Media.Control;
using Windows.Storage.Streams;

public static class GregMediaArt
{
    static async Task<byte[]> ReadAsync()
    {
        var manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
        var session = manager.GetCurrentSession();
        if (session == null) return null;

        var props = await session.TryGetMediaPropertiesAsync();
        if (props == null || props.Thumbnail == null) return null;

        using (var stream = await props.Thumbnail.OpenReadAsync())
        {
            var size = (uint)stream.Size;
            if (size == 0) return null;
            var reader = new DataReader(stream.GetInputStreamAt(0));
            await reader.LoadAsync(size);
            var bytes = new byte[size];
            reader.ReadBytes(bytes);
            return bytes;
        }
    }

    public static byte[] Read()
    {
        var task = ReadAsync();
        return task.Wait(6000) ? task.Result : null;
    }
}
'@
        [IO.File]::WriteAllText($source, $code, (New-Object System.Text.UTF8Encoding $false))

        $null = & $csc /nologo /target:library /out:"$dll" `
            /reference:"$($winmd.FullName)" /reference:"$($wrt.Location)" /reference:"$($sysRuntime.FullName)" "$source" 2>&1
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $dll)) { return $false }
    }

    Add-Type -Path $dll
    return $true
}

try {
    $artReady = Initialize-Art
} catch {
    $artReady = $false
}
if (-not $artReady) {
    [Console]::Error.WriteLine('no album art: the Windows SDK metadata or the C# compiler is missing')
}

# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------

$manager = Await ($managerType::RequestAsync()) $managerType

$lastState = ''
$lastTrack = ''
$lastAt = 0

while ($true) {
    $payload = $null

    try {
        $session = $manager.GetCurrentSession()
        if ($session) {
            $props = Await ($session.TryGetMediaPropertiesAsync()) $propsType
            $info = $session.GetPlaybackInfo()
            $timeline = $session.GetTimelineProperties()

            $payload = [ordered]@{
                playing  = $true
                title    = [string]$props.Title
                artist   = [string]$props.Artist
                album    = [string]$props.AlbumTitle
                # Podcasts and videos come back with a PlaybackType that is not
                # Music, which is worth knowing: an episode has no album and its
                # "artist" is the show.
                kind     = [string]$props.PlaybackType
                app      = [string]$session.SourceAppUserModelId
                status   = [string]$info.PlaybackStatus
                position = [math]::Round($timeline.Position.TotalSeconds, 1)
                duration = [math]::Round($timeline.EndTime.TotalSeconds, 1)
                at       = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
            }
        }
    } catch {
        # A session closing mid-read throws. Next tick will pick up whatever
        # replaced it; one dropped reading costs nothing.
        $payload = $null
    }

    if (-not $payload) {
        $payload = [ordered]@{ playing = $false; at = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
    }

    # What counts as "changed". Position is deliberately excluded — it moves
    # every tick by definition, and the browser interpolates it from `at`
    # anyway, so including it would make this write a line per second forever.
    $track = "$($payload.app)|$($payload.title)|$($payload.artist)|$($payload.album)"
    $state = "$track|$($payload.status)|$($payload.playing)"

    # Seeking and pausing both jump the position, and neither shows up in the
    # state key, so send a reading every few seconds regardless to keep the
    # browser's interpolation honest.
    $stale = ($payload.at - $lastAt) -gt 4000

    if ($state -ne $lastState -or $stale) {
        if ($artReady -and $payload.playing -and $track -ne $lastTrack) {
            try {
                $bytes = [GregMediaArt]::Read()
                # An empty string says "this track has no art", which is a
                # different fact from "no art was read this tick" and has to
                # clear the picture rather than leave the last one up.
                $payload['art'] = if ($bytes -and $bytes.Length) { [Convert]::ToBase64String($bytes) } else { '' }
            } catch {
                # Leave `art` absent — the reader keeps whatever it had.
            }
        }

        [Console]::Out.WriteLine(($payload | ConvertTo-Json -Compress -Depth 3))
        [Console]::Out.Flush()
        $lastState = $state
        $lastTrack = $track
        $lastAt = $payload.at
    }

    Start-Sleep -Milliseconds 900
}
