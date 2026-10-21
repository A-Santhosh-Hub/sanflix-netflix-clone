import os
import unittest
from unittest import mock

import sanflix_test_env  # noqa: F401
import app as sanflix


class NetworkUrlTests(unittest.TestCase):
    def test_loopback_host_shares_nothing(self):
        with mock.patch.dict(os.environ, {'SANFLIX_HOST': '127.0.0.1'}):
            self.assertEqual(sanflix.network_urls(), [])

    def test_all_interfaces_lists_private_addresses_only(self):
        fake = ['192.168.1.20', '172.17.51.90', '8.8.8.8', '127.0.0.1', '169.254.3.4', 'bad']
        with mock.patch.dict(os.environ, {'SANFLIX_HOST': '0.0.0.0', 'SANFLIX_PORT': '5000'}), \
                mock.patch('socket.gethostbyname_ex', return_value=('pc', [], fake)), \
                mock.patch('socket.socket', side_effect=OSError):
            self.assertEqual(sanflix.network_urls(),
                             ['http://192.168.1.20:5000', 'http://172.17.51.90:5000'])

    def test_remote_visitors_do_not_receive_internal_addresses(self):
        client = sanflix.app.test_client()
        with client.session_transaction() as session:
            session['viewer'] = True
            session['sid'] = 'test-session'
        with mock.patch.dict(os.environ, {'SANFLIX_HOST': '0.0.0.0'}):
            response = client.get('/api/network', headers={'X-Forwarded-For': '203.0.113.9'})
        self.assertEqual(response.get_json(), {'urls': []})


if __name__ == '__main__':
    unittest.main()
