import json
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import sanflix_test_env  # noqa: F401
import youtube_catalog as catalog
import app as sanflix


class CatalogTests(unittest.TestCase):
    def setUp(self):
        catalog._cache.clear()

    def response(self, entries):
        return SimpleNamespace(returncode=0, stdout=json.dumps({'entries': entries, 'title': 'Course'}))

    def test_pagination_cache_and_metadata_only(self):
        entries = [{'id': f'{i:011d}', 'title': 'Lesson', 'duration': 12} for i in range(13)]
        with patch.object(catalog.subprocess, 'run', return_value=self.response(entries)) as run:
            result = catalog.browse(query='Python', page=2)
            self.assertEqual(len(result['results']), 12)
            self.assertTrue(result['has_more'])
            self.assertEqual(result, catalog.browse(query='python', page=2))
            self.assertEqual(run.call_count, 1)
            args = run.call_args.args[0]
            self.assertIn('--flat-playlist', args)
            self.assertIn('--skip-download', args)
            self.assertEqual(args[args.index('--playlist-start') + 1], '13')
            self.assertEqual(args[-1], 'ytsearch25:Python')

    def test_collection_validation_and_clean_results(self):
        for kwargs in [{'mode': 'channel', 'collection': 'https://evil.test'}, {'page': 11, 'query': 'x'}, {'query': ''}]:
            with self.assertRaises(ValueError):
                catalog.browse(**kwargs)
        entries = [{'id': 'UC' + 'a'*22, 'title': '<script>', 'thumbnails': [{'url': 'https://evil.test/a'}]}, {'id': 'invalid'}]
        with patch.object(catalog.subprocess, 'run', return_value=self.response(entries)):
            result = catalog.browse(mode='channels', query='science')
        self.assertEqual(len(result['results']), 1)
        self.assertEqual(result['results'][0]['kind'], 'channel')
        self.assertEqual(result['results'][0]['thumbnail'], '')

    def test_errors_release_search_capacity(self):
        with patch.object(catalog.subprocess, 'run', return_value=SimpleNamespace(returncode=0, stdout='[]')):
            for _ in range(3):
                with self.assertRaises(catalog.BrowseUnavailable):
                    catalog.browse(query='x')

    def test_routes_require_login_and_validate_requests(self):
        client = sanflix.app.test_client()
        network = {'REMOTE_ADDR': '192.168.1.50'}
        self.assertEqual(client.get('/api/youtube/browse?q=x', environ_overrides=network).status_code, 401)
        self.assertEqual(client.get('/tv', environ_overrides=network).status_code, 302)
        with client.session_transaction() as session:
            session['viewer'] = True
            session['sid'] = 'test-session'
        self.assertEqual(client.get('/api/youtube/browse?page=bad', environ_overrides=network).status_code, 400)
        with patch.object(catalog, 'browse', return_value={'results': [], 'has_more': False}) as browse:
            self.assertEqual(client.get('/api/youtube/browse?mode=playlist&id=PLabcdefghij1&page=2', environ_overrides=network).status_code, 200)
            browse.assert_called_once_with(mode='playlist', query='', page=2, collection='PLabcdefghij1')


if __name__ == '__main__':
    unittest.main()
