"""Production entry point: runs SANFLIX on Waitress (Windows-compatible WSGI server).

    python serve.py            start the server
    python serve.py --check    only verify the configuration, then exit (0 = ready, 2 = not ready)
"""
import os
import sys

import security_config


def server_options(max_request_body_size):
    return dict(threads=int(os.environ.get('SANFLIX_THREADS', '16')),
                max_request_body_size=max_request_body_size, channel_timeout=600, ident='sanflix',
                # Waitress would silently delete X-Forwarded-* headers. The app never trusts them for
                # identity, but needs to SEE them so a proxied request is not mistaken for a local browser.
                clear_untrusted_proxy_headers=False)


def main(argv):
    try:
        import app as sanflix
    except security_config.ConfigError as error:
        print(error)
        return 2
    if '--check' in argv:
        print('Configuration is valid.')
        return 0
    try:
        from waitress import serve
    except ImportError:
        print('Waitress is not installed. Run: python -m pip install -r requirements.txt')
        return 2
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sanflix.announce()
    sanflix.cleanup_old_hls()
    print('Serving with Waitress. Press Ctrl+C to stop.')
    serve(sanflix.app, host=sanflix.listen_host(), port=sanflix.listen_port(),
          **server_options(sanflix.app.config['MAX_CONTENT_LENGTH']))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
