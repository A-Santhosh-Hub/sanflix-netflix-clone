# Playback timing and performance

## What changed

The player uses a single HTML video element for both sound and picture. Direct
playback serves the original file with HTTP range requests. MKV and unsupported
codecs can instead require FFmpeg to remux or transcode into fragmented MP4.

The live MP4 command used `empty_moov`, which writes the initial track metadata
before the muxer has the timing needed for edit lists. In a local H.264/AC3 movie,
the first encoded AAC packet claimed **83 ms at startup** and **916 ms after a
seek**, although an AAC frame at 48 kHz contains about **21.33 ms** of audio.
This is a malformed initial sample interval and a potential browser playback
problem. A generated flash/tone fixture also showed that a non-keyframe seek
could replay the preceding video interval while the player reported the requested
position.

The command now uses `delay_moov` with edit lists. It retains the common source
timeline and represents video pre-roll and AAC encoder delay correctly. The same
local sample now has normal 21.33 ms audio packet durations at startup and after
seeking. Fragments are capped at one second to avoid waiting for a long video GOP
before delivering data. Transcoded video preserves source frame timing and gets
regular keyframes. The player also retains fractional seek positions.

This follows FFmpeg's documented [fragmented MP4 options](https://ffmpeg.org/ffmpeg-formats.html#mov_002c-mp4_002c-ismv)
and [input seeking behavior](https://ffmpeg.org/ffmpeg.html#Main-options). No guessed
audio delay or independent audio/video timestamp reset is applied.

## Large and 4K files

Local playback previously ignored ready HLS caches and could start a new live
conversion unnecessarily. Ready HLS is now preferred when a file otherwise needs
remuxing or transcoding. Compatible local originals still use direct playback.
Browsers without HLS support fall back to the normal stream.

Live CPU conversion of an eight-second portion of the local 4K HEVC sample took
9.58 seconds at full resolution, versus 6.72 seconds when scaled to 1080p. Those
short measurements include startup and seeking, with background work running;
they are not a sustained throughput guarantee. They do show why this machine can
struggle to convert full-resolution video while displaying it.

Live compatibility encoding is now bounded to 1920 × 1080, preserves aspect ratio,
and does not upscale smaller sources. The player labels this mode. Original files,
direct playback, and the existing resolution of prepared HLS are unchanged.
Prepared HLS avoids the cost of live encoding; its video still needs to be decoded
by the viewing device. Existing completed caches do not need rebuilding for the
live MP4 timing fix.

Background HLS conversion no longer has a fixed two-hour processing deadline.
The existing shared conversion lock still allows only one background job at a
time. A long conversion can finish normally; it is not forcibly stopped just
because the movie is unusually long.

## Activate the update

1. Stop the running Flask server with **Ctrl+C** in its terminal.
2. Run `python app.py` from the project folder. Avoid starting another server beside it.
3. Hard-refresh the browser with **Ctrl+F5**, then reopen the movie.
4. For a demanding movie, use the player's **HLS** button to prepare it once. If a
   background conversion is already running, the panel shows its progress.

If no fixed admin password is configured, a server restart generates a new password
and prints it in that terminal, as before. Original media was not modified by this fix.

## Verification

- Python: **32 tests passed**, including real FFmpeg conversion and decoding.
- JavaScript: **26 tests passed**, using DOM/media doubles.
- New checks decode a synchronized flash/tone at startup and after a non-keyframe
  seek through both live paths, verify normal AAC packet intervals, and preserve an
  intentional 350 ms source track offset.
- Checks cover prepared-stream selection locally, fractional progress, HLS fallback,
  and actual 4K-to-1080p output dimensions without upscaling small portrait video.
- The local H.264/AC3 startup and seek packet measurements were repeated with the fix.

An actual browser playback session was not available to this automation. These
checks do not certify lip-sync in every movie, browser, or a complete ten-hour
viewing session. After restarting, verify the affected movie from the beginning,
after a seek, and for several minutes. If direct playback still drops frames,
device decoding capacity or the source itself needs separate investigation.
