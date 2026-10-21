"""Import before `app`: tests run in development mode and never read the real sanflix.env."""
import os

os.environ.setdefault('SANFLIX_DEV', '1')
os.environ.setdefault('SANFLIX_ENV_FILE', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'no-such-file.env'))
