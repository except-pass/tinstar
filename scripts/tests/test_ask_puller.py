"""Executable adapter behavior; these fixtures never use a real home or vault."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import sys
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('ask_puller', Path(__file__).parents[1] / 'ask-puller.py')
puller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(puller)


class PullerTests(unittest.TestCase):
    def test_cli_reads_token_only_from_clavis_and_does_not_log_it(self):
        secret = 'isolated-secret-value'
        with patch.object(puller.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, secret, '')) as command, patch.object(puller, 'pull_once', return_value={'captured': 1, 'replied': 0}) as run, patch('sys.argv', ['ask-puller.py', '--url', 'https://floor.example.test', '--home', '/isolated/home', '--token-key', 'test.ask']), contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(puller.main(), 0)
            command.assert_called_once_with(['clavis', 'get', 'test.ask'], text=True, capture_output=True, timeout=15)
            run.assert_called_once_with('https://floor.example.test', secret, Path('/isolated/home'))
            self.assertNotIn(secret, stdout.getvalue())

    def test_cli_failure_never_prints_sensitive_subprocess_error(self):
        with patch.object(puller.subprocess, 'run', side_effect=OSError('secret-value')), patch('sys.argv', ['ask-puller.py', '--url', 'https://floor.example.test', '--home', '/isolated/home', '--token-key', 'test.ask']), contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.assertEqual(puller.main(), 1)
            self.assertNotIn('secret-value', stderr.getvalue())

    def test_capture_retry_keeps_id_after_lost_bridge_response(self):
        request = {'request_id': 'request-1', 'inbox_request_id': 'tinstar-ask-request-1', 'body': 'Question'}
        note = {'schema': 'fm-inbox-note.v1', 'id': 'note-1', 'saved': True, 'request_id': request['inbox_request_id']}
        calls = []
        def inbox(home, args, body=None):
            calls.append((args, body))
            if args[0] == 'note':
                return note, 0
            return {'schema': 'fm-inbox-receipts.v1', 'pending': [], 'handled': [], 'omitted': []}, 0
        def api(base, token, payload=None):
            if payload is None:
                return {'pending': [request], 'tracked': []}
            if len(calls) == 1:
                raise puller.PullerError('Lost response after durable capture')
            return {'accepted': True}
        with patch.object(puller, 'api', side_effect=api), patch.object(puller, 'inbox', side_effect=inbox):
            with self.assertRaises(puller.PullerError):
                puller.pull_once('https://example.test', 'test', Path('/isolated'))
            self.assertEqual(puller.pull_once('https://example.test', 'test', Path('/isolated'))['captured'], 1)
        self.assertEqual(calls[0], calls[1])
        self.assertIn('tinstar-ask-request-1', calls[0][0])

    def test_does_not_send_unrelated_receipts_and_requires_note_request_mapping(self):
        work = {'pending': [], 'tracked': [{'request_id': 'request-1', 'note_id': 'note-1'}]}
        receipt = {'id': 'unrelated-note', 'request_id': 'unrelated', 'reply': {'body': 'Private unrelated answer'}}
        posts = []
        def api(base, token, payload=None):
            if payload is None:
                return work
            posts.append(payload)
        receipts = {'schema': 'fm-inbox-receipts.v1', 'pending': [receipt], 'handled': [], 'omitted': []}
        with patch.object(puller, 'api', side_effect=api), patch.object(puller, 'inbox', return_value=(receipts, 0)):
            self.assertEqual(puller.pull_once('https://example.test', 'test', Path('/isolated'))['replied'], 0)
            self.assertEqual(posts, [])
            receipt['id'] = 'note-1'
            with self.assertRaises(puller.PullerError):
                puller.pull_once('https://example.test', 'test', Path('/isolated'))
            self.assertEqual(posts, [])

    def test_executable_pass_delivers_independent_receipts_despite_incomplete_coverage(self):
        for failure in ('omitted', 'rejected', 'correlation'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                (home / 'bin').mkdir()
                good = {'id': 'good-note', 'request_id': 'tinstar-ask-good',
                        'reply': {'id': 'good-note', 'body': '漢' * 32000, 'cursor': '1', 'at': '2026-11-05T00:00:00Z'}}
                bad = {'id': 'bad-note', 'request_id': 'wrong' if failure == 'correlation' else 'tinstar-ask-bad',
                       'reply': {'body': 'private-rejected-answer'}}
                receipts = {'schema': 'fm-inbox-receipts.v1', 'pending': [bad], 'handled': [good],
                            'omitted': [{'id': 'unrelated-private-record'}] if failure == 'omitted' else []}
                if failure == 'omitted':
                    receipts['pending'] = []
                (home / 'receipts.json').write_text(json.dumps(receipts))
                script = home / 'bin' / 'fm-inbox.sh'
                script.write_text('#!/usr/bin/env python3\nimport os,pathlib\nprint((pathlib.Path(os.environ["FM_HOME"]) / "receipts.json").read_text())\n')
                script.chmod(0o700)
                delivered = []
                class Handler(BaseHTTPRequestHandler):
                    def log_message(self, *args):
                        pass

                    def do_GET(self):
                        self.send_response(200)
                        self.end_headers()
                        self.wfile.write(json.dumps({'ok': True, 'data': {'pending': [], 'tracked': [
                            {'note_id': 'bad-note', 'request_id': 'bad'},
                            {'note_id': 'good-note', 'request_id': 'good'}]}}).encode())

                    def do_POST(self):
                        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                        accepted = payload['request_id'] == 'good'
                        if accepted:
                            delivered.append(payload)
                        self.send_response(200 if accepted else 400)
                        self.end_headers()
                        self.wfile.write(json.dumps({'ok': accepted, 'data': {}}).encode())

                server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
                thread = threading.Thread(target=server.serve_forever)
                thread.start()
                driver = """import importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location('puller',sys.argv[1])
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
try:
    print(m.pull_once(sys.argv[2], 'isolated-token', pathlib.Path(sys.argv[3])))
except m.PullerError:
    print('Receipt delivery incomplete', file=sys.stderr)
    sys.exit(1)
"""
                try:
                    result = subprocess.run([sys.executable, '-c', driver, str(Path(puller.__file__).resolve()),
                                             'http://127.0.0.1:' + str(server.server_port), str(home)],
                                            text=True, capture_output=True, timeout=15)
                finally:
                    server.shutdown()
                    thread.join()
                    server.server_close()
                self.assertEqual(result.returncode, 1)
                self.assertIn('Receipt delivery incomplete', result.stderr)
                self.assertEqual(delivered, [{'request_id': 'good', 'reply': good['reply']}])
                self.assertNotIn('private', result.stdout + result.stderr)
                self.assertNotIn('isolated-token', result.stdout + result.stderr)

    def test_redirect_cannot_forward_the_bearer(self):
        self.assertIsNone(puller.NoRedirect().redirect_request(None, None, 302, 'Found', {}, 'https://another.example.test'))


if __name__ == '__main__':
    unittest.main()
