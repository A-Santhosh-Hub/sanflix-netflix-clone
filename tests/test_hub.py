"""Hub: the server only serves a static page. Local media must never reach it or the catalogue."""
import hashlib
import io
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import sanflix_test_env  # noqa: F401
import app
from media_utils import atomic_json, media_id

REMOTE = {'REMOTE_ADDR': '203.0.113.20'}
ADMIN, VIEW = 'admin-hub-pass-0123456', 'viewer-hub-pass-0123456'


class HubTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='sanflix-hub-test-')
        self.root = Path(self.temporary.name).resolve()
        (self.root / 'database').mkdir()
        (self.root / 'media' / 'movies').mkdir(parents=True)
        self.video = self.root / 'media' / 'movies' / 'Server Movie.mp4'
        self.video.write_bytes(b'server-owned video bytes')
        relative = self.video.relative_to(self.root).as_posix()
        self.catalogue_file = self.root / 'database' / 'media_library.json'
        atomic_json(self.catalogue_file, [{'id': media_id(relative), 'file': relative, 'title': 'UNIQUE-SERVER-TITLE', 'category': 'movie'}])
        self.stack = [
            patch.multiple(app, BASE_DIR=str(self.root), MEDIA_DIR=str(self.root / 'media'),
                           DATABASE_FILE=str(self.catalogue_file), _library_cache={'data': None, 'mtime': None, 'etag': None},
                           _login_failures={}, _revoked={'stamp': None, 'data': {}}),
            patch.dict(app.app.config, TESTING=True, TRUSTED_PROXY=False, LOCAL_BYPASS=True,
                       ADMIN_PASSWORD_HASH=app.generate_password_hash(ADMIN), VIEW_PASSWORD_HASH=app.generate_password_hash(VIEW)),
        ]
        for patcher in self.stack:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.stack):
            patcher.stop()
        self.temporary.cleanup()

    def login(self, password=VIEW):
        client = app.app.test_client()
        page = client.get('/login', environ_overrides=REMOTE).get_data(as_text=True)
        token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
        client.post('/login', data={'password': password, 'csrf_token': token}, environ_overrides=REMOTE)
        return client

    def state(self):
        """A fingerprint of everything the Hub must never change."""
        media = sorted((p.relative_to(self.root).as_posix(), p.stat().st_size) for p in (self.root / 'media').rglob('*'))
        return hashlib.sha256(self.catalogue_file.read_bytes()).hexdigest(), media, sorted(p.name for p in (self.root / 'database').iterdir())

    def test_network_visitors_must_sign_in_and_the_local_browser_may_view(self):
        anonymous = app.app.test_client().get('/hub', environ_overrides=REMOTE)
        self.assertEqual(anonymous.status_code, 302)
        self.assertIn('/login', anonymous.headers['Location'])
        self.assertEqual(self.login().get('/hub', environ_overrides=REMOTE).status_code, 200)
        self.assertEqual(app.app.test_client().get('/hub').status_code, 200)  # Passwordless localhost, as for the library.

    def test_page_allows_only_same_origin_requests_and_no_inline_code(self):
        policy = self.login().get('/hub', environ_overrides=REMOTE).headers['Content-Security-Policy']
        for required in ("default-src 'none'", "connect-src 'self'", "script-src 'self'", "frame-ancestors 'none'",
                         "media-src 'self' blob:", "img-src 'self' blob: data:"):
            self.assertIn(required, policy)
        for forbidden in ('unsafe-inline', 'unsafe-eval', 'http:', 'https:', '*', 'ws:', 'wss:'):
            self.assertNotIn(forbidden, policy)

    def test_page_offers_files_and_folder_inputs_without_any_upload_form(self):
        html = self.login().get('/hub', environ_overrides=REMOTE).get_data(as_text=True)
        for text in ('Add Media', 'Select Files', 'Select Folder', 'webkitdirectory', 'hub-input-files'):
            self.assertIn(text, html)
        forms = re.findall(r'<form[^>]*>', html)
        self.assertEqual(len(forms), 1)
        self.assertIn('action="/logout"', forms[0])
        for tag in re.findall(r'<input[^>]*type="file"[^>]*>', html):
            self.assertNotRegex(tag, r'\sname=')
        self.assertNotIn('/api/', html)
        self.assertNotIn('admin.js', html)

    def test_hub_is_in_the_navigation_of_the_other_pages(self):
        client = app.app.test_client()
        for page in ('/', '/youtube'):
            html = client.get(page).get_data(as_text=True)
            nav = re.search(r'<nav class="nav-links".*?</nav>', html, re.S).group(0)
            mobile = re.search(r'<nav class="mobile-nav".*?</nav>', html, re.S).group(0)
            self.assertIn('href="/hub"', nav, page)
            self.assertIn('href="/hub"', mobile, page)

    def test_the_page_is_identical_for_every_visitor_and_never_lists_server_media(self):
        def normalised(client):
            html = client.get('/hub', environ_overrides=REMOTE).get_data(as_text=True)
            html = re.sub(r'(name="csrf_token"\s+value=")[^"]+', r'\1X', html)
            return re.sub(r'(name="csrf-token" content=")[^"]+', r'\1X', html)
        first, second = normalised(self.login()), normalised(self.login())
        self.assertEqual(first, second)
        self.assertNotIn('UNIQUE-SERVER-TITLE', first)
        self.assertNotIn('Server Movie', first)

    def test_the_only_hub_routes_are_the_page_and_small_json_metadata_and_signaling(self):
        rules = {(rule.rule, tuple(sorted(rule.methods - {'HEAD', 'OPTIONS'}))) for rule in app.app.url_map.iter_rules() if 'hub' in rule.rule.lower()}
        self.assertEqual(rules, {
            ('/hub', ('GET',)), ('/api/hub/join', ('POST',)), ('/api/hub/name', ('POST',)), ('/api/hub/poll', ('GET',)),
            ('/api/hub/shares', ('POST',)), ('/api/hub/shares/<share_id>/remove', ('POST',)), ('/api/hub/shares/<share_id>/request', ('POST',)),
            ('/api/hub/transfers/<transfer_id>/decision', ('POST',)), ('/api/hub/transfers/<transfer_id>/signal', ('POST',)),
            ('/api/hub/transfers/<transfer_id>/status', ('POST',))})
        client = self.login()
        with client.session_transaction() as session:
            token = session['csrf_token']
        before = self.state()
        for url in ('/api/hub/join', '/api/hub/name', '/api/hub/shares', f'/api/hub/shares/{"a" * 16}/request', f'/api/hub/transfers/{"a" * 16}/signal'):
            response = client.post(url, data={'file': (io.BytesIO(b'local phone video'), 'phone.mp4')}, headers={'X-CSRF-Token': token},
                                   environ_overrides=REMOTE, content_type='multipart/form-data')
            self.assertEqual(response.status_code, 415, url)
        self.assertEqual(self.state(), before, 'a rejected upload attempt changes nothing')
        client = self.login()
        with client.session_transaction() as session:
            token = session['csrf_token']
        before = self.state()
        for url in ('/hub', '/hub/upload', '/api/hub', '/api/hub/upload', '/api/hub/import', '/api/media'):  # No such routes.
            response = client.post(url, data={'file': (io.BytesIO(b'local phone video'), 'phone.mp4')}, headers={'X-CSRF-Token': token},
                                   environ_overrides=REMOTE, content_type='multipart/form-data')
            self.assertIn(response.status_code, (404, 405), url)
        self.assertEqual(self.state(), before, 'catalogue, media folder and database folder are unchanged')

    def test_browsing_the_hub_never_touches_the_catalogue_or_media_folder(self):
        before = self.state()
        client = self.login()
        for _ in range(3):
            for url in ('/hub', '/static/hub.js', '/static/hub.css'):
                client.get(url, environ_overrides=REMOTE).close()
        self.assertEqual(self.state(), before)

    def test_existing_upload_stays_admin_only_and_unrelated_to_the_hub(self):
        viewer = self.login()
        with viewer.session_transaction() as session:
            token = session['csrf_token']
        denied = viewer.post('/api/admin/upload', data={'file': (io.BytesIO(b'x'), 'x.mp4'), 'category': 'movies'},
                             headers={'X-CSRF-Token': token}, environ_overrides=REMOTE, content_type='multipart/form-data')
        self.assertEqual(denied.status_code, 401)

    def test_hub_script_has_no_network_or_upload_or_content_reading_code(self):
        source = (Path(__file__).resolve().parents[1] / 'static' / 'hub.js').read_text(encoding='utf-8')
        for pattern in (r'\bfetch\s*\(', r'XMLHttpRequest', r'sendBeacon', r'FormData', r'WebSocket', r'EventSource', r'RTCPeerConnection',
                        r'localStorage', r'FileReader', r'\.arrayBuffer\s*\(', r'/api/', r'upload'):
            self.assertIsNone(re.search(pattern, source, re.I if pattern == 'upload' else 0), pattern)
        served = self.login().get('/static/hub.js', environ_overrides=REMOTE)
        self.assertEqual(served.status_code, 200)
        served.close()


if __name__ == '__main__':
    unittest.main()
