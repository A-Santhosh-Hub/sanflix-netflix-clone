"""
SANFLIX — Thumbnail Generator
Captures a landscape frame beyond opening logos using FFmpeg.
"""

import os
import subprocess
import re
import hashlib
import json
import tempfile
from media_utils import fingerprint


THUMBNAILS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "thumbnails")

# Ensure ffmpeg is in PATH
ffmpeg_path = os.path.join(os.environ.get("LOCALAPPDATA", ""), "ffmpegio", "ffmpeg-downloader", "ffmpeg", "bin")
if os.path.exists(ffmpeg_path) and ffmpeg_path not in os.environ.get("PATH", ""):
    os.environ["PATH"] = ffmpeg_path + os.pathsep + os.environ.get("PATH", "")


def sanitize_filename(name):
    """Create a safe filename from a string."""
    name = os.path.splitext(os.path.basename(name))[0]
    name = re.sub(r'[^\w\s-]', '', name)
    name = re.sub(r'[\s]+', '_', name).strip('_')
    return name.lower()


def generate_thumbnail(video_path, output_dir=None, duration_seconds=None):
    """
    Generate a thumbnail for a video file.
    Captures a frame 15% into the video when its duration is known.
    Returns the relative path to the thumbnail.
    """
    if output_dir is None:
        output_dir = THUMBNAILS_DIR

    os.makedirs(output_dir, exist_ok=True)

    # Include path and source version: no collisions or stale replacement art.
    try:
        relative = os.path.relpath(video_path, os.path.dirname(os.path.abspath(__file__))).replace('\\', '/')
    except ValueError:  # Standalone calls may supply media on a different drive.
        relative = os.path.realpath(video_path).replace('\\', '/')
    identity = 'landscape-v2:' + relative + json.dumps(fingerprint(video_path), sort_keys=True)
    thumbnail_filename = hashlib.sha256(identity.encode('utf-8')).hexdigest()[:24] + '.jpg'
    thumbnail_path = os.path.join(output_dir, thumbnail_filename)

    # Skip if thumbnail already exists
    if os.path.exists(thumbnail_path) and os.path.getsize(thumbnail_path) > 0:
        return f"thumbnails/{thumbnail_filename}"

    fd, temporary = tempfile.mkstemp(suffix='.jpg', dir=output_dir)
    os.close(fd)
    # Use the scanner's existing duration probe. Keep old cached artwork intact.
    preferred = min(900, max(0, float(duration_seconds) * 0.15)) if duration_seconds else 10
    for seek_time in [str(preferred), "1", "0"]:
        try:
            cmd = [
                "ffmpeg",
                "-ss", seek_time,
                "-i", video_path,
                "-frames:v", "1",
                "-q:v", "2",
                "-vf", "scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,setsar=1",
                "-y",
                temporary
            ]
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                encoding='utf-8', errors='replace',
                timeout=30
            )
            if result.returncode == 0 and os.path.getsize(temporary) > 0:
                os.replace(temporary, thumbnail_path)
                print(f"  + Thumbnail: {thumbnail_filename}")
                return f"thumbnails/{thumbnail_filename}"
        except subprocess.TimeoutExpired:
            continue
        except Exception as e:
            print(f"  - Thumbnail error: {e}")
            continue

    if os.path.exists(temporary):
        os.unlink(temporary)
    print(f"  - Failed to generate thumbnail for: {os.path.basename(video_path)}")
    return None


if __name__ == "__main__":
    import sys
    if len(sys.argv) > 1:
        result = generate_thumbnail(sys.argv[1])
        if result:
            print(f"Thumbnail saved: {result}")
        else:
            print("Failed to generate thumbnail")
    else:
        print("Usage: python generate_thumbnails.py <video_path>")
