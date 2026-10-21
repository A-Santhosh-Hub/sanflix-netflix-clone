"""Regression and real FFmpeg integration checks; all writes use isolated fixtures."""
import contextlib
from array import array
import io
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.parse import quote

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sanflix_test_env  # noqa: F401
import app
import convert_hls
import generate_thumbnails
import hls_manager
import scan_media
from media_utils import atomic_json, contained_path, file_lock, media_id, read_json


class RegressionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.fixture = tempfile.TemporaryDirectory(prefix='sanflix-fixture-')
        cls.fixture_root = Path(cls.fixture.name).resolve()
        clip = cls.fixture_root / 'clip.mp4'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '1.2',
                        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-y', str(clip)], check=True, timeout=30)
        cls.clip_bytes = clip.read_bytes()
        audio = cls.fixture_root / 'clip.mp3'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(clip), '-vn', '-y', str(audio)], check=True, timeout=30)
        cls.audio_bytes = audio.read_bytes()
        multi = cls.fixture_root / 'multi.mp4'
        subprocess.run([
            'ffmpeg', '-nostdin', '-v', 'error', '-i', str(clip), '-f', 'lavfi',
            '-i', 'sine=frequency=880:sample_rate=44100:duration=1.2',
            '-map', '0:v:0', '-map', '0:a:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
            '-metadata:s:a:0', 'language=tam', '-metadata:s:a:1', 'language=eng',
            '-metadata:s:a:1', 'title=English stereo', '-disposition:a:0', 'default',
            '-disposition:a:1', '0', '-y', str(multi)
        ], check=True, timeout=30)
        cls.multi_bytes = multi.read_bytes()
        # A flash and tone share a source timestamp. Long GOPs and B-frames
        # exercise the copied video pre-roll that used to corrupt AAC durations.
        cls.sync_clip = cls.fixture_root / 'sync.mkv'
        subprocess.run([
            'ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
            r'color=black:s=160x90:r=25:d=8,drawbox=color=white:t=fill:enable=gte(t\,4)',
            '-f', 'lavfi', '-i', r'aevalsrc=if(gte(t\,4)\,sin(2*PI*440*t)\,0):s=48000:d=8',
            '-c:v', 'libx264', '-g', '100', '-sc_threshold', '0', '-bf', '2',
            '-c:a', 'pcm_s16le', '-y', str(cls.sync_clip)
        ], check=True, timeout=30)

    @classmethod
    def tearDownClass(cls):
        cls.safe_cleanup(cls.fixture, 'sanflix-fixture-')

    @staticmethod
    def safe_cleanup(temporary, prefix):
        target = Path(temporary.name).resolve()
        assert target.parent == Path(tempfile.gettempdir()).resolve() and target.name.startswith(prefix)
        temporary.cleanup()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='sanflix-test-')
        self.root = Path(self.temporary.name).resolve()
        self.media = self.root / 'media'
        self.media.mkdir()
        self.database = self.root / 'database'
        self.database.mkdir()
        self.catalog = self.database / 'media_library.json'
        self.hls = self.root / 'hls_cache'
        self.thumbs = self.root / 'thumbnails'
        self.thumbs.mkdir()
        self.video = self.media / 'movies' / 'Movie #1.mp4'
        self.video.parent.mkdir()
        self.video.write_bytes(self.clip_bytes)
        self.relative = self.video.relative_to(self.root).as_posix()
        self.mid = media_id(self.relative)
        self.item = {'id': self.mid, 'file': self.relative, 'title': 'Movie #1', 'category': 'movie'}
        atomic_json(self.catalog, [self.item])
        self.stack = contextlib.ExitStack()
        for module in (app, scan_media):
            for key, value in {'BASE_DIR': str(self.root), 'MEDIA_DIR': str(self.media),
                               'DATABASE_FILE': str(self.catalog)}.items():
                self.stack.enter_context(patch.object(module, key, value))
        self.stack.enter_context(patch.object(scan_media, 'DATABASE_DIR', str(self.database)))
        self.stack.enter_context(patch.object(app, 'HLS_DIR', str(self.hls)))
        self.stack.enter_context(patch.object(app, 'THUMBNAILS_DIR', str(self.thumbs)))
        self.stack.enter_context(patch.object(app, '_library_cache', {'data': None, 'mtime': None, 'etag': None}))
        self.stack.enter_context(patch.object(app, '_codec_cache', {}))
        self.stack.enter_context(patch.object(app, '_hls_jobs', {}))
        self.stack.enter_context(patch.object(app, '_login_failures', {}))
        self.stack.enter_context(patch.dict(app.app.config, TESTING=True,
                                           ADMIN_PASSWORD_HASH=app.generate_password_hash('test-admin'),
                                           VIEW_PASSWORD_HASH=app.generate_password_hash('test-viewer')))
        self.client = app.app.test_client()
        self.client.get('/')
        with self.client.session_transaction() as session:
            self.token = session['csrf_token']
        self.headers = {'X-CSRF-Token': self.token}

    def register(self, path):
        """Add a fixture file to the temporary catalogue, as a scan would."""
        relative = Path(path).relative_to(self.root).as_posix()
        atomic_json(self.catalog, read_json(self.catalog) + [{'id': media_id(relative), 'file': relative,
                                                              'title': Path(path).stem, 'category': 'movie'}])

    def tearDown(self):
        for future in app._hls_jobs.values():
            future.result(timeout=30)
        self.stack.close()
        self.safe_cleanup(self.temporary, 'sanflix-test-')

    def admin(self):
        response = self.client.post('/api/admin/login', json={'password': 'test-admin'}, headers=self.headers)
        self.assertEqual(response.status_code, 200)

    def upload(self, name='new.mp4', contents=None, **fields):
        return self.client.post('/api/admin/upload', headers=self.headers,
                                data={'file': (io.BytesIO(self.clip_bytes if contents is None else contents), name), **fields})

    def test_pages_and_media_api(self):
        for url in ['/', '/player/' + self.mid, '/api/media', '/api/media/' + self.mid]:
            self.assertEqual(self.client.get(url).status_code, 200)

    def test_ranges_and_suffix(self):
        url = '/stream/' + quote(self.relative, safe='/')
        with self.client.get(url, headers={'Range': 'bytes=0-15'}) as result:
            self.assertEqual(result.status_code, 206)
            self.assertEqual(result.data, self.clip_bytes[:16])
        with self.client.get(url, headers={'Range': 'bytes=-16'}) as result:
            self.assertEqual(result.status_code, 206)
            self.assertEqual(result.data, self.clip_bytes[-16:])
        for value in ['bytes=100-20', 'bytes=999999999-']:
            with self.subTest(value=value), self.client.get(url, headers={'Range': value}) as result:
                self.assertEqual(result.status_code, 416)
                self.assertGreaterEqual(int(result.headers['Content-Length']), 0)

    def test_sibling_and_other_project_files_are_blocked(self):
        sibling = self.root / 'media-secret'
        sibling.mkdir()
        (sibling / 'secret.mp4').write_bytes(self.clip_bytes)
        self.assertEqual(self.client.get('/stream/media/../media-secret/secret.mp4').status_code, 403)
        with self.assertRaises(ValueError):
            contained_path(self.media, sibling / 'secret.mp4')

    def test_stream_serves_only_catalogued_visible_media(self):
        def stream(relative):
            return self.client.get('/stream/' + quote(relative, safe='/'))
        with self.client.get('/stream/' + quote(self.relative, safe='/'), headers={'Range': 'bytes=0-15'}) as result:
            self.assertEqual((result.status_code, result.data), (206, self.clip_bytes[:16]))
        stray = self.media / 'movies' / 'stray.mp4'
        stray.write_bytes(self.clip_bytes)
        self.assertEqual(stream('media/movies/stray.mp4').status_code, 404)  # On disk, not catalogued.
        for hidden_folder in ('.uploads', '.private'):
            hidden = self.media / hidden_folder / 'partial.mp4'
            hidden.parent.mkdir(exist_ok=True)
            hidden.write_bytes(self.clip_bytes)
            self.register(hidden)  # Even a catalogue entry cannot expose a hidden folder.
            self.assertEqual(stream(f'media/{hidden_folder}/partial.mp4').status_code, 404, hidden_folder)
        (self.media / 'movies' / 'notes.txt').write_text('private notes')
        self.register(self.media / 'movies' / 'notes.txt')
        self.assertEqual(stream('media/movies/notes.txt').status_code, 404)
        self.assertEqual(stream('media/movies/missing.mp4').status_code, 404)
        self.assertEqual(stream('media/../media-secret/secret.mp4').status_code, 403)
        self.assertEqual(stream('media/movies/../movies/Movie #1.mp4').status_code, 404)

    def test_download_works_for_catalogue_entries_and_refuses_hidden_files(self):
        with self.client.get('/download/' + self.mid) as result:
            self.assertEqual((result.status_code, result.data), (200, self.clip_bytes))
        hidden = self.media / '.uploads' / 'partial.mp4'
        hidden.parent.mkdir(exist_ok=True)
        hidden.write_bytes(self.clip_bytes)
        self.register(hidden)
        hidden_id = media_id(hidden.relative_to(self.root).as_posix())
        for url in ('/download/' + hidden_id, '/download/not-a-real-id', '/api/stream-info/zzzz', '/hls/zzzz/playlist.m3u8',
                    '/player/zzzz', '/api/media/zzzz'):
            self.assertEqual(self.client.get(url).status_code, 404, url)

    def test_remote_library_requires_login(self):
        remote = {'REMOTE_ADDR': '203.0.113.20'}
        self.assertEqual(self.client.get('/api/media', environ_overrides=remote).status_code, 401)
        self.assertEqual(self.client.get('/download/' + self.mid, environ_overrides=remote).status_code, 401)
        self.assertEqual(self.client.get('/').status_code, 200)
        result = self.client.post('/login', data={'password': 'test-viewer', 'csrf_token': self.token}, environ_overrides=remote)
        self.assertEqual(result.status_code, 302)
        self.assertEqual(self.client.get('/api/media', environ_overrides=remote).status_code, 200)
        self.assertEqual(self.upload().status_code, 401)  # Viewer is not admin.

    def test_forwarded_and_nonlocal_host_are_not_trusted(self):
        self.assertEqual(self.client.get('/api/media', headers={'CF-Connecting-IP': '1.2.3.4'}).status_code, 401)
        self.assertEqual(self.client.get('/api/media', headers={'Host': 'example.com'}).status_code, 401)

    def test_login_csrf_password_and_rate_limit(self):
        self.assertEqual(self.client.post('/api/admin/login', json={'password': 'test-admin'}).status_code, 403)
        for _ in range(10):
            self.assertEqual(self.client.post('/api/admin/login', json={'password': 'wrong'}, headers=self.headers).status_code, 401)
        self.assertEqual(self.client.post('/api/admin/login', json={'password': 'wrong'}, headers=self.headers).status_code, 429)

    def test_login_rejects_external_redirect(self):
        result = self.client.post('/login?next=//example.com', data={'password': 'test-viewer', 'csrf_token': self.token})
        self.assertEqual(result.headers['Location'], '/')

    def test_valid_upload_and_duplicate_preserve_original(self):
        self.admin()
        with patch.object(app, 'request_scan'):
            first = self.upload()
            self.assertEqual(first.status_code, 202)
            original = (self.media / 'movies' / 'new.mp4').read_bytes()
            second = self.upload()
            self.assertEqual(second.status_code, 409)
            self.assertEqual((self.media / 'movies' / 'new.mp4').read_bytes(), original)
        self.assertFalse(list((self.media / '.uploads').iterdir()))

    def test_invalid_uploads_are_rejected(self):
        self.admin()
        self.assertEqual(self.upload('bad.txt', b'bad').status_code, 400)
        self.assertEqual(self.upload('bad.mp4', b'bad').status_code, 400)
        self.assertEqual(self.upload(category='series').status_code, 400)
        self.assertEqual(self.upload('bad.mp3', self.audio_bytes, category='movies').status_code, 400)

    def test_series_upload_has_show_and_episode(self):
        self.admin()
        with patch.object(app, 'request_scan'):
            result = self.upload('Example.S02E03.mp4', category='series', show='Example Show')
        self.assertEqual(result.status_code, 202)
        path = self.media / 'series' / 'Example_Show' / 'Example.S02E03.mp4'
        self.assertTrue(path.exists())
        self.assertEqual(scan_media.detect_series_info(str(path)), {'show': 'Example Show', 'season': 2, 'episode': 3})

    def test_flat_series_and_null_legacy_entry(self):
        info = scan_media.detect_series_info(str(self.media / 'series' / 'Example.S01E01.mp4'))
        self.assertEqual(info['show'], 'Example')
        atomic_json(self.catalog, [{'id': 'legacy', 'category': 'series', 'show': None}])
        self.assertEqual(self.client.get('/api/series/example').json['seasons'], {})

    def test_audio_upload_and_scanner(self):
        self.admin()
        with patch.object(app, 'request_scan'):
            self.assertEqual(self.upload('Song.mp3', self.audio_bytes, category='music').status_code, 202)
        with patch.object(scan_media, 'generate_thumbnail', return_value=None), contextlib.redirect_stdout(io.StringIO()):
            library = scan_media.scan_media()
        song = next(item for item in library if item['filename'] == 'Song.mp3')
        self.assertEqual((song['category'], song['media_type'], song['codec']), ('music', 'audio', 'mp3'))
        self.assertEqual(len(library), 2)
        self.assertEqual(self.client.get('/api/stream-info/' + song['id']).json['strategy'], 'direct')

    def test_corrupt_catalog_keeps_last_good_version(self):
        self.assertEqual(len(app.load_library()), 1)
        self.catalog.write_text('{broken', encoding='utf-8')
        with self.assertLogs(app.app.logger, level='ERROR'):
            self.assertEqual(app.load_library(), [self.item])

    def test_atomic_catalog_replacement(self):
        errors = []
        def writer():
            try:
                for i in range(15):
                    atomic_json(self.catalog, [{'id': str(i)}] * 100)
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=writer)
        thread.start()
        while thread.is_alive():
            self.assertIsInstance(read_json(self.catalog), list)
        thread.join()
        self.assertEqual(errors, [])

    def test_process_lock_is_exclusive_and_released(self):
        lock = self.database / '.scan.lock'
        command = [sys.executable, '-B', '-c',
                   'from media_utils import file_lock; import sys\ntry:\n with file_lock(sys.argv[1],timeout=0): pass\nexcept TimeoutError: sys.exit(7)', str(lock)]
        with file_lock(lock):
            self.assertEqual(subprocess.run(command, timeout=10).returncode, 7)
        self.assertEqual(subprocess.run(command, timeout=10).returncode, 0)

    def test_thumbnail_collision_and_source_replacement(self):
        one, two = self.media / 'A' / 'Episode1.mp4', self.media / 'B' / 'Episode1.mp4'
        for path in (one, two):
            path.parent.mkdir()
            path.write_bytes(self.clip_bytes)
        with contextlib.redirect_stdout(io.StringIO()):
            first = generate_thumbnails.generate_thumbnail(str(one), str(self.thumbs))
            second = generate_thumbnails.generate_thumbnail(str(two), str(self.thumbs))
        self.assertIsNotNone(first)
        self.assertNotEqual(first, second)
        self.assertEqual(len(list(self.thumbs.glob('*.jpg'))), 2)
        artwork = self.thumbs / Path(first).name
        dimensions = subprocess.check_output([
            'ffprobe', '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', str(artwork)
        ], text=True).strip()
        self.assertEqual(dimensions, '1280x720')

    def test_hls_actual_conversion_reuse_and_force(self):
        hls_manager.convert(self.hls, self.mid, self.video)
        playlist = self.hls / self.mid / 'playlist.m3u8'
        before = playlist.read_text()
        self.assertTrue(hls_manager.playlist_ready(self.hls, self.mid, self.video))
        self.assertEqual(self.client.get('/api/hls/status/' + self.mid).json['status'], 'ready')
        self.assertEqual(self.client.post('/api/hls/start/' + self.mid, headers=self.headers).json['status'], 'ready')
        app.cleanup_old_hls()
        self.assertEqual(playlist.read_text(), before)
        hls_manager.convert(self.hls, self.mid, self.video, force=True)
        self.assertNotEqual(playlist.read_text(), before)
        old_segment = next(line for line in before.splitlines() if line and not line.startswith('#'))
        self.assertTrue((playlist.parent / old_segment).exists())
        with self.client.get('/hls/' + self.mid + '/' + old_segment) as result:
            self.assertEqual(result.status_code, 200)

    def test_hls_partial_playlists_are_not_ready(self):
        folder = hls_manager.cache_dir(self.hls, self.mid)
        folder.mkdir(parents=True)
        (folder / 'playlist.m3u8').write_text('#EXTM3U\n#EXTINF:4,\nmissing.ts\n#EXT-X-ENDLIST\n')
        self.assertFalse(hls_manager.playlist_ready(self.hls, self.mid))
        (folder / 'missing.ts').write_bytes(b'segment')
        self.assertTrue(hls_manager.playlist_ready(self.hls, self.mid))
        (folder / 'playlist.m3u8').write_text('#EXTM3U\n#EXTINF:4,\nmissing.ts\n')
        self.assertFalse(hls_manager.playlist_ready(self.hls, self.mid))

    def test_hls_missing_tool_reports_error(self):
        with patch.object(hls_manager, 'probe', side_effect=FileNotFoundError()):
            with self.assertRaises(RuntimeError):
                hls_manager.convert(self.hls, self.mid, self.video)
        result = self.client.get('/api/hls/status/' + self.mid)
        self.assertEqual(result.json['status'], 'error')
        self.assertIn('unavailable', result.json['error'])

    def test_hls_source_changes_invalidate_cache(self):
        hls_manager.convert(self.hls, self.mid, self.video)
        with self.video.open('ab') as stream:
            stream.write(b'updated')
        self.assertFalse(hls_manager.playlist_ready(self.hls, self.mid, self.video))

    def test_failed_force_keeps_published_stream(self):
        hls_manager.convert(self.hls, self.mid, self.video)
        playlist = self.hls / self.mid / 'playlist.m3u8'
        before = playlist.read_bytes()
        with patch.object(hls_manager, 'probe', side_effect=FileNotFoundError()):
            with self.assertRaises(RuntimeError):
                hls_manager.convert(self.hls, self.mid, self.video, force=True)
        self.assertEqual(playlist.read_bytes(), before)
        self.assertTrue(hls_manager.playlist_ready(self.hls, self.mid, self.video))
        self.assertEqual(hls_manager.job_status(self.hls, self.mid, self.video)['status'], 'error')

    def test_hardware_failure_falls_back_to_cpu(self):
        hls_manager.convert(self.hls, self.mid, self.video, force_transcode=True, gpu_encoder='nonexistent_encoder')
        self.assertTrue(hls_manager.playlist_ready(self.hls, self.mid, self.video))

    def test_duplicate_hls_jobs_only_build_once(self):
        failures = []
        def convert():
            try:
                hls_manager.convert(self.hls, self.mid, self.video)
            except Exception as error:
                failures.append(error)
        # The server creates the cache root at startup. Without this, the two threads race to create it
        # and one can observe it half-created (a Windows path-normalisation difference), a flaky failure.
        self.hls.mkdir(exist_ok=True)
        threads = [threading.Thread(target=convert) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
            self.assertFalse(thread.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(len(list((self.hls / self.mid).glob('build-*'))), 1)

    def test_audio_hls_can_be_decoded(self):
        path = self.media / 'audio.mp3'
        path.write_bytes(self.audio_bytes)
        item_id = media_id('media/audio.mp3')
        hls_manager.convert(self.hls, item_id, path)
        playlist = self.hls / item_id / 'playlist.m3u8'
        self.assertTrue(hls_manager.playlist_ready(self.hls, item_id, path))
        result = subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(playlist), '-f', 'null', '-'], capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_converter_force_rebuilds_ready_files(self):
        with patch.object(convert_hls, 'HLS_DIR', str(self.hls)), patch.object(convert_hls, 'BASE_DIR', self.root), \
                patch.object(convert_hls, 'find_all_videos', return_value=[str(self.video)]), \
                patch.object(convert_hls, 'detect_gpu_encoder', return_value=(None, None)), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(convert_hls.convert_all(), (1, 0, 0))
            self.assertEqual(convert_hls.convert_all(), (0, 1, 0))
            self.assertEqual(convert_hls.convert_all(force=True), (1, 0, 0))

    def test_hls_requires_post_and_csrf(self):
        self.assertEqual(self.client.get('/api/hls/start/' + self.mid).status_code, 405)
        self.assertEqual(self.client.post('/api/hls/start/' + self.mid).status_code, 403)
        self.assertEqual(self.client.post('/api/hls/start/' + self.mid + '?force=1', headers=self.headers).status_code, 403)

    def test_network_classification(self):
        for address, expected in [('172.15.0.1', False), ('172.16.0.1', True), ('172.31.255.1', True),
                                  ('172.32.0.1', False), ('192.168.1.5', True), ('::1', True)]:
            with app.app.test_request_context('/', environ_base={'REMOTE_ADDR': address}):
                self.assertEqual(app.is_local_request(), expected)

    def test_real_remux_does_not_set_transfer_encoding(self):
        mkv = self.media / 'movies' / 'sample.mkv'
        subprocess.run(['ffmpeg', '-nostdin', '-v', 'error', '-i', str(self.video), '-c', 'copy', '-y', str(mkv)], check=True, timeout=30)
        self.register(mkv)
        response = self.client.get('/stream/media/movies/sample.mkv', buffered=False)
        try:
            self.assertEqual(response.status_code, 200)
            self.assertNotIn('Transfer-Encoding', response.headers)
            self.assertTrue(next(iter(response.response)))
        finally:
            response.close()

    @staticmethod
    def flash_and_tone(path):
        decoded = subprocess.run([
            'ffmpeg', '-nostdin', '-v', 'info', '-copyts', '-i', str(path),
            '-vf', 'blackdetect=d=0.01:pix_th=0.5', '-af', 'silencedetect=n=-30dB:d=0.01',
            '-fps_mode', 'passthrough', '-f', 'null', '-'
        ], capture_output=True, text=True, timeout=30)
        if decoded.returncode:
            raise AssertionError(decoded.stderr)
        return tuple(float(re.search(pattern, decoded.stderr)[1]) for pattern in
                     (r'black_end:([\d.\-]+)', r'silence_end: ([\d.\-]+)'))

    def check_live_sync(self, source, start, transcode):
        baseline = self.flash_and_tone(source)
        self.register(source)
        relative = source.relative_to(self.root).as_posix()
        with self.client.get('/stream/' + quote(relative, safe='/'),
                             query_string={'start': start, 'force_transcode': int(transcode)}) as response:
            self.assertEqual(response.status_code, 200)
            output = self.root / 'live.mp4'
            output.write_bytes(response.data)
        flash, tone = self.flash_and_tone(output)
        # Retain the source offset, while both tracks seek to the requested time.
        self.assertAlmostEqual(flash, baseline[0] - start, delta=0.045)
        self.assertAlmostEqual(tone, baseline[1] - start, delta=0.025)
        self.assertAlmostEqual(tone - flash, baseline[1] - baseline[0], delta=0.045)
        packets = json.loads(subprocess.check_output([
            'ffprobe', '-v', 'error', '-select_streams', 'a:0', '-show_packets',
            '-show_entries', 'packet=pts_time,duration_time', '-of', 'json', str(output)
        ]))['packets']
        # In the broken stream, the first AAC packet claimed ~1.45 seconds.
        durations = [float(packet['duration_time']) for packet in packets]
        self.assertLess(max(durations), 0.025)
        times = [float(packet['pts_time']) for packet in packets]
        self.assertTrue(all(0 < b - a < 0.025 for a, b in zip(times, times[1:])))

    def test_live_audio_video_sync_at_start_and_non_keyframe_seek(self):
        source = self.media / 'sync.mkv'
        shutil.copyfile(self.sync_clip, source)
        for transcode in (False, True):
            for start in (0, 1.37):
                with self.subTest(transcode=transcode, start=start):
                    self.check_live_sync(source, start, transcode)

    def test_live_conversion_preserves_intentional_track_offsets(self):
        source = self.media / 'offset.mkv'
        subprocess.run([
            'ffmpeg', '-nostdin', '-v', 'error', '-i', str(self.sync_clip),
            '-itsoffset', '0.35', '-i', str(self.sync_clip), '-map', '0:v:0',
            '-map', '1:a:0', '-c', 'copy', '-y', str(source)
        ], check=True, timeout=30)
        for transcode in (False, True):
            with self.subTest(transcode=transcode):
                self.check_live_sync(source, 1.37, transcode)

    def test_prepared_hls_avoids_local_live_conversion(self):
        for strategy in ('remux', 'transcode', 'direct'):
            for ready in (True, False):
                with self.subTest(strategy=strategy, ready=ready), \
                        patch.object(app, 'get_stream_strategy', return_value=strategy), \
                        patch.object(hls_manager, 'playlist_ready', return_value=ready):
                    result = self.client.get('/api/stream-info/' + self.mid).json
                    self.assertEqual(result['use_hls_auto'], ready and strategy != 'direct')
                    self.assertEqual(result['live_max_height'], 1080)

    def test_live_compatibility_bounds_resolution_without_upscaling(self):
        for size, expected in [('3840x2160', '1920x1080'), ('90x160', '90x160')]:
            with self.subTest(size=size):
                source = self.media / 'dimensions.mkv'
                subprocess.run([
                    'ffmpeg', '-nostdin', '-v', 'error', '-f', 'lavfi', '-i',
                    f'color=black:s={size}:r=2:d=0.5', '-c:v', 'libx264',
                    '-preset', 'ultrafast', '-y', str(source)
                ], check=True, timeout=30)
                self.register(source)
                with self.client.get('/stream/media/dimensions.mkv?force_transcode=1') as response:
                    output = self.root / 'dimensions.mp4'
                    output.write_bytes(response.data)
                dimensions = subprocess.check_output([
                    'ffprobe', '-v', 'error', '-select_streams', 'v:0',
                    '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', str(output)
                ], text=True).strip()
                self.assertEqual(dimensions, expected)

    def install_multi_audio(self):
        self.video.write_bytes(self.multi_bytes)

    def assert_audio_frequency(self, path, expected):
        # Decode the actual output, not just command arguments or stream labels.
        raw = subprocess.check_output([
            'ffmpeg', '-nostdin', '-v', 'error', '-i', str(path), '-ss', '0.25', '-t', '0.25',
            '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-f', 's16le', '-'
        ], timeout=30)
        samples = array('h', raw)
        crossings = sum(a <= 0 < b for a, b in zip(samples, samples[1:]))
        self.assertAlmostEqual(crossings * 16000 / len(samples), expected, delta=12)

    def test_audio_tracks_are_listed_and_live_output_plays_selected_language(self):
        self.install_multi_audio()
        result = self.client.get('/api/stream-info/' + self.mid).json
        self.assertEqual(result['selected_audio_index'], 1)
        self.assertEqual([t['language'] for t in result['audio_tracks']], ['tam', 'eng'])
        self.assertEqual(result['audio_tracks'][0]['label'], 'Tamil')
        self.assertEqual(result['strategy'], 'remux')  # Multi-audio MP4 must honor selection.
        for index, frequency in [(1, 440), (2, 880)]:
            for transcode in (0, 1):
                with self.subTest(index=index, transcode=transcode):
                    with self.client.get('/stream/' + quote(self.relative, safe='/'),
                                         query_string={'audio': index, 'start': 0.2,
                                                       'force_transcode': transcode}) as response:
                        self.assertEqual(response.status_code, 200)
                        output = self.root / 'selected.mp4'
                        output.write_bytes(response.data)
                    self.assert_audio_frequency(output, frequency)
                    _, audios = hls_manager.probe_tracks(output)
                    self.assertEqual(len(audios), 1)

    def test_invalid_audio_selection_is_rejected_before_conversion(self):
        self.install_multi_audio()
        app.get_file_codecs(str(self.video))
        for selection in ('bad', '-1', '0', '3', '1.5', '../2'):
            with self.subTest(selection=selection), patch.object(app.subprocess, 'Popen') as popen:
                urls = ['/api/stream-info/' + self.mid,
                        '/stream/' + quote(self.relative, safe='/'), '/api/hls/status/' + self.mid]
                for url in urls:
                    self.assertEqual(self.client.get(url, query_string={'audio': selection}).status_code, 400)
                self.assertEqual(self.client.post('/api/hls/start/' + self.mid,
                                 query_string={'audio': selection}, headers=self.headers).status_code, 400)
                popen.assert_not_called()

    def test_hls_audio_variants_are_isolated_and_served_with_relative_segments(self):
        self.install_multi_audio()
        hls_manager.convert(self.hls, self.mid, self.video)
        original = self.hls / self.mid / 'playlist.m3u8'
        before = original.read_bytes()
        self.assertFalse(self.client.get('/api/stream-info/' + self.mid + '?audio=2').json['hls_ready'])
        response = self.client.post('/api/hls/start/' + self.mid + '?audio=2', headers=self.headers)
        self.assertEqual(response.status_code, 202)
        for future in list(app._hls_jobs.values()):
            future.result(timeout=30)
        status = self.client.get('/api/hls/status/' + self.mid + '?audio=2').json
        self.assertEqual(status['status'], 'ready')
        self.assertEqual(status['playlist'], f'/hls/{self.mid}/audio-2/playlist.m3u8')
        with self.client.get(status['playlist']) as manifest:
            self.assertEqual(manifest.status_code, 200)
            segment = next(l for l in manifest.text.splitlines() if l and not l.startswith('#'))
        with self.client.get(f'/hls/{self.mid}/audio-2/' + segment) as response:
            self.assertEqual(response.status_code, 200)
        variant = self.hls / self.mid / 'audio-2' / 'playlist.m3u8'
        self.assert_audio_frequency(original, 440)
        self.assert_audio_frequency(variant, 880)
        self.assertEqual(original.read_bytes(), before)
        self.assertTrue(self.client.get('/api/stream-info/' + self.mid + '?audio=2').json['use_hls_auto'])
        self.assertEqual(self.client.get('/api/hls/status/' + self.mid + '?audio=1').json['playlist'],
                         f'/hls/{self.mid}/playlist.m3u8')
        with self.video.open('ab') as stream:
            stream.write(b'changed')
        self.assertFalse(hls_manager.playlist_ready(self.hls, self.mid, self.video, 2))

    def test_missing_language_has_honest_track_label(self):
        info = self.client.get('/api/stream-info/' + self.mid).json
        self.assertEqual(info['audio_tracks'][0]['label'], 'Audio 1')

    def test_source_default_track_does_not_reuse_first_track_cache(self):
        self.install_multi_audio()
        changed = self.root / 'default.mp4'
        subprocess.run([
            'ffmpeg', '-nostdin', '-v', 'error', '-i', str(self.video), '-map', '0', '-c', 'copy',
            '-disposition:a:0', '0', '-disposition:a:1', 'default', '-y', str(changed)
        ], check=True, timeout=30)
        self.video.write_bytes(changed.read_bytes())
        hls_manager.convert(self.hls, self.mid, self.video)
        info = self.client.get('/api/stream-info/' + self.mid).json
        self.assertEqual(info['selected_audio_index'], 2)
        self.assertFalse(info['hls_ready'])
        with self.client.get('/stream/' + quote(self.relative, safe='/')) as response:
            output = self.root / 'default-stream.mp4'
            output.write_bytes(response.data)
        self.assert_audio_frequency(output, 880)


if __name__ == '__main__':
    unittest.main()
