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

    def decision_snapshot(self, lines):
        path = self.root / 'worker.status'
        path.write_text(lines)
        return {'tasks': [{'id': 'worker', 'harness': 'claude',
            'current_state': {'state': 'unknown', 'source': 'pane'},
            'paths': {'status_log': {'path': str(path)}},
            'hints': {'open_decisions': [], 'pending_decision': False,
                      'blocked_event': False, 'last_event_text': 'keep me'}}]}

    def test_unknown_pane_recovers_keyed_decisions_and_blockers(self):
        snapshot = self.decision_snapshot(
            'needs-decision [at=100] [key=pilot-go]: Approve the pilot: yes or no?\n'
            'blocked [key=access] [at=200]: Access required\n'
            'needs-decision [at=300]: Unkeyed report\n')
        hints = collector.augment(snapshot, [], NOW)['tasks'][0]['hints']
        self.assertEqual(hints, {
            'open_decisions': [
                {'key': 'pilot-go', 'verb': 'needs-decision', 'summary': 'Approve the pilot: yes or no?'},
                {'key': 'access', 'verb': 'blocked', 'summary': 'Access required'}],
            'pending_decision': True, 'blocked_event': True,
            'last_event_text': 'keep me', 'open_decisions_source': 'tinstar-status-fold'})

    def test_decisions_close_only_on_resolution_with_the_same_key(self):
        history = ('needs-decision [key=pilot-go] [corr=shared] [at=100]: Choose\n'
                   'blocked [key=access] [at=200]: Access required\n'
                   'resolved [key=other] [corr=shared] [at=300]: Unrelated\n'
                   'resolved [corr=shared] [at=400]: No matching key\n'
                   'resolved [key=access] [at=500]: Access granted\n')
        snapshot = self.decision_snapshot(history)
        hints = collector.augment(snapshot, [], NOW)['tasks'][0]['hints']
        self.assertEqual(hints['open_decisions'], [
            {'key': 'pilot-go', 'verb': 'needs-decision', 'summary': 'Choose'}])
        self.assertTrue(hints['pending_decision'])
        self.assertFalse(hints['blocked_event'])
        snapshot = self.decision_snapshot(history + 'resolved [key=pilot-go] [at=600]: Approved\n')
        hints = collector.augment(snapshot, [], NOW)['tasks'][0]['hints']
        self.assertEqual(hints['open_decisions'], [])
        self.assertFalse(hints['pending_decision'])
        self.assertFalse(hints['blocked_event'])

    def test_working_and_done_do_not_close_a_keyed_decision(self):
        snapshot = self.decision_snapshot(
            'needs-decision [key=pilot-go] [at=100]: Choose\n'
            'working [key=pilot-go] [at=200]: Resumed\n'
            'done [key=pilot-go] [at=300]: Completed elsewhere\n')
        self.assertEqual(collector.augment(snapshot, [], NOW)['tasks'][0]['hints']['open_decisions'], [
            {'key': 'pilot-go', 'verb': 'needs-decision', 'summary': 'Choose'}])

    def test_authoritative_states_and_nonpane_unknown_are_untouched(self):
        for state, source in [('working', 'run-step'), ('parked', 'pane'),
                              ('blocked', 'run-step'), ('done', 'run-step'),
                              ('failed', 'run-step'), ('unknown', 'run-step')]:
            with self.subTest(state=state, source=source):
                snapshot = self.decision_snapshot('needs-decision [key=pilot-go] [at=100]: Choose\n')
                snapshot['tasks'][0]['current_state'] = {'state': state, 'source': source}
                before = json.loads(json.dumps(snapshot))
                self.assertEqual(collector.augment(snapshot, [], NOW), before)

    def test_existing_firstmate_decisions_are_untouched(self):
        snapshot = self.decision_snapshot('needs-decision [key=pilot-go] [at=100]: Choose\n')
        snapshot['tasks'][0]['hints']['open_decisions'] = [
            {'key': 'firstmate', 'verb': 'needs-decision', 'summary': 'Published by First Mate'}]
        before = json.loads(json.dumps(snapshot))
        self.assertEqual(collector.augment(snapshot, [], NOW), before)

    def test_unreadable_or_missing_status_log_is_unchanged(self):
        for path in [self.root / 'missing.status', self.root, None]:
            with self.subTest(path=path):
                snapshot = self.decision_snapshot('needs-decision [key=pilot-go] [at=100]: Choose\n')
                snapshot['tasks'][0]['paths']['status_log'] = {'path': str(path)} if path else {}
                before = json.loads(json.dumps(snapshot))
                self.assertEqual(collector.augment(snapshot, [], NOW), before)

    def test_partial_resolution_does_not_close_decision(self):
        snapshot = self.decision_snapshot(
            'needs-decision [key=pilot-go] [at=100]: Choose\nresolved [key=pilot-go]')
        self.assertEqual(collector.augment(snapshot, [], NOW)['tasks'][0]['hints']['open_decisions'], [
            {'key': 'pilot-go', 'verb': 'needs-decision', 'summary': 'Choose'}])

    def test_collect_recovers_decision_even_without_a_codex_session(self):
        snapshot = self.decision_snapshot('needs-decision [key=pilot-go] [at=100]: Choose\n')
        snapshot.update(schema='fm-fleet-snapshot.v1', fm_home=str(self.root))
        snapshot['tasks'][0]['harness'] = 'codex'
        result = subprocess.CompletedProcess([], 0, stdout=json.dumps(snapshot))
        with patch.object(collector.subprocess, 'run', return_value=result):
            task = collector.collect(str(self.root), [], NOW)['tasks'][0]
        self.assertEqual(task['hints']['open_decisions'], [
            {'key': 'pilot-go', 'verb': 'needs-decision', 'summary': 'Choose'}])
        self.assertEqual(task['codex_reason'], 'worker_folder_missing')

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

    def test_parent_asks_bare_at_after_key_is_aged(self):
        bare = collector.fold_parent_asks('needs-decision [key=k] at=1794498392: choose the API\n')
        self.assertEqual(bare, {'status': 'known', 'items': [{
            'key': 'k', 'corr': None, 'state': 'needs-decision', 'at': 1794498392,
            'text': 'choose the API'}]})
        bracket = collector.fold_parent_asks('blocked [key=k] [at=1794498392]: still waiting\n')
        self.assertEqual(bracket['status'], 'known')
        self.assertEqual(bracket['items'][0]['at'], 1794498392)

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

    def test_parent_asks_resolved_ageless_history_restores_known_coverage(self):
        history = ('blocked [corr=fa26339b40a79efc] [key=bandit-ssh]: access needed\n'
                   'resolved [key=bandit-ssh] [at=200]: access restored\n'
                   'needs-decision [corr=1234567890abcdef] [key=api] [at=bad]: choose\n'
                   'resolved [corr=1234567890abcdef] [at=300]: answered\n'
                   'blocked [key=malformed] [at=350] missing colon\n'
                   'resolved [key=malformed] [at=400]: closed\n'
                   'blocked [key=current] [at=500]: still waiting\n')
        self.assertEqual(collector.fold_parent_asks(history), {
            'status': 'known', 'items': [{'key': 'current', 'corr': None,
                'state': 'blocked', 'at': 500, 'text': 'still waiting'}]})

    def test_parent_asks_ageless_open_ask_is_retained_until_resolved(self):
        history = 'blocked [corr=fa26339b40a79efc] [key=bandit-ssh]: access needed\n'
        result = collector.fold_parent_asks(history)
        self.assertEqual(result, {'status': 'unknown', 'items': [{
            'key': 'bandit-ssh', 'corr': 'fa26339b40a79efc', 'state': 'blocked',
            'at': None, 'text': 'access needed'}]})
        self.assertEqual(collector.fold_parent_asks(history +
            'working [key=bandit-ssh] [at=200]: checking\n')['status'], 'unknown')
        self.assertEqual(collector.fold_parent_asks(history +
            'resolved [corr=fa26339b40a79efc] [at=300]: restored\n'),
            {'status': 'known', 'items': []})

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

    def test_parent_resolutions_publish_secondmate_keys_from_the_parent_home(self):
        home = self.root / 'main'
        state = home / 'state'
        state.mkdir(parents=True)
        (state / 'remote-mate.status').write_text(
            'needs-decision [key=api] [at=100]: choose\n'
            'resolved [key=api] [at=50]: first\n'
            'resolved [key=other] [at=150]: closed\n'
            'resolved [key=unstamped]: answered: no time\n'
            'resolved [key=dup] [at=1] [at=2]: ambiguous\n'
            'resolved [key=pad] [at=01]: padded\n'
            'working [key=other] [at=160]: not a close\n'
            'resolved [key=api] [at=200]: answered: use REST\n'
            'resolved [key=partial] [at=999]: still writing')
        (state / 'ship-worker.status').write_text('resolved [key=ship-key] [at=900]: answered\n')
        (state / 'by-role.status').write_text('resolved [key=role-key] [at=50]: answered\n')
        (state / 'from-registry.status').write_text(
            'resolved [key=reg] [at=10]: first\nresolved [key=reg] [at=80]: later\n')
        (state / 'quiet-mate.status').mkdir()
        (home / 'escape.status').write_text('resolved [key=escaped] [at=1]: no\n')
        snapshot = {
            'schema': 'fm-fleet-snapshot.v1', 'fm_home': str(home),
            'tasks': [
                {'id': 'remote-mate', 'kind': 'secondmate', 'harness': 'claude'},
                {'id': 'quiet-mate', 'kind': 'secondmate', 'harness': 'claude'},
                {'id': 'absent-mate', 'kind': 'secondmate', 'harness': 'claude'},
                {'id': 'ship-worker', 'kind': 'ship', 'harness': 'claude'},
                {'id': 'by-role', 'role': 'secondmate', 'harness': 'claude'},
                {'id': '../escape', 'kind': 'secondmate', 'harness': 'claude'},
            ],
            'secondmate_current': {'records': [{'id': 'from-registry'}, {'id': 'remote-mate'}]},
        }
        published = collector.parent_resolutions(str(home), snapshot, NOW)
        self.assertEqual(published['status'], 'unknown')
        self.assertEqual(published['observed_at'], collector.iso(NOW.timestamp()))
        self.assertEqual(published['mates']['remote-mate'], {'status': 'known', 'keys': [
            {'key': 'api', 'at': 200}, {'key': 'other', 'at': 150}]})
        self.assertEqual(published['mates']['by-role'], {'status': 'known', 'keys': [{'key': 'role-key', 'at': 50}]})
        self.assertEqual(published['mates']['from-registry']['keys'], [{'key': 'reg', 'at': 80}])
        self.assertEqual(published['mates']['absent-mate'], {'status': 'known', 'keys': []})
        self.assertEqual(published['mates']['quiet-mate'], {'status': 'unknown', 'keys': []})
        self.assertEqual(published['mates']['../escape'], {'status': 'unknown', 'keys': []})
        self.assertNotIn('ship-worker', published['mates'])
        self.assertNotIn('escaped', json.dumps(published))
        script = home / 'bin/fm-fleet-snapshot.sh'
        script.parent.mkdir()
        script.write_text('#!/bin/sh\ncat <<\'JSON\'\n' + json.dumps(snapshot) + '\nJSON\n')
        script.chmod(0o755)
        collected = collector.collect(str(home), [], NOW)
        self.assertEqual(collected['parent_resolutions']['mates']['remote-mate']['keys'],
                         published['mates']['remote-mate']['keys'])

    def test_parent_resolutions_omitted_when_the_home_has_no_secondmates(self):
        home = self.home('plain')
        self.assertIsNone(collector.parent_resolutions(str(home), {'tasks': []}, NOW))
        self.assertNotIn('parent_resolutions', collector.collect(str(home), [], NOW))

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
