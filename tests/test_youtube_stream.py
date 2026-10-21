import io
import unittest
from unittest.mock import patch, MagicMock
import sanflix_test_env  # noqa: F401
import app
import youtube_stream as streams


def sample():
    return {'title': 'Lesson', 'duration': 90, 'formats': [
        {'height': h, 'format_id': str(h), 'protocol': 'https', 'vcodec': 'avc1.4D',
         'acodec': 'none', 'url': f'https://rr1.googlevideo.com/videoplayback?height={h}'}
        for h in (144, 360, 720)] + [
        {'protocol': 'https', 'vcodec': 'none', 'acodec': 'mp4a.40.2',
         'abr': 128, 'url': 'https://rr1.googlevideo.com/videoplayback?audio=1'}]}


class TVStreamTests(unittest.TestCase):
    def setUp(self):
        self.client = app.app.test_client()
        streams._cache.clear()

    def test_quality_cap_and_real_audio_are_selected(self):
        for quality in (144, 360, 720):
            selected = streams.select_streams(sample(), quality)
            self.assertEqual(selected['height'], quality)
            self.assertEqual(len(selected['inputs']), 2)
            command = streams.command(selected, 12.5)
            self.assertEqual(command.count('-ss'), 2)
            self.assertIn('1:a:0', command)
            self.assertEqual(command[-1], '-')

    def test_unavailable_or_unsafe_sources_are_not_forwarded(self):
        for url in ('file:///secret', 'http://localhost/video', 'https://googlevideo.com.evil.example/v',
                    'https://user@rr1.googlevideo.com/v'):
            self.assertFalse(streams.safe_media_url(url))
        with self.assertRaises(streams.StreamUnavailable):
            streams.select_streams({**sample(), 'is_live': True}, 360)
        with self.assertRaises(streams.StreamUnavailable):
            streams.select_streams({'duration': 90, 'formats': []}, 360)

    def test_resolver_uses_metadata_only_and_reuses_short_cache(self):
        import json
        result = MagicMock(returncode=0, stdout=json.dumps(sample()))
        with patch.object(streams.subprocess, 'run', return_value=result) as run:
            streams.resolve('jNQXAC9IVRw', 360)
            streams.resolve('jNQXAC9IVRw', 360)
            self.assertEqual(run.call_count, 1)
            args = run.call_args.args[0]
            self.assertIn('--skip-download', args)
            self.assertIn('--ignore-config', args)
            self.assertIn('--no-cache-dir', args)
            self.assertNotIn('--cookies-from-browser', args)

    def test_routes_validate_access_and_do_not_expose_remote_urls(self):
        self.assertEqual(self.client.get('/api/youtube/resolve/jNQXAC9IVRw',
                         environ_overrides={'REMOTE_ADDR': '192.168.1.50'}).status_code, 401)
        with patch.object(streams, 'resolve') as resolve:
            self.assertEqual(self.client.get('/api/youtube/resolve/invalid').status_code, 400)
            self.assertEqual(self.client.get('/api/youtube/resolve/jNQXAC9IVRw?quality=999').status_code, 400)
            resolve.assert_not_called()
        with patch.object(streams, 'resolve', return_value=streams.select_streams(sample(), 360)):
            response = self.client.get('/api/youtube/resolve/jNQXAC9IVRw')
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('googlevideo', response.text)
            self.assertEqual(self.client.get('/youtube-stream/jNQXAC9IVRw?start=NaN').status_code, 400)
            self.assertEqual(self.client.get('/youtube-stream/jNQXAC9IVRw?start=91').status_code, 416)

    def test_stream_close_releases_process_and_slot(self):
        media = streams.select_streams(sample(), 360)
        for _ in range(3):
            process = MagicMock(stdout=io.BytesIO(b'mp4data'))
            process.poll.return_value = None
            with patch.object(streams, 'resolve', return_value=media), \
                    patch.object(app.subprocess, 'Popen', return_value=process):
                with self.client.get('/youtube-stream/jNQXAC9IVRw?start=5') as response:
                    self.assertEqual(response.status_code, 200)
                    self.assertEqual(response.data, b'mp4data')
                process.terminate.assert_called_once()

    def test_resolver_failure_is_readable_without_automatic_embed(self):
        with patch.object(streams, 'resolve', side_effect=streams.StreamUnavailable('Try another lesson.')):
            response = self.client.get('/api/youtube/resolve/jNQXAC9IVRw')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json['error'], 'Try another lesson.')
