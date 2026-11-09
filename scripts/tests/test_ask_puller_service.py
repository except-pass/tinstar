"""Deterministic service/lifecycle behavior without launchd or a real vault/home."""
import argparse
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import plistlib
import shutil
import shlex
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location('service', Path(__file__).parents[1] / 'ask-puller-service.py')
service = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(service)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / 'First Mate & home'
        (self.home / 'bin').mkdir(parents=True)
        self.settings = {'enabled': True, 'home': str(self.home), 'url': 'https://isolated.example.test',
                         'token_key': 'isolated.ask', 'clavis': '/isolated/clavis', 'path': '/usr/bin:/bin'}
        self.agent = self.root / 'LaunchAgents' / (service.LABEL + '.plist')
        self.options = argparse.Namespace(url=None, home=None, token_key=None)
        service.write_json(self.root / 'ask-puller.json', self.settings)
        # Existing poll/lifecycle cases isolate reconciliation from downloads;
        # UpdateTests exercises the updater and cache separately below.
        updater = patch.object(service, 'update_adapter', return_value=service.puller)
        updater.start()
        self.addCleanup(updater.stop)

    def health(self):
        return service.read_json(self.root / 'ask-puller-health.json')

    def test_empty_and_unchanged_slow_reply_only_read_receipts(self):
        # Any side effect other than clavis/receipts is a failure, including a
        # model executable, note capture or wake. No shell is used by the pass.
        receipts = {'schema': 'fm-inbox-receipts.v1', 'pending': [], 'handled': [], 'omitted': []}
        calls = []
        def command(argv, **kwargs):
            calls.append(argv)
            if argv == ['/isolated/clavis', 'get', 'isolated.ask']:
                return subprocess.CompletedProcess(argv, 0, 'private-token', '')
            self.assertEqual(argv, [str(self.home / 'bin' / 'fm-inbox.sh'), 'receipts', '--all-pending', '--all-handled', '--all-replies'])
            return subprocess.CompletedProcess(argv, 0, json.dumps(receipts), '')
        for tracked in ([], [{'request_id': 'slow', 'note_id': 'note-slow'}]):
            service.write_json(self.root / 'ask-puller-health.json', {})
            with patch.object(service.puller, 'api', return_value={'pending': [], 'tracked': tracked}) as api, patch.object(service.subprocess, 'run', side_effect=command):
                for i in range(11):
                    self.assertEqual(service.tick(self.root, now=i * 60), 'noop')
                self.assertEqual(api.call_count, 11)
            self.assertEqual(self.health()['noop_polls'], 11)
            self.assertEqual(self.health()['work_polls'], 0)
            self.assertEqual(self.health()['queued'], len(tracked))
        self.assertEqual(len(calls), 33)  # 22 credential reads + 11 receipt reads

    def test_bounded_backoff_survives_restart_and_recovers(self):
        for code in ('network', 'credential-expired', 'credential-store', 'timeout'):
            service.write_json(self.root / 'ask-puller-health.json', {})
            with patch.object(service.puller, 'read_token', return_value='private-token'), patch.object(service.puller, 'pull_once', side_effect=service.puller.PullerError('private-token', code)) as poll:
                now = 1000
                for delay in (60, 120, 240, 480, 900, 900):
                    self.assertEqual(service.tick(self.root, now=now), 'error')
                    self.assertEqual(self.health()['last_error_class'], code)
                    self.assertEqual(self.health()['next_poll_at'], now + delay)
                    self.assertEqual(service.tick(self.root, now=now + delay - 1), 'backoff')
                    now += delay
                self.assertEqual(poll.call_count, 6)
            # A fresh module/process reads back the same persisted health.
            with patch.object(service.puller, 'read_token', return_value='private-token'), patch.object(service.puller, 'pull_once', return_value={'captured': 0, 'replied': 0, 'queued': 1}):
                self.assertEqual(service.tick(self.root, now=now), 'noop')
            self.assertEqual(self.health()['consecutive_failures'], 0)
            self.assertIsNone(self.health()['last_error_class'])
            self.assertNotIn('private-token', (self.root / 'ask-puller-health.json').read_text())

    def test_successful_ticks_tolerate_launchd_timer_jitter(self):
        with patch.object(service.puller, 'read_token', return_value='token'), patch.object(service.puller, 'pull_once', return_value={'captured': 0, 'replied': 0, 'queued': 0}) as poll:
            self.assertEqual(service.tick(self.root, now=100), 'noop')
            self.assertEqual(service.tick(self.root, now=159.99), 'noop')
            self.assertEqual(poll.call_count, 2)
        self.assertEqual(self.health()['noop_polls'], 2)

    def test_overlap_process_death_and_restart_release_kernel_lock(self):
        driver = """import importlib.util,pathlib,sys,time
s=importlib.util.spec_from_file_location('p',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with m.single_flight(pathlib.Path(sys.argv[2])) as acquired:
 print(acquired,flush=True)
 time.sleep(30)
"""
        child = subprocess.Popen([sys.executable, '-c', driver, service.puller.__file__, str(self.home)], stdout=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'True')
            with patch.object(service.puller, 'read_token') as token:
                self.assertEqual(service.tick(self.root, now=100), 'overlap')
                token.assert_not_called()
            self.assertEqual(self.health(), {})
        finally:
            child.kill()
            child.wait(timeout=5)
            child.stdout.close()
        with service.puller.single_flight(self.home) as acquired:
            self.assertTrue(acquired)
        with patch.object(service.puller, 'read_token', return_value='token'), patch.object(service.puller, 'pull_once', return_value={'captured': 1, 'replied': 0, 'queued': 1}):
            self.assertEqual(service.tick(self.root, now=100), 'work')
        self.assertEqual(self.health()['work_polls'], 1)

    def test_deadline_stops_slow_work_and_records_safe_error(self):
        import time
        with patch.object(service, 'PASS_TIMEOUT', .02), patch.object(service.puller, 'read_token', side_effect=lambda *args: time.sleep(1)):
            self.assertEqual(service.tick(self.root, now=0), 'error')
        self.assertEqual(self.health()['last_error_class'], 'timeout')
        self.assertFalse(self.health()['in_progress'])

    def test_deadline_during_later_capture_preserves_same_id_retry(self):
        self.check_delivery_deadline('capture')

    def test_deadline_during_mapped_reply_stops_later_posts(self):
        self.check_delivery_deadline('reply')

    def check_delivery_deadline(self, phase):
        import time
        started = time.monotonic()
        subprocess.run([sys.executable, '-c', 'pass'], check=True)
        spawn = max(time.monotonic() - started, 0.05)
        # Token, note and receipt processes run before the slow step. A full
        # suite stretches those starts. Size the pass deadline from a live
        # spawn and hold the slow step past it, but stay inside the inbox
        # command's own 30s timeout so this deadline is what stops the step.
        budget = min(20, max(2, spawn * 12))
        hold = budget + 2
        requests = [{'request_id': str(i), 'inbox_request_id': 'tinstar-ask-' + str(i),
                     'body': 'fixture question'} for i in range(3)]
        posts = []
        acknowledged = set()
        received_slow_reply = threading.Event()
        release_reply = threading.Event()
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def respond(self, data):
                self.send_response(200)
                self.end_headers()
                try:
                    self.wfile.write(json.dumps({'ok': True, 'data': data}).encode())
                except (BrokenPipeError, ConnectionResetError):
                    pass

            def do_GET(self):
                self.respond({'pending': [r for r in requests if r['request_id'] not in acknowledged]
                              if phase == 'capture' else [],
                              'tracked': [{'request_id': r['request_id'], 'note_id': 'note-' + r['request_id']}
                                          for r in requests if phase == 'reply' or r['request_id'] in acknowledged]})

            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                posts.append(payload)
                if 'note' in payload:
                    acknowledged.add(payload['request_id'])
                if phase == 'reply' and payload['request_id'] == '1':
                    received_slow_reply.set()
                    release_reply.wait(hold)
                self.respond({})

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(thread.join)
        self.addCleanup(server.shutdown)
        self.addCleanup(release_reply.set)
        self.settings['url'] = 'http://127.0.0.1:' + str(server.server_port)
        credential = self.root / 'clavis'
        credential.write_text('#!' + sys.executable + '\nprint("fixture-private-token")\n')
        credential.chmod(0o700)
        self.settings['clavis'] = str(credential)
        service.write_json(self.root / 'ask-puller.json', self.settings)
        script = self.home / 'bin' / 'fm-inbox.sh'
        script.write_text('#!' + sys.executable + '\n' + """import json, os, pathlib, sys, time
home = pathlib.Path(os.environ['FM_HOME'])
if sys.argv[1] == 'note':
    request_id = sys.argv[3]
    with (home / 'calls.jsonl').open('a') as stream:
        stream.write(json.dumps(request_id) + '\\n')
    note_path = home / (request_id + '.json')
    first = not note_path.exists()
    note = {'saved': True, 'id': 'note-' + request_id.removeprefix('tinstar-ask-'), 'request_id': request_id}
    note_path.write_text(json.dumps(note))
    if first and request_id == 'tinstar-ask-1':
        time.sleep(HOLD_SECONDS)
    print(json.dumps(note))
else:
    print((home / 'receipts.json').read_text())
""")
        script.write_text(script.read_text().replace('HOLD_SECONDS', repr(hold)))
        script.chmod(0o700)
        receipts = {'schema': 'fm-inbox-receipts.v1', 'pending': [], 'handled': [], 'omitted': []}
        if phase == 'reply':
            receipts['pending'] = [{'id': 'note-' + r['request_id'], 'request_id': r['inbox_request_id'],
                                    'reply': {'body': 'fixture answer'}} for r in requests]
        (self.home / 'receipts.json').write_text(json.dumps(receipts))
        with patch.object(service, 'PASS_TIMEOUT', budget):
            self.assertEqual(service.tick(self.root, now=100), 'error')
        health = self.health()
        self.assertEqual(health['last_error_class'], 'timeout')
        self.assertEqual(health['error_polls'], 1)
        self.assertEqual(health['consecutive_failures'], 1)
        self.assertEqual(health['next_poll_at'], 160)
        self.assertFalse(health['in_progress'])
        self.assertNotIn('last_success_at', health)
        self.assertEqual(health['work_polls'], 0)
        self.assertEqual(health['noop_polls'], 0)
        self.assertNotIn('fixture-private-token', json.dumps(health))
        before = list(posts)
        self.assertEqual(service.tick(self.root, now=159), 'backoff')
        self.assertEqual(posts, before)
        if phase == 'capture':
            self.assertEqual([p['request_id'] for p in posts], ['0'])
            self.assertTrue(all('error' not in p for p in posts))
            calls = self.home / 'calls.jsonl'
            self.assertEqual([json.loads(line) for line in calls.read_text().splitlines()],
                             ['tinstar-ask-0', 'tinstar-ask-1'])
            saved = (self.home / 'tinstar-ask-1.json').read_bytes()
            self.assertEqual(service.tick(self.root, now=160), 'work')
            self.assertEqual((self.home / 'tinstar-ask-1.json').read_bytes(), saved)
            self.assertEqual([json.loads(line) for line in calls.read_text().splitlines()],
                             ['tinstar-ask-0', 'tinstar-ask-1', 'tinstar-ask-1', 'tinstar-ask-2'])
            self.assertEqual([p['request_id'] for p in posts], ['0', '1', '2'])
            self.assertEqual(self.health()['last_success_at'], 160)
            self.assertEqual(self.health()['consecutive_failures'], 0)
        else:
            self.assertTrue(received_slow_reply.is_set())
            self.assertEqual([p['request_id'] for p in posts], ['0', '1'])
            self.assertTrue(all('reply' in p for p in posts))
            self.assertFalse((self.home / 'calls.jsonl').exists())
        release_reply.set()

    def test_lifecycle_install_upgrade_disable_enable_restart_uninstall(self):
        (self.home / 'bin' / 'fm-inbox.sh').touch()
        clavis = self.root / 'clavis'
        clavis.touch()
        calls = []
        loaded = False
        def launchctl(args, check=True):
            nonlocal loaded
            calls.append(args)
            if args[0] == 'print':
                return subprocess.CompletedProcess(args, 0 if loaded else 113)
            if args[0] == 'bootstrap':
                loaded = True
            if args[0] == 'bootout':
                loaded = False
            return subprocess.CompletedProcess(args, 0)
        installed = self.root / 'installed-package'
        template = installed / 'services' / 'ask-puller'
        template.mkdir(parents=True)
        shutil.copyfile(service.PACKAGE / 'services' / 'ask-puller' / 'agent.plist', template / 'agent.plist')
        with patch.object(service, 'PACKAGE', installed), patch.object(service.sys, 'platform', 'darwin'), patch.object(service, 'plist_path', return_value=self.agent), patch.object(service.shutil, 'which', return_value=str(clavis)), patch.object(service, 'launchctl', side_effect=launchctl), contextlib.redirect_stdout(io.StringIO()):
            service.manage('install', self.root, self.options)
            config = service.read_json(self.root / 'ask-puller.json')
            self.assertTrue(config['enabled'])
            agent = plistlib.loads(self.agent.read_bytes())
            self.assertEqual(agent['StartInterval'], 60)
            self.assertTrue(agent['RunAtLoad'])
            self.assertNotIn('KeepAlive', agent)
            self.assertEqual(agent['ProgramArguments'], [sys.executable, str(service.PACKAGE / 'scripts' / 'ask-puller-service.py'), 'tick', '--config-root', str(self.root)])
            self.assertEqual(agent['EnvironmentVariables']['FM_HOME'], str(self.home))
            self.assertEqual(self.agent.stat().st_mode & 0o777, 0o600)
            bootstrap_count = calls.count(['bootstrap', service.domain(), str(self.agent)])
            service.manage('upgrade', self.root, self.options)
            self.assertEqual(calls.count(['bootstrap', service.domain(), str(self.agent)]), bootstrap_count)
            # npm replaces the package: regenerate the installed executable path.
            with patch.object(service, 'PACKAGE', service.PACKAGE / 'new-install'), patch.object(service, 'render_plist', wraps=lambda root, settings: plistlib.dumps({**agent, 'ProgramArguments': ['/new/package/puller']})):
                service.manage('upgrade', self.root, self.options)
            self.assertEqual(plistlib.loads(self.agent.read_bytes())['ProgramArguments'], ['/new/package/puller'])
            service.manage('disable', self.root, self.options)
            self.assertFalse(loaded)
            service.manage('upgrade', self.root, self.options)
            self.assertFalse(loaded)
            self.assertEqual(service.tick(self.root), 'disabled')
            service.manage('enable', self.root, self.options)
            self.assertTrue(loaded)
            service.manage('restart', self.root, self.options)
            self.assertTrue(loaded)
            service.manage('uninstall', self.root, self.options)
            self.assertFalse(loaded)
            self.assertFalse(self.agent.exists())
            self.assertFalse((self.root / 'ask-puller.json').exists())
            service.manage('upgrade', self.root, self.options)
            self.assertFalse(loaded)

    def test_source_checkout_upgrade_cannot_replace_an_installed_agent(self):
        checkout = self.root / 'disposable-checkout'
        checkout.mkdir()
        (checkout / '.git').write_text('gitdir: isolated-worktree')
        before = (self.root / 'ask-puller.json').read_bytes()
        with patch.object(service, 'PACKAGE', checkout), patch.object(service.sys, 'platform', 'darwin'), patch.object(service, 'launchctl') as launchctl, contextlib.redirect_stdout(io.StringIO()) as output:
            service.manage('upgrade', self.root, self.options)
            self.assertIn('keeping the installed LaunchAgent', output.getvalue())
            for command in ('install', 'enable', 'restart'):
                with self.assertRaises(service.puller.PullerError) as error:
                    service.manage(command, self.root, self.options)
                self.assertEqual(error.exception.code, 'source-checkout')
            launchctl.assert_not_called()
        self.assertEqual((self.root / 'ask-puller.json').read_bytes(), before)

    def test_non_mac_cli_refuses_install_and_npm_hook_is_inert(self):
        if sys.platform == 'darwin':
            self.skipTest('Linux-specific proof')
        package = service.PACKAGE
        result = subprocess.run(['node', str(package / 'bin' / 'tinstar.js'), 'ask-puller', 'install'], text=True, capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn('require macOS', result.stderr)
        result = subprocess.run([shutil.which('node'), str(package / 'bin' / 'ask-puller-postinstall.js')], env={**os.environ, 'PATH': '/nonexistent'}, text=True, capture_output=True)
        # node is already located by the caller; test with an absolute node path.
        self.assertEqual(result.returncode, 0)


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.home = self.root / 'First Mate home'
        self.active = self.home / 'state' / 'tinstar-ask-reply-receipts'
        self.active.mkdir(parents=True)
        self.settings = {'home': str(self.home), 'url': 'https://current.example.test', 'enabled': False}
        service.write_json(self.root / 'ask-puller.json', self.settings)
        self.origin = 'https://obsolete.example.test'
        for name, origin in [('legacy-1', self.origin), ('legacy-2', self.origin), ('current', self.settings['url'])]:
            service.write_json(self.active / (name + '.json'), {
                'origin': origin, 'payload': {'request_id': name, 'reply': {'id': name, 'cursor': '1', 'body': 'private-body'}},
                'response': {'reply_warnings': [{'reason': 'private-warning'}]},
            })
        (self.active / 'corrupt.json').write_text('{bad JSON')

    def command(self, action, origin=None, reason='Owner retired old bridge'):
        options = argparse.Namespace(journal_action=action, origin=origin or self.origin, reason=reason)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            service.manage('journal', self.root, options)
        return json.loads(output.getvalue())

    def audit(self):
        path = self.home / 'state' / 'tinstar-ask-reply-journal-audit.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()]

    def test_status_command_executes_retire_and_resume_through_installed_cli(self):
        # Invoke the public CLI, with a private PATH resolving its printed
        # recovery command to this checkout and an isolated config/home.
        bin_path = self.root / 'bin'
        bin_path.mkdir()
        (bin_path / 'tinstar').symlink_to(service.PACKAGE / 'bin' / 'tinstar.js')
        env = {**os.environ, 'TINSTAR_CONFIG_HOME': str(self.root), 'PATH': str(bin_path) + os.pathsep + os.environ['PATH']}
        def status():
            result = subprocess.run(['node', str(service.PACKAGE / 'bin/tinstar.js'), 'ask-puller', 'status'], env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertNotIn('private-body', result.stdout)
            return json.loads(result.stdout)['journal']
        def execute(command):
            args = shlex.split(command)
            args[args.index('--reason') + 1] = 'Operator approved transition'
            result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)
        before = {path.name: path.read_bytes() for path in self.active.glob('*.json')}
        observed = status()
        self.assertEqual(observed['stuck_count'], 3)  # old origin plus corrupt
        row = next(row for row in observed['pending'] if row['origin'] == self.origin)
        self.assertEqual(execute(row['command'])['count'], 2)
        self.assertTrue((self.active / 'current.json').exists())
        self.assertEqual(status()['stuck_count'], 1)
        self.assertEqual(execute(row['command'])['count'], 0)  # idempotent
        archived = status()['retired'][0]
        self.assertEqual(execute(archived['command'])['count'], 2)
        self.assertEqual({path.name: path.read_bytes() for path in self.active.glob('*.json')}, before)
        final = self.audit()[-1]
        self.assertEqual(final['action'], 'resume')
        self.assertEqual(final['count'], 2)
        self.assertEqual(final['origin'], self.origin)
        self.assertEqual(final['reason'], 'Operator approved transition')
        self.assertTrue(final['user'])
        self.assertEqual(final['uid'], os.getuid())
        self.assertIsInstance(final['at'], float)
        audit_path = Path(status()['audit_log'])
        self.assertEqual(audit_path.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('private-body', audit_path.read_text())
        self.assertNotIn('private-warning', audit_path.read_text())

    def test_retire_suppresses_recreation_and_resume_keeps_legacy_inbox_id(self):
        for path in self.active.glob('*.json'):
            path.unlink()
        reply = {'id': 'note-1', 'cursor': '1', 'at': 'old timestamp', 'body': 'Answer'}
        payload = {'request_id': 'request-1', 'reply': reply}
        old_key = service.hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
        path = self.active / (old_key + '.json')
        service.write_json(path, {'origin': self.origin, 'payload': payload,
                                 'response': {'reply_warnings': [{'reason': 'rejected'}]}})
        expected = 'tinstar-ask-receipt-' + old_key
        notes = {expected}
        attempts, posts = [], []
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
            attempts.append(args[2])
            notes.add(args[2])
            return {'saved': True, 'request_id': args[2]}, 0
        self.assertEqual(self.command('retire')['count'], 1)
        with patch.object(service.puller, 'api', side_effect=api), patch.object(service.puller, 'inbox', side_effect=inbox):
            service.puller.pull_once(self.origin, 'fixture', self.home)
            self.assertEqual(attempts, [])
            self.assertEqual(posts, [])
            self.assertFalse(path.exists())
            self.assertEqual(self.command('resume')['count'], 1)
            service.puller.pull_once(self.origin, 'fixture', self.home)
        self.assertEqual(attempts, [expected])
        self.assertEqual(notes, {expected})
        self.assertEqual(posts, [])
        self.assertFalse(path.exists())

    def test_reason_is_checked_before_lock_and_audit_failure_moves_nothing(self):
        with patch.object(service.puller, 'single_flight') as lock:
            with self.assertRaises(service.puller.PullerError):
                self.command('retire', reason=' ')
            lock.assert_not_called()
        with patch.object(service, 'journal_audit', side_effect=OSError('audit unavailable')):
            with self.assertRaises(OSError):
                self.command('retire')
        self.assertEqual(len(list(self.active.glob('*.json'))), 4)

    def test_busy_poll_warns_and_same_command_can_be_retried(self):
        with service.puller.single_flight(self.home) as acquired:
            self.assertTrue(acquired)
            result = self.command('retire')
        self.assertEqual(result['outcome'], 'busy')
        self.assertEqual(self.audit()[-1]['outcome'], 'busy')
        self.assertEqual(self.command('retire')['count'], 2)

    def test_partial_retirement_retries_and_corrupt_journals_have_a_close_path(self):
        replace = Path.replace
        moved = []
        def move(source, target):
            if source.name == 'legacy-2.json' and not moved:
                moved.append('injected failure')
                raise OSError('fixture')
            return replace(source, target)
        with patch.object(Path, 'replace', move):
            first = self.command('retire')
        self.assertEqual(first['outcome'], 'partial')
        self.assertEqual(first['count'], 1)
        self.assertEqual(self.audit()[-1]['count'], 1)
        self.assertEqual(self.command('retire')['count'], 1)
        self.assertEqual(self.command('retire', origin='unknown')['count'], 1)
        self.assertFalse((self.active / 'corrupt.json').exists())
        self.assertEqual(self.command('resume', origin='unknown')['count'], 1)
        self.assertEqual((self.active / 'corrupt.json').read_text(), '{bad JSON')

    def test_resume_never_overwrites_an_active_journal(self):
        self.command('retire')
        original = b'{"origin":"https://current.example.test","progress":"new"}'
        (self.active / 'legacy-1.json').write_bytes(original)
        result = self.command('resume')
        self.assertEqual(result['count'], 1)
        self.assertEqual(result['skipped'], 1)
        self.assertEqual((self.active / 'legacy-1.json').read_bytes(), original)
        self.assertEqual(service.journal_status(self.root, self.settings)['retired_count'], 1)


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.settings = {'url': 'https://isolated.example.test'}
        self.health = {}
        self.source = "VERSION = '6.0.2'\nclass PullerError(Exception): pass\ndef pull_once(*args): return {'captured': 2, 'replied': 0, 'queued': 0}\n"
        self.release = {'version': '6.0.2', 'bootstrap_api': 1, 'source': self.source,
                        'sha256': service.hashlib.sha256(self.source.encode()).hexdigest()}

    def update(self):
        return service.update_adapter(self.root, self.settings, 'private-token', self.health)

    def test_verified_update_atomic_cache_and_offline_fallback(self):
        with patch.object(service.puller, 'api', return_value=self.release) as download:
            adapter = self.update()
            self.assertEqual(adapter.VERSION, '6.0.2')
            self.assertEqual(adapter.pull_once()['captured'], 2)
            download.assert_called_once_with(self.settings['url'], 'private-token', path='/api/ask/bridge/puller', timeout=5)
        cache = self.root / 'ask-puller-release.json'
        self.assertEqual(cache.stat().st_mode & 0o777, 0o600)
        self.assertEqual(self.health['puller_version'], '6.0.2')
        before = cache.read_bytes()
        with patch.object(service.puller, 'api', side_effect=service.puller.PullerError('private-token')):
            self.assertEqual(self.update().VERSION, '6.0.2')
        self.assertEqual(cache.read_bytes(), before)
        self.assertEqual(self.health['last_update_error_class'], 'update-failed')
        self.assertNotIn('private-token', json.dumps(self.health))

    def test_digest_schema_syntax_and_download_failure_keep_current(self):
        marker = self.root / 'unverified-code-ran'
        unverified = "from pathlib import Path\nPath(" + repr(str(marker)) + ").touch()"
        for release in ({**self.release, 'source': unverified},
                        {**self.release, 'bootstrap_api': 2},
                        {**self.release, 'source': 'invalid python !', 'sha256': service.hashlib.sha256(b'invalid python !').hexdigest()},
                        {**self.release, 'version': '9.9.9'},
                        {**self.release, 'source': 'raise RuntimeError()', 'sha256': service.hashlib.sha256(b'raise RuntimeError()').hexdigest()}):
            with self.subTest(release=release), patch.object(service.puller, 'api', return_value=release):
                self.assertIs(self.update(), service.puller)
                self.assertFalse((self.root / 'ask-puller-release.json').exists())
        self.assertFalse(marker.exists())
        with patch.object(service.puller, 'api', side_effect=TimeoutError('private-token')):
            self.assertIs(self.update(), service.puller)

    def test_failed_swap_retains_previous_cached_release(self):
        with patch.object(service.puller, 'api', return_value=self.release):
            self.update()
        before = (self.root / 'ask-puller-release.json').read_bytes()
        newer = self.source.replace('6.0.2', '6.0.3')
        release = {**self.release, 'version': '6.0.3', 'source': newer, 'sha256': service.hashlib.sha256(newer.encode()).hexdigest()}
        with patch.object(service.puller, 'api', return_value=release), patch.object(service, 'write_json', side_effect=OSError()):
            self.assertEqual(self.update().VERSION, '6.0.2')
        self.assertEqual((self.root / 'ask-puller-release.json').read_bytes(), before)

    def test_corrupt_cache_recovers_and_http_cannot_download_code(self):
        cache = self.root / 'ask-puller-release.json'
        service.write_json(cache, {**self.release, 'source': 'corrupt', 'origin': self.settings['url']})
        with patch.object(service.puller, 'api', return_value=self.release):
            self.assertEqual(self.update().VERSION, '6.0.2')
        self.settings['url'] = 'http://example.test'
        with patch.object(service.puller, 'api') as download:
            self.assertIs(self.update(), service.puller)
            download.assert_not_called()

    def test_upgrade_required_in_status_survives_failed_update(self):
        home = self.root / 'home'
        settings = {**self.settings, 'home': str(home), 'enabled': True, 'token_key': 'isolated.ask', 'clavis': '/isolated/clavis'}
        service.write_json(self.root / 'ask-puller.json', settings)
        error = service.puller.PullerError('Upgrade', 'puller-upgrade-required', '7.0.0')
        with patch.object(service.puller, 'api', side_effect=error), patch.object(service.puller, 'read_token', return_value='private-token'):
            self.assertEqual(service.tick(self.root, now=100), 'error')
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            service.manage('status', self.root, argparse.Namespace())
        status = json.loads(output.getvalue())
        self.assertEqual(status['health']['last_error_class'], 'puller-upgrade-required')
        self.assertEqual(status['health']['minimum_puller_version'], '7.0.0')
        self.assertIn('minimum puller 7.0.0', status['next_action'])
        self.assertNotIn('private-token', output.getvalue())


if __name__ == '__main__':
    unittest.main()
