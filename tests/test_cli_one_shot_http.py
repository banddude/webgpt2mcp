import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ID = '12345678-1234-1234-1234-1234567890ab'
URL = f'https://chatgpt.com/c/{ID}'
EXACT = '  Café 🧪\n\nKeep\tspacing and `ticks` $(literal).\n  '


class OneShotCliHTTP(unittest.TestCase):
    def setUp(self):
        self.calls = []
        calls = self.calls

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                calls.append(('POST', self.path, body))
                if body.get('prompt') == '__uncertain__':
                    self.send_response(502)
                    data = {'error': 'send_outcome_unknown', 'submitted': None, 'actual_url': URL}
                else:
                    self.send_response(200)
                    data = {'success': True, 'submitted': True, 'detached': True,
                            'conversation_url': URL, 'stream_status_after': 'IS_STREAMING'}
                self.send_header('content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps(data).encode())

            def do_GET(self):
                calls.append(('GET', self.path, None))
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({'title': 'Current snapshot', 'stream_status': 'IS_STREAMING',
                    'messages': [{'role': 'assistant', 'text': 'Partial reply'}]}).encode())

        self.api = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.api.serve_forever, daemon=True)
        self.thread.start()
        self.temp = tempfile.TemporaryDirectory()
        config = Path(self.temp.name) / 'config.yaml'
        config.write_text('server:\n  auth: test-only-token\n  port: 17841\n')
        self.env = {**os.environ, 'CHATGPT_CONFIG': str(config), 'CHATGPT_CLI_TIMEOUT': '3',
                    'CHATGPT_API_URL': f'http://127.0.0.1:{self.api.server_port}'}

    def tearDown(self):
        self.api.shutdown()
        self.api.server_close()
        self.thread.join(timeout=2)
        self.temp.cleanup()

    def run_cli(self, *args, command='chatgpt'):
        return subprocess.run([sys.executable, str(ROOT / 'bin' / command), *args],
            env=self.env, cwd=self.temp.name, text=True, capture_output=True, timeout=5)

    def test_all_send_commands_send_exact_text_once_and_exit_before_completion(self):
        for command, args in [('chatgpt', ['new', EXACT]), ('chatgpt', ['dispatch', EXACT]),
                              ('chatgpt', ['send', URL, EXACT]), ('chatgpt-web', ['new', EXACT])]:
            with self.subTest(args=args[0], command=command):
                count = len(self.calls)
                result = self.run_cli(*args, '--json', command=command)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(len(self.calls), count + 1)
                method, endpoint, body = self.calls[-1]
                self.assertEqual((method, endpoint), ('POST', '/admin/chatgpt/dispatch'))
                self.assertEqual(body['prompt'], EXACT)
                self.assertNotIn('messages', body)
                self.assertNotIn('system_prompt', body)
                self.assertEqual(json.loads(result.stdout)['conversation_url'], URL)
        self.assertFalse(any(call[0] == 'GET' for call in self.calls))

    def test_explicit_read_returns_one_partial_snapshot(self):
        result = self.run_cli('read', URL, '--json')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['stream_status'], 'IS_STREAMING')
        self.assertEqual(self.calls, [('GET', f'/admin/chatgpt/conversation/{ID}', None)])

    def test_failed_send_is_not_replayed_and_retired_options_do_not_reach_http(self):
        result = self.run_cli('new', '__uncertain__')
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.calls), 1)
        for args in [['new', EXACT, '--system-prompt', 'hidden'], ['responses', EXACT], ['read', 'fuzzy title']]:
            result = self.run_cli(*args)
            self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.calls), 1)


if __name__ == '__main__':
    unittest.main()
