"""Bounded public YouTube browsing: metadata only, no API key or video downloads."""
import json
import re
import subprocess
import sys
import threading
import time
from urllib.parse import urlencode, urlsplit

PAGE_SIZE = 12
MAX_PAGE = 10
VIDEO = re.compile(r'[A-Za-z0-9_-]{11}')
CHANNEL = re.compile(r'UC[A-Za-z0-9_-]{22}')
PLAYLIST = re.compile(r'[A-Za-z0-9_-]{10,80}')
_cache = {}
_lock = threading.Lock()
_slots = threading.BoundedSemaphore(2)


class BrowseUnavailable(Exception):
    pass


def thumbnail(entry):
    for item in reversed(entry.get('thumbnails') or []):
        if not isinstance(item, dict):
            continue
        url = str(item.get('url') or '')
        try:
            parsed = urlsplit(url)
        except ValueError:
            continue
        if parsed.scheme == 'https' and parsed.hostname in {'i.ytimg.com', 'yt3.ggpht.com', 'yt3.googleusercontent.com'}:
            return url
    return ''


def browse(mode='videos', query='', page=1, collection=''):
    if mode not in {'videos', 'channels', 'playlists', 'channel', 'playlist'} or not 1 <= page <= MAX_PAGE:
        raise ValueError('Choose a valid browsing category and page.')
    query = ' '.join(str(query).split())[:100]
    if mode == 'channel':
        if not CHANNEL.fullmatch(collection):
            raise ValueError('Invalid channel.')
        target = f'https://www.youtube.com/channel/{collection}/videos'
    elif mode == 'playlist':
        if not PLAYLIST.fullmatch(collection):
            raise ValueError('Invalid playlist.')
        target = 'https://www.youtube.com/playlist?' + urlencode({'list': collection})
    else:
        if not query:
            raise ValueError('Enter a topic, title, or channel name.')
        target = (f'ytsearch{page * PAGE_SIZE + 1}:{query}' if mode == 'videos' else
                  'https://www.youtube.com/results?' + urlencode({
                      'search_query': query, 'sp': 'EgIQAg==' if mode == 'channels' else 'EgIQAw=='}))
    key = (mode, query.casefold(), page, collection)
    with _lock:
        cached = _cache.get(key)
        if cached and time.monotonic() - cached[0] < 600:
            return cached[1]
    if not _slots.acquire(blocking=False):
        raise BrowseUnavailable('Other searches are still loading. Please retry in a moment.')
    try:
        args = [sys.executable, '-m', 'yt_dlp', '--ignore-config', '--no-cache-dir',
                '--flat-playlist', '--skip-download', '--dump-single-json',
                '--playlist-start', str((page - 1) * PAGE_SIZE + 1),
                '--playlist-end', str(page * PAGE_SIZE + 1),
                '--socket-timeout', '10', '--retries', '0', '--extractor-retries', '0', target]
        try:
            response = subprocess.run(args, capture_output=True, text=True, encoding='utf-8',
                                      errors='replace', timeout=45)
            if response.returncode:
                raise BrowseUnavailable('YouTube could not load these results. Check the server internet connection and retry.')
            data = json.loads(response.stdout)
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            raise BrowseUnavailable('Search is unavailable right now. Please retry shortly.') from error
        if not isinstance(data, dict) or not isinstance(data.get('entries'), list):
            raise BrowseUnavailable('YouTube returned unreadable results. Please retry.')
        entries = data['entries']
        results = []
        for entry in entries[:PAGE_SIZE]:
            if not isinstance(entry, dict):
                continue
            kind = {'channels': 'channel', 'playlists': 'playlist'}.get(mode, 'video')
            item_id = str(entry.get('id') or '')
            pattern = {'video': VIDEO, 'channel': CHANNEL, 'playlist': PLAYLIST}[kind]
            if not pattern.fullmatch(item_id) or entry.get('is_live'):
                continue
            channel_id = str(entry.get('channel_id') or '')
            results.append({'id': item_id, 'kind': kind, 'title': str(entry.get('title') or 'Untitled'),
                            'channel': str(entry.get('channel') or entry.get('uploader') or ''),
                            'channel_id': channel_id if CHANNEL.fullmatch(channel_id) else '',
                            'duration': entry.get('duration'), 'thumbnail': thumbnail(entry)})
        payload = {'results': results, 'page': page, 'has_more': len(entries) > PAGE_SIZE and page < MAX_PAGE,
                   'title': str(data.get('title') or query), 'mode': mode}
        with _lock:
            if len(_cache) >= 100:
                _cache.clear()
            _cache[key] = (time.monotonic(), payload)
        return payload
    finally:
        _slots.release()
