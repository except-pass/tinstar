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
import subprocess
import sys
import tempfile
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
        with patch.object(service.sys, 'platform', 'darwin'), patch.object(service, 'plist_path', return_value=self.agent), patch.object(service.shutil, 'which', return_value=str(clavis)), patch.object(service, 'launchctl', side_effect=launchctl), contextlib.redirect_stdout(io.StringIO()):
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


if __name__ == '__main__':
    unittest.main()
