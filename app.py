"""SANFLIX: local browsing, authenticated sharing, and persistent streaming."""
import gzip
import hashlib
import ipaddress
import json
import math
import mimetypes
import os
from pathlib import Path
import re
import secrets
import socket
import sys
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from datetime import timedelta
from html import unescape as html_unescape
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlsplit

from flask import Flask, Response, abort, jsonify, redirect, render_template, request, send_file, send_from_directory, session
from flask.sessions import SecureCookieSessionInterface
from werkzeug.exceptions import HTTPException
from werkzeug.security import check_password_hash, generate_password_hash
from werkzeug.utils import secure_filename
import hls_manager
import hubroom
import localgram
import security_config
import youtube_stream
import youtube_catalog
from media_utils import AUDIO_EXTENSIONS, MEDIA_EXTENSIONS, atomic_json, contained_path, fingerprint, media_id, read_json

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MEDIA_DIR = os.path.join(BASE_DIR, 'media')
THUMBNAILS_DIR = os.path.join(BASE_DIR, 'thumbnails')
DATABASE_FILE = os.path.join(BASE_DIR, 'database', 'media_library.json')
HLS_DIR = os.path.join(BASE_DIR, 'hls_cache')
# Live compatibility encoding must leave enough headroom for real-time playback.
# Original/direct video and prepared HLS retain their existing resolution.
LIVE_MAX_HEIGHT = 1080
LIVE_VIDEO_FILTER = ('scale=w=min(1920\\,iw):h=min(1080\\,ih):'
                     'force_original_aspect_ratio=decrease:force_divisible_by=2')
ffmpeg_path = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'ffmpegio', 'ffmpeg-downloader', 'ffmpeg', 'bin')
if os.path.isdir(ffmpeg_path) and ffmpeg_path not in os.environ.get('PATH', ''):
    os.environ['PATH'] = ffmpeg_path + os.pathsep + os.environ.get('PATH', '')

security_config.load_env_file(os.environ.get('SANFLIX_ENV_FILE') or os.path.join(BASE_DIR, 'sanflix.env'), os.environ)
try:
    _settings = security_config.load(os.environ)
except security_config.ConfigError as _error:
    if __name__ == '__main__':
        print(_error)
        sys.exit(2)
    raise

app = Flask(__name__)
app.config.update(
    MAX_CONTENT_LENGTH=10 * 1024 ** 3,
    SECRET_KEY=_settings.secret_key,
    SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax',
    # Forces Secure cookies everywhere. Otherwise Secure is set per request when HTTPS is verifiable.
    SESSION_COOKIE_SECURE=os.environ.get('SANFLIX_HTTPS_ONLY') == '1',
    PERMANENT_SESSION_LIFETIME=timedelta(hours=12),
    ADMIN_PASSWORD_HASH=generate_password_hash(_settings.admin_password),
    VIEW_PASSWORD_HASH=generate_password_hash(_settings.view_password),
    # Opt in only when cloudflared runs on this computer; the peer must then be loopback.
    TRUSTED_PROXY=os.environ.get('SANFLIX_TRUSTED_PROXY', '').strip().lower() == 'cloudflare',
    # Passwordless viewing on this computer's own browser (localhost). "off" requires sign-in there too.
    LOCAL_BYPASS=os.environ.get('SANFLIX_LOCAL_BYPASS', 'on').strip().lower() not in {'off', '0', 'false', 'no'},
    # Who may create sharing links: "admin" (default) or "viewers" (anyone signed in).
    HUB_LIMITS=hubroom.limits_from_environment(os.environ),
    SHARE_CREATORS='viewers' if os.environ.get('SANFLIX_SHARE_CREATORS', '').strip().lower() == 'viewers' else 'admin',
    HLS_MAX_PENDING=4,
)
_dev_generated = dict(_settings.generated)
del _settings
_library_cache = {'data': None, 'mtime': None, 'etag': None}
_library_lock = threading.Lock()
_codec_cache = {}
_login_failures = {}
_login_lock = threading.Lock()
_hls_jobs = {}
_hls_lock = threading.Lock()
_hls_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='sanflix-hls')
_scan_lock = threading.Lock()
_scan_requested = False
_scan_running = False
_scan_error = None

def csrf_token():
    if 'csrf_token' not in session:
        session['csrf_token'] = secrets.token_hex(24)
    return session['csrf_token']

# The developer credit shown (and linked) on every page; change it here only.
DEVELOPER_NAME = 'Santhosh A'
DEVELOPER_URL = 'https://a-santhosh-hub.github.io/in/'

app.context_processor(lambda: {'csrf_token': csrf_token, 'developer_name': DEVELOPER_NAME, 'developer_url': DEVELOPER_URL})

def peer_is_loopback():
    try:
        return ipaddress.ip_address(request.remote_addr or '').is_loopback
    except ValueError:
        return False

def trusted_proxy_request():
    """Forwarding headers are believed only when enabled AND the direct peer is this computer."""
    return bool(app.config.get('TRUSTED_PROXY')) and peer_is_loopback()

def client_ip():
    peer = request.remote_addr or 'unknown'
    if trusted_proxy_request():
        try:
            return str(ipaddress.ip_address(request.headers.get('CF-Connecting-IP', '').strip()))
        except ValueError:
            pass
    return peer

def request_is_https():
    if request.is_secure:
        return True
    if trusted_proxy_request():
        if request.headers.get('X-Forwarded-Proto', '').split(',')[0].strip().lower() == 'https':
            return True
        return '"scheme":"https"' in request.headers.get('CF-Visitor', '').replace(' ', '').lower()
    return False

class SanflixSessionInterface(SecureCookieSessionInterface):
    def get_cookie_secure(self, app):
        return bool(app.config.get('SESSION_COOKIE_SECURE')) or request_is_https()

app.session_interface = SanflixSessionInterface()
_revoked = {'stamp': None, 'data': {}}
_revoked_lock = threading.Lock()

def revoked_file():
    return os.path.join(BASE_DIR, 'database', 'revoked_sessions.json')

def revoked_sessions():
    """Persisted so logout stays effective across restarts; entries expire with the session."""
    path = revoked_file()
    try:
        stat = os.stat(path)
        stamp = (path, stat.st_mtime_ns, stat.st_size)
    except OSError:
        return {}
    if _revoked['stamp'] != stamp:
        try:
            data = read_json(path)
        except (OSError, ValueError):
            return _revoked['data']
        cutoff = time.time() - app.config['PERMANENT_SESSION_LIFETIME'].total_seconds() - 3600
        recent = {}
        if isinstance(data, dict):
            recent = {k: v for k, v in data.items() if isinstance(v, (int, float)) and v > cutoff}
        _revoked.update(stamp=stamp, data=recent)
    return _revoked['data']

def revoke_session(sid):
    with _revoked_lock:
        data = dict(revoked_sessions())
        data[sid] = time.time()
        try:
            atomic_json(revoked_file(), data)
        except OSError:
            app.logger.exception('Could not record the signed-out session')

def start_session(*, admin=False):
    """Give every sign-in a new server-checked session ID (also prevents session fixation)."""
    old = session.get('sid')
    if old:
        revoke_session(old)
    session['sid'] = secrets.token_hex(16)
    session['viewer'] = True
    if admin:
        session['admin'] = True
    session.permanent = True

PROXY_HEADER_NAMES = {'forwarded', 'via', 'x-real-ip', 'true-client-ip', 'cdn-loop'}
PROXY_HEADER_PREFIXES = ('cf-', 'x-forwarded-')

def has_proxy_headers():
    """Any sign the request passed through a proxy or tunnel. A direct browser never sends these."""
    return any(name.lower() in PROXY_HEADER_NAMES or name.lower().startswith(PROXY_HEADER_PREFIXES)
               for name in request.headers.keys())

def is_local_request():
    """Streaming preference only; LAN membership does not grant authorization."""
    if has_proxy_headers():
        return False
    try:
        address = ipaddress.ip_address(request.remote_addr or '')
        return address.is_loopback or any(address in ipaddress.ip_network(net) for net in
                                         ('10.0.0.0/8', '192.168.0.0/16', '172.16.0.0/12'))
    except (ValueError, TypeError):
        return False

def is_trusted_local_browser():
    """The only passwordless path: this computer's own loopback connection, addressed as localhost."""
    if not app.config.get('LOCAL_BYPASS', True):
        return False
    try:
        return (is_local_request() and ipaddress.ip_address(request.remote_addr or '').is_loopback
                and urlsplit(request.host_url).hostname in {'localhost', '127.0.0.1', '::1'})
    except ValueError:
        return False

def listen_host():
    return os.environ.get('SANFLIX_HOST', '127.0.0.1')

def listen_port():
    return int(os.environ.get('SANFLIX_PORT', '5000'))

def lan_addresses():
    """Private IPv4 addresses of this computer, main network first (Wi-Fi, Ethernet, hotspot...)."""
    found = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(('10.255.255.255', 1))  # Chooses a route; sends nothing.
            found.append(probe.getsockname()[0])
    except OSError:
        pass
    try:
        found.extend(socket.gethostbyname_ex(socket.gethostname())[2])
    except OSError:
        pass
    result = []
    for text in found:
        try:
            address = ipaddress.ip_address(text)
        except ValueError:
            continue
        if address.is_private and not address.is_loopback and not address.is_link_local and text not in result:
            result.append(text)
    return result

def network_urls():
    host, port = listen_host(), listen_port()
    if host in {'0.0.0.0', '::', ''}:
        return [f'http://{address}:{port}' for address in lan_addresses()]
    if host in {'127.0.0.1', 'localhost', '::1'}:
        return []
    return [f'http://{host}:{port}']

@app.before_request
def protect_requests():
    if session.get('viewer') or session.get('admin'):
        sid = session.get('sid')
        if not sid or sid in revoked_sessions():
            session.clear()
    if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
        supplied = request.headers.get('X-CSRF-Token') or request.form.get('csrf_token', '')
        expected = session.get('csrf_token', '')
        if not expected or not secrets.compare_digest(str(supplied), expected):
            return jsonify(error='Your session expired. Reload this page and try again.'), 403
    if request.endpoint in {'static', 'login', 'admin_login'} or request.endpoint in localgram.PUBLIC_ENDPOINTS:
        return None
    if session.get('viewer') or session.get('admin') or is_trusted_local_browser():
        return None
    if request.path in {'/', '/youtube', '/tv', '/hub'} or request.path.startswith('/player/'):
        return redirect('/login?next=' + request.path)
    return jsonify(error='Please sign in to view this library.'), 401

@app.after_request
def response_headers(response):
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers.setdefault('Referrer-Policy', 'same-origin')
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    if request.endpoint != 'static':
        # Do not leak authenticated content through shared proxy caches.
        current = response.headers.get('Cache-Control', 'no-cache').replace('public', 'private')
        response.headers['Cache-Control'] = current if 'private' in current else 'private, ' + current
    return response

def check_login(password, expected_hash):
    key, now = client_ip(), time.monotonic()
    with _login_lock:
        for old in list(_login_failures):
            if now - _login_failures[old][1] > 300:
                del _login_failures[old]
        count, _ = _login_failures.get(key, (0, now))
        if count >= 10:
            abort(429, description='Too many attempts. Try again in five minutes.')
    valid = isinstance(password, str) and len(password) <= 1024 and check_password_hash(expected_hash, password)
    with _login_lock:
        if valid:
            _login_failures.pop(key, None)
        else:
            _login_failures[key] = (count + 1, now)
    return valid

@app.route('/login', methods=['GET', 'POST'])
def login():
    error = None
    if request.method == 'POST':
        if check_login(request.form.get('password', ''), app.config['VIEW_PASSWORD_HASH']):
            start_session()
            target = request.args.get('next', '/')
            return redirect(target if target.startswith('/') and not target.startswith('//') and '\\' not in target else '/')
        error = 'Incorrect password. Please try again.'
    return render_template('login.html', error=error), 401 if error else 200

@app.post('/api/admin/login')
def admin_login():
    body = request.get_json(silent=True) or request.form
    if not check_login(body.get('password', ''), app.config['ADMIN_PASSWORD_HASH']):
        return jsonify(error='Incorrect password.'), 401
    start_session(admin=True)
    return jsonify(success=True)

@app.post('/logout')
def logout():
    if session.get('sid'):
        revoke_session(session['sid'])
    session.clear()
    return redirect('/login')

def load_library():
    with _library_lock:
        try:
            stat = os.stat(DATABASE_FILE)
            stamp = (stat.st_mtime_ns, stat.st_size)
            if _library_cache['data'] is not None and stamp == _library_cache['mtime']:
                return _library_cache['data']
            data = read_json(DATABASE_FILE)
            if not isinstance(data, list) or any(not isinstance(x, dict) for x in data):
                raise ValueError('Catalog must be a list of media objects')
            _library_cache.update(data=data, mtime=stamp,
                                  etag=hashlib.sha256(json.dumps(data, sort_keys=True).encode()).hexdigest())
        except FileNotFoundError:
            return _library_cache['data'] or []
        except (OSError, ValueError):
            app.logger.exception('Could not read catalog; retaining the last good version')
            if _library_cache['data'] is None:
                abort(503, description='The catalog is unavailable. Run the media scanner.')
        return _library_cache['data']

def find_item(item_id):
    item = next((x for x in load_library() if x.get('id') == item_id), None)
    if item is None:
        abort(404)
    return item

def media_path(relative_path):
    if not isinstance(relative_path, str) or not relative_path:
        abort(404)
    try:
        full = contained_path(MEDIA_DIR, os.path.join(BASE_DIR, relative_path))
    except ValueError:
        abort(403)
    if Path(full).suffix.lower() not in MEDIA_EXTENSIONS or not os.path.isfile(full):
        abort(404)
    inside = Path(os.path.relpath(full, os.path.realpath(MEDIA_DIR))).parts
    if any(part.startswith('.') for part in inside):
        abort(404)  # Temporary uploads and other hidden folders are never served.
    return full

def is_catalogued(relative_path):
    wanted = str(relative_path).replace('\\', '/')
    return any(item.get('file') == wanted for item in load_library())

def gzip_response(response):
    response.vary.add('Accept-Encoding')
    if request.accept_encodings['gzip'] > 0 and response.status_code == 200 and len(response.get_data()) >= 500:
        response.set_data(gzip.compress(response.get_data(), compresslevel=6))
        response.headers['Content-Encoding'] = 'gzip'
    return response

@app.get('/')
def index():
    return render_template('index.html')

@app.get('/player/<media_id>')
def player(media_id):
    find_item(media_id)
    return render_template('player.html', media_id=media_id)

@app.get('/api/network')
def api_network():
    # Only people already on this network need the address; remote/tunnel visitors do not.
    return jsonify(urls=network_urls() if is_local_request() else [])

YOUTUBE_KEY_FILE = os.path.join(BASE_DIR, 'youtube_key.txt')
YOUTUBE_ID = re.compile(r'[A-Za-z0-9_-]{11}')
_youtube_cache = {}

def youtube_api_key():
    value = os.environ.get('YOUTUBE_API_KEY', '').strip()
    if not value and os.path.isfile(YOUTUBE_KEY_FILE):
        with open(YOUTUBE_KEY_FILE, encoding='utf-8') as stream:
            value = stream.read().strip()
    return value

@app.get('/youtube')
def youtube_page():
    return render_template('youtube.html', search_enabled=True)


# The Hub plays files chosen on the visitor's own device and, only when the owner shares them, sends
# them peer to peer over WebRTC. The page may talk to this server only for small JSON metadata and
# signaling (connect-src 'self'); the server rejects anything else, and no external host is allowed.
HUB_CSP = ("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; "
           "media-src 'self' blob:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")

@app.get('/hub')
def hub_page():
    response = app.make_response(render_template('hub.html'))
    response.headers['Content-Security-Policy'] = HUB_CSP
    return response

@app.get('/tv')
def tv_home():
    return redirect('/youtube')


@app.get('/api/youtube/browse')
def youtube_browse():
    try:
        return jsonify(youtube_catalog.browse(
            mode=request.args.get('mode', 'videos'), query=request.args.get('q', ''),
            page=int(request.args.get('page', '1')), collection=request.args.get('id', '')))
    except ValueError as error:
        abort(400, description=str(error))
    except youtube_catalog.BrowseUnavailable as error:
        abort(503, description=str(error))

@app.get('/api/youtube/search')
def youtube_search():
    query = ' '.join(request.args.get('q', '').split())[:100]
    if not query:
        return jsonify(error='Type something to search.'), 400
    key = youtube_api_key()
    if not key:
        try:
            return jsonify(youtube_catalog.browse(query=query))
        except youtube_catalog.BrowseUnavailable as error:
            abort(503, description=str(error))
    cached = _youtube_cache.get(query.casefold())
    if cached and time.monotonic() - cached[0] < 600:
        return jsonify(results=cached[1])
    url = 'https://www.googleapis.com/youtube/v3/search?' + urlencode({
        'part': 'snippet', 'type': 'video', 'maxResults': 12, 'q': query, 'safeSearch': 'moderate',
        'videoEmbeddable': 'true', 'key': key})
    try:
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        message = ('YouTube search is out of free quota for today. Paste a link, or try tomorrow.'
                   if error.code == 403 else 'YouTube search failed. Try again.')
        return jsonify(error=message), 502
    except (urllib.error.URLError, OSError, ValueError):
        return jsonify(error='Could not reach YouTube. Check the internet connection.'), 502
    results = []
    for item in data.get('items', []):
        video_id = item.get('id', {}).get('videoId', '')
        if not YOUTUBE_ID.fullmatch(video_id):
            continue
        snippet = item.get('snippet', {})
        thumbs = snippet.get('thumbnails', {})
        thumbnail = (thumbs.get('medium') or thumbs.get('default') or {}).get('url', '')
        results.append({'id': video_id, 'title': html_unescape(snippet.get('title', '')),
                        'channel': html_unescape(snippet.get('channelTitle', '')),
                        'thumbnail': thumbnail if thumbnail.startswith('https://i.ytimg.com/') else ''})
    if len(_youtube_cache) > 100:
        _youtube_cache.clear()
    _youtube_cache[query.casefold()] = (time.monotonic(), results)
    return jsonify(results=results)


def youtube_selection(video_id):
    try:
        quality = int(request.args.get('quality', '360'))
        youtube_stream.validate(video_id, quality)
    except ValueError:
        abort(400, description='Choose a valid video and quality.')
    try:
        return quality, youtube_stream.resolve(video_id, quality)
    except youtube_stream.StreamUnavailable as error:
        abort(503, description=str(error))


@app.get('/api/youtube/resolve/<video_id>')
def youtube_resolve(video_id):
    quality, media = youtube_selection(video_id)
    return jsonify(title=media['title'], duration=media['duration'], height=media['height'],
                   stream=f'/youtube-stream/{video_id}?quality={quality}')


_youtube_slots = threading.BoundedSemaphore(2)


@app.get('/youtube-stream/<video_id>')
def youtube_video(video_id):
    try:
        start = float(request.args.get('start', '0'))
        if not math.isfinite(start) or start < 0:
            raise ValueError()
    except ValueError:
        abort(400, description='Invalid seek position')
    _, media = youtube_selection(video_id)
    if start >= media['duration']:
        abort(416, description='Seek position is past the end of this lesson.')
    if not _youtube_slots.acquire(blocking=False):
        abort(503, description='Two lessons are already streaming. Stop one and retry.')
    try:
        process = subprocess.Popen(youtube_stream.command(media, start), stdout=subprocess.PIPE,
                                   stderr=subprocess.DEVNULL, bufsize=0)
    except (OSError, ValueError):
        _youtube_slots.release()
        abort(503, description='The TV stream could not start. Check FFmpeg on the server.')
    closed = False
    def close():
        nonlocal closed
        if closed:
            return
        closed = True
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        _youtube_slots.release()
    def generate():
        try:
            while True:
                block = process.stdout.read(65536)
                if not block:
                    break
                yield block
        finally:
            close()
    response = Response(generate(), mimetype='video/mp4', headers={'Cache-Control': 'private, no-store'})
    response.call_on_close(close)
    return response

@app.get('/api/media')
def api_media():
    data = load_library()
    etag = _library_cache['etag'] or hashlib.sha256(b'[]').hexdigest()
    response = Response(status=304) if request.if_none_match.contains_weak(etag) else gzip_response(jsonify(data))
    response.set_etag(etag, weak=True)
    return response

@app.get('/api/media/<media_id>')
def api_media_item(media_id):
    return gzip_response(jsonify(find_item(media_id)))

def normalize_show(name):
    return ' '.join(str(name or '').lower().replace('-', ' ').replace('_', ' ').split())

@app.get('/api/series/<path:show_name>')
def api_series(show_name):
    seasons = {}
    for item in load_library():
        if item.get('category') == 'series' and normalize_show(item.get('show')) == normalize_show(show_name):
            seasons.setdefault(int(item.get('season') or 1), []).append(item)
    for episodes in seasons.values():
        episodes.sort(key=lambda x: int(x.get('episode') or 0))
    return gzip_response(jsonify(show=show_name, seasons={str(k): v for k, v in sorted(seasons.items())}))

@app.get('/download/<media_id>')
def download_media(media_id):
    path = media_path(find_item(media_id).get('file'))
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))

def request_scan():
    global _scan_requested, _scan_running, _scan_error
    with _scan_lock:
        _scan_requested, _scan_error = True, None
        if _scan_running:
            return
        _scan_running = True
    def worker():
        global _scan_requested, _scan_running, _scan_error
        from scan_media import scan_media
        while True:
            with _scan_lock:
                if not _scan_requested:
                    _scan_running = False
                    return
                _scan_requested = False
            try:
                scan_media()
                with _scan_lock:
                    _scan_error = None
            except Exception:
                app.logger.exception('Media scan failed')
                with _scan_lock:
                    _scan_error = 'Media scan failed. Run scan_media.py to retry.'
    threading.Thread(target=worker, daemon=True, name='sanflix-scan').start()

@app.get('/api/admin/scan-status')
def scan_status():
    if not session.get('admin'):
        abort(401)
    with _scan_lock:
        return jsonify(running=_scan_running, error=_scan_error)

@app.post('/api/admin/upload')
def admin_upload():
    if not session.get('admin'):
        return jsonify(error='Sign in as admin before uploading.'), 401
    upload = request.files.get('file')
    if upload is None or not upload.filename:
        return jsonify(error='Choose a media file.'), 400
    filename = secure_filename(upload.filename)
    extension = Path(filename).suffix.lower()
    if not filename or extension not in MEDIA_EXTENSIONS:
        return jsonify(error='This file type is not supported.'), 400
    category = request.form.get('category', 'movies')
    if category not in {'movies', 'series', 'music'}:
        return jsonify(error='Choose a valid category.'), 400
    if extension in AUDIO_EXTENSIONS and category != 'music':
        return jsonify(error='Choose Music for audio files.'), 400
    folder = Path(contained_path(MEDIA_DIR, category))
    if category == 'series':
        show = secure_filename(request.form.get('show', '').strip())
        if not show:
            return jsonify(error='Enter a show name for this episode.'), 400
        folder = Path(contained_path(MEDIA_DIR, category, show))
    folder.mkdir(parents=True, exist_ok=True)
    destination = Path(contained_path(MEDIA_DIR, folder / filename))
    incoming = Path(contained_path(MEDIA_DIR, '.uploads'))
    incoming.mkdir(exist_ok=True)
    fd, temporary = tempfile.mkstemp(suffix=extension, dir=incoming)
    try:
        with os.fdopen(fd, 'wb') as stream:
            upload.save(stream)
        try:
            video, audio = hls_manager.probe(temporary)
        except FileNotFoundError:
            return jsonify(error='FFprobe is unavailable. Install FFmpeg before uploading.'), 503
        except (ValueError, subprocess.TimeoutExpired):
            return jsonify(error='The uploaded file is not readable media.'), 400
        if extension not in AUDIO_EXTENSIONS and not video:
            return jsonify(error='The uploaded video has no video stream.'), 400
        if extension in AUDIO_EXTENSIONS and not audio:
            return jsonify(error='The uploaded audio has no audio stream.'), 400
        # Atomic publication on the same volume; an existing destination is never replaced.
        try:
            os.link(temporary, destination)
        except FileExistsError:
            return jsonify(error='A file with this name already exists. Rename your upload.'), 409
        relative = os.path.relpath(destination, BASE_DIR).replace('\\', '/')
        request_scan()
        return jsonify(success=True, id=media_id(relative), message='Upload saved. Updating the library.'), 202
    finally:
        Path(temporary).unlink(missing_ok=True)

@app.get('/thumbnails/<path:filename>')
def serve_thumbnail(filename):
    return send_from_directory(THUMBNAILS_DIR, filename, max_age=86400)

def get_file_codecs(filepath):
    stamp = fingerprint(filepath)
    cached = _codec_cache.get(filepath)
    if cached and cached[0] == stamp:
        return cached[1]
    try:
        video, audios = hls_manager.probe_tracks(filepath)
    except (OSError, ValueError, subprocess.TimeoutExpired):
        abort(503, description='Cannot inspect this file. Check FFmpeg and FFprobe.')
    audio = audios[0] if audios else None
    tracks = []
    languages = {'tam': 'Tamil', 'ta': 'Tamil', 'eng': 'English', 'en': 'English',
                 'hin': 'Hindi', 'hi': 'Hindi', 'tel': 'Telugu', 'te': 'Telugu',
                 'mal': 'Malayalam', 'ml': 'Malayalam', 'kan': 'Kannada', 'kn': 'Kannada',
                 'ben': 'Bengali', 'bn': 'Bengali', 'mar': 'Marathi', 'mr': 'Marathi',
                 'jpn': 'Japanese', 'ja': 'Japanese', 'kor': 'Korean', 'ko': 'Korean',
                 'fra': 'French', 'fre': 'French', 'fr': 'French', 'spa': 'Spanish', 'es': 'Spanish',
                 'deu': 'German', 'ger': 'German', 'de': 'German', 'zho': 'Chinese',
                 'chi': 'Chinese', 'zh': 'Chinese', 'ara': 'Arabic', 'ar': 'Arabic'}
    for number, track in enumerate(audios, 1):
        tags = {k.lower(): v for k, v in track.get('tags', {}).items()}
        language = str(tags.get('language', 'und')).lower()
        name = languages.get(language, f'Audio {number}' if language in {'und', ''} else language.upper())
        title = str(tags.get('title', '')).strip()
        label = name + (f' · {title}' if title and title.casefold() != name.casefold() else '')
        tracks.append({'index': track['index'], 'language': language, 'title': title,
                       'label': label, 'codec': track.get('codec_name'),
                       'channels': track.get('channels'),
                       'default': bool(track.get('disposition', {}).get('default'))})
    info = {'video': video.get('codec_name') if video else None,
            'audio': audio.get('codec_name') if audio else None,
            'video_index': video['index'] if video else None,
            'audio_index': audio['index'] if audio else None,
            'default_audio_index': next((t['index'] for t in tracks if t['default']),
                                        audio['index'] if audio else None),
            'audio_tracks': tracks,
            'container': Path(filepath).suffix.lower()}
    _codec_cache[filepath] = (stamp, info)
    return info

def get_stream_strategy(filepath):
    info = get_file_codecs(filepath)
    video, audio, ext = info['video'], info['audio'], info['container']
    # Browser audioTracks support varies. Select exactly one track on the server
    # for multi-audio sources, including otherwise directly playable MP4/WebM.
    if len(info['audio_tracks']) > 1:
        return 'remux' if video in {None, 'h264', 'avc'} else 'transcode'
    if video is None:
        return 'direct' if ext in AUDIO_EXTENSIONS else 'remux'
    if ext == '.webm' and video in {'vp8', 'vp9', 'av1'} and audio in {None, 'opus', 'vorbis'}:
        return 'direct'
    if ext == '.mp4' and video in {'h264', 'avc', 'av1'} and audio in {None, 'aac', 'mp3'}:
        return 'direct'
    return 'remux' if video in {'h264', 'avc'} else 'transcode'

def hls_playlist_exists(media_id):
    return hls_manager.playlist_ready(HLS_DIR, media_id, media_path(find_item(media_id).get('file')))


def selected_audio(info):
    value = request.args.get('audio')
    if value is None:
        return info['default_audio_index']
    try:
        index = int(value)
    except ValueError:
        abort(400, description='Invalid audio track')
    if not any(track['index'] == index for track in info['audio_tracks']):
        abort(400, description='This audio track is not available in the file')
    return index


def audio_variant(info):
    selected = selected_audio(info)
    return selected if selected != info['audio_index'] else None

@app.get('/api/stream-info/<media_id>')
def stream_info(media_id):
    path = media_path(find_item(media_id).get('file'))
    strategy, info = get_stream_strategy(path), get_file_codecs(path)
    index = selected_audio(info)
    variant = audio_variant(info)
    audio = next((t for t in info['audio_tracks'] if t['index'] == index), {})
    ready, local = hls_manager.playlist_ready(HLS_DIR, media_id, path, variant), is_local_request()
    return jsonify(strategy=strategy, video_codec=info['video'], audio_codec=audio.get('codec'),
                   audio_tracks=info['audio_tracks'], selected_audio_index=index,
                   container=info['container'], seekable=strategy == 'direct', hls_supported=True,
                   hls_ready=ready, is_local=local,
                   use_hls_auto=ready and (not local or strategy != 'direct'),
                   live_max_height=LIVE_MAX_HEIGHT,
                   hls_playlist=hls_manager.playlist_url(media_id, variant) if ready else None)

@app.get('/stream/<path:filepath>')
def stream_video(filepath):
    path = media_path(filepath)
    if not is_catalogued(filepath):
        abort(404)
    selected_audio(get_file_codecs(path))
    strategy = get_stream_strategy(path)
    if request.args.get('force_transcode') == '1':
        strategy = 'transcode'
    if strategy == 'direct':
        return direct_stream(path)
    return remux_stream(path) if strategy == 'remux' else transcode_stream(path)

def direct_stream(full_path):
    # Werkzeug implements conditional, suffix, open-ended and invalid ranges.
    return send_file(full_path, conditional=True, mimetype=mimetypes.guess_type(full_path)[0] or 'video/mp4')

_live_stream_slots = threading.BoundedSemaphore(2)

def _ffmpeg_stream(path, transcode):
    try:
        start = float(request.args.get('start', '0'))
        if not math.isfinite(start) or start < 0:
            raise ValueError()
    except ValueError:
        abort(400, description='Invalid seek position')
    info = get_file_codecs(path)
    audio_index = selected_audio(info)
    command = ['ffmpeg', '-nostdin', '-v', 'error', '-ss', str(start), '-i', path]
    if info['video']:
        command += ['-map', f'0:{info["video_index"]}']
        command += (['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
                     '-crf', '23', '-pix_fmt', 'yuv420p', '-vf', LIVE_VIDEO_FILTER,
                     '-fps_mode', 'passthrough',
                     '-force_key_frames', 'expr:gte(t,n_forced*2)'] if transcode else ['-c:v', 'copy'])
    else:
        command += ['-vn']
    if info['audio']:
        command += ['-map', f'0:{audio_index}', '-c:a', 'aac', '-b:a', '192k', '-ac', '2']
    # empty_moov cannot describe seek pre-roll / AAC encoder delay: it stretches
    # the first audio sample (almost a second on some files). Wait for the first
    # fragment so the muxer can write edit lists using both tracks' timestamps.
    # Keep the common source clock; resetting audio and video separately loses
    # intentional track offsets. Cap fragments even on long-GOP copied video.
    command += ['-sn', '-movflags', 'frag_keyframe+delay_moov+default_base_moof',
                '-use_editlist', '1', '-frag_duration', '1000000', '-f', 'mp4', '-']
    if not _live_stream_slots.acquire(blocking=False):
        abort(503, description='Other videos are converting. Try HLS playback or retry shortly.')
    try:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
    except OSError:
        _live_stream_slots.release()
        abort(503, description='FFmpeg is unavailable.')
    closed = False
    def close():
        nonlocal closed
        if closed:
            return
        closed = True
        process.stdout.close()
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        _live_stream_slots.release()
    def generate():
        try:
            while True:
                data = process.stdout.read(65536)
                if not data:
                    break
                yield data
        finally:
            close()
    response = Response(generate(), mimetype='video/mp4', headers={
        'Cache-Control': 'private, no-store', 'X-Stream-Strategy': 'transcode' if transcode else 'remux'})
    response.call_on_close(close)
    return response

def remux_stream(full_path):
    return _ffmpeg_stream(full_path, False)

def transcode_stream(full_path):
    return _ffmpeg_stream(full_path, True)

def get_hls_dir(media_id):
    try:
        return str(hls_manager.cache_dir(HLS_DIR, media_id))
    except ValueError:
        abort(404)

def cleanup_old_hls():
    """Completed generations persist; no destructive age-based startup cleanup."""
    os.makedirs(HLS_DIR, exist_ok=True)

def start_hls_transcode(media_id, full_path, force_transcode=False, force=False, audio_index=None):
    job_key = (media_id, audio_index)
    with _hls_lock:
        pending = _hls_jobs.get(job_key)
        if pending and not pending.done():
            return False
        for key in list(_hls_jobs):
            if _hls_jobs[key].done():
                del _hls_jobs[key]
        if len(_hls_jobs) >= app.config['HLS_MAX_PENDING']:
            abort(429, description='The conversion queue is full. Try again shortly.')
        def worker():
            try:
                hls_manager.convert(HLS_DIR, media_id, full_path, force=force,
                                    force_transcode=force_transcode, audio_index=audio_index)
            except Exception:
                app.logger.exception('HLS conversion failed for %s', media_id)
        _hls_jobs[job_key] = _hls_executor.submit(worker)
        return True

@app.get('/api/hls/all-status')
def hls_all_status():
    items = []
    for item in load_library():
        try:
            ready = hls_manager.playlist_ready(HLS_DIR, item['id'], media_path(item.get('file')))
        except (HTTPException, ValueError):
            ready = False
        items.append({'id': item['id'], 'title': item.get('title', ''), 'hls_ready': ready})
    return jsonify(total=len(items), ready=sum(i['hls_ready'] for i in items), items=items)

@app.post('/api/hls/start/<media_id>')
def hls_start(media_id):
    path = media_path(find_item(media_id).get('file'))
    variant = audio_variant(get_file_codecs(path))
    force = request.args.get('force') == '1'
    if force and not session.get('admin'):
        abort(403, description='Only an admin may force a new conversion.')
    if not force and hls_manager.playlist_ready(HLS_DIR, media_id, path, variant):
        return jsonify(status='ready', playlist=hls_manager.playlist_url(media_id, variant))
    status = hls_manager.job_status(HLS_DIR, media_id, path, variant)
    if status['status'] in {'queued', 'processing'}:
        return jsonify(status)
    start_hls_transcode(media_id, path, force=force, audio_index=variant)
    return jsonify(status='queued'), 202

@app.get('/api/hls/status/<media_id>')
def hls_status(media_id):
    path = media_path(find_item(media_id).get('file'))
    variant = audio_variant(get_file_codecs(path))
    with _hls_lock:
        future = _hls_jobs.get((media_id, variant))
        in_queue = future is not None and not future.done()
    status = hls_manager.job_status(HLS_DIR, media_id, path, variant)
    if in_queue and status['status'] not in {'processing', 'queued'}:
        status = {'status': 'queued'}
    return jsonify(status)

@app.get('/hls/<media_id>/<path:filename>')
def serve_hls_file(media_id, filename):
    find_item(media_id)
    folder = get_hls_dir(media_id)
    try:
        path = contained_path(folder, filename)
    except ValueError:
        abort(403)
    is_playlist = filename == 'playlist.m3u8' or (
        filename.startswith('audio-') and filename.split('/')[0][6:].isdigit()
        and filename.count('/') == 1 and filename.endswith('/playlist.m3u8'))
    if not is_playlist and not filename.endswith('.ts'):
        abort(404)
    if not os.path.isfile(path):
        abort(404)
    response = send_file(path, mimetype='application/vnd.apple.mpegurl' if filename.endswith('.m3u8') else 'video/mp2t')
    response.headers['Cache-Control'] = 'private, no-cache' if filename.endswith('.m3u8') else 'private, max-age=3600'
    return response

@app.errorhandler(HTTPException)
def http_error(error):
    response = error.get_response()
    response.data = app.json.dumps({'error': error.description})
    response.content_type = 'application/json'
    return response

@app.errorhandler(Exception)
def server_error(error):
    app.logger.exception('Unexpected request failure')
    return jsonify(error='An unexpected server error occurred. Check the server log.'), 500

def share_item(media_id):
    return next((x for x in load_library() if x.get('id') == media_id), None)

def share_playback(item):
    path = media_path(item.get('file'))
    info = get_file_codecs(path)
    selected = info['default_audio_index']
    variant = selected if selected != info['audio_index'] else None
    ready = hls_manager.playlist_ready(HLS_DIR, item['id'], path, variant)
    playlist = (f'audio-{variant}/' if variant is not None else '') + 'playlist.m3u8'
    return {'strategy': get_stream_strategy(path), 'hls_playlist': playlist if ready else None}

def share_thumbnail_name(item):
    name = item.get('backdrop') or item.get('thumbnail') or item.get('poster')
    return name if isinstance(name, str) and localgram.THUMBNAIL_PATTERN.fullmatch(name) else None

# Lambdas look names up at call time, so the existing streaming, download and HLS code is reused unchanged.
localgram.init_app(app, SimpleNamespace(
    database_path=lambda: os.environ.get('SANFLIX_SHARE_DB') or os.path.join(BASE_DIR, 'database', 'localgram.sqlite3'),
    find_item=lambda media_id: share_item(media_id),
    media_path=lambda relative: media_path(relative),
    playback=lambda item: share_playback(item),
    stream=lambda item: stream_video(item['file']),
    hls=lambda item, filename: serve_hls_file(item['id'], filename),
    download=lambda item: download_media(item['id']),
    thumbnail_name=lambda item: share_thumbnail_name(item),
    thumbnail_dir=lambda: THUMBNAILS_DIR,
    client_ip=lambda: client_ip(),
    https=lambda: request_is_https()))

hubroom.init_app(app, SimpleNamespace(
    database_path=lambda: os.environ.get('SANFLIX_HUB_DB') or os.path.join(BASE_DIR, 'database', 'hubroom.sqlite3'),
    https=lambda: request_is_https()))

def announce():
    print(f'SANFLIX - http://localhost:{listen_port()}')
    urls = network_urls()
    if urls:
        print('Other devices on the same Wi-Fi/network can open:')
        for url in urls:
            print('  ' + url)
        print('They sign in with the viewing password.')
    elif listen_host() in {'127.0.0.1', 'localhost', '::1'}:
        print('Network sharing is off. Set SANFLIX_HOST=0.0.0.0 (start.bat does this) to allow other devices.')
    if _dev_generated:
        print('DEVELOPMENT MODE: temporary secrets were generated for this run only.')
        for name, value in _dev_generated.items():
            if name != security_config.SECRET_VAR:
                print(f'  {name}={value}')
    else:
        print('Passwords and the session key come from your environment or sanflix.env.')

if __name__ == '__main__':
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    announce()
    cleanup_old_hls()
    print('Development server (SANFLIX_DEV=1). For sharing, run serve.py instead.')
    app.run(host=listen_host(), port=listen_port(), debug=False, use_reloader=False)
