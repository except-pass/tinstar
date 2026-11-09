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
        with patch.object(puller, 'single_flight', return_value=contextlib.nullcontext(True)), patch.object(puller.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, secret, '')) as command, patch.object(puller, 'pull_once', return_value={'captured': 1, 'replied': 0}) as run, patch('sys.argv', ['ask-puller.py', '--url', 'https://floor.example.test', '--home', '/isolated/home', '--token-key', 'test.ask']), contextlib.redirect_stdout(io.StringIO()) as stdout:
            self.assertEqual(puller.main(), 0)
            command.assert_called_once_with(['clavis', 'get', 'test.ask'], text=True, capture_output=True, timeout=15)
            run.assert_called_once_with('https://floor.example.test', secret, Path('/isolated/home'))
            self.assertNotIn(secret, stdout.getvalue())

    def test_cli_failure_never_prints_sensitive_subprocess_error(self):
        with patch.object(puller, 'single_flight', return_value=contextlib.nullcontext(True)), patch.object(puller.subprocess, 'run', side_effect=OSError('secret-value')), patch('sys.argv', ['ask-puller.py', '--url', 'https://floor.example.test', '--home', '/isolated/home', '--token-key', 'test.ask']), contextlib.redirect_stderr(io.StringIO()) as stderr:
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

    def test_reply_warnings_are_durable_idempotent_followup_notes(self):
        for failure in ('lost-post-response', 'inbox-wake', 'none'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as temporary:
                home = Path(temporary)
                receipt = {'id': 'note-1', 'request_id': 'tinstar-ask-request-1',
                           'reply': {'id': 'note-1', 'body': 'Answer', 'cursor': '1'}}
                accepted = False
                posts = 0
                notes = {}
                attempts = []
                warnings = [{'index': 0, 'reason': 'rejected action'}]
                def api(base, token, payload=None):
                    nonlocal accepted, posts
                    if payload is None:
                        return {'pending': [], 'tracked': [] if accepted else [{'request_id': 'request-1', 'note_id': 'note-1'}]}
                    accepted = True
                    posts += 1
                    if failure == 'lost-post-response' and posts == 1:
                        raise puller.PullerError('Lost response', 'network')
                    return {'accepted': True, 'reply_warnings': warnings}
                def inbox(home, args, body=None):
                    if args[0] == 'receipts':
                        return {'schema': 'fm-inbox-receipts.v1', 'pending': [receipt], 'handled': [], 'omitted': []}, 0
                    self.assertEqual(args[0], 'note')
                    self.assertEqual(args[3:], ['--json', '-'])
                    key = args[2]
                    attempts.append(key)
                    notes.setdefault(key, body)
                    return {'saved': True, 'request_id': key, 'id': 'receipt-note'}, 3 if failure == 'inbox-wake' and len(attempts) == 1 else 0
                with patch.object(puller, 'api', side_effect=api), patch.object(puller, 'inbox', side_effect=inbox):
                    if failure != 'none':
                        with self.assertRaises(puller.PullerError):
                            puller.pull_once('https://example.test', 'private-token', home)
                        journal = list((home / 'state' / 'tinstar-ask-reply-receipts').glob('*.json'))
                        self.assertEqual(len(journal), 1)
                        self.assertEqual(journal[0].stat().st_mode & 0o777, 0o600)
                        self.assertNotIn('private-token', journal[0].read_text())
                    puller.pull_once('https://example.test', 'private-token', home)
                    puller.pull_once('https://example.test', 'private-token', home)
                self.assertEqual(posts, 2 if failure == 'lost-post-response' else 1)
                self.assertEqual(len(notes), 1)
                body = next(iter(notes.values()))
                content = json.loads(body.splitlines()[1])
                self.assertEqual(content, {'request_id': 'request-1', 'note_id': 'note-1', 'reply_warnings': warnings})
                self.assertTrue(all(key == attempts[0] for key in attempts))
                self.assertFalse(list((home / 'state' / 'tinstar-ask-reply-receipts').glob('*.json')))

    def test_receipt_identity_ignores_timestamp_body_format_and_cursor_padding(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            reply = {'id': 'note-1', 'cursor': '0001', 'at': '2026-11-09T00:00:00Z', 'body': '{"summary":"Answer"}'}
            receipt = {'id': 'note-1', 'request_id': 'tinstar-ask-request-1', 'reply': reply}
            note_ids, notes = [], set()
            def api(base, token, payload=None):
                if payload is None:
                    return {'pending': [], 'tracked': [{'request_id': 'request-1', 'note_id': 'note-1'}]}
                return {'accepted': True, 'reply_warnings': [{'reason': 'rejected'}]}
            def inbox(home, args, body=None):
                if args[0] == 'receipts':
                    return {'schema': 'fm-inbox-receipts.v1', 'pending': [receipt], 'handled': [], 'omitted': []}, 0
                note_ids.append(args[2])
                notes.add(args[2])
                return {'saved': True, 'request_id': args[2]}, 0
            with patch.object(puller, 'api', side_effect=api), patch.object(puller, 'inbox', side_effect=inbox):
                puller.pull_once('https://example.test', 'fixture', home)
                reply.update(at='2027-01-01T00:00:00Z', body='{ "summary": "Answer" }', cursor='1')
                puller.pull_once('https://EXAMPLE.test:443/', 'fixture', home)
            self.assertEqual(len(notes), 1)
            self.assertEqual(note_ids[0], note_ids[1])
            payload = {'request_id': 'request-1', 'reply': reply}
            key = puller.receipt_identity('https://example.test', payload)
            for origin, changed in [('https://different.test', payload),
                                    ('https://example.test', {**payload, 'request_id': 'other'}),
                                    ('https://example.test', {**payload, 'reply': {**reply, 'id': 'other'}}),
                                    ('https://example.test', {**payload, 'reply': {**reply, 'cursor': '2'}})]:
                self.assertNotEqual(key, puller.receipt_identity(origin, changed))

    def test_legacy_pending_journal_keeps_its_inbox_id_and_skips_same_answer(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            reply = {'id': 'note-1', 'cursor': '1', 'at': 'old timestamp', 'body': 'Answer'}
            payload = {'request_id': 'request-1', 'reply': reply}
            old_key = puller.hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
            path = home / 'state' / 'tinstar-ask-reply-receipts' / (old_key + '.json')
            puller.save_receipt(path, {'origin': 'https://example.test', 'payload': payload,
                                     'response': {'reply_warnings': [{'reason': 'rejected'}]}})
            legacy_id = 'tinstar-ask-receipt-' + old_key
            saved_notes = {legacy_id}
            calls, posts = [], []
            def api(base, token, data=None):
                if data is not None:
                    posts.append(data)
                    return {}
                return {'pending': [], 'tracked': [{'request_id': 'request-1', 'note_id': 'note-1'}]}
            def inbox(home, args, body=None):
                if args[0] == 'receipts':
                    return {'schema': 'fm-inbox-receipts.v1', 'pending': [
                        {'id': 'note-1', 'request_id': 'tinstar-ask-request-1', 'reply': {**reply, 'at': 'new timestamp'}}],
                            'handled': [], 'omitted': []}, 0
                calls.append(args[2])
                saved_notes.add(args[2])
                return {'saved': True, 'request_id': args[2]}, 0
            with patch.object(puller, 'api', side_effect=api), patch.object(puller, 'inbox', side_effect=inbox):
                puller.pull_once('https://example.test', 'fixture', home)
            self.assertEqual(calls, [legacy_id])
            self.assertEqual(saved_notes, {legacy_id})
            self.assertEqual(posts, [])
            self.assertFalse(path.exists())

    def test_post_warning_response_reaches_executable_inbox_over_http(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            (home / 'bin').mkdir()
            receipt = {'id': 'note-1', 'request_id': 'tinstar-ask-request-1',
                       'reply': {'id': 'note-1', 'body': 'Answer', 'cursor': '1'}}
            receipts = {'schema': 'fm-inbox-receipts.v1', 'pending': [receipt], 'handled': [], 'omitted': []}
            (home / 'receipts.json').write_text(json.dumps(receipts))
            command = home / 'bin' / 'fm-inbox.sh'
            command.write_text('#!' + sys.executable + '\n' + """import json,os,pathlib,sys
home=pathlib.Path(os.environ['FM_HOME'])
if sys.argv[1]=='receipts':
    print((home/'receipts.json').read_text())
else:
    assert sys.argv[1:3]==['note','--request-id'] and sys.argv[4:]==['--json','-']
    (home/'warning-note.txt').write_text(sys.stdin.read())
    print(json.dumps({'saved':True,'request_id':sys.argv[3],'id':'warning-note'}))
""")
            command.chmod(0o700)
            accepted = []
            versions = []
            warnings = [{'id': 'unsafe', 'reason': 'Action rejected'}]
            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *args):
                    pass
                def respond(self, data):
                    self.send_response(200)
                    self.end_headers()
                    self.wfile.write(json.dumps({'ok': True, 'data': data}).encode())
                def do_GET(self):
                    versions.append(self.headers.get('X-Tinstar-Puller-Version'))
                    self.respond({'pending': [], 'tracked': [] if accepted else [{'request_id': 'request-1', 'note_id': 'note-1'}]})
                def do_POST(self):
                    accepted.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                    self.respond({'accepted': True, 'reply_warnings': warnings})
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            thread = threading.Thread(target=server.serve_forever)
            thread.start()
            try:
                base = 'http://127.0.0.1:' + str(server.server_port)
                self.assertEqual(puller.pull_once(base, 'private-token', home)['replied'], 1)
                self.assertEqual(puller.pull_once(base, 'private-token', home)['replied'], 0)
            finally:
                server.shutdown()
                thread.join()
                server.server_close()
            content = json.loads((home / 'warning-note.txt').read_text().splitlines()[1])
            self.assertEqual(content['reply_warnings'], warnings)
            self.assertEqual(versions, [puller.VERSION, puller.VERSION])
            self.assertEqual(accepted, [{'request_id': 'request-1', 'reply': receipt['reply']}])

    def test_http_sends_version_and_parses_upgrade_header_without_logging_body(self):
        import urllib.error
        from email.message import Message
        headers = Message()
        headers['X-Tinstar-Minimum-Puller-Version'] = '7.0.0'
        error = urllib.error.HTTPError('https://example.test', 426, 'Upgrade', headers, io.BytesIO(b'private-token'))
        with patch.object(puller.urllib.request, 'build_opener') as build:
            build.return_value.open.side_effect = error
            with self.assertRaises(puller.PullerError) as caught:
                puller.api('https://example.test', 'private-token')
            request = build.return_value.open.call_args.args[0]
            self.assertEqual(request.get_header('X-tinstar-puller-version'), puller.VERSION)
        self.assertEqual(caught.exception.code, 'puller-upgrade-required')
        self.assertEqual(caught.exception.minimum_version, '7.0.0')
        self.assertNotIn('private-token', str(caught.exception))

    def test_redirect_cannot_forward_the_bearer(self):
        self.assertIsNone(puller.NoRedirect().redirect_request(None, None, 302, 'Found', {}, 'https://another.example.test'))


if __name__ == '__main__':
    unittest.main()
