"""Shared Hub room: metadata, presence and signaling only. Isolated temporary databases; no media is involved."""
import io
import json
import os
import re
import sqlite3
import tempfile
import threading
import time
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

import sanflix_test_env  # noqa: F401
import app
import hubroom
import localgram

REMOTE = {'REMOTE_ADDR': '203.0.113.20'}
ADMIN, VIEW = 'admin-room-pass-01234', 'viewer-room-pass-01234'
SDP = {'type': 'offer', 'sdp': 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n'}
ICE = {'candidates': [{'candidate': 'candidate:1 1 udp 2122260223 192.168.1.5 5000 typ host', 'sdpMid': '0', 'sdpMLineIndex': 0}]}


class Person:
    """One browser: its own cookie jar, signed in as a viewer (or admin)."""

    def __init__(self, case, name=None, admin=False, join=True, fresh=True):
        self.case = case
        self.client = app.app.test_client()
        page = self.client.get('/login', environ_overrides=REMOTE).get_data(as_text=True)
        token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
        if admin:
            self.client.post('/api/admin/login', json={'password': ADMIN}, headers={'X-CSRF-Token': token}, environ_overrides=REMOTE)
        else:
            self.client.post('/login', data={'password': VIEW, 'csrf_token': token}, environ_overrides=REMOTE)
        self.epoch, self.pid = '', None
        if join:
            self.join(name, fresh)

    def csrf(self):
        with self.client.session_transaction() as session:
            return session['csrf_token']

    def call(self, method, path, body=None, epoch=True, content_type='application/json', raw=None, headers=None):
        merged = {'X-CSRF-Token': self.csrf(), **(headers or {})}
        if epoch and self.epoch:
            merged['X-Hub-Epoch'] = self.epoch
        kwargs = {'headers': merged, 'environ_overrides': REMOTE}
        if method == 'GET':
            return self.client.get(path, **kwargs)
        if raw is not None:
            return self.client.open(path, method=method, data=raw, content_type=content_type, **kwargs)
        return self.client.open(path, method=method, json=body if body is not None else {}, **kwargs)

    def join(self, name=None, fresh=True):
        response = self.call('POST', '/api/hub/join', {'name': name, 'fresh': fresh} if name else {'fresh': fresh}, epoch=False)
        self.case.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        data = response.get_json()
        self.epoch, self.pid = data['epoch'], data['pid']
        return data

    def poll(self, after=0):
        response = self.call('GET', f'/api/hub/poll?after={after}')
        self.case.assertEqual(response.status_code, 200, response.get_data(as_text=True))
        return response.get_json()

    def share(self, name='clip.mp4', size=1000, kind='video', mime='video/mp4', ref=None):
        item = {'name': name, 'size': size, 'kind': kind, 'mime': mime}
        if ref:
            item['ref'] = ref
        response = self.call('POST', '/api/hub/shares', {'items': [item]})
        self.case.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        return response.get_json()['shares'][0]


class HubRoomCase(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='sanflix-hubroom-')
        self.root = Path(self.temporary.name).resolve()
        (self.root / 'database').mkdir()
        self.clock = [time.time()]
        self.environment = patch.dict(os.environ, {'SANFLIX_HUB_DB': '', 'SANFLIX_SHARE_DB': ''})
        self.environment.start()
        os.environ.pop('SANFLIX_HUB_DB')
        os.environ.pop('SANFLIX_SHARE_DB')
        self.stack = [
            patch.multiple(app, BASE_DIR=str(self.root), _login_failures={}, _revoked={'stamp': None, 'data': {}}),
            patch.dict(app.app.config, TESTING=True, TRUSTED_PROXY=False, LOCAL_BYPASS=True,
                       HUB_LIMITS=dict(hubroom.DEFAULT_LIMITS),
                       ADMIN_PASSWORD_HASH=app.generate_password_hash(ADMIN), VIEW_PASSWORD_HASH=app.generate_password_hash(VIEW)),
            patch.object(hubroom, 'now', lambda: self.clock[0]),
            patch.object(hubroom, 'limiter', localgram.RateLimiter()),
            patch.object(hubroom, '_cleanup', {'last': 0.0}),
        ]
        for patcher in self.stack:
            patcher.start()
        hubroom._ready.clear()
        self.db = self.root / 'database' / 'hubroom.sqlite3'

    def tearDown(self):
        for patcher in reversed(self.stack):
            patcher.stop()
        self.environment.stop()
        hubroom._ready.clear()
        self.temporary.cleanup()

    def limits(self, **changes):
        return patch.dict(app.app.config['HUB_LIMITS'], changes)

    def advance(self, seconds):
        self.clock[0] += seconds

    def rows(self, sql, *args):
        hubroom.prepare(str(self.db))
        with closing(sqlite3.connect(self.db)) as connection:
            return connection.execute(sql, args).fetchall()

    def transfer(self, owner, friend, size=1000):
        share = owner.share(size=size)
        response = friend.call('POST', f'/api/hub/shares/{share["id"]}/request', {'purpose': 'download'})
        self.assertEqual(response.status_code, 201, response.get_data(as_text=True))
        return share, response.get_json()['transfer']

    def connected(self, owner, friend):
        share, transfer = self.transfer(owner, friend)
        self.assertEqual(owner.call('POST', f'/api/hub/transfers/{transfer}/decision', {'approve': True}).status_code, 200)
        self.assertEqual(owner.call('POST', f'/api/hub/transfers/{transfer}/status', {'status': 'connected'}).status_code, 200)
        return share, transfer


class MembershipTests(HubRoomCase):
    def test_only_signed_in_participants_can_use_the_room(self):
        anonymous = app.app.test_client()
        page = anonymous.get('/login', environ_overrides=REMOTE).get_data(as_text=True)
        token = re.search(r'name="csrf_token" value="([^"]+)"', page).group(1)
        for method, path in (('POST', '/api/hub/join'), ('GET', '/api/hub/poll'), ('POST', '/api/hub/shares'), ('POST', '/api/hub/name')):
            response = anonymous.open(path, method=method, json={}, headers={'X-CSRF-Token': token}, environ_overrides=REMOTE)
            self.assertEqual(response.status_code, 401, path)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM participants')[0][0], 0)
        self.assertEqual(Person(self).poll()['me']['name'][:6], 'Guest-')
        local = app.app.test_client()  # The passwordless localhost browser is a viewer too.
        local.get('/login')
        with local.session_transaction() as session:
            token = session['csrf_token']
        self.assertEqual(local.post('/api/hub/join', json={}, headers={'X-CSRF-Token': token}).status_code, 200)

    def test_csrf_is_required_for_every_state_changing_call(self):
        person = Person(self)
        share = person.share()
        for path, body in (('/api/hub/join', {}), ('/api/hub/name', {'name': 'x'}), ('/api/hub/shares', {'items': []}),
                           (f'/api/hub/shares/{share["id"]}/remove', {}), (f'/api/hub/shares/{share["id"]}/request', {})):
            response = person.client.post(path, json=body, headers={'X-Hub-Epoch': person.epoch}, environ_overrides=REMOTE)
            self.assertEqual(response.status_code, 403, path)
            wrong = person.client.post(path, json=body, headers={'X-CSRF-Token': 'wrong', 'X-Hub-Epoch': person.epoch}, environ_overrides=REMOTE)
            self.assertEqual(wrong.status_code, 403, path)
        self.assertEqual(len(person.poll()['shares']), 1, 'nothing was changed by the rejected calls')

    def test_participant_identity_is_a_signed_server_issued_cookie(self):
        person = Person(self, join=False)
        response = person.call('POST', '/api/hub/join', {}, epoch=False)
        cookie = next(h for h in response.headers.getlist('Set-Cookie') if h.startswith('sanflix_peer='))
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=Lax', cookie)
        data = response.get_json()
        self.assertRegex(data['pid'], r'^[a-f0-9]{16}$')
        self.assertNotIn('Secure', cookie.replace('SameSite', ''))
        raw = person.client.get_cookie('sanflix_peer').value
        self.assertNotIn(data['pid'], app.app.secret_key if isinstance(app.app.secret_key, str) else '')
        for forged in ('garbage', raw[:-3] + 'abc', hubroom.URLSafeSerializer('another-key', salt='sanflix-hub-peer').dumps('a' * 16)):
            intruder = Person(self, join=False)
            intruder.client.set_cookie('sanflix_peer', forged)
            self.assertEqual(intruder.call('GET', '/api/hub/poll').status_code, 409)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM participants')[0][0], 1)
        with patch.dict(app.app.config, TRUSTED_PROXY=True):
            tunnel = Person(self, join=False)
            reply = tunnel.client.post('/api/hub/join', json={}, headers={'X-CSRF-Token': tunnel.csrf(), 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '198.51.100.4'})
            self.assertIn('Secure', next(h for h in reply.headers.getlist('Set-Cookie') if h.startswith('sanflix_peer=')))

    def test_participants_cannot_act_as_each_other(self):
        alice, bob = Person(self, 'Alice'), Person(self, 'Bob')
        share = alice.share()
        forged = bob.call('POST', f'/api/hub/shares/{share["id"]}/remove', {'pid': alice.pid, 'owner': alice.pid})
        self.assertEqual(forged.status_code, 404, 'removal by a non-owner looks like a missing item')
        spoof = bob.call('POST', '/api/hub/shares', {'items': [{'name': 'x.mp4', 'size': 5, 'kind': 'video'}], 'owner_id': alice.pid, 'pid': alice.pid})
        self.assertEqual(spoof.status_code, 201)
        self.assertEqual(self.rows('SELECT owner_id FROM shares WHERE name=?', 'x.mp4')[0][0], bob.pid)
        self.assertEqual(len(alice.poll()['shares']), 2)
        self.assertEqual(alice.call('POST', f'/api/hub/shares/{share["id"]}/remove', {}).status_code, 200)

    def test_display_names_are_sanitised_and_never_treated_as_identity(self):
        person = Person(self, '\u202eevil\u0007 \u200bname\n   with   spaces' + 'x' * 80)
        name = person.poll()['me']['name']
        self.assertEqual(name, 'evil name with spaces' + 'x' * 11)
        self.assertLessEqual(len(name), 32)
        self.assertEqual(person.call('POST', '/api/hub/name', {'name': ' \u202e\u200b '}).status_code, 400)
        self.assertEqual(person.call('POST', '/api/hub/name', {'name': '<b>Sam</b>'}).get_json()['name'], '<b>Sam</b>')
        twin = Person(self, '<b>Sam</b>')
        self.assertNotEqual(person.pid, twin.pid, 'two people may share a name; the id still differs')
        self.assertEqual({p['tag'] for p in twin.poll()['participants']}, {person.pid[-4:], twin.pid[-4:]})

    def test_a_second_tab_replaces_the_first_instead_of_silently_conflicting(self):
        first = Person(self, 'Alice')
        first.share()
        second_epoch = first.join('Alice', fresh=False)['epoch']
        self.assertNotEqual(second_epoch, '')
        stale = first.call('GET', '/api/hub/poll', epoch=False, headers={'X-Hub-Epoch': 'f' * 8})
        self.assertEqual(stale.status_code, 409)
        self.assertIn('another tab', stale.get_json()['error'])
        self.assertEqual(len(first.poll()['shares']), 1)

    def test_a_full_room_turns_new_people_away_politely(self):
        with self.limits(max_participants=2):
            Person(self), Person(self)
            late = Person(self, join=False)
            response = late.call('POST', '/api/hub/join', {}, epoch=False)
            self.assertEqual(response.status_code, 503)
            self.advance(hubroom.ONLINE_SECONDS + 1)  # Everyone looks offline, so there is room again.
            self.assertEqual(late.call('POST', '/api/hub/join', {}, epoch=False).status_code, 200)


class ShareMetadataTests(HubRoomCase):
    def test_a_published_item_is_visible_to_other_participants_with_safe_metadata(self):
        alice, bob = Person(self, 'Alice'), Person(self, 'Bob')
        created = alice.share('Funny clip.mp4', 2048, ref='7')
        self.assertEqual(created['ref'], '7')
        seen = bob.poll()['shares']
        self.assertEqual(len(seen), 1)
        entry = seen[0]
        self.assertEqual((entry['name'], entry['size'], entry['kind'], entry['owner_name'], entry['available']), ('Funny clip.mp4', 2048, 'video', 'Alice', True))
        self.assertEqual(entry['owner'], alice.pid)
        self.assertRegex(entry['id'], r'^[a-f0-9]{16}$')
        for hidden in ('path', 'file', 'cookie', 'epoch', 'secret'):
            self.assertNotIn(hidden, json.dumps(entry).lower())
        self.assertNotIn(alice.epoch, json.dumps(bob.poll()), "another participant's epoch is never exposed")

    def test_only_explicitly_shared_items_exist_on_the_server(self):
        alice, bob = Person(self, 'Alice'), Person(self, 'Bob')
        alice.share('shared.mp4')  # Her other, unshared local files are never mentioned to the server at all.
        self.assertEqual([s['name'] for s in bob.poll()['shares']], ['shared.mp4'])
        self.assertEqual(self.rows('SELECT COUNT(*) FROM shares')[0][0], 1)

    def test_file_names_cannot_smuggle_paths_or_markup_controls(self):
        person = Person(self)
        for sent, expected in ((r'C:\Users\me\Private\holiday.mp4', 'holiday.mp4'), ('/home/me/../../etc/passwd', 'passwd'),
                               ('a\u202eb.mp4', 'ab.mp4'), ('  spaced \t out.mp4 ', 'spaced out.mp4'), ('<img src=x onerror=alert(1)>.mp4', '<img src=x onerror=alert(1)>.mp4'), ('<script>alert(1)</script>.mp4', 'script>.mp4')):
            self.assertEqual(person.share(sent)['name'], expected)
        self.assertFalse(any('\\' in r[0] or '/' in r[0] for r in self.rows('SELECT name FROM shares')))

    def test_invalid_metadata_is_rejected_without_storing_anything(self):
        person = Person(self)
        good = {'name': 'a.mp4', 'size': 10, 'kind': 'video', 'mime': 'video/mp4'}
        bad = [
            {**good, 'kind': 'document'}, {**good, 'kind': None}, {**good, 'name': ''}, {**good, 'name': '\u202e\u200b'}, {**good, 'size': 0}, {**good, 'size': -5},
            {**good, 'size': '10'}, {**good, 'size': True}, {**good, 'size': 1.5}, {**good, 'ref': 'bad ref!'}, {**good, 'ref': 5}, 'not-an-object', None,
        ]
        for item in bad:
            response = person.call('POST', '/api/hub/shares', {'items': [item]})
            self.assertIn(response.status_code, (400, 413), item)
        for payload in ({}, {'items': 'x'}, {'items': []}, {'items': [good] * (hubroom.MAX_BATCH + 1)}):
            self.assertEqual(person.call('POST', '/api/hub/shares', payload).status_code, 400)
        too_big = person.call('POST', '/api/hub/shares', {'items': [{**good, 'size': app.app.config['HUB_LIMITS']['max_file_bytes'] + 1}]})
        self.assertEqual(too_big.status_code, 413)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM shares')[0][0], 0)
        odd_mime = person.share('b.mp4', 10, 'video', 'application/x-evil')
        self.assertEqual(odd_mime['mime'], '')
        self.assertEqual(person.share('c.mp4', 10, 'video', 'audio/mpeg')['mime'], '', 'a type that contradicts the kind is dropped')

    def test_the_server_stores_only_metadata_never_content(self):
        person = Person(self, 'Alice')
        person.share('v.mp4', 4096)
        columns = {t: [r[1] for r in self.rows(f'PRAGMA table_info({t})')] for t in ('participants', 'shares', 'transfers', 'signals')}
        self.assertEqual(sorted(columns), ['participants', 'shares', 'signals', 'transfers'])
        for table, names in columns.items():
            self.assertFalse([n for n in names if n in ('data', 'content', 'bytes', 'blob', 'thumbnail', 'file', 'path', 'chunk')], table)
        types = {r[2].upper() for t in columns for r in self.rows(f'PRAGMA table_info({t})')}
        self.assertNotIn('BLOB', types)
        self.assertNotEqual(self.db.name, 'localgram.sqlite3', 'separate from the Phase 1 sharing database')

    def test_per_participant_limits_and_rate_limits(self):
        person = Person(self)
        with self.limits(max_shares_per_participant=3):
            for number in range(3):
                person.share(f'{number}.mp4')
            self.assertEqual(person.call('POST', '/api/hub/shares', {'items': [{'name': 'x.mp4', 'size': 5, 'kind': 'video'}]}).status_code, 429)
        with patch.object(hubroom, '_limit', wraps=hubroom._limit):
            other = Person(self)
            codes = [other.call('POST', '/api/hub/shares', {'items': [{'name': f'{i}.mp4', 'size': 5, 'kind': 'video'}]}).status_code for i in range(62)]
            self.assertEqual(codes.count(201), 60)
            self.assertEqual(codes[-1], 429)


class OwnershipAndPresenceTests(HubRoomCase):
    def test_only_the_owner_or_an_admin_can_remove_a_share(self):
        alice, bob, boss = Person(self, 'Alice'), Person(self, 'Bob'), Person(self, 'Boss', admin=True)
        first, second = alice.share('one.mp4'), alice.share('two.mp4')
        self.assertEqual(bob.call('POST', f'/api/hub/shares/{first["id"]}/remove', {}).status_code, 404)
        self.assertEqual(bob.call('POST', '/api/hub/shares/ffffffffffffffff/remove', {}).status_code, 404)
        self.assertEqual(bob.call('POST', '/api/hub/shares/not-an-id/remove', {}).status_code, 404)
        self.assertEqual(len(bob.poll()['shares']), 2)
        self.assertEqual(alice.call('POST', f'/api/hub/shares/{first["id"]}/remove', {}).status_code, 200)
        self.assertEqual(boss.call('POST', f'/api/hub/shares/{second["id"]}/remove', {}).status_code, 200)
        self.assertEqual(bob.poll()['shares'], [])
        self.assertEqual(alice.call('POST', f'/api/hub/shares/{first["id"]}/remove', {}).status_code, 404, 'already removed')

    def test_shares_expire(self):
        alice, bob = Person(self), Person(self)
        alice.share()
        self.advance(app.app.config['HUB_LIMITS']['share_ttl_seconds'] - 5)
        alice.poll(), bob.poll()
        self.assertEqual(len(bob.poll()['shares']), 1)
        self.advance(10)
        alice.poll()
        self.assertEqual(bob.poll()['shares'], [])

    def test_an_owner_who_goes_quiet_is_marked_unavailable_then_removed(self):
        alice, bob = Person(self, 'Alice'), Person(self, 'Bob')
        share = alice.share()
        self.advance(hubroom.ONLINE_SECONDS - 5)
        self.assertTrue(bob.poll()['shares'][0]['available'])
        self.advance(10)  # Alice missed her heartbeats; Bob keeps polling.
        entry = bob.poll()['shares'][0]
        self.assertFalse(entry['available'])
        refusal = bob.call('POST', f'/api/hub/shares/{share["id"]}/request', {'purpose': 'download'})
        self.assertEqual(refusal.status_code, 409)
        self.assertIn('offline', refusal.get_json()['error'])
        alice.poll()  # A missed heartbeat is not proof she left: she is back.
        self.assertTrue(bob.poll()['shares'][0]['available'])
        self.advance(hubroom.OFFLINE_REMOVE_SECONDS + 5)
        self.assertEqual(bob.poll()['shares'], [])

    def test_reloading_the_hub_drops_the_old_shares_because_the_files_are_gone(self):
        alice, bob = Person(self, 'Alice'), Person(self, 'Bob')
        alice.share('lost-after-reload.mp4')
        _, transfer = self.transfer(alice, bob)
        alice.join('Alice', fresh=True)
        self.assertEqual(bob.poll()['shares'], [])
        self.assertEqual(self.rows('SELECT status FROM transfers WHERE id=?', transfer)[0][0], 'cancelled')
        kept = Person(self, 'Carol')
        kept.share('keep.mp4')
        kept.join('Carol', fresh=False)
        self.assertEqual(len(bob.poll()['shares']), 1)

    def test_removing_a_share_ends_its_transfers(self):
        alice, bob = Person(self), Person(self)
        share, transfer = self.connected(alice, bob)
        alice.call('POST', f'/api/hub/shares/{share["id"]}/remove', {})
        self.assertEqual(self.rows('SELECT status FROM transfers WHERE id=?', transfer)[0][0], 'cancelled')
        self.assertTrue(any(s['type'] == 'status' and s['payload']['status'] == 'cancelled' for s in bob.poll()['signals']))


class SignalingTests(HubRoomCase):
    def test_a_request_reaches_only_the_owner_and_needs_an_explicit_decision(self):
        alice, bob, carol = Person(self, 'Alice'), Person(self, 'Bob'), Person(self, 'Carol')
        share, transfer = self.transfer(alice, bob)
        incoming = [s for s in alice.poll()['signals'] if s['type'] == 'request']
        self.assertEqual(len(incoming), 1)
        self.assertEqual((incoming[0]['payload']['from_name'], incoming[0]['payload']['name'], incoming[0]['transfer']), ('Bob', 'clip.mp4', transfer))
        self.assertEqual([s for s in carol.poll()['signals'] if s['type'] == 'request'], [])
        self.assertEqual(self.rows('SELECT status FROM transfers WHERE id=?', transfer)[0][0], 'requested')
        self.assertEqual(alice.call('POST', f'/api/hub/transfers/{transfer}/signal', {'kind': 'offer', 'payload': SDP}).status_code, 409, 'no signaling before approval')
        for outsider in (bob, carol):
            denied = outsider.call('POST', f'/api/hub/transfers/{transfer}/decision', {'approve': True})
            self.assertIn(denied.status_code, (403, 404))
        self.assertEqual(alice.call('POST', f'/api/hub/transfers/{transfer}/decision', {'approve': 'yes'}).status_code, 400)
        self.assertEqual(alice.call('POST', f'/api/hub/transfers/{transfer}/decision', {'approve': False}).status_code, 200)
        self.assertEqual(alice.call('POST', f'/api/hub/transfers/{transfer}/decision', {'approve': True}).status_code, 409, 'a decision cannot be changed')
        self.assertEqual([s['payload']['approved'] for s in bob.poll()['signals'] if s['type'] == 'decision'], [False])

    def test_offer_answer_and_ice_are_relayed_only_between_the_two_parties(self):
        alice, bob, carol = Person(self, 'Alice'), Person(self, 'Bob'), Person(self, 'Carol')
        share, transfer = self.transfer(alice, bob)
        alice.call('POST', f'/api/hub/transfers/{transfer}/decision', {'approve': True})
        post = lambda who, kind, payload: who.call('POST', f'/api/hub/transfers/{transfer}/signal', {'kind': kind, 'payload': payload})
        self.assertEqual(post(alice, 'offer', SDP).status_code, 200)
        self.assertEqual(post(bob, 'answer', {**SDP, 'type': 'answer'}).status_code, 200)
        self.assertEqual(post(alice, 'ice', ICE).status_code, 200)
        self.assertEqual(post(bob, 'ice', ICE).status_code, 200)
        to_bob = [s for s in bob.poll()['signals'] if s['type'] == 'signal']
        to_alice = [s for s in alice.poll()['signals'] if s['type'] == 'signal']
        self.assertEqual(sorted(s['payload']['kind'] for s in to_bob), ['ice', 'offer'])
        self.assertEqual(sorted(s['payload']['kind'] for s in to_alice), ['answer', 'ice'])
        self.assertEqual([s for s in carol.poll()['signals'] if s['type'] == 'signal'], [], 'a third participant sees nothing')
        self.assertEqual(post(carol, 'ice', ICE).status_code, 404, 'a stranger cannot inject messages')
        self.assertEqual(post(bob, 'offer', SDP).status_code, 403, 'only the owner offers')
        self.assertEqual(post(alice, 'answer', {**SDP, 'type': 'answer'}).status_code, 403, 'only the requester answers')

    def test_malformed_connection_messages_are_rejected(self):
        alice, bob = Person(self), Person(self)
        _, transfer = self.transfer(alice, bob)
        alice.call('POST', f'/api/hub/transfers/{transfer}/decision', {'approve': True})
        send = lambda kind, payload: alice.call('POST', f'/api/hub/transfers/{transfer}/signal', {'kind': kind, 'payload': payload})
        bad = [('offer', None), ('offer', {'type': 'answer', 'sdp': 'x'}), ('offer', {'type': 'offer', 'sdp': ''}), ('offer', {'type': 'offer', 'sdp': 'x' * (hubroom.MAX_SDP + 1)}),
               ('offer', {'type': 'offer', 'sdp': 'x', 'extra': 1}), ('offer', {'type': 'offer', 'sdp': 5}), ('ice', {'candidates': []}), ('ice', {'candidates': 'x'}),
               ('ice', {'candidates': [ICE['candidates'][0]] * 21}), ('ice', {'candidates': [{'candidate': 'x' * 601}]}), ('ice', {'candidates': [{'candidate': 'c', 'evil': 1}]}),
               ('ice', {'candidates': [{'candidate': 'c', 'sdpMLineIndex': 99}]}), ('ice', {'candidates': [{'candidate': 'c', 'sdpMid': 'm' * 65}]}), ('ice', {'candidates': [5]}),
               ('movie', SDP), (None, SDP), ('ice', {'candidates': [ICE['candidates'][0]], 'x': 1})]
        for kind, payload in bad:
            self.assertEqual(send(kind, payload).status_code, 400, (kind, str(payload)[:60]))
        self.assertEqual(self.rows('SELECT COUNT(*) FROM signals WHERE type=?', 'signal')[0][0], 0)

    def test_status_transitions_and_terminal_states(self):
        alice, bob = Person(self), Person(self)
        share, transfer = self.transfer(alice, bob)
        status = lambda who, value, reason='': who.call('POST', f'/api/hub/transfers/{transfer}/status', {'status': value, 'reason': reason})
        self.assertEqual(status(bob, 'done').status_code, 409, 'cannot finish before connecting')
        self.assertEqual(status(bob, 'connected').status_code, 409, 'not approved yet')
        self.assertEqual(status(bob, 'exploded').status_code, 400)
        alice.call('POST', f'/api/hub/transfers/{transfer}/decision', {'approve': True})
        self.assertEqual(status(bob, 'connected').status_code, 200)
        self.assertEqual(status(bob, 'connected').status_code, 200, 'keep-alive')
        self.assertEqual(status(Person(self), 'failed').status_code, 404, 'a stranger cannot end it')
        self.assertEqual(status(bob, 'done', '\u202e finished').status_code, 200)
        self.assertEqual(status(bob, 'failed').get_json()['status'], 'done', 'finished transfers cannot be rewritten')
        note = [s for s in alice.poll()['signals'] if s['type'] == 'status'][0]['payload']
        self.assertEqual((note['status'], note['reason']), ('done', 'finished'))

    def test_signals_are_deleted_after_delivery_and_expire(self):
        alice, bob = Person(self), Person(self)
        self.transfer(alice, bob)
        first = alice.poll()
        last = max(s['id'] for s in first['signals'])
        alice.poll(after=last)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM signals WHERE to_id=?', alice.pid)[0][0], 0, 'acknowledged messages are deleted')
        self.assertEqual(alice.poll(after=last)['signals'], [])
        bob.call('POST', f'/api/hub/shares/{first["shares"][0]["id"]}/remove', {})  # Not his: ignored.
        self.transfer(alice, Person(self))
        self.advance(hubroom.SIGNAL_TTL + 20)
        Person(self).poll()
        self.assertEqual(self.rows('SELECT COUNT(*) FROM signals')[0][0], 0, 'undelivered messages expire too')

    def test_signal_flooding_is_capped(self):
        alice, bob = Person(self), Person(self)
        _, transfer = self.transfer(alice, bob)
        alice.call('POST', f'/api/hub/transfers/{transfer}/decision', {'approve': True})
        codes = {alice.call('POST', f'/api/hub/transfers/{transfer}/signal', {'kind': 'ice', 'payload': ICE}).status_code for _ in range(hubroom.MAX_SIGNALS_PER_TRANSFER + 5)}
        self.assertIn(429, codes)
        self.assertLessEqual(self.rows('SELECT signal_count FROM transfers WHERE id=?', transfer)[0][0], hubroom.MAX_SIGNALS_PER_TRANSFER)


class ConcurrencyTests(HubRoomCase):
    def test_limits_apply_per_person_per_owner_per_item_and_overall(self):
        alice, bob, carol, dave, erin = (Person(self, n) for n in ('Alice', 'Bob', 'Carol', 'Dave', 'Erin'))
        shares = [alice.share(f'{n}.mp4') for n in range(4)]
        ask = lambda who, share: who.call('POST', f'/api/hub/shares/{share["id"]}/request', {'purpose': 'download'})
        self.assertEqual(ask(bob, shares[0]).status_code, 201)
        self.assertEqual(ask(bob, shares[0]).status_code, 409, 'no duplicate requests for the same item')
        self.assertEqual(ask(bob, shares[1]).status_code, 201)
        self.assertEqual(ask(bob, shares[2]).status_code, 429, 'two transfers per person')
        self.assertEqual(ask(carol, shares[0]).status_code, 201)
        self.assertEqual(ask(dave, shares[3]).status_code, 429, 'three transfers per owner')
        bob_other = Person(self, 'Frank')
        frank_share = bob_other.share('f.mp4')
        with self.limits(max_transfers=3, transfers_per_owner=9):
            self.assertEqual(ask(erin, frank_share).status_code, 429, 'global limit of simultaneous transfers')
        with self.limits(transfers_per_share=1, transfers_per_owner=9, max_transfers=9):
            self.assertEqual(ask(dave, shares[0]).status_code, 429, 'per-item limit')
        self.assertEqual(ask(alice, shares[0]).status_code, 400, 'your own item')
        self.assertEqual(ask(erin, {'id': 'f' * 16}).status_code, 404)

    def test_finished_cancelled_and_timed_out_transfers_free_their_slots(self):
        alice, bob = Person(self), Person(self)
        shares = [alice.share(f'{n}.mp4') for n in range(4)]
        ask = lambda share: bob.call('POST', f'/api/hub/shares/{share["id"]}/request', {'purpose': 'play'})
        first, second = ask(shares[0]).get_json()['transfer'], ask(shares[1]).get_json()['transfer']
        self.assertEqual(ask(shares[2]).status_code, 429)
        bob.call('POST', f'/api/hub/transfers/{first}/status', {'status': 'cancelled'})
        self.assertEqual(ask(shares[2]).status_code, 201)
        self.assertEqual(ask(shares[3]).status_code, 429)
        self.advance(hubroom.REQUEST_TIMEOUT + 5)  # Nobody answered: the requests time out.
        alice.poll(), bob.poll()
        self.assertEqual(self.rows('SELECT status, reason FROM transfers WHERE id=?', second)[0], ('failed', 'timeout'))
        self.assertEqual(ask(shares[3]).status_code, 201)

    def test_a_connected_transfer_that_goes_silent_times_out_but_a_keep_alive_prevents_it(self):
        alice, bob = Person(self), Person(self)
        share, transfer = self.connected(alice, bob)
        for _ in range(3):
            self.advance(hubroom.CONNECTED_IDLE - 20)
            bob.call('POST', f'/api/hub/transfers/{transfer}/status', {'status': 'connected'})
            alice.poll(), bob.poll()
        self.assertEqual(self.rows('SELECT status FROM transfers WHERE id=?', transfer)[0][0], 'connected')
        self.advance(hubroom.CONNECTED_IDLE + 5)
        alice.poll(), bob.poll()
        self.assertEqual(self.rows('SELECT status FROM transfers WHERE id=?', transfer)[0][0], 'failed')

    def test_old_records_are_cleaned_up(self):
        alice, bob = Person(self), Person(self)
        share, transfer = self.transfer(alice, bob)
        bob.call('POST', f'/api/hub/transfers/{transfer}/status', {'status': 'cancelled'})
        self.advance(hubroom.KEEP_FINISHED_SECONDS + 30)
        alice.poll()
        self.advance(40)
        alice.poll()
        self.assertEqual(self.rows('SELECT COUNT(*) FROM transfers')[0][0], 0)
        self.advance(hubroom.PARTICIPANT_FORGET_SECONDS + 100)
        Person(self).poll()
        self.assertEqual(self.rows('SELECT COUNT(*) FROM participants')[0][0], 1)

    def test_many_simultaneous_participants_do_not_corrupt_the_store(self):
        people = [Person(self, f'P{n}') for n in range(10)]
        errors, results = [], []

        def work(person, number):
            try:
                person.share(f'file{number}.mp4')
                results.append(len(person.poll()['shares']))
            except Exception as error:  # noqa: BLE001
                errors.append(error)

        threads = [threading.Thread(target=work, args=(p, n)) for n, p in enumerate(people)]
        [t.start() for t in threads]
        [t.join(timeout=60) for t in threads]
        self.assertEqual(errors, [])
        self.assertEqual(self.rows('SELECT COUNT(*) FROM shares')[0][0], 10)
        self.assertEqual(len(people[0].poll()['participants']), 10)

    def test_disconnecting_peers_are_cleaned_up_so_others_can_continue(self):
        alice, bob, carol = Person(self), Person(self), Person(self)
        share, transfer = self.connected(alice, bob)
        self.advance(hubroom.ONLINE_SECONDS + 5)  # Bob vanished mid-transfer; Alice and Carol still poll.
        alice.poll(), carol.poll()
        self.advance(hubroom.CONNECTED_IDLE)
        alice.poll(), carol.poll()
        self.assertEqual(self.rows('SELECT status FROM transfers WHERE id=?', transfer)[0][0], 'failed')
        self.assertEqual(carol.call('POST', f'/api/hub/shares/{share["id"]}/request', {'purpose': 'download'}).status_code, 201)


class BodyGuardTests(HubRoomCase):
    def test_media_can_never_be_posted_to_the_hub_api(self):
        person = Person(self)
        before = self.rows('SELECT COUNT(*) FROM shares')[0][0]
        paths = ['/api/hub/join', '/api/hub/name', '/api/hub/shares']
        for path in paths:
            binary = person.call('POST', path, raw=b'\x00\x01video-bytes' * 5000, content_type='application/octet-stream')
            self.assertEqual(binary.status_code, 415, path)
            upload = person.client.post(path, data={'file': (io.BytesIO(b'v' * 5000), 'movie.mp4')}, headers={'X-CSRF-Token': person.csrf(), 'X-Hub-Epoch': person.epoch},
                                        environ_overrides=REMOTE, content_type='multipart/form-data')
            self.assertEqual(upload.status_code, 415, path)
            huge = person.call('POST', path, raw=json.dumps({'items': [], 'pad': 'x' * (hubroom.MAX_BODY + 10)}).encode(), content_type='application/json')
            self.assertEqual(huge.status_code, 413, path)
        self.assertEqual(self.rows('SELECT COUNT(*) FROM shares')[0][0], before)
        self.assertLess(self.db.stat().st_size, 200000, 'nothing large was stored')

    def test_only_get_poll_is_read_only_and_errors_do_not_leak_secrets(self):
        person = Person(self)
        for response in (person.call('POST', '/api/hub/shares', {'items': 5}), person.call('GET', '/api/hub/poll?after=abc'),
                         person.call('POST', '/api/hub/shares/zzzz/request', {})):
            body = response.get_data(as_text=True)
            self.assertNotIn(person.epoch, body)
            self.assertNotIn(app.app.secret_key if isinstance(app.app.secret_key, str) else 'no-secret', body)
            self.assertNotIn(str(self.root), body)
        self.assertEqual(person.call('GET', '/api/hub/poll?after=-5').status_code, 200)
        self.assertEqual(person.call('GET', '/api/hub/poll').headers['Cache-Control'], 'private, no-store')


class PageAndSeparationTests(HubRoomCase):
    def test_the_hub_page_allows_only_same_origin_requests_and_other_pages_are_unchanged(self):
        response = Person(self, join=False).client.get('/hub', environ_overrides=REMOTE)
        policy = response.headers['Content-Security-Policy']
        self.assertIn("connect-src 'self'", policy)
        self.assertIn("default-src 'none'", policy)
        for forbidden in ('unsafe-inline', 'unsafe-eval', 'http:', 'https:', '*', 'ws:', 'wss:'):
            self.assertNotIn(forbidden, policy)
        self.assertIn('name="csrf-token"', response.get_data(as_text=True))
        for page in ('/', '/youtube'):
            self.assertNotIn('Content-Security-Policy', app.app.test_client().get(page).headers, page)

    def test_phase_one_share_links_and_the_hosted_library_still_work_alongside(self):
        person = Person(self, admin=True)
        self.assertEqual(person.call('GET', '/api/shares/me').get_json()['can_create'], True)
        self.assertEqual(person.call('GET', '/api/media').status_code, 200)
        self.assertEqual(person.call('GET', '/api/shares').status_code, 200)
        self.assertEqual(person.call('GET', '/api/admin/scan-status').status_code, 200)
        viewer = Person(self)
        self.assertEqual(viewer.call('GET', '/api/admin/scan-status').status_code, 401)
        self.assertEqual(viewer.call('POST', '/api/shares', {'media_id': 'a' * 12, 'allow_stream': True}).status_code, 403)

    def test_limits_come_from_the_environment_with_safe_defaults(self):
        limits = hubroom.limits_from_environment({'SANFLIX_HUB_MAX_FILE_MB': '10', 'SANFLIX_HUB_STUN': 'stun:a.example:3478, turn:evil.example, stun:b.example,javascript:x',
                                                   'SANFLIX_HUB_MAX_TRANSFERS': 'oops'})
        self.assertEqual(limits['max_file_bytes'], 10 * 1024 ** 2)
        self.assertEqual(limits['stun'], ['stun:a.example:3478', 'stun:b.example'], 'only STUN servers are accepted; no relay is configured')
        self.assertEqual(limits['max_transfers'], hubroom.DEFAULT_LIMITS['max_transfers'])
        self.assertEqual(hubroom.limits_from_environment({'SANFLIX_HUB_STUN': ''})['stun'], [])
        self.assertEqual(hubroom.limits_from_environment({})['stun'], ['stun:stun.l.google.com:19302'])

    def test_join_response_exposes_only_what_the_browser_needs(self):
        data = Person(self, join=False).join('Alice')
        self.assertEqual(sorted(data), ['admin', 'epoch', 'ice', 'limits', 'name', 'pid', 'tag'])
        self.assertTrue(all(set(server) == {'urls'} and server['urls'].startswith('stun') for server in data['ice']))

    def test_the_database_is_created_repeatably_and_a_newer_version_is_refused(self):
        hubroom.prepare(str(self.db))
        for _ in range(3):
            hubroom._ready.clear()
            hubroom.prepare(str(self.db))
        with closing(sqlite3.connect(self.db)) as connection:
            self.assertEqual(connection.execute('PRAGMA user_version').fetchone()[0], hubroom.SCHEMA_VERSION)
            connection.execute(f'PRAGMA user_version={hubroom.SCHEMA_VERSION + 1}')
        hubroom._ready.clear()
        with self.assertRaises(RuntimeError):
            hubroom.prepare(str(self.db))


if __name__ == '__main__':
    unittest.main()
