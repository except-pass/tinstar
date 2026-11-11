import fcntl
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / 'codex-activity.py'
spec = importlib.util.spec_from_file_location('collector', SCRIPT)
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
NOW = datetime(2026, 11, 9, 22, tzinfo=timezone.utc)


class CollectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sessions = self.root / 'sessions'

    def log(self, name, cwd='/worker', events=(), days=0, age=0, tail=''):
        path = self.sessions / (NOW - timedelta(days=days)).strftime('%Y/%m/%d') / ('rollout-' + name + '.jsonl')
        path.parent.mkdir(parents=True, exist_ok=True)
        rows = [{'type': 'session_meta', 'payload': {'cwd': cwd}}]
        rows += [{'type': 'event_msg', 'payload': {'type': event, 'message': 'PRIVATE'}} for event in events]
        rows += [{'type': 'response_item', 'payload': {'message': 'PRIVATE OUTPUT'}}]
        path.write_text(''.join(json.dumps(row) + '\n' for row in rows) + tail)
        os.utime(path, (NOW.timestamp() - age, NOW.timestamp() - age))
        return path

    def snapshot(self):
        return {'schema': 'fm-fleet-snapshot.v1', 'fm_home': '/fm', 'tasks': [
            {'id': 'worker', 'harness': 'codex', 'paths': {'worktree': {'path': '/worker'}}},
            {'id': 'other', 'harness': 'claude'},
        ]}

    def read(self):
        return collector.augment(self.snapshot(), collector.session_candidates(self.sessions, NOW), NOW)

    def test_parent_asks_fold_by_key_or_corr_only_resolved_closes(self):
        log = ('needs-decision [corr=1234567890abcdef] [key=api] [at=100]: choose API\n'
               'blocked [key=other] [at=200]: access\n'
               'working [key=api] [at=300]: resumed\n'
               'done [key=api] [at=400]: done elsewhere\n'
               'resolved [corr=1234567890abcdef] [at=500]: answered\n')
        self.assertEqual([row['key'] for row in collector.fold_parent_asks(log)['items']], ['other'])
        result = collector.fold_parent_asks(log + 'resolved [key=other] [at=600]: closed\n'
                                            'blocked [key=api] [at=700]: new request\n')
        self.assertEqual(result['status'], 'known')
        self.assertEqual(result['items'][0]['at'], 700)
        self.assertEqual(result['items'][0]['text'], 'new request')

    def test_parent_asks_missing_malformed_and_partial_append_stay_unknown(self):
        self.assertEqual(collector.parent_asks(str(self.root), NOW)['status'], 'unknown')
        state = self.root / 'state'
        state.mkdir()
        path = state / 'parent-replies.status'
        path.write_text('blocked [key=api] [at=100]: choose\nresolved [key=api]')
        result = collector.parent_asks(str(self.root), NOW)
        self.assertEqual(result['status'], 'unknown')
        self.assertEqual(result['items'][0]['key'], 'api')
        path.write_text('blocked [key=api]: missing timestamp\n')
        self.assertEqual(collector.parent_asks(str(self.root), NOW)['status'], 'unknown')
        path.write_text('')
        self.assertEqual(collector.parent_asks(str(self.root), NOW)['status'], 'known')
        self.assertEqual(collector.parent_asks(str(self.root), NOW)['items'], [])

    def test_open_closed_and_reopened_turns(self):
        for events, expected in [(['task_started'], True), (['task_started', 'task_complete'], False),
                                 (['task_started', 'task_complete', 'task_started'], True), (['task_complete'], False)]:
            self.log('turn', events=events)
            result = self.read()
            self.assertIs(result['tasks'][0]['codex']['turn_open'], expected)
            self.assertNotIn('codex', result['tasks'][1])
            self.assertNotIn('PRIVATE', json.dumps(result))

    def test_newest_matching_cwd_by_mtime_across_all_dates(self):
        self.log('old', events=['task_started'], age=300)
        newest = self.log('new', events=['task_started', 'task_complete'], days=20, age=10)
        self.log('wrong-cwd', cwd='/worker-other', events=['task_started'])
        result = self.read()['tasks'][0]['codex']
        self.assertIs(result['turn_open'], False)
        self.assertEqual(result['session_file'], newest.name)
        self.assertEqual(result['last_activity_at'], collector.iso(NOW.timestamp() - 10))
        self.assertEqual(result['observed_at'], collector.iso(NOW.timestamp()))

    def test_missing_logs_and_cwd_mismatch_stay_unknown(self):
        self.log('different', cwd='/other', events=['task_started'])
        result = self.read()['tasks'][0]
        self.assertIsNone(result['codex'])
        self.assertEqual(result['codex_reason'], 'no_matching_session_modified_within_7_days')

    def test_mtime_cutoff_ignores_old_files_in_recent_directories(self):
        self.log('expired', events=['task_started'], age=7 * 86400 + 1)
        self.assertEqual(self.read()['tasks'][0]['codex_reason'],
                         'no_matching_session_modified_within_7_days')
        self.log('boundary', events=['task_started'], days=100, age=7 * 86400)
        self.assertIs(self.read()['tasks'][0]['codex']['turn_open'], True)

    def test_matching_stops_at_newest_folder_match(self):
        newest = self.log('newest', events=['task_started'])
        older = self.log('older', events=['task_complete'], age=10)
        candidates = collector.session_candidates(self.sessions, NOW)
        original = Path.open
        def open_candidate(path, *args, **kwargs):
            self.assertNotEqual(path, older)
            return original(path, *args, **kwargs)
        with patch.object(Path, 'open', open_candidate):
            self.assertEqual(collector.matching_session(candidates, '/worker')[0], newest)

    def test_no_hung_worker_timeout(self):
        self.log('quiet', events=['task_started'], days=20, age=30 * 3600)
        self.assertIs(self.read()['tasks'][0]['codex']['turn_open'], True)

    def test_truncated_tail_and_missing_events(self):
        self.log('truncated', events=['task_started'], tail='{"type":"event_msg","payload":')
        self.assertIs(self.read()['tasks'][0]['codex']['turn_open'], True)
        self.log('truncated', events=[])
        result = self.read()['tasks'][0]
        self.assertIsNone(result['codex']['turn_open'])
        self.assertEqual(result['codex_reason'], 'no_turn_events')

    def test_bad_header_and_deleted_log_are_unknown(self):
        path = self.log('invalid', events=['task_started'])
        path.write_text('{bad header\n')
        self.assertIsNone(self.read()['tasks'][0]['codex'])
        path = self.log('deleted', events=['task_started'])
        index = collector.session_candidates(self.sessions, NOW)
        path.unlink()
        result = collector.augment(self.snapshot(), index, NOW)['tasks'][0]
        self.assertEqual(result['codex_reason'], 'no_matching_session_modified_within_7_days')

    def test_atomic_publication_and_failed_replace_keep_previous_snapshot(self):
        output = self.root / 'published.json'
        output.write_text('{"previous":true}')
        with patch.object(collector.os, 'replace', side_effect=OSError('disk failed')):
            with self.assertRaises(OSError):
                collector.atomic_write(output, {'next': True})
        self.assertEqual(json.loads(output.read_text()), {'previous': True})
        self.assertEqual(list(self.root.glob('.published.json.*')), [])
        replace = collector.os.replace
        def observe_replace(source, dest):
            self.assertEqual(json.loads(output.read_text()), {'previous': True})
            self.assertEqual(json.loads(Path(source).read_text()), {'next': True})
            replace(source, dest)
        with patch.object(collector.os, 'replace', side_effect=observe_replace):
            collector.atomic_write(output, {'next': True})
        self.assertEqual(json.loads(output.read_text()), {'next': True})

    def home(self, name):
        home = self.root / name
        (home / 'bin').mkdir(parents=True)
        snapshot = self.snapshot()
        snapshot['fm_home'] = str(home)
        command = home / 'bin/fm-fleet-snapshot.sh'
        command.write_text('#!/bin/sh\n[ "$1" = --json ] || exit 9\n[ "$FM_HOME" = "' + str(home) + '" ] || exit 8\ncat <<\'JSON\'\n' + json.dumps(snapshot) + '\nJSON\n')
        command.chmod(0o755)
        return home

    def test_concurrent_run_exits_without_snapshot_work(self):
        home = self.home('fm')
        marker = self.root / 'called'
        command = home / 'bin/fm-fleet-snapshot.sh'
        command.write_text('#!/bin/sh\ntouch "' + str(marker) + '"\nexit 1\n')
        state = self.root / 'state'
        state.mkdir()
        config = self.root / 'config.json'
        config.write_text(json.dumps({'homes': [{'home': str(home)}]}))
        with (state / 'codex-activity.lock').open('a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            for arguments in [['--home', str(home)], ['--config', str(config)]]:
                result = subprocess.run([sys.executable, str(SCRIPT), '--state-dir', str(state)] + arguments,
                                        capture_output=True, text=True)
                self.assertEqual((result.returncode, result.stdout, result.stderr), (0, '', ''))
                self.assertFalse(marker.exists())
        result = subprocess.run([sys.executable, str(SCRIPT), '--state-dir', str(state), '--home', str(home)],
                                capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertTrue(marker.exists())

    def test_cli_runs_home_snapshot_and_config_isolates_failures(self):
        home = self.home('fm')
        output = self.root / 'published.json'
        command = [sys.executable, str(SCRIPT), '--state-dir', str(self.root / 'state'), '--sessions-root', str(self.sessions)]
        result = subprocess.run(command + ['--home', str(home), '--output', str(output)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(output.read_text())['fm_home'], str(home))
        config = self.root / 'config.json'
        config.write_text(json.dumps({'homes': [
            {'home': str(self.root / 'missing'), 'output': str(output)},
            {'home': str(home), 'output': str(self.root / 'second.json')},
        ]}))
        result = subprocess.run(command + ['--config', str(config)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(output.read_text())['fm_home'], str(home))
        self.assertTrue((self.root / 'second.json').exists())


if __name__ == '__main__':
    unittest.main()
