"""LocalGram sharing links: expiring, revocable links to ONE catalogued media item.

A link carries a random token. Only the SHA-256 hash of the token is stored (SQLite). Every
request through a link re-checks the token, expiry, revocation, permissions and that the media
item still exists. A link never grants library, admin or any other file access.

Ownership: SANFLIX has shared passwords, not user accounts, so a "creator" is a browser,
identified by a signed cookie (sanflix_owner). Admin sessions may list and revoke everything.
"""
import hashlib
import logging
import os
import re
import secrets
import sqlite3
import threading
import time
from collections import deque
from contextlib import closing

from flask import Blueprint, abort, current_app, jsonify, make_response, render_template, request, send_from_directory, session
from itsdangerous import BadSignature, URLSafeSerializer
from werkzeug.exceptions import HTTPException

TOKEN_PATTERN = re.compile(r'[A-Za-z0-9_-]{43}')
SHARE_ID_PATTERN = re.compile(r'[a-f0-9]{16}')
MEDIA_ID_PATTERN = re.compile(r'[a-f0-9]{12}')
THUMBNAIL_PATTERN = re.compile(r'thumbnails/(?:art/)?[A-Za-z0-9_.-]+\.jpg')
DURATIONS = {'1h': ('1 hour', 3600), '24h': ('24 hours', 86400), '7d': ('7 days', 604800)}
DEFAULT_DURATION = '24h'
SCHEMA_VERSION = 1
MAX_ACTIVE_PER_OWNER = 100
OWNER_COOKIE = 'sanflix_owner'
CREATE_LIMIT, REVOKE_LIMIT, LIMIT_WINDOW = 20, 60, 600
CREATE_LIMIT_PER_IP = 60
SHARED_TRANSFER_SLOTS = 8

bp = Blueprint('localgram', __name__)
PUBLIC_ENDPOINTS = frozenset({
    'localgram.share_page', 'localgram.share_info', 'localgram.share_stream',
    'localgram.share_download', 'localgram.share_hls', 'localgram.share_thumbnail'})
now = time.time  # Replaced in tests to move the clock.
deps = None
_transfer_slots = threading.BoundedSemaphore(SHARED_TRANSFER_SLOTS)
_ready = set()
_ready_lock = threading.Lock()


class LimitReached(Exception):
    pass


# ---------------------------------------------------------------- storage

def _connect(path):
    connection = sqlite3.connect(path, timeout=15, isolation_level=None)  # Autocommit; explicit transactions.
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA busy_timeout=15000')
    return connection


def prepare(path):
    """Create or upgrade the schema. Safe to call repeatedly and from several processes."""
    with _ready_lock:
        if path in _ready:
            return
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with closing(_connect(path)) as connection:
            connection.execute('PRAGMA journal_mode=WAL')
            connection.execute('BEGIN IMMEDIATE')
            try:
                version = connection.execute('PRAGMA user_version').fetchone()[0]
                if version > SCHEMA_VERSION:
                    raise RuntimeError('The sharing database was created by a newer SANFLIX version.')
                if version < 1:
                    connection.execute('''CREATE TABLE IF NOT EXISTS shares (
                        id TEXT PRIMARY KEY,
                        token_hash TEXT NOT NULL UNIQUE,
                        media_id TEXT NOT NULL,
                        media_title TEXT NOT NULL,
                        owner_id TEXT NOT NULL,
                        created_by_admin INTEGER NOT NULL,
                        created_at INTEGER NOT NULL,
                        expires_at INTEGER NOT NULL,
                        allow_stream INTEGER NOT NULL,
                        allow_download INTEGER NOT NULL,
                        revoked_at INTEGER,
                        revoked_by TEXT,
                        access_count INTEGER NOT NULL DEFAULT 0,
                        last_access_at INTEGER)''')
                    connection.execute('CREATE INDEX IF NOT EXISTS shares_owner ON shares (owner_id)')
                    connection.execute(f'PRAGMA user_version={SCHEMA_VERSION}')
                connection.execute('COMMIT')
            except BaseException:
                connection.execute('ROLLBACK')
                raise
        _ready.add(path)


def hash_token(token):
    return hashlib.sha256(token.encode('ascii')).hexdigest()


def create_share(path, *, media_id, title, owner_id, admin, duration, allow_stream, allow_download):
    prepare(path)
    token = secrets.token_urlsafe(32)  # 256 bits; 43 URL-safe characters.
    share_id, created = secrets.token_hex(8), int(now())
    expires = created + DURATIONS[duration][1]
    with closing(_connect(path)) as connection:
        connection.execute('BEGIN IMMEDIATE')
        try:
            active = connection.execute(
                'SELECT COUNT(*) FROM shares WHERE owner_id=? AND revoked_at IS NULL AND expires_at>?',
                (owner_id, created)).fetchone()[0]
            if active >= MAX_ACTIVE_PER_OWNER:
                raise LimitReached()
            connection.execute(
                'INSERT INTO shares (id, token_hash, media_id, media_title, owner_id, created_by_admin, created_at,'
                ' expires_at, allow_stream, allow_download) VALUES (?,?,?,?,?,?,?,?,?,?)',
                (share_id, hash_token(token), media_id, title[:200], owner_id, int(admin), created, expires,
                 int(allow_stream), int(allow_download)))
            connection.execute('COMMIT')
        except BaseException:
            connection.execute('ROLLBACK')
            raise
    return share_id, token, created, expires


def find_active(path, token):
    """The row for a usable link, or None for unknown, expired or revoked links."""
    if not TOKEN_PATTERN.fullmatch(token or ''):
        return None
    prepare(path)
    with closing(_connect(path)) as connection:
        return connection.execute(
            'SELECT * FROM shares WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?',
            (hash_token(token), int(now()))).fetchone()


def record_access(path, share_id):
    with closing(_connect(path)) as connection:
        connection.execute('UPDATE shares SET access_count=access_count+1, last_access_at=? WHERE id=?',
                           (int(now()), share_id))


def list_shares(path, owner_id, admin):
    prepare(path)
    with closing(_connect(path)) as connection:
        if admin:
            rows = connection.execute('SELECT * FROM shares ORDER BY created_at DESC LIMIT 500').fetchall()
        else:
            rows = connection.execute('SELECT * FROM shares WHERE owner_id=? ORDER BY created_at DESC LIMIT 500',
                                      (owner_id or '',)).fetchall()
    return rows


def revoke_share(path, share_id, owner_id, admin):
    """'revoked', 'already' or None (no such share, or not yours)."""
    prepare(path)
    with closing(_connect(path)) as connection:
        connection.execute('BEGIN IMMEDIATE')
        try:
            row = connection.execute('SELECT owner_id, revoked_at FROM shares WHERE id=?', (share_id,)).fetchone()
            if row is None or not (admin or (owner_id and row['owner_id'] == owner_id)):
                connection.execute('COMMIT')
                return None
            if row['revoked_at'] is not None:
                connection.execute('COMMIT')
                return 'already'
            connection.execute('UPDATE shares SET revoked_at=?, revoked_by=? WHERE id=?',
                               (int(now()), 'admin' if admin else 'owner', share_id))
            connection.execute('COMMIT')
            return 'revoked'
        except BaseException:
            connection.execute('ROLLBACK')
            raise


# ---------------------------------------------------------------- helpers

class RateLimiter:
    def __init__(self):
        self.hits, self.lock = {}, threading.Lock()

    def allow(self, key, limit, window):
        moment = time.monotonic()
        with self.lock:
            if len(self.hits) > 5000:
                self.hits.clear()
            queue = self.hits.setdefault(key, deque())
            while queue and moment - queue[0] > window:
                queue.popleft()
            if len(queue) >= limit:
                return False
            queue.append(moment)
            return True


limiter = RateLimiter()


def db_path():
    return deps.database_path()


def is_admin():
    return bool(session.get('admin'))


def can_create():
    return is_admin() or current_app.config.get('SHARE_CREATORS', 'admin') == 'viewers'


def _owner_serializer():
    return URLSafeSerializer(current_app.secret_key, salt='sanflix-share-owner')


def read_owner():
    raw = request.cookies.get(OWNER_COOKIE)
    if not raw:
        return None
    try:
        value = _owner_serializer().loads(raw)
    except BadSignature:
        return None
    return value if isinstance(value, str) and re.fullmatch(r'[a-f0-9]{32}', value) else None


def _private(response, *, page=False):
    response = make_response(response)
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Robots-Tag'] = 'noindex, nofollow'
    if page:
        response.headers['Content-Security-Policy'] = (
            "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; media-src 'self' blob:; "
            "connect-src 'self'; worker-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'")
    return response


def _authorize(token, permission=None):
    row = find_active(db_path(), token)
    item = deps.find_item(row['media_id']) if row else None
    if row is None or item is None:
        abort(404, description='This link is not available.')
    if permission and not row[permission]:
        abort(403, description='This link does not allow that.')
    return row, item


class _ReleaseOnClose:
    """Frees a transfer slot when the server closes the response.

    Werkzeug skips Response.call_on_close for file responses (direct_passthrough), so the slot is
    released from the body iterable itself, which every WSGI server closes.
    """

    def __init__(self, body):
        self.body, self.released = body, False

    def __iter__(self):
        return iter(self.body)

    def close(self):
        try:
            close = getattr(self.body, 'close', None)
            if close:
                close()
        finally:
            if not self.released:
                self.released = True
                _transfer_slots.release()


def _transfer(produce):
    """Bound concurrent shared transfers so friends cannot occupy every server thread."""
    if not _transfer_slots.acquire(blocking=False):
        abort(503, description='Too many shared transfers are running. Please try again shortly.')
    try:
        response = _private(produce())
    except BaseException:
        _transfer_slots.release()
        raise
    response.response = _ReleaseOnClose(response.response)
    return response


def _display_title(item):
    title = str(item.get('title') or 'Untitled')
    return f'{item["show"]} — {title}' if item.get('show') else title


def _status(row):
    if row['revoked_at'] is not None:
        return 'revoked'
    return 'expired' if row['expires_at'] <= now() else 'active'


# ---------------------------------------------------------------- creator API

@bp.get('/api/shares/me')
def share_policy():
    return jsonify(can_create=can_create(), admin=is_admin(), default=DEFAULT_DURATION,
                   durations=[{'key': key, 'label': label} for key, (label, _) in DURATIONS.items()])


@bp.post('/api/shares')
def create():
    if not can_create():
        return jsonify(error='Sharing needs admin sign-in. Use Manage library first.'), 403
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        return jsonify(error='Send the share options as JSON.'), 400
    media_id, duration = body.get('media_id'), body.get('duration', DEFAULT_DURATION)
    if not isinstance(media_id, str) or not MEDIA_ID_PATTERN.fullmatch(media_id):
        return jsonify(error='Choose a valid title to share.'), 400
    if not isinstance(duration, str) or duration not in DURATIONS:
        return jsonify(error='Choose a valid expiry.'), 400
    allow_stream, allow_download = body.get('allow_stream') is True, body.get('allow_download') is True
    if not (allow_stream or allow_download):
        return jsonify(error='Allow streaming, downloading, or both.'), 400
    owner = read_owner()
    new_owner = owner or secrets.token_hex(16)
    keys = [('create-ip', deps.client_ip(), CREATE_LIMIT_PER_IP), ('create-owner', new_owner, CREATE_LIMIT)]
    if not all(limiter.allow(kind + ':' + key, limit, LIMIT_WINDOW) for kind, key, limit in keys):
        return jsonify(error='Too many links created. Wait a few minutes.'), 429
    item = deps.find_item(media_id)
    if item is None:
        return jsonify(error='That title is not in the library.'), 404
    try:
        deps.media_path(item.get('file'))
    except HTTPException:
        return jsonify(error='That file is not available to share right now.'), 404
    try:
        share_id, token, created, expires = create_share(
            db_path(), media_id=media_id, title=_display_title(item), owner_id=new_owner, admin=is_admin(),
            duration=duration, allow_stream=allow_stream, allow_download=allow_download)
    except LimitReached:
        return jsonify(error='You have too many active links. Revoke some first.'), 429
    response = _private(jsonify(id=share_id, path='/s/' + token, title=_display_title(item), created_at=created,
                                expires_at=expires, allow_stream=allow_stream, allow_download=allow_download))
    response.status_code = 201
    if owner is None:
        response.set_cookie(OWNER_COOKIE, _owner_serializer().dumps(new_owner), max_age=365 * 86400, httponly=True,
                            samesite='Lax', secure=deps.https(), path='/')
    return response


@bp.get('/api/shares')
def list_my_shares():
    owner, admin = read_owner(), is_admin()
    return _private(jsonify(admin=admin, shares=[{
        'id': row['id'], 'title': row['media_title'], 'status': _status(row), 'created_at': row['created_at'],
        'expires_at': row['expires_at'], 'allow_stream': bool(row['allow_stream']),
        'allow_download': bool(row['allow_download']), 'access_count': row['access_count'],
        'last_access_at': row['last_access_at'], 'revoked_by': row['revoked_by'],
        'mine': bool(owner and row['owner_id'] == owner)} for row in list_shares(db_path(), owner, admin)]))


@bp.post('/api/shares/<share_id>/revoke')
def revoke(share_id):
    owner = read_owner()
    if not SHARE_ID_PATTERN.fullmatch(share_id):
        abort(404, description='That link was not found.')
    if not limiter.allow('revoke:' + (owner or deps.client_ip()), REVOKE_LIMIT, LIMIT_WINDOW):
        return jsonify(error='Too many requests. Wait a few minutes.'), 429
    if revoke_share(db_path(), share_id, owner, is_admin()) is None:
        abort(404, description='That link was not found.')  # Same answer for "not yours" and "does not exist".
    return jsonify(status='revoked')


# ---------------------------------------------------------------- recipient routes (token only)

def _unavailable():
    return _private(render_template('share.html', available=False), page=True), 404


@bp.get('/s/<token>')
def share_page(token):
    try:
        row, item = _authorize(token)
        deps.media_path(item.get('file'))
    except HTTPException:
        return _unavailable()
    record_access(db_path(), row['id'])
    return _private(render_template(
        'share.html', available=True, title=_display_title(item), duration=item.get('duration'),
        size=item.get('size'), expires_at=row['expires_at'],
        expires_text=time.strftime('on %Y-%m-%d %H:%M UTC', time.gmtime(row['expires_at'])),
        allow_stream=bool(row['allow_stream']),
        allow_download=bool(row['allow_download']), has_art=bool(deps.thumbnail_name(item))), page=True)


@bp.get('/s/<token>/info')
def share_info(token):
    row, item = _authorize(token)
    data = {'title': _display_title(item), 'size': item.get('size'), 'duration_seconds': item.get('duration_seconds'),
            'expires_at': row['expires_at'], 'allow_stream': bool(row['allow_stream']),
            'allow_download': bool(row['allow_download'])}
    if row['allow_stream']:
        data.update(deps.playback(item))
    return _private(jsonify(data))


@bp.get('/s/<token>/stream')
def share_stream(token):
    _, item = _authorize(token, 'allow_stream')
    return _transfer(lambda: deps.stream(item))


@bp.get('/s/<token>/hls/<path:filename>')
def share_hls(token, filename):
    _, item = _authorize(token, 'allow_stream')
    return _private(deps.hls(item, filename))


@bp.get('/s/<token>/download')
def share_download(token):
    row, item = _authorize(token, 'allow_download')
    record_access(db_path(), row['id'])
    return _transfer(lambda: deps.download(item))


@bp.get('/s/<token>/thumbnail')
def share_thumbnail(token):
    _, item = _authorize(token)
    name = deps.thumbnail_name(item)
    if not name:
        abort(404, description='This link is not available.')
    return _private(send_from_directory(deps.thumbnail_dir(), name[len('thumbnails/'):], max_age=0))


# ---------------------------------------------------------------- setup

class _RedactTokens(logging.Filter):
    """Keep share tokens out of server logs (the development server logs every request path)."""
    pattern = re.compile(r'/s/[A-Za-z0-9_-]{20,}')

    def filter(self, record):
        try:
            message = record.getMessage()
        except Exception:
            return True
        if '/s/' in message:
            record.msg, record.args = self.pattern.sub('/s/[token]', message), ()
        return True


def init_app(app, dependencies):
    global deps
    deps = dependencies
    app.config.setdefault('SHARE_CREATORS', 'admin')
    app.register_blueprint(bp)
    redactor = _RedactTokens()
    for name in ('werkzeug', 'waitress', 'waitress.queue', app.logger.name):
        logging.getLogger(name).addFilter(redactor)
