"""Prepare persistent HLS streams. Uses the same queue and cache as the server."""
import os
import sys
import subprocess
import time
import threading
from pathlib import Path
import hls_manager
from media_utils import BASE_DIR, VIDEO_EXTENSIONS, MEDIA_EXTENSIONS, contained_path, media_id

MEDIA_DIR = str(BASE_DIR / 'media')
HLS_DIR = str(BASE_DIR / 'hls_cache')
ffmpeg_path = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'ffmpegio', 'ffmpeg-downloader', 'ffmpeg', 'bin')
if os.path.isdir(ffmpeg_path) and ffmpeg_path not in os.environ.get('PATH', ''):
    os.environ['PATH'] = ffmpeg_path + os.pathsep + os.environ.get('PATH', '')

def generate_id(filepath):
    return media_id(os.path.relpath(filepath, BASE_DIR).replace(chr(92), '/'))

def get_hls_dir(item_id):
    return str(hls_manager.cache_dir(HLS_DIR, item_id))

def hls_is_ready(item_id, filepath=None):
    return hls_manager.playlist_ready(HLS_DIR, item_id, filepath)

def detect_gpu_encoder():
    """
    Try to detect available hardware encoder.
    Returns encoder name or None if only CPU available.
    """
    encoders_to_try = [
        ("h264_nvenc",  "NVIDIA GPU"),   # NVIDIA
        ("h264_amf",    "AMD GPU"),       # AMD
        ("h264_qsv",    "Intel GPU"),     # Intel Quick Sync
    ]

    test_cmd_base = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", "nullsrc=s=128x128",
        "-frames:v", "1", "-an"
    ]

    for encoder, name in encoders_to_try:
        try:
            cmd = test_cmd_base + ["-c:v", encoder, "-f", "null", "-"]
            result = subprocess.run(
                cmd,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=10
            )
            if result.returncode == 0:
                return encoder, name
        except Exception:
            pass
    return None, None

def convert_to_hls(filepath, item_id, index=1, total=1, gpu_encoder=None, gpu_name=None, force=False):
    print(f'[{index}/{total}] {Path(filepath).name}', flush=True)
    if not force and hls_is_ready(item_id, filepath):
        print('  Already converted.')
        return True
    started = time.monotonic()
    finished = threading.Event()
    def progress():
        while not finished.wait(5):
            try:
                status = hls_manager.job_status(HLS_DIR, item_id, filepath)
                print(f'  {status["status"]}: {status.get("segments_ready", 0)} segments, '
                      f'{time.monotonic() - started:.0f}s elapsed', flush=True)
            except OSError:
                pass
    reporter = threading.Thread(target=progress, daemon=True)
    reporter.start()
    try:
        hls_manager.convert(HLS_DIR, item_id, filepath, force=force, gpu_encoder=gpu_encoder)
        print(f'  Ready ({time.monotonic() - started:.0f}s).', flush=True)
        return True
    except Exception as exc:
        print(f'  Conversion failed: {exc}', flush=True)
        return False
    finally:
        finished.set()
        reporter.join(timeout=1)

def find_all_videos():
    files = []
    for folder, dirs, names in os.walk(MEDIA_DIR):
        dirs[:] = sorted(d for d in dirs if not d.startswith('.') and not os.path.islink(os.path.join(folder, d)))
        for name in sorted(names):
            if name.startswith('.') or Path(name).suffix.lower() not in MEDIA_EXTENSIONS:
                continue
            try:
                files.append(contained_path(MEDIA_DIR, os.path.join(folder, name)))
            except ValueError:
                continue
    return files

def convert_all(force=False):
    videos = find_all_videos()
    if not videos:
        print('No media found.')
        return 0, 0, 0
    gpu_encoder, gpu_name = detect_gpu_encoder()
    print(f'SANFLIX HLS converter: {len(videos)} files. Encoder: {gpu_name or "CPU"}.', flush=True)
    done = skipped = failed = 0
    for index, filepath in enumerate(videos, 1):
        item_id = generate_id(filepath)
        if not force and hls_is_ready(item_id, filepath):
            skipped += 1
            continue
        if convert_to_hls(filepath, item_id, index, len(videos), gpu_encoder, gpu_name, force=force):
            done += 1
        else:
            failed += 1
    print(f'Converted: {done}; reused: {skipped}; failed: {failed}.')
    return done, skipped, failed

if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    _, _, failed = convert_all(force='--force' in sys.argv or '-f' in sys.argv)
    raise SystemExit(1 if failed else 0)
