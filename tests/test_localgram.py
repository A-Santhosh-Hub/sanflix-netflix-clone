"""Phase 1: private sharing links. Real FFmpeg fixtures; every write goes to a temporary directory."""
import logging
import re
import sqlite3
from contextlib import closing
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import sanflix_test_env  # noqa: F401
import app
import hls_manager
import localgram
from media_utils import atomic_json, media_id

REMOTE = {'REMOTE_ADDR': '203.0.113.20'}
ADMIN, VIEW = 'admin-share-pass-0123', 'viewer-share-pass-0123'
TOKEN_IN_URL = re.compile(r'/s/([A-Za-z0-9_-]{43})')


class ShareCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix='sanflix-share-fixture-')
        clip = Path(cls.fixture.name) / 'clip.mp4'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1.2',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', str(clip)], check=True, timeout=30)
        mkv = Path(cls.fixture.name) / 'clip.mkv'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(clip), '-c', 'copy', '-y', str(mkv)],
                       check=True, timeout=30)
        cls.clip, cls.mkv = clip.read_bytes(), mkv.read_bytes()

    @classmethod
    def tearDownClass(cls):
        cls.fixture.cleanup()

    def put(self, relative, data, **extra):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        entry = {'id': media_id(relative), 'file': relative, 'title': path.stem, 'category': 'movie',
                 'filename': path.name, 'size': '10 KB', 'duration': '00:00:01', 'duration_seconds': 1.2, **extra}
        self.catalogue.append(entry)
        return entry

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='sanflix-share-test-')
        self.root = Path(self.temporary.name).resolve()
        (self.root / 'database').mkdir()
        (self.root / 'thumbnails').mkdir()
        self.catalogue = []
        self.movie = self.put('media/movies/Movie #1.mp4', self.clip)
        self.other = self.put('media/movies/Other.mp4', self.clip + b'\0')
        self.xss = self.put('media/movies/Xss.mp4', self.clip, title='<script>alert(1)</script>')
        self.remux = self.put('media/movies/Remux.mkv', self.mkv)
        self.hidden = self.put('media/.uploads/Hidden.mp4', self.clip)
        self.missing = {'id': media_id('media/movies/missing.mp4'), 'file': 'media/movies/missing.mp4', 'title': 'Gone'}
        (self.root / 'outside.mp4').write_bytes(self.clip)
        self.outside = {'id': media_id('media/../outside.mp4'), 'file': 'media/../outside.mp4', 'title': 'Outside'}
        self.nofile = {'id': media_id('nofile'), 'title': 'No file'}
        self.catalogue += [self.missing, self.outside, self.nofile]
        atomic_json(self.root / 'database' / 'media_library.json', self.catalogue)
        self.clock = [time.time()]
        self.patches = [
            patch.multiple(app, BASE_DIR=str(self.root), MEDIA_DIR=str(self.root / 'media'),
                           DATABASE_FILE=str(self.root / 'database' / 'media_library.json'),
                           HLS_DIR=str(self.root / 'hls_cache'), THUMBNAILS_DIR=str(self.root / 'thumbnails'),
                           _library_cache={'data': None, 'mtime': None, 'etag': None}, _codec_cache={},
                           _login_failures={}, _revoked={'stamp': None, 'data': {}}),
            patch.dict(app.app.config, TESTING=True, TRUSTED_PROXY=False, SHARE_CREATORS='admin',
                       ADMIN_PASSWORD_HASH=app.generate_password_hash(ADMIN),
                       VIEW_PASSWORD_HASH=app.generate_password_hash(VIEW)),
            patch.object(localgram, 'now', lambda: self.clock[0]),
            patch.object(localgram, 'limiter', localgram.RateLimiter()),
            patch.object(localgram, '_transfer_slots', threading.BoundedSemaphore(localgram.SHARED_TRANSFER_SLOTS)),
        ]
        for patcher in self.patches:
            patcher.start()
        localgram._ready.clear()
        self.db = self.root / 'database' / 'localgram.sqlite3'
        self.admin = self.login(admin=True)
        self.recipient = app.app.test_client()

    def tearDown(self):
        for patcher in reversed(self.patches):
            patcher.stop()
        localgram._ready.clear()
        self.temporary.cleanup()

    def login(self, admin=False):
        client = app.app.test_client()
        page = client.get('/login', environ_overrides=REMOTE).get_data(as_text=True)
        token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
        if admin:
            response = client.post('/api/admin/login', json={'password': ADMIN}, headers={'X-CSRF-Token': token},
                                   environ_overrides=REMOTE)
        else:
            response = client.post('/login', data={'password': VIEW, 'csrf_token': token}, environ_overrides=REMOTE)
        self.assertIn(response.status_code, (200, 302))
        return client

    @staticmethod
    def csrf(client):
        with client.session_transaction() as session:
            return session['csrf_token']

    def create(self, client=None, item=None, duration='24h', stream=True, download=False, **headers):
        client = client or self.admin
        item = item or self.movie
        return client.post('/api/shares', json={'media_id': item['id'], 'duration': duration, 'allow_stream': stream,
                                                'allow_download': download},
                           headers={'X-CSRF-Token': self.csrf(client), **headers}, environ_overrides=REMOTE)

    def link(self, **options):
        response = self.create(**options)
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        data = response.get_json()
        return data['path'], data['id'], TOKEN_IN_URL.fullmatch(data['path']).group(1)

    def get(self, path, **kwargs):
        kwargs.setdefault('buffered', True)  # A real server closes the response; the test client must too.
        return self.recipient.get(path, environ_overrides=REMOTE, **kwargs)

    def revoke(self, client, share_id):
        return client.post(f'/api/shares/{share_id}/revoke', headers={'X-CSRF-Token': self.csrf(client)},
                           environ_overrides=REMOTE)

    def rows(self):
        localgram.prepare(str(self.db))
        with closing(sqlite3.connect(self.db)) as connection:
            return connection.execute('SELECT * FROM shares').fetchall()


class CreationTests(ShareCase):
    def test_admin_creates_a_private_link_and_only_a_hash_is_stored(self):
        response = self.create(download=True)
        self.assertEqual(response.status_code, 201)
        data = response.get_json()
        token = TOKEN_IN_URL.fullmatch(data['path']).group(1)
        self.assertRegex(data['id'], r'^[a-f0-9]{16}$')
        self.assertEqual(data['expires_at'] - data['created_at'], 86400)
        self.assertEqual(response.headers['Cache-Control'], 'private, no-store')
        row = self.rows()[0]
        self.assertIn(localgram.hash_token(token), row)
        stored = b''.join(p.read_bytes() for p in self.db.parent.glob('localgram.sqlite3*'))
        self.assertNotIn(token.encode(), stored)
        cookie = next(h for h in response.headers.getlist('Set-Cookie') if h.startswith('sanflix_owner='))
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Lax', cookie)

    def test_anonymous_and_unsigned_requests_cannot_create_or_list(self):
        anonymous = app.app.test_client()
        page = anonymous.get('/login', environ_overrides=REMOTE).get_data(as_text=True)
        token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
        body = {'media_id': self.movie['id'], 'allow_stream': True}
        self.assertEqual(anonymous.post('/api/shares', json=body, environ_overrides=REMOTE).status_code, 403)  # CSRF
        self.assertEqual(anonymous.post('/api/shares', json=body, headers={'X-CSRF-Token': token},
                                        environ_overrides=REMOTE).status_code, 401)
        for url in ('/api/shares', '/api/shares/me'):
            self.assertEqual(anonymous.get(url, environ_overrides=REMOTE).status_code, 401, url)
        self.assertEqual(self.rows() if self.db.exists() else [], [])

    def test_creation_policy_admin_by_default_and_viewers_when_enabled(self):
        viewer = self.login()
        self.assertEqual(self.create(client=viewer).status_code, 403)
        self.assertFalse(viewer.get('/api/shares/me', environ_overrides=REMOTE).get_json()['can_create'])
        local = app.app.test_client()  # Passwordless localhost browser: viewer rights only.
        local.get('/login')
        denied = local.post('/api/shares', json={'media_id': self.movie['id'], 'allow_stream': True},
                            headers={'X-CSRF-Token': self.csrf(local)})
        self.assertEqual(denied.status_code, 403)
        with patch.dict(app.app.config, SHARE_CREATORS='viewers'):
            self.assertEqual(self.create(client=viewer).status_code, 201)
            self.assertTrue(viewer.get('/api/shares/me', environ_overrides=REMOTE).get_json()['can_create'])

    def test_invalid_media_ids_and_catalogue_entries_are_rejected(self):
        for bad in (None, 123, '', ' ', '../../etc/passwd', 'zzzzzzzzzzzz', 'A' * 12, 'a' * 11, 'a' * 13, ['a' * 12], {'x': 1}):
            with self.subTest(media_id=bad):
                response = self.admin.post('/api/shares', json={'media_id': bad, 'allow_stream': True},
                                           headers={'X-CSRF-Token': self.csrf(self.admin)}, environ_overrides=REMOTE)
                self.assertIn(response.status_code, (400, 404))
        self.assertEqual(self.create(item={'id': 'a' * 12}).status_code, 404)  # Valid shape, not in the library.
        for item in (self.missing, self.outside, self.nofile, self.hidden):
            with self.subTest(entry=item['title'] if 'title' in item else item['id']):
                self.assertEqual(self.create(item=item).status_code, 404)
        self.assertEqual(self.rows(), [])

    def test_expiry_and_permissions_are_validated_on_the_server(self):
        for duration in ('1y', '', None, 24, '24H', '../1h'):
            with self.subTest(duration=duration):
                self.assertEqual(self.create(duration=duration).status_code, 400)
        self.assertEqual(self.create(stream=False, download=False).status_code, 400)
        for text in ('true', 1, 'yes'):
            response = self.admin.post('/api/shares', json={'media_id': self.movie['id'], 'allow_stream': text,
                                                            'allow_download': text},
                                       headers={'X-CSRF-Token': self.csrf(self.admin)}, environ_overrides=REMOTE)
            self.assertEqual(response.status_code, 400, text)
        for duration, seconds in (('1h', 3600), ('24h', 86400), ('7d', 604800)):
            self.assertEqual(self.create(duration=duration).get_json()['expires_at'] - int(self.clock[0]), seconds)
        policy = self.admin.get('/api/shares/me', environ_overrides=REMOTE).get_json()
        self.assertEqual((policy['default'], [d['key'] for d in policy['durations']]), ('24h', ['1h', '24h', '7d']))

    def test_owner_cookie_is_secure_over_a_trusted_https_tunnel_only(self):
        local = app.app.test_client()
        local.get('/login')
        with patch.dict(app.app.config, TRUSTED_PROXY=True, SHARE_CREATORS='viewers'):
            headers = {'X-CSRF-Token': self.csrf(local), 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '198.51.100.9'}
            local.post('/login', data={'password': VIEW, 'csrf_token': self.csrf(local)},
                       headers={'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '198.51.100.9'})
            response = local.post('/api/shares', json={'media_id': self.movie['id'], 'allow_stream': True}, headers=headers)
        self.assertEqual(response.status_code, 201)
        cookie = next(h for h in response.headers.getlist('Set-Cookie') if h.startswith('sanflix_owner='))
        self.assertIn('Secure', cookie)


class AccessTests(ShareCase):
    def test_link_works_before_expiry_with_private_headers_and_no_cookies(self):
        path, _, token = self.link(download=True)
        page = self.get(path)
        self.assertEqual(page.status_code, 200)
        html = page.get_data(as_text=True)
        self.assertIn('Movie #1', html)
        self.assertNotIn(token, html)
        self.assertNotIn('Set-Cookie', page.headers)
        self.assertEqual(page.headers['Referrer-Policy'], 'no-referrer')
        self.assertEqual(page.headers['Cache-Control'], 'private, no-store')
        self.assertIn('noindex', page.headers['X-Robots-Tag'])
        self.assertIn("frame-ancestors 'none'", page.headers['Content-Security-Policy'])
        info = self.get(path + '/info').get_json()
        self.assertEqual((info['title'], info['allow_stream'], info['allow_download']), ('Movie #1', True, True))
        self.assertEqual(info['strategy'], 'direct')
        self.assertNotIn('file', info)
        self.assertNotIn(str(self.root), str(info))
        self.assertEqual(self.admin.get('/api/shares', environ_overrides=REMOTE).get_json()['shares'][0]['access_count'], 1)

    def test_expired_links_stop_working_everywhere(self):
        path, share_id, token = self.link(duration='1h', download=True)
        self.assertEqual(self.get(path).status_code, 200)
        self.clock[0] += 3599
        self.assertEqual(self.get(path + '/info').status_code, 200)
        self.clock[0] += 2
        for suffix in ('', '/info', '/stream', '/download', '/thumbnail', '/hls/playlist.m3u8'):
            response = self.get(path + suffix)
            self.assertEqual(response.status_code, 404, suffix)
            self.assertNotIn(token, response.get_data(as_text=True))
        listed = self.admin.get('/api/shares', environ_overrides=REMOTE).get_json()['shares']
        self.assertEqual(listed[0]['status'], 'expired')

    def test_revocation_takes_effect_immediately_and_is_repeatable(self):
        path, share_id, _ = self.link(download=True)
        self.assertEqual(self.get(path + '/stream', headers={'Range': 'bytes=0-3'}).status_code, 206)
        self.assertEqual(self.revoke(self.admin, share_id).status_code, 200)
        for suffix in ('', '/info', '/stream', '/download'):
            self.assertEqual(self.get(path + suffix).status_code, 404, suffix)
        self.assertEqual(self.revoke(self.admin, share_id).status_code, 200)  # Idempotent.
        self.assertEqual(self.admin.get('/api/shares', environ_overrides=REMOTE).get_json()['shares'][0]['status'], 'revoked')

    def test_stream_and_download_permissions_are_independent(self):
        stream_only, _, _ = self.link(stream=True, download=False)
        self.assertEqual(self.get(stream_only + '/stream', headers={'Range': 'bytes=0-3'}).status_code, 206)
        self.assertEqual(self.get(stream_only + '/download').status_code, 403)
        self.assertIn('strategy', self.get(stream_only + '/info').get_json())
        download_only, _, _ = self.link(stream=False, download=True)
        self.assertEqual(self.get(download_only + '/download').status_code, 200)
        for suffix in ('/stream', '/hls/playlist.m3u8'):
            self.assertEqual(self.get(download_only + suffix).status_code, 403, suffix)
        self.assertNotIn('strategy', self.get(download_only + '/info').get_json())
        page = self.get(download_only).get_data(as_text=True)
        self.assertNotIn('<video', page)
        self.assertIn('share-download', page)
        both, _, _ = self.link(stream=True, download=True)
        self.assertEqual(self.get(both + '/download').status_code, 200)
        self.assertEqual(self.get(both + '/stream', headers={'Range': 'bytes=0-3'}).status_code, 206)

    def test_range_playback_and_seeking_through_a_share(self):
        path, _, _ = self.link()
        with self.get(path + '/stream', headers={'Range': 'bytes=0-15'}) as result:
            self.assertEqual((result.status_code, result.data), (206, self.clip[:16]))
            self.assertEqual(result.headers['Accept-Ranges'], 'bytes')
            self.assertEqual(result.headers['Content-Range'], f'bytes 0-15/{len(self.clip)}')
        with self.get(path + '/stream', headers={'Range': 'bytes=-16'}) as result:
            self.assertEqual((result.status_code, result.data), (206, self.clip[-16:]))
        with self.get(path + '/stream', headers={'Range': f'bytes={len(self.clip) // 2}-'}) as result:
            self.assertEqual((result.status_code, result.data), (206, self.clip[len(self.clip) // 2:]))
        for value in ('bytes=100-20', 'bytes=999999999-'):
            with self.get(path + '/stream', headers={'Range': value}) as result:
                self.assertEqual(result.status_code, 416, value)

    def test_original_download_has_exact_bytes_and_filename(self):
        path, _, _ = self.link(download=True)
        with self.get(path + '/download') as result:
            self.assertEqual((result.status_code, result.data), (200, self.clip))
            self.assertIn('attachment', result.headers['Content-Disposition'])
            self.assertIn('Movie', result.headers['Content-Disposition'])
            self.assertTrue(result.headers['Content-Disposition'].endswith('.mp4') or '.mp4' in result.headers['Content-Disposition'])
        with self.get(path + '/download', headers={'Range': 'bytes=5-20'}) as result:
            self.assertEqual((result.status_code, result.data), (206, self.clip[5:21]))

    def test_live_conversion_and_prepared_hls_work_through_a_share(self):
        remux_link, _, _ = self.link(item=self.remux)
        self.assertEqual(self.get(remux_link + '/info').get_json()['strategy'], 'remux')
        with self.get(remux_link + '/stream') as result:
            self.assertEqual((result.status_code, result.headers['Content-Type']), (200, 'video/mp4'))
            self.assertGreater(len(result.data), 1000)
        hls_manager.convert(str(self.root / 'hls_cache'), self.remux['id'], str(self.root / self.remux['file']))
        info = self.get(remux_link + '/info').get_json()
        self.assertEqual(info['hls_playlist'], 'playlist.m3u8')
        playlist = self.get(remux_link + '/hls/playlist.m3u8')
        self.assertEqual((playlist.status_code, playlist.mimetype), (200, 'application/vnd.apple.mpegurl'))
        segment = next(line for line in playlist.get_data(as_text=True).splitlines() if line.endswith('.ts'))
        self.assertEqual(self.get(f'{remux_link}/hls/{segment}').status_code, 200)
        download_only, _, _ = self.link(item=self.remux, stream=False, download=True)
        self.assertEqual(self.get(download_only + '/hls/playlist.m3u8').status_code, 403)

    def test_persistence_across_an_application_restart(self):
        path, share_id, _ = self.link(download=True)
        localgram._ready.clear()  # A new process starts with no cached schema state.
        localgram.limiter = localgram.RateLimiter()
        self.assertEqual(self.get(path).status_code, 200)
        self.assertEqual(self.get(path + '/download').status_code, 200)
        localgram._ready.clear()
        self.assertEqual(self.revoke(self.admin, share_id).status_code, 200)
        localgram._ready.clear()
        self.assertEqual(self.get(path).status_code, 404)


class IsolationTests(ShareCase):
    def test_a_link_never_grants_library_or_admin_access(self):
        path, _, _ = self.link(download=True)
        recipient = self.recipient
        token_header = {'X-CSRF-Token': 'anything'}
        checks = [('GET', '/api/media'), ('GET', f'/api/media/{self.other["id"]}'), ('GET', '/stream/' + self.other['file']),
                  ('GET', f'/download/{self.other["id"]}'), ('GET', f'/api/stream-info/{self.movie["id"]}'),
                  ('GET', f'/hls/{self.movie["id"]}/playlist.m3u8'), ('GET', '/api/admin/scan-status'),
                  ('GET', '/api/shares'), ('GET', '/api/shares/me'), ('GET', '/thumbnails/x.jpg'),
                  ('GET', f'/player/{self.movie["id"]}'), ('GET', '/youtube')]
        for method, url in checks:
            with self.subTest(url=url):
                self.assertIn(recipient.open(url, method=method, environ_overrides=REMOTE).status_code, (302, 401, 403))
        for url in ('/api/admin/upload', '/api/shares', f'/api/hls/start/{self.movie["id"]}'):
            self.assertIn(recipient.post(url, headers=token_header, environ_overrides=REMOTE).status_code, (401, 403), url)
        # The token path serves only its own item; other items are not reachable through it.
        self.assertNotIn(self.other['title'], self.get(path).get_data(as_text=True))

    def test_viewers_cannot_manage_other_viewers_shares_or_reach_admin_functions(self):
        with patch.dict(app.app.config, SHARE_CREATORS='viewers'):
            first, second = self.login(), self.login()
            a_path, a_id, _ = self.link(client=first)
            b_path, b_id, _ = self.link(client=second, item=self.other)
            self.assertEqual([s['id'] for s in first.get('/api/shares', environ_overrides=REMOTE).get_json()['shares']], [a_id])
            self.assertEqual([s['id'] for s in second.get('/api/shares', environ_overrides=REMOTE).get_json()['shares']], [b_id])
            self.assertEqual(self.revoke(second, a_id).status_code, 404)  # Same answer as "does not exist".
            self.assertEqual(self.revoke(second, 'f' * 16).status_code, 404)
            self.assertEqual(self.get(a_path).status_code, 200)
            self.assertEqual(self.revoke(first, a_id).status_code, 200)
            self.assertEqual(self.get(a_path).status_code, 404)
            self.assertEqual(self.get(b_path).status_code, 200)
            # Viewer rights end at admin functions.
            self.assertEqual(first.get('/api/admin/scan-status', environ_overrides=REMOTE).status_code, 401)
            self.assertEqual(first.post('/api/admin/upload', headers={'X-CSRF-Token': self.csrf(first)},
                                        environ_overrides=REMOTE).status_code, 401)
            fresh = self.login()  # Same password, different browser: no ownership.
            self.assertEqual(fresh.get('/api/shares', environ_overrides=REMOTE).get_json()['shares'], [])
            self.assertEqual(self.revoke(fresh, b_id).status_code, 404)

    def test_admin_can_see_and_revoke_any_share(self):
        with patch.dict(app.app.config, SHARE_CREATORS='viewers'):
            viewer = self.login()
            path, share_id, _ = self.link(client=viewer)
        listed = self.admin.get('/api/shares', environ_overrides=REMOTE).get_json()
        self.assertTrue(listed['admin'])
        self.assertEqual([(s['id'], s['mine']) for s in listed['shares']], [(share_id, False)])
        self.assertEqual(self.revoke(self.admin, share_id).status_code, 200)
        self.assertEqual(self.get(path).status_code, 404)
        shown = viewer.get('/api/shares', environ_overrides=REMOTE).get_json()['shares'][0]
        self.assertEqual((shown['status'], shown['revoked_by']), ('revoked', 'admin'))

    def test_management_api_never_exposes_tokens_or_hashes(self):
        path, _, token = self.link()
        raw = self.admin.get('/api/shares', environ_overrides=REMOTE).get_data(as_text=True)
        self.assertNotIn(token, raw)
        self.assertNotIn(localgram.hash_token(token), raw)
        self.assertNotIn('token', raw.lower())

    def test_csrf_is_enforced_on_every_state_changing_route(self):
        body = {'media_id': self.movie['id'], 'allow_stream': True}
        self.assertEqual(self.admin.post('/api/shares', json=body, environ_overrides=REMOTE).status_code, 403)
        self.assertEqual(self.admin.post('/api/shares', json=body, headers={'X-CSRF-Token': 'wrong'},
                                         environ_overrides=REMOTE).status_code, 403)
        _, share_id, _ = self.link()
        self.assertEqual(self.admin.post(f'/api/shares/{share_id}/revoke', environ_overrides=REMOTE).status_code, 403)
        self.assertEqual(self.admin.get('/api/shares', environ_overrides=REMOTE).get_json()['shares'][0]['status'], 'active')


class HostileInputTests(ShareCase):
    def test_malformed_unknown_and_traversal_tokens_get_the_same_generic_answer(self):
        path, _, token = self.link(download=True)
        for bad in ('short', 'A' * 42, 'A' * 44, 'A' * 43, '..', '%2e%2e', token[:-1] + ('A' if token[-1] != 'A' else 'B')):
            with self.subTest(token=bad):
                for suffix in ('', '/info', '/stream', '/download', '/thumbnail'):
                    response = self.get(f'/s/{bad}{suffix}')
                    self.assertEqual(response.status_code, 404, (bad, suffix))
                    self.assertNotIn(bad if len(bad) > 6 else 'zzz', response.get_data(as_text=True) + 'x')
        self.assertIn('not available', self.get('/s/' + 'A' * 43).get_data(as_text=True))

    def test_path_traversal_and_internal_files_are_unreachable_through_hls(self):
        path, _, _ = self.link()
        for tail in ('../../database/media_library.json', '..%2f..%2fapp.py', '../Other.mp4', 'job.json', '.lock',
                     'build-0/../../x.ts', '..\\..\\app.py', 'playlist.m3u8/../../../app.py'):
            with self.subTest(tail=tail):
                self.assertIn(self.get(f'{path}/hls/{tail}').status_code, (403, 404))
        self.assertIn(self.get(path + '/hls/playlist.m3u8').status_code, (404,))  # Nothing prepared yet.

    def test_missing_files_and_removed_items_fail_safely(self):
        path, _, token = self.link(download=True)
        (self.root / self.movie['file']).unlink()
        page = self.get(path)
        self.assertEqual(page.status_code, 404)
        self.assertNotIn(self.movie['title'], page.get_data(as_text=True))
        for suffix in ('/stream', '/download'):
            response = self.get(path + suffix)
            self.assertEqual(response.status_code, 404)
            self.assertNotIn(str(self.root), response.get_data(as_text=True))
            self.assertNotIn(token, response.get_data(as_text=True))
        path2, _, _ = self.link(item=self.other, download=True)
        atomic_json(self.root / 'database' / 'media_library.json', [e for e in self.catalogue if e is not self.other])
        self.assertEqual(self.get(path2).status_code, 404)

    def test_a_link_made_for_one_item_can_never_reach_a_hidden_or_foreign_file(self):
        path, share_id, _ = self.link(download=True)
        # Even if the catalogue entry is later edited to point at a hidden file, the shared routes refuse it.
        for entry in self.catalogue:
            if entry['id'] == self.movie['id']:
                entry['file'] = self.hidden['file']
        atomic_json(self.root / 'database' / 'media_library.json', self.catalogue)
        for suffix in ('/stream', '/download'):
            self.assertEqual(self.get(path + suffix).status_code, 404, suffix)
        self.assertEqual(self.get(path).status_code, 404)

    def test_user_controlled_text_is_escaped(self):
        path, _, _ = self.link(item=self.xss)
        html = self.get(path).get_data(as_text=True)
        self.assertNotIn('<script>alert(1)</script>', html)
        self.assertIn('&lt;script&gt;alert(1)&lt;/script&gt;', html)

    def test_server_logs_never_contain_tokens(self):
        token = 'T' * 43
        record = logging.LogRecord('werkzeug', logging.INFO, __file__, 1, '127.0.0.1 "GET /s/%s/stream HTTP/1.1" 200', (token,), None)
        self.assertTrue(localgram._RedactTokens().filter(record))
        self.assertNotIn(token, record.getMessage())
        self.assertIn('/s/[token]', record.getMessage())
        for name in ('werkzeug', 'waitress'):
            self.assertTrue(any(isinstance(f, localgram._RedactTokens) for f in logging.getLogger(name).filters), name)

    def test_shared_transfer_slots_are_bounded(self):
        path, _, _ = self.link(download=True)
        with patch.object(localgram, '_transfer_slots', threading.BoundedSemaphore(1)) as slots:
            slots.acquire()
            self.assertEqual(self.get(path + '/download').status_code, 503)
            slots.release()
            with self.get(path + '/download') as result:
                self.assertEqual(result.status_code, 200)
            self.assertTrue(slots.acquire(blocking=False))  # Released after the response closed.


class LimitTests(ShareCase):
    def test_creation_and_revocation_are_rate_limited_per_browser_not_per_visitor_address(self):
        with patch.object(localgram, 'CREATE_LIMIT', 3):
            self.create()  # Receives the owner cookie.
            statuses = [self.create().status_code for _ in range(4)]
            self.assertEqual(statuses, [201, 201, 429, 429])
            other = self.login(admin=True)  # Another browser from the same address keeps its own allowance.
            self.assertEqual(self.create(client=other).status_code, 201)
            self.assertEqual(self.create(client=other).status_code, 201)

    def test_spoofed_forwarding_headers_do_not_reset_address_limits(self):
        with patch.object(localgram, 'CREATE_LIMIT_PER_IP', 3):
            codes = [self.create(**{'CF-Connecting-IP': f'198.51.100.{i}'}).status_code for i in range(5)]
            self.assertEqual(codes, [201, 201, 201, 429, 429])
        localgram.limiter = localgram.RateLimiter()
        with patch.object(localgram, 'CREATE_LIMIT_PER_IP', 2), patch.dict(app.app.config, TRUSTED_PROXY=True):
            def attempt(address):
                return self.admin.post('/api/shares', json={'media_id': self.movie['id'], 'allow_stream': True},
                                       headers={'X-CSRF-Token': self.csrf(self.admin), 'CF-Connecting-IP': address},
                                       environ_overrides={'REMOTE_ADDR': '127.0.0.1'}).status_code
            self.assertEqual([attempt('198.51.100.1'), attempt('198.51.100.1'), attempt('198.51.100.1')], [201, 201, 429])
            self.assertEqual(attempt('198.51.100.2'), 201)  # Tunnel visitors are separate clients.

    def test_active_link_cap_per_browser(self):
        with patch.object(localgram, 'MAX_ACTIVE_PER_OWNER', 3):
            self.assertEqual([self.create().status_code for _ in range(4)], [201, 201, 201, 429])
            self.clock[0] += 90000  # Expired links stop counting.
            self.assertEqual(self.create().status_code, 201)

    def test_revoke_requests_are_rate_limited(self):
        _, share_id, _ = self.link()
        with patch.object(localgram, 'REVOKE_LIMIT', 2):
            self.assertEqual([self.revoke(self.admin, 'e' * 16).status_code for _ in range(3)], [404, 404, 429])


class DatabaseTests(ShareCase):
    def test_initialisation_is_repeatable_and_never_loses_data(self):
        path, share_id, _ = self.link()
        for _ in range(3):
            localgram._ready.clear()
            localgram.prepare(str(self.db))
        with closing(sqlite3.connect(self.db)) as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0], localgram.SCHEMA_VERSION)
            self.assertEqual(connection.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
        self.assertEqual(len(self.rows()), 1)
        self.assertEqual(self.get(path).status_code, 200)

    def test_a_database_from_a_newer_version_is_refused_not_modified(self):
        localgram.prepare(str(self.db))
        with closing(sqlite3.connect(self.db)) as connection:
            connection.execute(f'PRAGMA user_version={localgram.SCHEMA_VERSION + 1}')
        localgram._ready.clear()
        with self.assertRaises(RuntimeError):
            localgram.prepare(str(self.db))

    def test_concurrent_creation_and_revocation_are_safe(self):
        path = str(self.db)
        results, errors = [], []

        def worker(number):
            try:
                results.append((number, localgram.create_share(
                    path, media_id=self.movie['id'], title='t', owner_id=f'{number:032x}', admin=False, duration='1h',
                    allow_stream=True, allow_download=False)))
            except Exception as error:  # noqa: BLE001
                errors.append(error)

        threads = [threading.Thread(target=worker, args=(n,)) for n in range(40)]
        [t.start() for t in threads]
        [t.join(timeout=60) for t in threads]
        self.assertEqual(errors, [])
        self.assertEqual(len({made[1] for _, made in results}), 40)
        self.assertEqual(len(self.rows()), 40)
        number, made = results[0]
        share_id, owner = made[0], f'{number:032x}'
        outcomes = []
        racers = [threading.Thread(target=lambda: outcomes.append(localgram.revoke_share(path, share_id, owner, False)))
                  for _ in range(8)]
        [t.start() for t in racers]
        [t.join(timeout=60) for t in racers]
        self.assertEqual(sorted(outcomes), ['already'] * 7 + ['revoked'])


if __name__ == '__main__':
    unittest.main()
