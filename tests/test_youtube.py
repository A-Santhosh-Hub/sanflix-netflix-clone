import io
import json
import os
import unittest
from unittest import mock

import sanflix_test_env  # noqa: F401
import app as sanflix


class YouTubeSectionTests(unittest.TestCase):
    def setUp(self):
        sanflix._youtube_cache.clear()
        self.client = sanflix.app.test_client()

    def signed_in(self):
        with self.client.session_transaction() as session:
            session['viewer'] = True
            session['sid'] = 'test-session'

    def test_page_requires_sign_in_for_network_visitors(self):
        response = self.client.get('/youtube', environ_overrides={'REMOTE_ADDR': '192.168.1.50'})
        self.assertEqual(response.status_code, 302)
        self.assertIn('/login', response.headers['Location'])

    def test_page_opens_when_signed_in(self):
        self.signed_in()
        response = self.client.get('/youtube', environ_overrides={'REMOTE_ADDR': '192.168.1.50'})
        self.assertEqual(response.status_code, 200)
        self.assertIn(b'yt-form', response.data)

    def test_search_without_key_uses_public_catalog(self):
        self.signed_in()
        with mock.patch.dict(os.environ, {'YOUTUBE_API_KEY': ''}), \
                mock.patch.object(sanflix, 'YOUTUBE_KEY_FILE', os.path.join('missing', 'key.txt')), \
                mock.patch.object(sanflix.youtube_catalog, 'browse', return_value={'results': []}) as browse:
            response = self.client.get('/api/youtube/search?q=python')
        self.assertEqual(response.status_code, 200)
        browse.assert_called_once_with(query='python')

    def test_search_returns_clean_results_and_caches(self):
        self.signed_in()
        payload = {'items': [
            {'id': {'videoId': 'dQw4w9WgXcQ'}, 'snippet': {
                'title': 'Learn &amp; Grow', 'channelTitle': 'Teacher',
                'thumbnails': {'medium': {'url': 'https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg'}}}},
            {'id': {'videoId': 'bad id'}, 'snippet': {'title': 'ignored'}},
            {'id': {'videoId': 'abcdefghijk'}, 'snippet': {
                'title': 'Other', 'thumbnails': {'medium': {'url': 'https://evil.example/x.jpg'}}}},
        ]}
        opener = mock.MagicMock(return_value=io.BytesIO(json.dumps(payload).encode()))
        opener.return_value.__enter__ = lambda s: s
        opener.return_value.__exit__ = lambda *a: False
        with mock.patch.dict(os.environ, {'YOUTUBE_API_KEY': 'k'}), \
                mock.patch('urllib.request.urlopen', opener):
            first = self.client.get('/api/youtube/search?q=Learn Python').get_json()
            self.client.get('/api/youtube/search?q=learn python')
        self.assertEqual(opener.call_count, 1)
        self.assertEqual([r['id'] for r in first['results']], ['dQw4w9WgXcQ', 'abcdefghijk'])
        self.assertEqual(first['results'][0]['title'], 'Learn & Grow')
        self.assertEqual(first['results'][1]['thumbnail'], '')

    def test_empty_query_is_rejected(self):
        self.signed_in()
        self.assertEqual(self.client.get('/api/youtube/search?q=%20').status_code, 400)


if __name__ == '__main__':
    unittest.main()
