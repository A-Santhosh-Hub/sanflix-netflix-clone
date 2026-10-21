"""Shared LocalGram Hub room: share metadata, presence and WebRTC signaling.

This module NEVER receives media. Files stay in the owner's browser and travel directly between
browsers over WebRTC. The server keeps only: participants (random id, display name, last seen),
shares (random id, owner, sanitised file name, type, size, expiry) and short-lived transfer and
signaling records (SDP / ICE text, deleted after delivery). Every request must be signed in, must
carry the browser's signed participant cookie, and is limited to a tiny JSON body.
"""
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import unicodedata
from contextlib import closing, contextmanager

from flask import Blueprint, abort, current_app, jsonify, make_response, request, session
from itsdangerous import BadSignature, URLSafeSerializer

from localgram import RateLimiter

PEER_COOKIE = 'sanflix_peer'
SCHEMA_VERSION = 1
ID_PATTERN = re.compile(r'[a-f0-9]{16}')
REF_PATTERN = re.compile(r'[A-Za-z0-9_-]{1,40}')
MIME_PATTERN = re.compile(r'(video|image|audio)/[a-z0-9][a-z0-9.+-]{0,60}')
KINDS = {'video', 'image', 'audio'}
ACTIVE = ('requested', 'approved', 'connected')
TERMINAL = ('rejected', 'failed', 'cancelled', 'done')
ONLINE_SECONDS = 30
OFFLINE_REMOVE_SECONDS = 600
SIGNAL_TTL = 300
REQUEST_TIMEOUT = 90
APPROVED_TIMEOUT = 90
CONNECTED_IDLE = 180
KEEP_FINISHED_SECONDS = 600
PARTICIPANT_FORGET_SECONDS = 24 * 3600
MAX_BODY = 32 * 1024
MAX_SDP = 12000
MAX_SIGNALS_PER_TRANSFER = 300
MAX_BATCH = 20

DEFAULT_LIMITS = {
    'max_file_bytes': 4096 * 1024 ** 2, 'play_max_bytes': 512 * 1024 ** 2,
    'max_shares_per_participant': 100, 'max_participants': 25, 'max_transfers': 8,
    'transfers_per_requester': 2, 'transfers_per_owner': 3, 'transfers_per_share': 3,
    'share_ttl_seconds': 12 * 3600, 'stun': ['stun:stun.l.google.com:19302'],
}

bp = Blueprint('hubroom', __name__)
now = time.time  # Replaced in tests to move the clock.
deps = None
limiter = RateLimiter()
_ready = set()
_ready_lock = threading.Lock()
_cleanup = {'last': 0.0}


# ---------------------------------------------------------------- storage

def _connect(path):
    connection = sqlite3.connect(path, timeout=15, isolation_level=None)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA busy_timeout=15000')
    return connection


def prepare(path):
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
                    raise RuntimeError('The Hub database was created by a newer SANFLIX version.')
                if version < 1:
                    connection.execute('''CREATE TABLE IF NOT EXISTS participants (
                        id TEXT PRIMARY KEY, name TEXT NOT NULL, epoch TEXT NOT NULL,
                        created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL)''')
                    connection.execute('''CREATE TABLE IF NOT EXISTS shares (
                        id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL,
                        mime TEXT NOT NULL, size INTEGER NOT NULL, created_at INTEGER NOT NULL,
                        expires_at INTEGER NOT NULL, removed_at INTEGER)''')
                    connection.execute('''CREATE TABLE IF NOT EXISTS transfers (
                        id TEXT PRIMARY KEY, share_id TEXT NOT NULL, owner_id TEXT NOT NULL,
                        requester_id TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '',
                        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, signal_count INTEGER NOT NULL DEFAULT 0)''')
                    connection.execute('''CREATE TABLE IF NOT EXISTS signals (
                        id INTEGER PRIMARY KEY AUTOINCREMENT, to_id TEXT NOT NULL, from_id TEXT NOT NULL,
                        transfer_id TEXT NOT NULL, type TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL)''')
                    connection.execute('CREATE INDEX IF NOT EXISTS shares_owner ON shares (owner_id)')
                    connection.execute('CREATE INDEX IF NOT EXISTS transfers_status ON transfers (status)')
                    connection.execute('CREATE INDEX IF NOT EXISTS signals_to ON signals (to_id, id)')
                    connection.execute(f'PRAGMA user_version={SCHEMA_VERSION}')
                connection.execute('COMMIT')
            except BaseException:
                connection.execute('ROLLBACK')
                raise
        _ready.add(path)


@contextmanager
def transaction():
    path = deps.database_path()
    prepare(path)
    connection = _connect(path)
    try:
        connection.execute('BEGIN IMMEDIATE')
        try:
            yield connection
            connection.execute('COMMIT')
        except BaseException:
            connection.execute('ROLLBACK')
            raise
    finally:
        connection.close()


def cleanup(connection, force=False):
    """Expire stale shares, signaling and transfers. Cheap; throttled to once per 15 seconds."""
    moment = int(now())
    if not force and moment - _cleanup['last'] < 15:
        return
    _cleanup['last'] = moment
    connection.execute('DELETE FROM signals WHERE created_at < ?', (moment - SIGNAL_TTL,))
    connection.execute(
        "UPDATE transfers SET status='failed', reason='timeout', updated_at=? WHERE "
        "(status='requested' AND created_at<?) OR (status='approved' AND updated_at<?) OR (status='connected' AND updated_at<?)",
        (moment, moment - REQUEST_TIMEOUT, moment - APPROVED_TIMEOUT, moment - CONNECTED_IDLE))
    connection.execute('DELETE FROM transfers WHERE status IN (?,?,?,?) AND updated_at < ?',
                       (*TERMINAL, moment - KEEP_FINISHED_SECONDS))
    connection.execute('UPDATE shares SET removed_at=? WHERE removed_at IS NULL AND expires_at<=?', (moment, moment))
    connection.execute(
        'UPDATE shares SET removed_at=? WHERE removed_at IS NULL AND owner_id IN (SELECT id FROM participants WHERE last_seen<?)',
        (moment, moment - OFFLINE_REMOVE_SECONDS))
    connection.execute('DELETE FROM shares WHERE removed_at IS NOT NULL AND removed_at<?', (moment - KEEP_FINISHED_SECONDS,))
    connection.execute('DELETE FROM participants WHERE last_seen<?', (moment - PARTICIPANT_FORGET_SECONDS,))


# ---------------------------------------------------------------- validation and identity

def limits():
    return current_app.config.get('HUB_LIMITS', DEFAULT_LIMITS)


def clean_text(value, limit):
    """User-supplied text: no control, format (e.g. bidi override) or private-use characters."""
    text = unicodedata.normalize('NFKC', str(value))
    text = ''.join(ch for ch in text if unicodedata.category(ch)[0] != 'C')
    return ' '.join(text.split())[:limit].strip()


def clean_filename(value):
    return clean_text(str(value).replace('\\', '/').split('/')[-1], 180)


def _serializer():
    return URLSafeSerializer(current_app.secret_key, salt='sanflix-hub-peer')


def cookie_pid():
    raw = request.cookies.get(PEER_COOKIE)
    if not raw:
        return None
    try:
        value = _serializer().loads(raw)
    except BadSignature:
        return None
    return value if isinstance(value, str) and ID_PATTERN.fullmatch(value) else None


def current_participant(connection):
    pid = cookie_pid()
    row = connection.execute('SELECT * FROM participants WHERE id=?', (pid,)).fetchone() if pid else None
    if row is None:
        abort(409, description='Join the Hub first.')
    if not secrets.compare_digest(row['epoch'], request.headers.get('X-Hub-Epoch', '')):
        abort(409, description='The Hub is open in another tab. Reload this page to use it here.')
    connection.execute('UPDATE participants SET last_seen=? WHERE id=?', (int(now()), row['id']))
    return row


def json_body():
    body = request.get_json(silent=True)
    if not isinstance(body, dict):
        abort(400, description='Send a JSON object.')
    return body


def reply(data, status=200):
    response = make_response(jsonify(data), status)
    response.headers['Cache-Control'] = 'private, no-store'
    return response


def online(row_last_seen):
    return row_last_seen >= now() - ONLINE_SECONDS


def tag(pid):
    return pid[-4:]


def public_share(row, owner_name, owner_last_seen):
    return {'id': row['id'], 'owner': row['owner_id'], 'owner_name': owner_name, 'owner_tag': tag(row['owner_id']),
            'name': row['name'], 'kind': row['kind'], 'mime': row['mime'], 'size': row['size'],
            'created_at': row['created_at'], 'expires_at': row['expires_at'],
            'available': online(owner_last_seen)}


def push(connection, to_id, from_id, transfer_id, kind, payload):
    connection.execute('INSERT INTO signals (to_id, from_id, transfer_id, type, payload, created_at) VALUES (?,?,?,?,?,?)',
                       (to_id, from_id, transfer_id, kind, json.dumps(payload, separators=(',', ':')), int(now())))


def finish_transfer(connection, row, status, reason, notify_from):
    connection.execute('UPDATE transfers SET status=?, reason=?, updated_at=? WHERE id=?', (status, reason[:120], int(now()), row['id']))
    other = row['requester_id'] if notify_from == row['owner_id'] else row['owner_id']
    push(connection, other, notify_from, row['id'], 'status', {'status': status, 'reason': reason[:120]})


def _limit(kind, key, count, window=600):
    if not limiter.allow(f'{kind}:{key}', count, window):
        abort(429, description='Too many requests. Wait a moment.')


# ---------------------------------------------------------------- request guards

@bp.before_request
def guard_body():
    """Only tiny JSON bodies are ever accepted here, so media cannot be uploaded through the Hub API."""
    if request.method in {'POST', 'PUT', 'PATCH', 'DELETE'}:
        if request.mimetype != 'application/json':
            abort(415, description='The Hub API accepts JSON only. Media is never uploaded.')
        if (request.content_length or 0) > MAX_BODY:
            abort(413, description='That request is too large. Media is never uploaded.')


# ---------------------------------------------------------------- membership

@bp.post('/api/hub/join')
def join():
    body = json_body()
    name, fresh = clean_text(body.get('name', ''), 32), body.get('fresh') is True
    pid, moment, created = cookie_pid(), int(now()), False
    epoch = secrets.token_hex(4)
    with transaction() as connection:
        cleanup(connection, force=True)
        row = connection.execute('SELECT * FROM participants WHERE id=?', (pid,)).fetchone() if pid else None
        if row is None:
            active = connection.execute('SELECT COUNT(*) FROM participants WHERE last_seen>=?', (moment - ONLINE_SECONDS,)).fetchone()[0]
            if active >= limits()['max_participants']:
                abort(503, description='The Hub is full right now. Try again later.')
            pid, created = secrets.token_hex(8), True
            name = name or 'Guest-' + tag(pid)
            connection.execute('INSERT INTO participants (id, name, epoch, created_at, last_seen) VALUES (?,?,?,?,?)',
                               (pid, name, epoch, moment, moment))
        else:
            name = name or row['name']
            connection.execute('UPDATE participants SET name=?, epoch=?, last_seen=? WHERE id=?', (name, epoch, moment, pid))
        if fresh:  # A reloaded page has lost its File objects, so anything it shared is gone.
            connection.execute('UPDATE shares SET removed_at=? WHERE owner_id=? AND removed_at IS NULL', (moment, pid))
            for transfer in connection.execute('SELECT * FROM transfers WHERE status IN (?,?,?) AND (owner_id=? OR requester_id=?)',
                                               (*ACTIVE, pid, pid)).fetchall():
                finish_transfer(connection, transfer, 'cancelled', 'The other device reloaded the Hub.', pid)
    response = reply({'pid': pid, 'name': name, 'tag': tag(pid), 'epoch': epoch, 'admin': bool(session.get('admin')),
                      'ice': [{'urls': url} for url in limits()['stun']],
                      'limits': {k: limits()[k] for k in ('max_file_bytes', 'play_max_bytes', 'max_shares_per_participant')}})
    if created or pid != cookie_pid():
        response.set_cookie(PEER_COOKIE, _serializer().dumps(pid), max_age=30 * 86400, httponly=True, samesite='Lax',
                            secure=deps.https(), path='/')
    return response


@bp.post('/api/hub/name')
def rename():
    name = clean_text(json_body().get('name', ''), 32)
    if not name:
        abort(400, description='Enter a display name.')
    with transaction() as connection:
        row = current_participant(connection)
        connection.execute('UPDATE participants SET name=? WHERE id=?', (name, row['id']))
    return reply({'name': name})


@bp.get('/api/hub/poll')
def poll():
    try:
        after = max(0, int(request.args.get('after', '0')))
    except ValueError:
        abort(400, description='Invalid position.')
    moment = int(now())
    with transaction() as connection:
        row = current_participant(connection)  # Record activity first, so a returning owner is not cleaned up by their own request.
        cleanup(connection)
        _limit('poll', row['id'], 240, 60)
        connection.execute('DELETE FROM signals WHERE to_id=? AND id<=?', (row['id'], after))
        signals = connection.execute('SELECT * FROM signals WHERE to_id=? AND id>? ORDER BY id LIMIT 100', (row['id'], after)).fetchall()
        shares = connection.execute(
            'SELECT s.*, p.name AS owner_name, p.last_seen AS owner_seen FROM shares s JOIN participants p ON p.id=s.owner_id '
            'WHERE s.removed_at IS NULL AND s.expires_at>? ORDER BY s.created_at DESC LIMIT 500', (moment,)).fetchall()
        people = connection.execute('SELECT id, name, last_seen FROM participants WHERE last_seen>=? ORDER BY name LIMIT 100',
                                    (moment - ONLINE_SECONDS,)).fetchall()
        mine = connection.execute('SELECT id, share_id, owner_id, requester_id, purpose, status FROM transfers '
                                  'WHERE (owner_id=? OR requester_id=?) AND status IN (?,?,?)', (row['id'], row['id'], *ACTIVE)).fetchall()
        names = {p['id']: p['name'] for p in people}
    return reply({
        'now': moment, 'me': {'pid': row['id'], 'name': row['name'], 'tag': tag(row['id'])},
        'participants': [{'pid': p['id'], 'name': p['name'], 'tag': tag(p['id'])} for p in people],
        'shares': [public_share(s, s['owner_name'], s['owner_seen']) for s in shares],
        'signals': [{'id': s['id'], 'type': s['type'], 'transfer': s['transfer_id'], 'from': s['from_id'],
                     'from_name': names.get(s['from_id'], ''), 'payload': json.loads(s['payload'])} for s in signals],
        'transfers': [dict(t) for t in mine]})


# ---------------------------------------------------------------- shares

@bp.post('/api/hub/shares')
def publish():
    items = json_body().get('items')
    if not isinstance(items, list) or not 1 <= len(items) <= MAX_BATCH:
        abort(400, description=f'Share between 1 and {MAX_BATCH} items at a time.')
    config, moment, clean = limits(), int(now()), []
    for item in items:
        if not isinstance(item, dict):
            abort(400, description='Invalid item.')
        name, kind, size = clean_filename(item.get('name', '')), item.get('kind'), item.get('size')
        mime = str(item.get('mime', '')).lower()[:80]
        ref = item.get('ref')
        if not name or kind not in KINDS:
            abort(400, description='Each item needs a file name and a type (video, image or audio).')
        if type(size) is not int or not 0 < size <= config['max_file_bytes']:
            abort(413, description=f'"{name}" is empty or larger than the Hub limit of {config["max_file_bytes"] // 1024 ** 2} MB.')
        if mime and not (MIME_PATTERN.fullmatch(mime) and mime.split('/')[0] == kind):
            mime = ''
        if ref is not None and not (isinstance(ref, str) and REF_PATTERN.fullmatch(ref)):
            abort(400, description='Invalid reference.')
        clean.append((name, kind, mime, size, ref))
    with transaction() as connection:
        row = current_participant(connection)
        cleanup(connection)
        _limit('publish', row['id'], 60, 600)
        active = connection.execute('SELECT COUNT(*) FROM shares WHERE owner_id=? AND removed_at IS NULL AND expires_at>?',
                                    (row['id'], moment)).fetchone()[0]
        if active + len(clean) > config['max_shares_per_participant']:
            abort(429, description='You are sharing too many items. Stop sharing some first.')
        created = []
        for name, kind, mime, size, ref in clean:
            share_id = secrets.token_hex(8)
            connection.execute('INSERT INTO shares (id, owner_id, name, kind, mime, size, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?)',
                               (share_id, row['id'], name, kind, mime, size, moment, moment + config['share_ttl_seconds']))
            created.append({'id': share_id, 'ref': ref, 'name': name, 'kind': kind, 'mime': mime, 'size': size,
                            'expires_at': moment + config['share_ttl_seconds']})
    return reply({'shares': created}, 201)


@bp.post('/api/hub/shares/<share_id>/remove')
def remove_share(share_id):
    if not ID_PATTERN.fullmatch(share_id):
        abort(404, description='That item was not found.')
    with transaction() as connection:
        row = current_participant(connection)
        share = connection.execute('SELECT * FROM shares WHERE id=? AND removed_at IS NULL', (share_id,)).fetchone()
        if share is None or not (share['owner_id'] == row['id'] or session.get('admin')):
            abort(404, description='That item was not found.')  # Same answer for "not yours" and "does not exist".
        connection.execute('UPDATE shares SET removed_at=? WHERE id=?', (int(now()), share_id))
        for transfer in connection.execute('SELECT * FROM transfers WHERE share_id=? AND status IN (?,?,?)', (share_id, *ACTIVE)).fetchall():
            finish_transfer(connection, transfer, 'cancelled', 'The owner stopped sharing this item.', share['owner_id'])
    return reply({'status': 'removed'})


# ---------------------------------------------------------------- transfers and signaling

@bp.post('/api/hub/shares/<share_id>/request')
def request_transfer(share_id):
    if not ID_PATTERN.fullmatch(share_id):
        abort(404, description='That item was not found.')
    purpose = json_body().get('purpose', 'download')
    if purpose not in {'download', 'play'}:
        abort(400, description='Choose download or play.')
    config, moment = limits(), int(now())
    with transaction() as connection:
        row = current_participant(connection)
        cleanup(connection)
        _limit('request', row['id'], 30, 600)
        share = connection.execute(
            'SELECT s.*, p.last_seen AS owner_seen, p.name AS owner_name FROM shares s JOIN participants p ON p.id=s.owner_id '
            'WHERE s.id=? AND s.removed_at IS NULL AND s.expires_at>?', (share_id, moment)).fetchone()
        if share is None:
            abort(404, description='That item is no longer shared.')
        if share['owner_id'] == row['id']:
            abort(400, description='That is your own item.')
        if not online(share['owner_seen']):
            abort(409, description=f'{share["owner_name"]} is offline, so this item is unavailable right now.')

        def active(column, value):
            return connection.execute(f'SELECT COUNT(*) FROM transfers WHERE {column}=? AND status IN (?,?,?)', (value, *ACTIVE)).fetchone()[0]
        if connection.execute('SELECT COUNT(*) FROM transfers WHERE share_id=? AND requester_id=? AND status IN (?,?,?)',
                              (share_id, row['id'], *ACTIVE)).fetchone()[0]:
            abort(409, description='You already requested this item.')
        if connection.execute('SELECT COUNT(*) FROM transfers WHERE status IN (?,?,?)', ACTIVE).fetchone()[0] >= config['max_transfers']:
            abort(429, description='The Hub is busy with other transfers. Try again shortly.')
        if active('requester_id', row['id']) >= config['transfers_per_requester']:
            abort(429, description='You have too many transfers in progress. Wait for one to finish.')
        if active('owner_id', share['owner_id']) >= config['transfers_per_owner']:
            abort(429, description=f'{share["owner_name"]} is already sending to other friends. Try again shortly.')
        if active('share_id', share_id) >= config['transfers_per_share']:
            abort(429, description='Several friends are already receiving this item. Try again shortly.')
        transfer_id = secrets.token_hex(8)
        connection.execute('INSERT INTO transfers (id, share_id, owner_id, requester_id, purpose, status, created_at, updated_at) '
                           'VALUES (?,?,?,?,?,?,?,?)', (transfer_id, share_id, share['owner_id'], row['id'], purpose, 'requested', moment, moment))
        push(connection, share['owner_id'], row['id'], transfer_id, 'request',
             {'share': share_id, 'name': share['name'], 'size': share['size'], 'purpose': purpose, 'from_name': row['name'],
              'from_tag': tag(row['id'])})
    return reply({'transfer': transfer_id, 'status': 'requested'}, 201)


def _transfer_for(connection, transfer_id, participant_id):
    if not ID_PATTERN.fullmatch(transfer_id):
        abort(404, description='That transfer was not found.')
    row = connection.execute('SELECT * FROM transfers WHERE id=?', (transfer_id,)).fetchone()
    if row is None or participant_id not in (row['owner_id'], row['requester_id']):
        abort(404, description='That transfer was not found.')
    return row


@bp.post('/api/hub/transfers/<transfer_id>/decision')
def decide(transfer_id):
    approve = json_body().get('approve')
    if not isinstance(approve, bool):
        abort(400, description='Approve or decline.')
    with transaction() as connection:
        row = current_participant(connection)
        transfer = _transfer_for(connection, transfer_id, row['id'])
        if transfer['owner_id'] != row['id']:
            abort(403, description='Only the owner can decide.')
        if transfer['status'] != 'requested':
            abort(409, description='This request is no longer waiting.')
        connection.execute('UPDATE transfers SET status=?, updated_at=? WHERE id=?', ('approved' if approve else 'rejected', int(now()), transfer_id))
        push(connection, transfer['requester_id'], row['id'], transfer_id, 'decision', {'approved': approve})
    return reply({'status': 'approved' if approve else 'rejected'})


def valid_signal(kind, payload):
    if kind in {'offer', 'answer'}:
        return (isinstance(payload, dict) and payload.get('type') == kind and isinstance(payload.get('sdp'), str)
                and 0 < len(payload['sdp']) <= MAX_SDP and set(payload) <= {'type', 'sdp'})
    if kind == 'ice':
        candidates = payload.get('candidates') if isinstance(payload, dict) else None
        if not isinstance(candidates, list) or not 1 <= len(candidates) <= 20 or set(payload) != {'candidates'}:
            return False
        for item in candidates:
            if not isinstance(item, dict) or not set(item) <= {'candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'}:
                return False
            if not isinstance(item.get('candidate'), str) or len(item['candidate']) > 600:
                return False
            if not isinstance(item.get('sdpMid'), (str, type(None))) or len(item.get('sdpMid') or '') > 64:
                return False
            if not (item.get('sdpMLineIndex') is None or (type(item['sdpMLineIndex']) is int and 0 <= item['sdpMLineIndex'] < 8)):
                return False
            if not isinstance(item.get('usernameFragment', None), (str, type(None))) or len(item.get('usernameFragment') or '') > 64:
                return False
        return True
    return False


@bp.post('/api/hub/transfers/<transfer_id>/signal')
def signal(transfer_id):
    body = json_body()
    kind, payload = body.get('kind'), body.get('payload')
    if not valid_signal(kind, payload):
        abort(400, description='Invalid connection message.')
    with transaction() as connection:
        row = current_participant(connection)
        transfer = _transfer_for(connection, transfer_id, row['id'])
        owner = transfer['owner_id'] == row['id']
        if transfer['status'] not in ('approved', 'connected'):
            abort(409, description='This transfer is not accepting connection messages.')
        if (kind == 'offer' and not owner) or (kind == 'answer' and owner):
            abort(403, description='That message is not allowed for your role.')
        if transfer['signal_count'] >= MAX_SIGNALS_PER_TRANSFER:
            abort(429, description='Too many connection messages for this transfer.')
        connection.execute('UPDATE transfers SET signal_count=signal_count+1 WHERE id=?', (transfer_id,))
        other = transfer['requester_id'] if owner else transfer['owner_id']
        push(connection, other, row['id'], transfer_id, 'signal', {'kind': kind, 'data': payload})
    return reply({'status': 'sent'})


@bp.post('/api/hub/transfers/<transfer_id>/status')
def update_status(transfer_id):
    body = json_body()
    status, reason = body.get('status'), clean_text(body.get('reason', ''), 120)
    if status not in {'connected', 'done', 'failed', 'cancelled'}:
        abort(400, description='Invalid status.')
    with transaction() as connection:
        row = current_participant(connection)
        transfer = _transfer_for(connection, transfer_id, row['id'])
        current = transfer['status']
        if current in TERMINAL:
            return reply({'status': current})
        if status == 'connected':
            if current not in ('approved', 'connected'):
                abort(409, description='This transfer is not ready.')
            connection.execute("UPDATE transfers SET status='connected', updated_at=? WHERE id=?", (int(now()), transfer_id))
        elif status == 'done':
            if current != 'connected':
                abort(409, description='This transfer never connected.')
            finish_transfer(connection, transfer, 'done', reason, row['id'])
        else:
            finish_transfer(connection, transfer, status, reason, row['id'])
    return reply({'status': status})


# ---------------------------------------------------------------- setup

def limits_from_environment(environ):
    """Conservative defaults, adjustable with SANFLIX_HUB_* variables (names only; no secrets)."""
    def number(name, default):
        try:
            return max(1, int(environ.get(name, default)))
        except ValueError:
            return default
    result = dict(DEFAULT_LIMITS)
    result.update(
        max_file_bytes=number('SANFLIX_HUB_MAX_FILE_MB', 4096) * 1024 ** 2,
        play_max_bytes=number('SANFLIX_HUB_PLAY_MAX_MB', 512) * 1024 ** 2,
        max_shares_per_participant=number('SANFLIX_HUB_MAX_SHARES', 100),
        max_participants=number('SANFLIX_HUB_MAX_PARTICIPANTS', 25),
        max_transfers=number('SANFLIX_HUB_MAX_TRANSFERS', 8),
        transfers_per_requester=number('SANFLIX_HUB_TRANSFERS_PER_PERSON', 2),
        transfers_per_owner=number('SANFLIX_HUB_TRANSFERS_PER_OWNER', 3),
        transfers_per_share=number('SANFLIX_HUB_TRANSFERS_PER_ITEM', 3),
        share_ttl_seconds=number('SANFLIX_HUB_SHARE_HOURS', 12) * 3600)
    if 'SANFLIX_HUB_STUN' in environ:  # Empty means no STUN: only same-network connections can work.
        servers = [item.strip() for item in environ['SANFLIX_HUB_STUN'].split(',') if item.strip()]
        result['stun'] = [item for item in servers if re.fullmatch(r'stuns?:[A-Za-z0-9.\-]{1,200}(:\d{1,5})?', item)]
    return result


def init_app(app, dependencies):
    global deps
    deps = dependencies
    app.config.setdefault('HUB_LIMITS', dict(DEFAULT_LIMITS))
    app.register_blueprint(bp)
