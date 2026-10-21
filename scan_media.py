"""
SANFLIX — Media Scanner
Scans the /media folder, extracts metadata via ffprobe,
generates thumbnails, and outputs database/media_library.json
"""

import os
import sys
import json
import subprocess
import re
import hashlib
import shutil
from pathlib import Path
from generate_thumbnails import generate_thumbnail
from poster_fetcher import artwork_for
from media_utils import AUDIO_EXTENSIONS, MEDIA_EXTENSIONS, VIDEO_EXTENSIONS, atomic_json, contained_path, file_lock

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MEDIA_DIR = os.path.join(BASE_DIR, "media")
DATABASE_DIR = os.path.join(BASE_DIR, "database")
DATABASE_FILE = os.path.join(DATABASE_DIR, "media_library.json")

# Ensure ffmpeg is in PATH
ffmpeg_path = os.path.join(os.environ.get("LOCALAPPDATA", ""), "ffmpegio", "ffmpeg-downloader", "ffmpeg", "bin")
if os.path.exists(ffmpeg_path) and ffmpeg_path not in os.environ.get("PATH", ""):
    os.environ["PATH"] = ffmpeg_path + os.pathsep + os.environ.get("PATH", "")

def generate_id(filepath):
    """Generate a unique ID from the file path."""
    return hashlib.md5(filepath.encode()).hexdigest()[:12]


def format_duration(seconds):
    """Convert seconds to HH:MM:SS format."""
    if seconds is None or seconds <= 0:
        return "00:00:00"
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def format_size(size_bytes):
    """Convert bytes to human-readable format."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    elif size_bytes < 1024 ** 2:
        return f"{size_bytes / 1024:.1f} KB"
    elif size_bytes < 1024 ** 3:
        return f"{size_bytes / (1024**2):.1f} MB"
    else:
        return f"{size_bytes / (1024**3):.2f} GB"


def format_bitrate(bitrate):
    """Convert bitrate to human-readable format."""
    if bitrate is None:
        return "Unknown"
    kbps = int(bitrate) / 1000
    if kbps > 1000:
        return f"{kbps/1000:.1f} Mbps"
    return f"{int(kbps)} kbps"


def get_metadata(filepath):
    """Extract video metadata using ffprobe."""
    try:
        cmd = [
            "ffprobe",
            "-v", "quiet",
            "-print_format", "json",
            "-show_format",
            "-show_streams",
            filepath
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
        if result.returncode != 0:
            return None
        return json.loads(result.stdout)
    except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError) as e:
        print(f"  - Metadata error: {e}")
        return None


def detect_category(filepath):
    """Detect content category from folder structure."""
    if Path(filepath).suffix.lower() in AUDIO_EXTENSIONS:
        return 'music'
    rel_path = os.path.relpath(filepath, MEDIA_DIR).replace("\\", "/")
    parts = rel_path.split("/")

    if len(parts) > 0:
        top_folder = parts[0].lower()
        if top_folder in ("movies", "movie", "films"):
            return "movie"
        elif top_folder in ("series", "shows", "tv", "tvshows"):
            return "series"
        elif top_folder in ("music", "musicvideos", "mv"):
            return "music"
    return "movie"


def detect_series_info(filepath):
    """
    Detect show name, season, and episode from folder structure.
    Expected: media/series/ShowName/Season1/Ep1.mp4
    """
    rel_path = os.path.relpath(filepath, MEDIA_DIR).replace("\\", "/")
    parts = rel_path.split("/")

    info = {"show": None, "season": 1, "episode": None}

    if len(parts) >= 3:
        # parts[0] = "series", parts[1] = ShowName, ...
        info["show"] = parts[1].replace("_", " ").replace("-", " ")

    # Exclude the show folder so numbers in show names are not seasons.
    for part in parts[2:] if len(parts) >= 3 else parts[-1:]:
        season_match = re.search(r'(?i)(?:^|[\s._-])s(?:eason)?[\s._-]*(\d+)', part)
        if season_match:
            info["season"] = int(season_match.group(1))
            break

    # Look for episode number in filename
    filename = os.path.splitext(parts[-1])[0]
    combined = re.search(r'(?i)s(\d+)[\s._-]*e(\d+)', filename)
    if combined:
        info['season'], info['episode'] = map(int, combined.groups())
    ep_match = re.search(r'(?i)(?:^|[\s._-])e(?:p(?:isode)?)?[\s._-]*(\d+)', filename)
    if ep_match:
        info["episode"] = int(ep_match.group(1))
    else:
        # Try S01E01 format
        se_match = re.search(r'[Ss](\d+)[Ee](\d+)', filename)
        if se_match:
            info["season"] = int(se_match.group(1))
            info["episode"] = int(se_match.group(2))

    if not info['show']:
        prefix = re.split(r'(?i)(?:^|[\s._-])(?:s(?:eason)?[\s._-]*\d+|e(?:p(?:isode)?)?[\s._-]*\d+)', filename, maxsplit=1)[0]
        info['show'] = clean_title(prefix) if prefix.strip(' ._-') else 'Unsorted Series'
    return info


def clean_title(filename):
    """Generate a clean title from filename."""
    name = os.path.splitext(filename)[0]
    # Remove common patterns like S01E01, resolution, codec info
    name = re.sub(r'[Ss]\d+[Ee]\d+', '', name)
    name = re.sub(r'\b(1080p|720p|480p|2160p|4k|x264|x265|hevc|aac|bluray|webrip|hdtv)\b', '', name, flags=re.IGNORECASE)
    # Replace separators with spaces
    name = re.sub(r'[._\-\[\]\(\)]', ' ', name)
    name = re.sub(r'\s+', ' ', name).strip()
    return name if name else filename


def scan_media():
    """Serialize both server-triggered and standalone scans across processes."""
    with file_lock(os.path.join(DATABASE_DIR, '.scan.lock')):
        return _scan_media()


def _scan_media():
    """Scan the media directory and build the library."""
    print("=" * 60)

    if not shutil.which('ffprobe') or not shutil.which('ffmpeg'):
        raise RuntimeError('Install FFmpeg and FFprobe before scanning. Existing catalog was kept.')
    print("  SANFLIX Media Scanner")
    print("=" * 60)

    if not os.path.exists(MEDIA_DIR):
        os.makedirs(MEDIA_DIR, exist_ok=True)
        os.makedirs(os.path.join(MEDIA_DIR, "movies"), exist_ok=True)
        os.makedirs(os.path.join(MEDIA_DIR, "series"), exist_ok=True)
        os.makedirs(os.path.join(MEDIA_DIR, "music"), exist_ok=True)
        print(f"\n[+] Created media directories at: {MEDIA_DIR}")
        print("   Place your video files in:")
        print("     media/movies/    - for movies")
        print("     media/series/    - for TV series")
        print("     media/music/     - for music videos")

    library = []
    video_count = 0

    print(f"\n[*] Scanning: {MEDIA_DIR}\n")

    for root, dirs, files in os.walk(MEDIA_DIR):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and not os.path.islink(os.path.join(root, d)))
        for filename in sorted(files):
            ext = os.path.splitext(filename)[1].lower()
            if filename.startswith('.') or ext not in MEDIA_EXTENSIONS:
                continue

            filepath = os.path.join(root, filename)
            try:
                contained_path(MEDIA_DIR, filepath)
            except ValueError:
                continue
            rel_path = os.path.relpath(filepath, BASE_DIR).replace("\\", "/")
            video_count += 1

            print(f"[{video_count}] {filename}")

            # Get metadata
            metadata = get_metadata(filepath)
            if not metadata or not any(s.get('codec_type') in {'video', 'audio'} for s in metadata.get('streams', [])):
                print('  - Skipping unreadable media')
                continue
            category = detect_category(filepath)

            # Extract info from ffprobe
            duration = None
            resolution = "Unknown"
            bitrate = None
            codec = "Unknown"

            if metadata:
                # Duration
                fmt = metadata.get("format", {})
                dur_str = fmt.get("duration")
                if dur_str:
                    try:
                        duration = float(dur_str)
                    except ValueError:
                        pass

                # Bitrate from format
                br = fmt.get("bit_rate")
                if br:
                    try:
                        bitrate = int(br)
                    except ValueError:
                        pass

                # Video stream info
                for stream in metadata.get("streams", []):
                    if stream.get("codec_type") == "video" and not stream.get('disposition', {}).get('attached_pic'):
                        w = stream.get("width")
                        h = stream.get("height")
                        if w and h:
                            resolution = f"{w}x{h}"
                        codec = stream.get("codec_name", "Unknown")
                        break

            audio_only = ext in AUDIO_EXTENSIONS
            if audio_only:
                codec = next((s.get('codec_name', 'Unknown') for s in metadata.get('streams', [])
                              if s.get('codec_type') == 'audio'), 'Unknown')
                resolution = 'Audio'

            # File size
            file_size = os.path.getsize(filepath)

            # Generate thumbnail
            thumbnail = None if audio_only else generate_thumbnail(filepath, duration_seconds=duration)

            # Build entry
            entry = {
                "id": generate_id(rel_path),
                "title": clean_title(filename),
                "file": rel_path,
                "filename": filename,
                "duration": format_duration(duration) if duration else "Unknown",
                "duration_seconds": duration or 0,
                "resolution": resolution,
                "bitrate": format_bitrate(bitrate),
                "codec": codec,
                "size": format_size(file_size),
                "size_bytes": file_size,
                "thumbnail": thumbnail,
                "category": category,
                "media_type": 'audio' if audio_only else 'video'
            }

            # Series-specific info
            if category == "series":
                series_info = detect_series_info(filepath)
                entry["show"] = series_info["show"]
                entry["season"] = series_info["season"]
                entry["episode"] = series_info["episode"]
                if series_info["show"]:
                    entry["title"] = f"Episode {series_info['episode']}" if series_info["episode"] else clean_title(filename)

            if not audio_only:
                entry.update(artwork_for(entry))

            library.append(entry)
            print(f"  + {category} | {resolution} | {format_duration(duration) if duration else 'Unknown'}")
            print()

    # Save library
    os.makedirs(DATABASE_DIR, exist_ok=True)
    atomic_json(DATABASE_FILE, library)

    print("=" * 60)
    print(f"  Scan complete!")
    print(f"  Videos found: {video_count}")
    print(f"  Database saved: {DATABASE_FILE}")
    print("=" * 60)

    return library


if __name__ == "__main__":
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    scan_media()
