"""Phase 0 security regressions. Every write goes to a temporary directory."""
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.request
from pathlib import Path
from unittest.mock import patch

import sanflix_test_env  # noqa: F401
import app
import security_config
import serve
from media_utils import atomic_json

ROOT = Path(__file__).resolve().parents[1]
REMOTE = {'REMOTE_ADDR': '203.0.113.20'}
GOOD = {'SANFLIX_ADMIN_PASSWORD': 'admin-test-pass-0123', 'SANFLIX_VIEW_PASSWORD': 'viewer-test-pass-0123',
        'SANFLIX_SECRET_KEY': 'k' * 40}


class ConfigTests(unittest.TestCase):
    def test_production_requires_every_secret_and_never_echoes_values(self):
        for missing in GOOD:
            env = {k: v for k, v in GOOD.items() if k != missing}
            with self.subTest(missing=missing), self.assertRaises(security_config.ConfigError) as caught:
                security_config.load(env)
            message = str(caught.exception)
            self.assertIn(f'{missing} is not set', message)
            for value in GOOD.values():
                self.assertNotIn(value, message)

    def test_viewing_password_never_falls_back_to_admin_password(self):
        with self.assertRaises(security_config.ConfigError) as caught:
            security_config.load({k: v for k, v in GOOD.items() if k != 'SANFLIX_VIEW_PASSWORD'})
        self.assertIn('SANFLIX_VIEW_PASSWORD is not set', str(caught.exception))

    def test_passwords_must_differ_and_be_long_enough(self):
        same = dict(GOOD, SANFLIX_VIEW_PASSWORD=GOOD['SANFLIX_ADMIN_PASSWORD'])
        with self.assertRaises(security_config.ConfigError) as caught:
            security_config.load(same)
        self.assertIn('must be different', str(caught.exception))
        for name, value in (('SANFLIX_VIEW_PASSWORD', 'short'), ('SANFLIX_SECRET_KEY', 'short')):
            with self.subTest(name=name), self.assertRaises(security_config.ConfigError):
                security_config.load(dict(GOOD, **{name: value}))

    def test_valid_configuration_is_stable_across_restarts(self):
        first, second = security_config.load(dict(GOOD)), security_config.load(dict(GOOD))
        self.assertEqual(first.secret_key, second.secret_key)
        self.assertFalse(first.development)
        self.assertEqual(first.generated, {})

    def test_development_generates_distinct_per_run_secrets(self):
        first, second = security_config.load({'SANFLIX_DEV': '1'}), security_config.load({'SANFLIX_DEV': '1'})
        self.assertTrue(first.development)
        self.assertNotEqual(first.admin_password, first.view_password)
        self.assertNotEqual(first.secret_key, second.secret_key)

    def test_env_file_fills_gaps_but_real_environment_wins(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'sanflix.env'
            path.write_text('# comment\nSANFLIX_ADMIN_PASSWORD="from-file-admin-0123"\n'
                            'SANFLIX_VIEW_PASSWORD=from-file-viewer\nOTHER=ignored\n', encoding='utf-8')
            environ = {'SANFLIX_VIEW_PASSWORD': 'from-real-environment'}
            self.assertTrue(security_config.load_env_file(path, environ))
            self.assertEqual(environ['SANFLIX_ADMIN_PASSWORD'], 'from-file-admin-0123')
            self.assertEqual(environ['SANFLIX_VIEW_PASSWORD'], 'from-real-environment')
            self.assertNotIn('OTHER', environ)
            self.assertFalse(security_config.load_env_file(Path(folder) / 'missing.env', {}))

    def test_serve_check_refuses_to_start_without_secrets(self):
        base = {k: v for k, v in os.environ.items() if not k.startswith('SANFLIX_')}
        base['SANFLIX_ENV_FILE'] = str(ROOT / 'tests' / 'no-such-file.env')
        bad = subprocess.run([sys.executable, 'serve.py', '--check'], cwd=ROOT, env=base,
                             capture_output=True, text=True, timeout=60)
        self.assertEqual(bad.returncode, 2)
        self.assertIn('SANFLIX_VIEW_PASSWORD is not set', bad.stdout)
        good = subprocess.run([sys.executable, 'serve.py', '--check'], cwd=ROOT, env={**base, **GOOD},
                              capture_output=True, text=True, timeout=60)
        self.assertEqual(good.returncode, 0, good.stdout + good.stderr)
        for value in GOOD.values():
            self.assertNotIn(value, good.stdout + good.stderr)


class AppSecurityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='sanflix-security-')
        root = Path(self.temporary.name)
        (root / 'database').mkdir()
        atomic_json(root / 'database' / 'media_library.json', [])
        self.stack = patch.multiple(
            app, BASE_DIR=str(root), DATABASE_FILE=str(root / 'database' / 'media_library.json'),
            _library_cache={'data': None, 'mtime': None, 'etag': None}, _login_failures={},
            _revoked={'stamp': None, 'data': {}})
        self.stack.start()
        self.config = patch.dict(app.app.config, TESTING=True, TRUSTED_PROXY=False, SESSION_COOKIE_SECURE=False,
                                 ADMIN_PASSWORD_HASH=app.generate_password_hash('admin-test-pass-0123'),
                                 VIEW_PASSWORD_HASH=app.generate_password_hash('viewer-test-pass-0123'))
        self.config.start()
        self.client = app.app.test_client()

    def tearDown(self):
        self.config.stop()
        self.stack.stop()
        self.temporary.cleanup()

    def token(self, client=None):
        client = client or self.client
        client.get('/login')
        with client.session_transaction() as session:
            return session['csrf_token']

    def viewer_login(self, client=None, password='viewer-test-pass-0123', **extra):
        client = client or self.client
        return client.post('/login', data={'password': password, 'csrf_token': self.token(client)},
                           environ_overrides=extra.pop('environ', REMOTE), **extra)

    def admin_login(self, client=None, password='admin-test-pass-0123'):
        client = client or self.client
        return client.post('/api/admin/login', json={'password': password},
                           headers={'X-CSRF-Token': self.token(client)}, environ_overrides=REMOTE)

    def test_viewer_password_cannot_authorize_admin_operations(self):
        self.assertEqual(self.viewer_login().status_code, 302)
        self.assertEqual(self.client.get('/api/media', environ_overrides=REMOTE).status_code, 200)
        self.assertEqual(self.admin_login(password='viewer-test-pass-0123').status_code, 401)
        headers = {'X-CSRF-Token': self.token()}
        self.assertEqual(self.client.post('/api/admin/upload', headers=headers, environ_overrides=REMOTE).status_code, 401)
        self.assertEqual(self.client.get('/api/admin/scan-status', environ_overrides=REMOTE).status_code, 401)

    def test_admin_password_is_not_a_viewing_password(self):
        self.assertEqual(self.viewer_login(password='admin-test-pass-0123').status_code, 401)
        self.assertEqual(self.client.get('/api/media', environ_overrides=REMOTE).status_code, 401)

    def test_admin_login_grants_admin_and_viewing(self):
        self.assertEqual(self.admin_login().status_code, 200)
        self.assertEqual(self.client.get('/api/admin/scan-status', environ_overrides=REMOTE).status_code, 200)
        self.assertEqual(self.client.get('/api/media', environ_overrides=REMOTE).status_code, 200)

    def test_wrong_passwords_are_rejected(self):
        self.assertEqual(self.viewer_login(password='nope').status_code, 401)
        self.assertEqual(self.admin_login(password='nope').status_code, 401)

    def test_logout_revokes_the_session_even_if_the_cookie_is_replayed(self):
        self.viewer_login()
        stolen = self.client.get_cookie('session').value
        replay = app.app.test_client()
        replay.set_cookie('session', stolen)
        self.assertEqual(replay.get('/api/media', environ_overrides=REMOTE).status_code, 200)
        self.client.post('/logout', headers={'X-CSRF-Token': self.token()}, environ_overrides=REMOTE)
        self.assertEqual(self.client.get('/api/media', environ_overrides=REMOTE).status_code, 401)
        self.assertEqual(replay.get('/api/media', environ_overrides=REMOTE).status_code, 401)
        app._revoked.update(stamp=None, data={})  # A restart forgets memory but not the saved list.
        self.assertEqual(replay.get('/api/media', environ_overrides=REMOTE).status_code, 401)

    def test_sessions_without_a_server_session_id_are_not_trusted(self):
        with self.client.session_transaction() as session:
            session['viewer'] = True
        self.assertEqual(self.client.get('/api/media', environ_overrides=REMOTE).status_code, 401)

    def test_each_login_gets_a_new_session_id(self):
        self.viewer_login()
        with self.client.session_transaction() as session:
            first = session['sid']
        self.viewer_login()
        with self.client.session_transaction() as session:
            self.assertNotEqual(first, session['sid'])
        self.assertIn(first, app.revoked_sessions())

    def cookie_flags(self, response):
        header = next(h for h in response.headers.getlist('Set-Cookie') if h.startswith('session='))
        return header.lower()

    def test_session_cookie_flags(self):
        plain = self.cookie_flags(self.viewer_login())
        self.assertIn('httponly', plain)
        self.assertIn('samesite=lax', plain)
        self.assertNotIn('secure', plain.replace('samesite', ''))
        with patch.dict(app.app.config, TRUSTED_PROXY=True):
            via_tunnel = self.cookie_flags(self.viewer_login(
                environ={'REMOTE_ADDR': '127.0.0.1'}, headers={'X-Forwarded-Proto': 'https'}))
            forged = self.cookie_flags(self.viewer_login(
                environ={'REMOTE_ADDR': '203.0.113.20'}, headers={'X-Forwarded-Proto': 'https'}))
        self.assertRegex(via_tunnel, r'; secure')
        self.assertNotRegex(forged, r'; secure')
        untrusted = self.cookie_flags(self.viewer_login(
            environ={'REMOTE_ADDR': '127.0.0.1'}, headers={'X-Forwarded-Proto': 'https'}))
        self.assertNotRegex(untrusted, r'; secure')
        with patch.dict(app.app.config, SESSION_COOKIE_SECURE=True):
            self.assertRegex(self.cookie_flags(self.viewer_login()), r'; secure')

    def attempt(self, address, forwarded=None, password='wrong-password'):
        headers = {'CF-Connecting-IP': forwarded} if forwarded else {}
        return self.client.post('/login', data={'password': password, 'csrf_token': self.token()},
                                headers=headers, environ_overrides={'REMOTE_ADDR': address})

    def test_untrusted_forwarding_headers_do_not_split_the_lockout(self):
        for number in range(10):
            self.assertEqual(self.attempt('127.0.0.1', f'198.51.100.{number}').status_code, 401)
        self.assertEqual(self.attempt('127.0.0.1', '198.51.100.99', 'viewer-test-pass-0123').status_code, 429)

    def test_trusted_tunnel_visitors_have_separate_lockouts(self):
        with patch.dict(app.app.config, TRUSTED_PROXY=True):
            for _ in range(10):
                self.assertEqual(self.attempt('127.0.0.1', '198.51.100.1').status_code, 401)
            self.assertEqual(self.attempt('127.0.0.1', '198.51.100.1').status_code, 429)
            self.assertEqual(self.attempt('127.0.0.1', '198.51.100.2').status_code, 401)
            self.assertEqual(self.attempt('127.0.0.1', '198.51.100.2', 'viewer-test-pass-0123').status_code, 302)

    def test_forged_headers_from_other_machines_are_ignored_even_when_trusted(self):
        with patch.dict(app.app.config, TRUSTED_PROXY=True):
            for number in range(10):
                self.assertEqual(self.attempt('203.0.113.20', f'198.51.100.{number}').status_code, 401)
            self.assertEqual(self.attempt('203.0.113.20', '198.51.100.200').status_code, 429)

    def test_client_ip_rejects_malformed_headers(self):
        with patch.dict(app.app.config, TRUSTED_PROXY=True), app.app.test_request_context(
                '/', environ_base={'REMOTE_ADDR': '127.0.0.1'}, headers={'CF-Connecting-IP': 'not an ip'}):
            self.assertEqual(app.client_ip(), '127.0.0.1')
        with patch.dict(app.app.config, TRUSTED_PROXY=True), app.app.test_request_context(
                '/', environ_base={'REMOTE_ADDR': '127.0.0.1'}, headers={'CF-Connecting-IP': '2001:db8::1'}):
            self.assertEqual(app.client_ip(), '2001:db8::1')


PROXY_HEADERS = {
    'CF-Connecting-IP': '203.0.113.5', 'X-Forwarded-For': '203.0.113.5', 'Forwarded': 'for=203.0.113.5',
    'CF-Ray': 'abc123-LHR', 'CF-Visitor': '{"scheme":"https"}', 'CF-IPCountry': 'IN', 'CDN-Loop': 'cloudflare',
    'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'example.com', 'X-Real-IP': '203.0.113.5',
    'True-Client-IP': '203.0.113.5', 'Via': '1.1 proxy',
}


class LocalAccessTests(unittest.TestCase):
    """Who may skip the password: only this computer's own loopback browser, never LAN or tunnel clients."""

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='sanflix-local-access-')
        root = Path(self.temporary.name)
        (root / 'database').mkdir()
        atomic_json(root / 'database' / 'media_library.json', [])
        self.stack = patch.multiple(
            app, BASE_DIR=str(root), DATABASE_FILE=str(root / 'database' / 'media_library.json'),
            _library_cache={'data': None, 'mtime': None, 'etag': None}, _login_failures={},
            _revoked={'stamp': None, 'data': {}})
        self.stack.start()
        self.config = patch.dict(app.app.config, TESTING=True, TRUSTED_PROXY=False, LOCAL_BYPASS=True,
                                 ADMIN_PASSWORD_HASH=app.generate_password_hash('admin-test-pass-0123'),
                                 VIEW_PASSWORD_HASH=app.generate_password_hash('viewer-test-pass-0123'))
        self.config.start()
        self.client = app.app.test_client()

    def tearDown(self):
        self.config.stop()
        self.stack.stop()
        self.temporary.cleanup()

    def get(self, path='/api/media', peer='127.0.0.1', host='localhost', **headers):
        return self.client.get(path, environ_overrides={'REMOTE_ADDR': peer}, headers={'Host': host, **headers})

    def token(self, host='localhost', **headers):
        """Read the CSRF token from the sign-in page, so the cookie belongs to the same host as the POST."""
        page = self.client.get('/login', headers={'Host': host, **headers}).get_data(as_text=True)
        return re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)

    def test_loopback_localhost_may_view_but_never_administer(self):
        for host in ('localhost', 'localhost:5000', '127.0.0.1', '127.0.0.1:5000'):
            with self.subTest(host=host):
                self.assertEqual(self.get(host=host).status_code, 200)
                self.assertEqual(self.get('/api/admin/scan-status', host=host).status_code, 401)
        upload = self.client.post('/api/admin/upload', headers={'X-CSRF-Token': self.token()},
                                  environ_overrides={'REMOTE_ADDR': '127.0.0.1'})
        self.assertEqual(upload.status_code, 401)

    def test_lan_and_public_clients_must_sign_in_even_with_a_forged_localhost_host(self):
        for peer in ('192.168.1.50', '10.0.0.5', '172.16.5.5', '169.254.1.1', '203.0.113.9'):
            for host in ('localhost', '127.0.0.1', '192.168.1.5:5000'):
                with self.subTest(peer=peer, host=host):
                    self.assertEqual(self.get(peer=peer, host=host).status_code, 401)
                    page = self.get('/', peer=peer, host=host)
                    self.assertEqual(page.status_code, 302)
                    self.assertIn('/login', page.headers['Location'])
        with app.app.test_request_context('/', environ_base={'REMOTE_ADDR': '192.168.1.50'}):
            self.assertTrue(app.is_local_request())  # Streaming preference only...
            self.assertFalse(app.is_trusted_local_browser())  # ...never authorization.

    def test_loopback_with_a_foreign_host_name_must_sign_in(self):
        for host in ('example.trycloudflare.com', '192.168.1.5:5000', 'localhost.evil.example', 'evil-localhost'):
            with self.subTest(host=host):
                self.assertEqual(self.get(host=host).status_code, 401)

    def test_any_proxy_or_tunnel_header_removes_the_local_shortcut(self):
        for name, value in PROXY_HEADERS.items():
            with self.subTest(header=name):
                self.assertEqual(self.get(**{name: value}).status_code, 401)

    def test_tunnel_requests_need_the_viewing_password_and_never_become_admin(self):
        with patch.dict(app.app.config, TRUSTED_PROXY=True):
            tunnel = {'CF-Connecting-IP': '198.51.100.7', 'CF-Visitor': '{"scheme":"https"}',
                      'X-Forwarded-Proto': 'https'}
            host = 'friends.example.com'
            self.assertEqual(self.get(host=host, **tunnel).status_code, 401)
            login = self.client.post('/login', data={'password': 'viewer-test-pass-0123',
                                                     'csrf_token': self.token(host, **tunnel)},
                                     environ_overrides={'REMOTE_ADDR': '127.0.0.1'}, headers={'Host': host, **tunnel})
            self.assertEqual(login.status_code, 302)
            self.assertEqual(self.get(host=host, **tunnel).status_code, 200)
            self.assertEqual(self.get('/api/admin/scan-status', host=host, **tunnel).status_code, 401)

    def test_a_claimed_client_ip_never_grants_access(self):
        for trusted in (False, True):
            with self.subTest(trusted=trusted), patch.dict(app.app.config, TRUSTED_PROXY=trusted):
                for name in ('CF-Connecting-IP', 'X-Forwarded-For', 'X-Real-IP'):
                    self.assertEqual(self.get(host='example.com', **{name: '127.0.0.1'}).status_code, 401)
                    self.assertEqual(self.get(peer='203.0.113.9', **{name: '127.0.0.1'}).status_code, 401)

    def test_local_shortcut_can_be_turned_off(self):
        with patch.dict(app.app.config, LOCAL_BYPASS=False):
            self.assertEqual(self.get().status_code, 401)
            login = self.client.post('/login', data={'password': 'viewer-test-pass-0123', 'csrf_token': self.token()},
                                     environ_overrides={'REMOTE_ADDR': '127.0.0.1'})
            self.assertEqual(login.status_code, 302)
            self.assertEqual(self.get().status_code, 200)

    def waitress_sees(self, **options):
        seen = {}

        def probe(environ, start_response):
            seen.update(forwarded_for=environ.get('HTTP_X_FORWARDED_FOR'), proto=environ.get('HTTP_X_FORWARDED_PROTO'),
                        forwarded=environ.get('HTTP_FORWARDED'), cf=environ.get('HTTP_CF_CONNECTING_IP'))
            start_response('200 OK', [('Content-Type', 'text/plain')])
            return [b'ok']

        from waitress.server import create_server
        server = create_server(probe, host='127.0.0.1', port=0, **options)
        threading.Thread(target=server.run, daemon=True).start()
        try:
            request = urllib.request.Request(f'http://127.0.0.1:{server.effective_port}/', headers={
                'X-Forwarded-For': '203.0.113.5', 'X-Forwarded-Proto': 'https', 'Forwarded': 'for=203.0.113.5',
                'CF-Connecting-IP': '203.0.113.5'})
            urllib.request.urlopen(request, timeout=10).read()
        finally:
            time.sleep(0.3)  # Let Waitress finish servicing the request before the socket closes.
            server.close()
        return seen

    def test_waitress_as_configured_lets_the_app_see_proxy_headers(self):
        default = self.waitress_sees(threads=1)
        self.assertIsNone(default['forwarded_for'])  # Waitress deletes these unless told otherwise.
        configured = self.waitress_sees(**serve.server_options(1024))
        self.assertEqual(configured['forwarded_for'], '203.0.113.5')
        self.assertEqual(configured['proto'], 'https')
        self.assertEqual(configured['forwarded'], 'for=203.0.113.5')
        self.assertEqual(configured['cf'], '203.0.113.5')

if __name__ == '__main__':
    unittest.main()
