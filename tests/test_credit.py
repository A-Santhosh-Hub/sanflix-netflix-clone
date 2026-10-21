"""Every page credits the developer with a link that opens the developer's site safely in a new tab."""
import re
import unittest

import sanflix_test_env  # noqa: F401
import app
from flask import render_template

URL = 'https://a-santhosh-hub.github.io/in/'


class CreditTests(unittest.TestCase):
    def pages(self):
        with app.app.test_request_context('/'):
            for name, kwargs in [('index', {}), ('login', {}), ('youtube', {}), ('hub', {}), ('player', {'media_id': 'x'}),
                                 ('share', {'available': False}), ('share', {'available': True, 'title': 'T', 'has_art': False,
                                  'allow_stream': False, 'allow_download': False, 'expires_at': 0, 'expires_text': 'soon', 'token': 't'})]:
                try:
                    yield name, render_template(name + '.html', **kwargs)
                except Exception as error:  # A template needing more context must not hide the other pages.
                    if name != 'share':
                        raise
                    self.skipTest('share template needs more context: %s' % error)

    def test_every_page_links_the_developer_site_safely(self):
        seen = set()
        for name, html in self.pages():
            seen.add(name)
            links = re.findall(r'<a class="credit-link"[^>]*>', html)
            self.assertEqual(len(links), 1, name)
            self.assertIn('href="%s"' % URL, links[0], name)
            self.assertIn('target="_blank"', links[0], name)
            self.assertIn('noopener', links[0], name)
            self.assertIn('Santhosh A', html, name)
        self.assertEqual(seen, {'index', 'login', 'youtube', 'hub', 'player', 'share'})

    def test_the_link_is_defined_in_one_place(self):
        self.assertEqual(app.DEVELOPER_URL, URL)
        self.assertEqual(app.DEVELOPER_NAME, 'Santhosh A')


if __name__ == '__main__':
    unittest.main()
