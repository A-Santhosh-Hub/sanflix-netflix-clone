"""Create sanflix.env with random SANFLIX secrets. Values are never printed.

Open the file yourself to read the viewing password you share with friends. The file is
excluded from Git; keep it private and do not send the admin password to anyone.
"""
import os
import secrets
import sys

PATH = os.environ.get('SANFLIX_ENV_FILE') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'sanflix.env')


def main():
    try:
        with open(PATH, 'x', encoding='utf-8') as stream:
            stream.write('# SANFLIX secrets. Keep private; never commit or share this file.\n')
            stream.write(f'SANFLIX_ADMIN_PASSWORD={secrets.token_urlsafe(18)}\n')
            stream.write(f'SANFLIX_VIEW_PASSWORD={secrets.token_urlsafe(18)}\n')
            stream.write(f'SANFLIX_SECRET_KEY={secrets.token_hex(32)}\n')
    except FileExistsError:
        print(f'{PATH} already exists and was left unchanged.')
        return 1
    print(f'Created {PATH}')
    print('It holds SANFLIX_ADMIN_PASSWORD, SANFLIX_VIEW_PASSWORD and SANFLIX_SECRET_KEY.')
    print('Open it to read the viewing password to share. Do not share the admin password.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
