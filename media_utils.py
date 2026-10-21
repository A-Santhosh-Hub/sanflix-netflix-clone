"""Shared filesystem, catalog, and media helpers."""

import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading
import time
from contextlib import contextmanager

BASE_DIR = Path(__file__).resolve().parent
VIDEO_EXTENSIONS = {'.mp4', '.mkv', '.webm', '.avi', '.mov'}
AUDIO_EXTENSIONS = {'.mp3', '.m4a', '.aac', '.wav', '.flac', '.ogg', '.opus'}
MEDIA_EXTENSIONS = VIDEO_EXTENSIONS | AUDIO_EXTENSIONS
_locks = {}
_locks_guard = threading.Lock()


def contained_path(root, *parts):
    """Resolve a path and reject absolute/traversing paths outside root."""
    root = os.path.realpath(root)
    candidate = os.path.realpath(os.path.join(root, *parts))
    try:
        if os.path.normcase(os.path.commonpath([root, candidate])) != os.path.normcase(root):
            raise ValueError('Path is outside the allowed directory')
    except ValueError:
        raise ValueError('Path is outside the allowed directory') from None
    return candidate


def media_id(path):
    path = str(path).replace('\\', '/')
    return hashlib.md5(path.encode('utf-8')).hexdigest()[:12]


def fingerprint(path):
    stat = os.stat(path)
    return {'size': stat.st_size, 'mtime_ns': stat.st_mtime_ns}


def atomic_replace(source, destination):
    """Windows readers can briefly prevent a rename; keep the old file intact."""
    for attempt in range(100):
        try:
            os.replace(source, destination)
            return
        except PermissionError:
            if attempt == 99:
                raise
            time.sleep(0.01)


def read_json(path):
    """Retry short Windows sharing violations during an atomic replacement."""
    for attempt in range(100):
        try:
            with open(path, encoding='utf-8') as stream:
                return json.load(stream)
        except PermissionError:
            if attempt == 99:
                raise
            time.sleep(0.01)


def atomic_json(path, data):
    """Readers see either the old complete document or the new one."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix='.' + path.name, suffix='.tmp', dir=path.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as stream:
            json.dump(data, stream, indent=2, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        atomic_replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def file_lock(path, timeout=None):
    """Thread and process lock, automatically released if a process exits.

    The small lock file is deliberately retained; deleting it would let another
    process lock a different inode while the original owner still holds a lock.
    """
    path = os.path.realpath(path)
    with _locks_guard:
        local_lock = _locks.setdefault(path, threading.Lock())
    started = time.monotonic()
    acquired = local_lock.acquire() if timeout is None else local_lock.acquire(timeout=max(0, timeout))
    if not acquired:
        raise TimeoutError('Another job is using this resource')
    stream = None
    locked = False
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        stream = open(path, 'a+b')
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b'0')
            stream.flush()
        while True:
            stream.seek(0)
            try:
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                locked = True
                break
            except OSError:
                if timeout is not None and time.monotonic() - started >= timeout:
                    raise TimeoutError('Another job is using this resource') from None
                time.sleep(0.1)
        yield
    finally:
        if stream:
            if locked:
                stream.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
            stream.close()
        local_lock.release()


def lock_in_use(path):
    try:
        with file_lock(path, timeout=0):
            return False
    except TimeoutError:
        return True
