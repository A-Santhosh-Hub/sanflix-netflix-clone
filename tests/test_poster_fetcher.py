import unittest

from poster_fetcher import parse_title


class ParseTitleTests(unittest.TestCase):
    def test_release_names_become_search_titles(self):
        cases = {
            'Iron Man 3.mp4': ('Iron Man 3', None),
            'Tumbbad.2018.mkv': ('Tumbbad', 2018),
            'Spider Man 2 (2004) BluRay - 720p - x264 - [Tam + Eng] - 1.8GB - ESub.mkv': ('Spider Man 2', 2004),
            'www.1TamilMV.ing - Lanterns (2026) S01 EP 01 TRUE WEB-DL - 1080p.mkv': ('Lanterns', 2026),
            'True Lies 1994.mkv': ('True Lies', 1994),
            'ONE.PIECE.S02E01.mkv': ('ONE PIECE', None),
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                self.assertEqual(parse_title(name), expected)


if __name__ == '__main__':
    unittest.main()
