"""Startup security settings: distinct viewer/admin passwords and a stable session secret.

Production (the default) refuses to start unless every secret is configured. Set SANFLIX_DEV=1
for local development, where missing secrets are generated for that run only.
Values come from the environment or from an optional local file (sanflix.env), never from code.
"""

import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path

ADMIN_VAR = 'SANFLIX_ADMIN_PASSWORD'
VIEW_VAR = 'SANFLIX_VIEW_PASSWORD'
SECRET_VAR = 'SANFLIX_SECRET_KEY'
MIN_PASSWORD_LENGTH = 12
MIN_SECRET_LENGTH = 32


class ConfigError(RuntimeError):
    """The message names variables and never includes their values."""


@dataclass
class Settings:
    admin_password: str
    view_password: str
    secret_key: str
    development: bool
    generated: dict = field(default_factory=dict)  # Only ever filled in development mode.


def load_env_file(path, environ):
    """Fill missing SANFLIX_* variables from a KEY=VALUE file. Real environment values win."""
    try:
        lines = Path(path).read_text(encoding='utf-8-sig').splitlines()
    except FileNotFoundError:
        return False
    for line in lines:
        line = line.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in '"\'':
            value = value[1:-1]
        if key.startswith('SANFLIX_') and key not in environ:
            environ[key] = value
    return True


def load(environ):
    development = environ.get('SANFLIX_DEV') == '1'
    values = {name: environ.get(name, '') for name in (ADMIN_VAR, VIEW_VAR, SECRET_VAR)}
    generated, problems = {}, []
    for name in values:
        if values[name]:
            continue
        if development:
            values[name] = secrets.token_hex(32) if name == SECRET_VAR else secrets.token_urlsafe(18)
            generated[name] = values[name]
        else:
            problems.append(f'{name} is not set.')
    if not problems:
        for name in (ADMIN_VAR, VIEW_VAR):
            if name not in generated and len(values[name]) < MIN_PASSWORD_LENGTH:
                problems.append(f'{name} must be at least {MIN_PASSWORD_LENGTH} characters.')
        if SECRET_VAR not in generated and len(values[SECRET_VAR]) < MIN_SECRET_LENGTH:
            problems.append(f'{SECRET_VAR} must be at least {MIN_SECRET_LENGTH} characters.')
        if values[ADMIN_VAR] == values[VIEW_VAR]:
            problems.append(f'{VIEW_VAR} must be different from {ADMIN_VAR}.')
    if problems:
        raise ConfigError(
            'SANFLIX cannot start safely:\n  - ' + '\n  - '.join(problems) +
            '\nRun "python make_secrets.py" to create sanflix.env, or set these environment variables.'
            '\nFor local development only, set SANFLIX_DEV=1.')
    return Settings(values[ADMIN_VAR], values[VIEW_VAR], values[SECRET_VAR], development, generated)
