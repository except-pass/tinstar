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
        return collector.augment(self.snapshot(), collector.session_index(self.sessions, NOW), NOW)

    def test_open_closed_and_reopened_turns(self):
        for events, expected in [(['task_started'], True), (['task_started', 'task_complete'], False),
                                 (['task_started', 'task_complete', 'task_started'], True), (['task_complete'], False)]:
            self.log('turn', events=events)
            result = self.read()
            self.assertIs(result['tasks'][0]['codex']['turn_open'], expected)
            self.assertNotIn('codex', result['tasks'][1])
            self.assertNotIn('PRIVATE', json.dumps(result))

    def test_newest_matching_cwd_by_mtime_across_both_days(self):
        self.log('old', events=['task_started'], age=300)
        newest = self.log('new', events=['task_started', 'task_complete'], days=1, age=10)
        self.log('wrong-cwd', cwd='/worker-other', events=['task_started'])
        result = self.read()['tasks'][0]['codex']
        self.assertIs(result['turn_open'], False)
        self.assertEqual(result['session_file'], newest.name)
        self.assertEqual(result['last_activity_at'], collector.iso(NOW.timestamp() - 10))
        self.assertEqual(result['observed_at'], collector.iso(NOW.timestamp()))

    def test_missing_old_logs_and_cwd_mismatch_stay_unknown(self):
        self.log('old', events=['task_started'], days=2)
        self.log('different', cwd='/other', events=['task_started'])
        result = self.read()['tasks'][0]
        self.assertIsNone(result['codex'])
        self.assertEqual(result['codex_reason'], 'no_matching_session_today_or_yesterday')

    def test_no_hung_worker_timeout(self):
        self.log('quiet', events=['task_started'], days=1, age=30 * 3600)
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
        index = collector.session_index(self.sessions, NOW)
        path.unlink()
        result = collector.augment(self.snapshot(), index, NOW)['tasks'][0]
        self.assertEqual(result['codex_reason'], 'session_unreadable')

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

    def test_cli_runs_home_snapshot_and_config_isolates_failures(self):
        home = self.home('fm')
        output = self.root / 'published.json'
        command = [sys.executable, str(SCRIPT), '--sessions-root', str(self.sessions)]
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
