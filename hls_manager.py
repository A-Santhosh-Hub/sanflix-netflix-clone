"""Persistent HLS conversions shared by the server and command-line converter."""

import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
import uuid

from media_utils import atomic_json, atomic_replace, contained_path, file_lock, fingerprint, lock_in_use


def cache_dir(root, media_id, audio_index=None):
    if not re.fullmatch(r'[a-f0-9]{12}', media_id):
        raise ValueError('Invalid media ID')
    folder = Path(contained_path(root, media_id))
    if audio_index is not None:
        if type(audio_index) is not int or audio_index < 0:
            raise ValueError('Invalid audio track')
        folder = Path(contained_path(folder, f'audio-{audio_index}'))
    return folder


def playlist_url(media_id, audio_index=None):
    variant = f'audio-{audio_index}/' if audio_index is not None else ''
    return f'/hls/{media_id}/{variant}playlist.m3u8'


def playlist_ready(root, media_id, source=None, audio_index=None):
    """Only complete playlists with every segment present are reusable."""
    try:
        folder = cache_dir(root, media_id, audio_index)
        playlist = folder / 'playlist.m3u8'
        lines = playlist.read_text(encoding='utf-8').splitlines()
        if '#EXTM3U' not in lines or '#EXT-X-ENDLIST' not in lines:
            return False
        if source:
            marker = next((line for line in lines if line.startswith('#SANFLIX-SOURCE:')), None)
            if marker:
                if json.loads(marker.split(':', 1)[1]) != fingerprint(source):
                    return False
            elif playlist.stat().st_mtime_ns < os.stat(source).st_mtime_ns:
                return False
        segments = [line for line in lines if line and not line.startswith('#')]
        return bool(segments) and all(
            Path(contained_path(folder, segment)).is_file()
            and Path(contained_path(folder, segment)).stat().st_size > 0
            for segment in segments
        )
    except (OSError, ValueError, TypeError):
        return False


def job_status(root, media_id, source=None, audio_index=None):
    folder = cache_dir(root, media_id, audio_index)
    try:
        job = json.loads((folder / 'job.json').read_text(encoding='utf-8'))
    except (OSError, ValueError):
        job = {}
    if lock_in_use(folder / '.lock'):
        stage = job.get('stage')
        segments = 0
        if stage and re.fullmatch(r'build-[a-f0-9]{32}', stage):
            segments = len(list(Path(contained_path(folder, stage)).glob('*.ts')))
        return {'status': job.get('status') if job.get('status') in {'queued', 'processing'} else 'processing',
                'segments_ready': segments,
                'elapsed_seconds': max(0, int(time.time() - job.get('started', time.time())))}
    if job.get('status') == 'error':
        return {'status': 'error', 'error': job.get('error', 'Conversion failed. Please retry.')}
    if playlist_ready(root, media_id, source, audio_index):
        return {'status': 'ready', 'playlist': playlist_url(media_id, audio_index)}
    if job.get('status') in {'queued', 'processing'}:
        return {'status': 'error', 'error': 'Conversion was interrupted. Please retry.'}
    return {'status': 'not_started'}


def probe_tracks(path):
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', str(path)],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30,
    )
    if result.returncode:
        raise ValueError('This file could not be read as media')
    info = json.loads(result.stdout)
    video = next((s for s in info.get('streams', []) if s.get('codec_type') == 'video'
                  and not s.get('disposition', {}).get('attached_pic')), None)
    audios = [s for s in info.get('streams', []) if s.get('codec_type') == 'audio']
    if not video and not audios:
        raise ValueError('No playable audio or video stream was found')
    return video, audios


def probe(path):
    # Keep existing first-track caches and the standalone converter compatible.
    video, audios = probe_tracks(path)
    return video, audios[0] if audios else None


def convert(root, media_id, source, *, force=False, force_transcode=False, gpu_encoder=None, audio_index=None):
    """Publish atomically; never remove a completed cache or overwrite its segments.

    Per-media locks deduplicate jobs across processes. A shared queue lock limits
    CPU/GPU conversion to one job, including the standalone converter.
    """
    folder = cache_dir(root, media_id, audio_index)
    folder.mkdir(parents=True, exist_ok=True)
    with file_lock(folder / '.lock'):
        if not force and playlist_ready(root, media_id, source, audio_index):
            return 'ready'
        state = {'status': 'queued', 'started': time.time()}
        atomic_json(folder / 'job.json', state)
        stage = None
        published = False
        try:
            with file_lock(Path(root) / '.conversion.lock'):
                source_stamp = fingerprint(source)
                if audio_index is None:
                    video, audio = probe(source)
                else:
                    video, audios = probe_tracks(source)
                    audio = next((track for track in audios if track['index'] == audio_index), None)
                    if audio is None:
                        raise ValueError('This audio track is not available in the file')
                # Hardware failures fall back to the CPU on a fresh build.
                attempts = [gpu_encoder, None] if gpu_encoder else [None]
                for encoder in attempts:
                    stage = Path(contained_path(folder, 'build-' + uuid.uuid4().hex))
                    stage.mkdir()
                    state.update(status='processing', stage=stage.name)
                    atomic_json(folder / 'job.json', state)
                    command = ['ffmpeg', '-nostdin', '-y', '-v', 'error', '-i', str(source)]
                    if video:
                        command += ['-map', f'0:{video["index"]}']
                        if video.get('codec_name') in {'h264', 'avc'} and not force_transcode:
                            command += ['-c:v', 'copy']
                        elif encoder:
                            command += ['-c:v', encoder, '-b:v', '4M', '-maxrate', '6M',
                                        '-bufsize', '8M', '-pix_fmt', 'yuv420p']
                            if encoder == 'h264_nvenc':
                                command += ['-preset', 'p4']
                            elif encoder == 'h264_qsv':
                                command += ['-preset', 'medium']
                            elif encoder == 'h264_amf':
                                command += ['-quality', 'balanced']
                            command += ['-force_key_frames', 'expr:gte(t,n_forced*4)']
                        else:
                            command += ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
                                        '-pix_fmt', 'yuv420p', '-force_key_frames', 'expr:gte(t,n_forced*4)']
                    else:
                        command += ['-vn']
                    if audio:
                        command += ['-map', f'0:{audio["index"]}', '-c:a', 'aac', '-b:a', '192k', '-ac', '2']
                    else:
                        command += ['-an']
                    command += ['-sn', '-f', 'hls', '-hls_time', '4', '-hls_list_size', '0',
                                '-hls_segment_filename', str(stage / 'seg%05d.ts'),
                                '-hls_flags', 'independent_segments', '-hls_playlist_type', 'vod',
                                str(stage / 'playlist.m3u8')]
                    # A long 4K film can legitimately take more than two hours.
                    # The shared lock still bounds work to one background job.
                    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                    if result.returncode == 0:
                        break
                    # This is our unique incomplete build, never a published cache.
                    _remove_build(folder, stage)
                    stage = None
                if result.returncode:
                    raise RuntimeError('FFmpeg could not convert this file')
                if fingerprint(source) != source_stamp:
                    raise RuntimeError('The source changed during conversion. Please retry.')
                lines = (stage / 'playlist.m3u8').read_text(encoding='utf-8').splitlines()
                if '#EXT-X-ENDLIST' not in lines:
                    raise RuntimeError('FFmpeg did not finish the playlist')
                manifest = []
                for line in lines:
                    if line and not line.startswith('#'):
                        segment = Path(contained_path(stage, line))
                        if not segment.is_file() or segment.stat().st_size == 0:
                            raise RuntimeError('A converted segment is missing')
                        line = f'{stage.name}/{line}'
                    manifest.append(line)
                if not any(line and not line.startswith('#') for line in manifest):
                    raise RuntimeError('No playable segments were produced')
                manifest.insert(1, '#SANFLIX-SOURCE:' + json.dumps(source_stamp))
                temporary = folder / ('playlist-' + uuid.uuid4().hex + '.tmp')
                try:
                    temporary.write_text('\n'.join(manifest) + '\n', encoding='utf-8')
                    atomic_replace(temporary, folder / 'playlist.m3u8')
                    published = True
                finally:
                    temporary.unlink(missing_ok=True)
                state.update(status='ready')
                atomic_json(folder / 'job.json', state)
                return 'ready'
        except Exception as exc:
            if stage and not published:
                _remove_build(folder, stage)
            if isinstance(exc, FileNotFoundError):
                message = 'FFmpeg or FFprobe is unavailable. Install both and retry.'
            elif isinstance(exc, subprocess.TimeoutExpired):
                message = 'Conversion timed out. Please retry.'
            else:
                message = str(exc)
            state.update(status='error', error=message)
            atomic_json(folder / 'job.json', state)
            raise RuntimeError(message) from exc


def _remove_build(folder, stage):
    checked = Path(contained_path(folder, stage))
    if checked.parent != folder.resolve() or not re.fullmatch(r'build-[a-f0-9]{32}', checked.name):
        raise ValueError('Refusing to remove an unexpected cache directory')
    if checked.is_dir():
        shutil.rmtree(checked)
