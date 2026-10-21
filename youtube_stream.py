"""Resolve public YouTube media for the local TV player; never save video files."""
import json
import re
import subprocess
import sys
import threading
import time
from urllib.parse import urlsplit

_cache = {}
_lock = threading.Lock()
_resolver = threading.BoundedSemaphore(1)


class StreamUnavailable(Exception):
    pass


def validate(video_id, quality):
    if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video_id) or quality not in (144, 360, 720):
        raise ValueError('Choose a valid video and quality.')


def safe_media_url(url):
    try:
        parsed = urlsplit(url or '')
        return (parsed.scheme == 'https' and parsed.hostname is not None
                and parsed.hostname.endswith('.googlevideo.com')
                and not parsed.username and not parsed.password and parsed.port in (None, 443))
    except ValueError:
        return False


def select_streams(info, quality):
    if info.get('is_live') or info.get('live_status') in {'is_live', 'is_upcoming'}:
        raise StreamUnavailable('Live broadcasts are not supported in the TV player. Choose a recorded lesson.')
    formats = [f for f in info.get('formats', []) if f.get('protocol') == 'https'
               and not f.get('has_drm') and safe_media_url(f.get('url'))]
    video = [f for f in formats if str(f.get('vcodec', '')).startswith('avc1')
             and 0 < (f.get('height') or 0) <= quality and f.get('acodec') == 'none']
    audio = [f for f in formats if f.get('vcodec') == 'none'
             and str(f.get('acodec', '')).startswith('mp4a')]
    combined = [f for f in formats if str(f.get('vcodec', '')).startswith('avc1')
                and str(f.get('acodec', '')).startswith('mp4a')
                and 0 < (f.get('height') or 0) <= quality]
    if video and audio:
        selected_video = max(video, key=lambda f: (f['height'], f.get('tbr') or 0))
        selected_audio = min(audio, key=lambda f: (not str(f.get('acodec')).startswith('mp4a.40.2'),
                                                  f.get('abr') or 999))
        inputs = [selected_video, selected_audio]
    elif combined:
        selected_video = max(combined, key=lambda f: f['height'])
        inputs = [selected_video]
    else:
        raise StreamUnavailable('No compatible stream is available at this quality. Try another quality or video.')
    duration = float(info.get('duration') or 0)
    if duration <= 0:
        raise StreamUnavailable('This video has no usable duration.')
    return {'title': str(info.get('title') or 'YouTube lesson'), 'duration': duration,
            'height': selected_video['height'], 'inputs': inputs}


def resolve(video_id, quality=360):
    validate(video_id, quality)
    key = (video_id, quality)
    with _lock:
        saved = _cache.get(key)
        if saved and time.monotonic() - saved[0] < 300:
            return saved[1]
    if not _resolver.acquire(blocking=False):
        raise StreamUnavailable('Another lesson is being prepared. Please retry in a moment.')
    try:
        command = [sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-cache-dir',
                   '--js-runtimes', 'node', '--no-playlist', '--skip-download', '--dump-single-json',
                   '--socket-timeout', '10', '--retries', '0', '--extractor-retries', '0',
                   'https://www.youtube.com/watch?v=' + video_id]
        try:
            result = subprocess.run(command, capture_output=True, text=True, encoding='utf-8',
                                    errors='replace', timeout=60)
        except (OSError, subprocess.TimeoutExpired) as error:
            raise StreamUnavailable('Could not prepare the lesson. Check the server internet connection and retry.') from error
        if result.returncode:
            raise StreamUnavailable('YouTube did not provide a playable public stream. Try another video. '
                                    'The server may need an updated yt-dlp installation.')
        try:
            media = select_streams(json.loads(result.stdout), quality)
        except (ValueError, TypeError, KeyError) as error:
            raise StreamUnavailable('YouTube returned an unreadable stream description.') from error
        with _lock:
            if len(_cache) >= 20:
                _cache.clear()
            _cache[key] = (time.monotonic(), media)
        return media
    finally:
        _resolver.release()


def command(media, start):
    args = ['ffmpeg', '-nostdin', '-v', 'error']
    for source in media['inputs']:
        # Only allow the fixed, validated HTTPS media endpoints selected above.
        if not safe_media_url(source['url']):
            raise ValueError('Invalid media endpoint')
        args += ['-rw_timeout', '15000000', '-protocol_whitelist', 'https,tls,tcp',
                 '-ss', str(start), '-i', source['url']]
    args += ['-map', '0:v:0', '-map', '1:a:0' if len(media['inputs']) == 2 else '0:a:0',
             '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-sn',
             '-movflags', 'frag_keyframe+delay_moov+default_base_moof', '-use_editlist', '1',
             '-frag_duration', '1000000', '-f', 'mp4', '-']
    return args
