"""SANFLIX artwork fetcher: finds a poster and a landscape backdrop on TMDB from a file name.

Without any setup it uses Wikipedia (movie posters) and TVMaze (TV posters): no account or key.
For landscape backdrops as well, add a free TMDB key: set TMDB_API_KEY or put it on one line in
tmdb_key.txt. If nothing matches, SANFLIX keeps using frames captured from the video.
"""

import difflib
import hashlib
import json
import os
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request

from media_utils import MEDIA_EXTENSIONS, atomic_json, read_json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ART_DIR = os.path.join(BASE_DIR, 'thumbnails', 'art')
CACHE_FILE = os.path.join(BASE_DIR, 'database', 'artwork_cache.json')
OVERRIDES_FILE = os.path.join(BASE_DIR, 'database', 'artwork_overrides.json')
KEY_FILE = os.path.join(BASE_DIR, 'tmdb_key.txt')
API = 'https://api.themoviedb.org/3'
IMAGES = 'https://image.tmdb.org/t/p'
WIKIPEDIA = 'https://en.wikipedia.org/w/api.php'
WIKIPEDIA_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary'
TVMAZE = 'https://api.tvmaze.com/search/shows'
RETRY_MISS_SECONDS = 7 * 24 * 3600
MIN_MATCH = 0.8

JUNK = re.compile(
    r'(?i)(?:^|[\s\[(])(?:2160p|1080p|720p|576p|480p|4k|uhd|bluray|blu-ray|brrip|bdrip|webrip|web-dl|'
    r'webdl|hdrip|hdtv|dvdrip|hdcam|x264|x265|h264|h265|hevc|av1|esub|esubs|remux)(?=$|[\s\]).+-])')
YEAR = re.compile(r'(?<!\d)((?:19|20)\d{2})(?!\d)')
_cache = None
_last_wikimedia = 0.0
_wikimedia_blocked = False


def _key():
    value = os.environ.get('TMDB_API_KEY', '').strip()
    if not value and os.path.isfile(KEY_FILE):
        with open(KEY_FILE, encoding='utf-8') as stream:
            value = stream.read().strip()
    return value


def parse_title(text):
    """Turn a messy release name into (search title, year or None)."""
    name = os.path.basename(str(text))
    if os.path.splitext(name)[1].lower() in MEDIA_EXTENSIONS:
        name = os.path.splitext(name)[0]
    name = re.sub(r'(?i)^\s*www\.\S+?\s*[-–]?\s+', '', name)
    name = re.sub(r'[_.]+', ' ', name)
    paren = re.search(r'\(\s*((?:19|20)\d{2})\s*\)', name)
    year = int(paren.group(1)) if paren else None
    cut = len(name)
    if paren:
        cut = paren.start()
    else:
        for match in YEAR.finditer(name):
            if match.start() > 0:
                year, cut = int(match.group(1)), match.start()
                break
    junk = JUNK.search(name)
    if junk and junk.start() > 0:
        cut = min(cut, junk.start())
    episode = re.search(r'(?i)(?:^|[\s\[(])s\d+\s*e\d+', name)
    if episode and episode.start() > 0:
        cut = min(cut, episode.start())
    title = re.sub(r'\[.*?\]|\(.*?\)', ' ', name[:cut])
    title = re.sub(r'\s+[-–]\s+', ' ', title)
    title = re.sub(r'\s+', ' ', title).strip(' -–')
    return title, year


def _normal(text):
    return re.sub(r'[^a-z0-9]+', ' ', str(text).casefold()).strip()


def _get(url, headers=None, timeout=10):
    request = urllib.request.Request(url, headers={'User-Agent': 'SANFLIX/1.0 (open-source personal media library; local use)', **(headers or {})})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _tmdb(path, **params):
    key = _key()
    headers = {}
    if len(key) > 40:
        headers['Authorization'] = 'Bearer ' + key
    else:
        params['api_key'] = key
    url = f'{API}{path}?{urllib.parse.urlencode(params)}'
    return json.loads(_get(url, headers).decode('utf-8'))


def _search(kind, title, year):
    """Return the best TMDB hit, or None. Raises on network/API failure."""
    endpoint = '/search/tv' if kind == 'tv' else '/search/movie'
    year_param = 'first_air_date_year' if kind == 'tv' else 'year'
    attempts = [{year_param: year}, {}] if year else [{}]
    wanted = _normal(title)
    for extra in attempts:
        results = _tmdb(endpoint, query=title, include_adult='false', **extra).get('results', [])
        best, best_score = None, 0
        for rank, hit in enumerate(results[:8]):
            if not hit.get('poster_path') and not hit.get('backdrop_path'):
                continue
            names = [hit.get('title'), hit.get('original_title'), hit.get('name'), hit.get('original_name')]
            score = max((difflib.SequenceMatcher(None, wanted, _normal(n)).ratio() for n in names if n), default=0)
            score -= rank * 0.01
            if score > best_score:
                best, best_score = hit, score
        if best and best_score >= MIN_MATCH:
            return best
    return None


def _wikimedia_get(url):
    """Polite access: a request every two seconds; wait out a 429 once, then pause until the next scan."""
    global _last_wikimedia, _wikimedia_blocked
    if _wikimedia_blocked:
        raise OSError('Wikipedia asked us to slow down; will retry on the next scan')
    for attempt in range(2):
        wait = 2.0 - (time.monotonic() - _last_wikimedia)
        if wait > 0:
            time.sleep(wait)
        try:
            return _get(url)
        except urllib.error.HTTPError as error:
            if error.code != 429:
                raise
            if attempt == 1:
                _wikimedia_blocked = True
                raise
            try:
                delay = int(error.headers.get('Retry-After', ''))
            except ValueError:
                delay = 30
            print(f'  (Wikipedia is busy; waiting {min(max(delay, 5), 60)}s)')
            time.sleep(min(max(delay, 5), 60))
        finally:
            _last_wikimedia = time.monotonic()


def _wikipedia(title, year):
    """Poster URL from the English Wikipedia film article that best matches, or None."""
    params = urllib.parse.urlencode({
        'action': 'query', 'format': 'json', 'generator': 'search', 'gsrlimit': 6,
        'gsrsearch': f'{title} {year or ""} film'.strip(), 'prop': 'description'})
    pages = json.loads(_wikimedia_get(f'{WIKIPEDIA}?{params}').decode('utf-8')).get('query', {}).get('pages', {})
    wanted, best, best_score = _normal(title), None, 0
    for page in pages.values():
        description = page.get('description', '').casefold()
        label = f'{page.get("title", "")} {description}'
        if 'film' not in description or 'series' in description or 'soundtrack' in description:
            continue
        name = re.sub(r'\s*\(.*?\)\s*$', '', page.get('title', ''))
        score = difflib.SequenceMatcher(None, wanted, _normal(name)).ratio()
        if year and str(year) in label:
            score += 0.1
        score -= page.get('index', 9) * 0.01
        if score > best_score:
            best, best_score = page['title'], score
    if best is None or best_score < MIN_MATCH:
        return None
    summary = json.loads(_wikimedia_get(
        f'{WIKIPEDIA_SUMMARY}/{urllib.parse.quote(best.replace(" ", "_"), safe="")}').decode('utf-8'))
    return (summary.get('thumbnail') or {}).get('source')


def _tvmaze(title):
    """Poster URL of the best TVMaze show match, or None."""
    hits = json.loads(_get(f'{TVMAZE}?{urllib.parse.urlencode({"q": title})}').decode('utf-8'))
    wanted = _normal(title)
    for hit in hits[:5]:
        show = hit.get('show', {})
        image = (show.get('image') or {}).get('medium')
        if image and difflib.SequenceMatcher(None, wanted, _normal(show.get('name', ''))).ratio() >= MIN_MATCH:
            return image
    return None


def _download_url(url, destination):
    if os.path.isfile(destination) and os.path.getsize(destination) > 0:
        return True
    os.makedirs(ART_DIR, exist_ok=True)
    data = _get(url, timeout=20)
    if not data:
        return False
    fd, temporary = tempfile.mkstemp(suffix='.jpg', dir=ART_DIR)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def _download(tmdb_path, size, destination):
    if os.path.isfile(destination) and os.path.getsize(destination) > 0:
        return True
    os.makedirs(ART_DIR, exist_ok=True)
    data = _get(f'{IMAGES}/{size}{tmdb_path}', timeout=20)
    if not data:
        return False
    fd, temporary = tempfile.mkstemp(suffix='.jpg', dir=ART_DIR)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
        os.replace(temporary, destination)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return True


def _load_cache():
    global _cache
    if _cache is None:
        try:
            _cache = read_json(CACHE_FILE)
            if not isinstance(_cache, dict):
                _cache = {}
        except (OSError, ValueError):
            _cache = {}
    return _cache


def _overrides():
    try:
        data = read_json(OVERRIDES_FILE)
        return {str(k).casefold(): str(v) for k, v in data.items()} if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _valid(entry):
    return all(not entry.get(field) or os.path.isfile(os.path.join(BASE_DIR, entry[field]))
               for field in ('poster', 'backdrop'))


def _fetch(kind, title, year):
    """Query the configured provider and download images. Raises on network failure."""
    result = {}
    if _key():
        hit = _search(kind, title, year)
        if hit:
            stem = hashlib.sha1(f'{kind}:{hit["id"]}'.encode()).hexdigest()[:16]
            for field, size, suffix, name in (('poster_path', 'w500', 'p', 'poster'),
                                              ('backdrop_path', 'w1280', 'b', 'backdrop')):
                if hit.get(field):
                    destination = os.path.join(ART_DIR, f'{stem}_{suffix}.jpg')
                    if _download(hit[field], size, destination):
                        result[name] = f'thumbnails/art/{stem}_{suffix}.jpg'
        return result
    url = _tvmaze(title) if kind == 'tv' else _wikipedia(title, year)
    if url:
        stem = hashlib.sha1(url.encode()).hexdigest()[:16]
        if _download_url(url, os.path.join(ART_DIR, f'{stem}_p.jpg')):
            result['poster'] = f'thumbnails/art/{stem}_p.jpg'
    return result


def lookup(kind, title, year=None):
    """Return {'poster': rel_path, 'backdrop': rel_path} (either may be missing)."""
    cache = _load_cache()
    cache_key = f'{"tmdb" if _key() else "free"}|{kind}|{_normal(title)}|{year or ""}'
    cached = cache.get(cache_key)
    if cached and _valid(cached) and (cached.get('poster') or cached.get('backdrop')
                                       or time.time() - cached.get('checked', 0) < RETRY_MISS_SECONDS):
        return {k: cached[k] for k in ('poster', 'backdrop') if cached.get(k)}
    try:
        result = _fetch(kind, title, year)
    except (urllib.error.URLError, OSError, ValueError, KeyError, TypeError) as error:
        print(f'  - Artwork lookup failed for "{title}": {error}')
        return {}
    cache[cache_key] = {**result, 'checked': time.time()}
    try:
        atomic_json(CACHE_FILE, cache)
    except OSError:
        pass
    return result


def artwork_for(entry):
    """Artwork for a scanned library entry; {} when disabled, unmatched, or offline."""
    if entry.get('media_type') == 'audio' or entry.get('category') == 'music':
        return {}
    overrides = _overrides()
    stem = os.path.splitext(entry.get('filename', ''))[0]
    show = entry.get('show')
    is_episode = entry.get('category') == 'series' and (
        entry.get('episode') is not None or re.search(r'(?i)(?:^|[\s._(\[-])s\d{1,2}(?=$|[\s._)\]-])', stem))
    if is_episode and show:
        kind, source = 'tv', show
    else:
        kind, source = 'movie', stem
    for candidate in (stem, show or ''):
        if candidate and candidate.casefold() in overrides:
            source = overrides[candidate.casefold()]
            break
    title, year = parse_title(source)
    if is_episode and show:
        year = None
    if not title:
        return {}
    return lookup(kind, title, year)
