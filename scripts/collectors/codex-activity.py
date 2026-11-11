#!/usr/bin/env python3
"""Read First Mate snapshots and Codex turn metadata; never operate workers."""
import argparse
from datetime import datetime, timezone
import fcntl
import json
import os
import re
from pathlib import Path
import subprocess
import sys
import tempfile


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace('+00:00', 'Z')


def session_candidates(root, now):
    files = []
    cutoff = now.timestamp() - 7 * 86400
    for path in root.glob('*/*/*/rollout-*.jsonl'):
        try:
            modified = path.stat().st_mtime
            if modified >= cutoff:
                files.append((path, modified))
        except OSError:
            continue
    files.sort(key=lambda item: item[1], reverse=True)
    return files


def matching_session(files, folder):
    for path, modified in files:
        try:
            with path.open() as stream:
                header = json.loads(stream.readline())
            cwd = header.get('payload', {}).get('cwd') if header.get('type') == 'session_meta' else None
            if cwd == folder:
                return path, modified
        except (OSError, ValueError, AttributeError):
            continue
    return None


def session_turn(path):
    turn = None
    with path.open() as stream:
        # Header already inspected during matching. JSON parsing decodes records,
        # but classification inspects only envelope and event payload types.
        next(stream, None)
        for line in stream:
            try:
                event = json.loads(line)
                if event.get('type') != 'event_msg':
                    continue
                kind = event.get('payload', {}).get('type')
                if kind == 'task_started':
                    turn = True
                elif kind == 'task_complete':
                    turn = False
            except (ValueError, AttributeError):
                # Codex may be appending its final line as we read.
                continue
    return turn


def augment(snapshot, candidates, now):
    observed = iso(now.timestamp())
    cache = {}
    for task in snapshot['tasks']:
        if task.get('harness') != 'codex':
            continue
        folder = task.get('paths', {}).get('worktree', {}).get('path')
        task['codex'] = None
        task['codex_reason'] = None
        if not folder:
            task['codex_reason'] = 'worker_folder_missing'
            continue
        match = matching_session(candidates, folder)
        if not match:
            task['codex_reason'] = 'no_matching_session_modified_within_7_days'
            continue
        path, modified = match
        try:
            if path not in cache:
                cache[path] = session_turn(path)
            task['codex'] = {'last_activity_at': iso(modified), 'turn_open': cache[path],
                             'session_file': path.name, 'observed_at': observed}
            if cache[path] is None:
                task['codex_reason'] = 'no_turn_events'
        except OSError:
            task['codex_reason'] = 'session_unreadable'
    return snapshot


def fold_parent_asks(lines):
    """Only resolved closes a keyed ask; ordinary working/done lines do not."""
    opened = {}
    for line in lines.splitlines():
        match = re.match(r'^(blocked|needs-decision|resolved)\b(.*)$', line)
        if not match:
            continue
        state, content = match.groups()
        metadata, separator, text = content.partition(':')
        fields = dict(re.findall(r'\[(key|corr|at)=([^\]]+)\]', metadata))
        key, corr = fields.get('key'), fields.get('corr')
        if state == 'resolved':
            for identity, ask in list(opened.items()):
                if key and identity == key or corr and ask['corr'] == corr:
                    del opened[identity]
        elif key:
            stamp = fields.get('at', '')
            # Keep ageless/malformed asks so later resolutions can close them.
            # Only unresolved unknown ages make the final coverage unknown.
            opened[key] = {'key': key, 'corr': corr, 'state': state,
                           'at': int(stamp) if separator and stamp.isdigit() else None,
                           'text': text.lstrip() if separator else content.strip()}
    known = all(ask['at'] is not None for ask in opened.values())
    return {'status': 'known' if known else 'unknown', 'items': list(opened.values())}


def parent_asks(home, now):
    try:
        channel = (Path(home) / 'state/parent-replies.status').read_text()
        result = fold_parent_asks(channel)
        # An in-progress append cannot prove that an earlier ask is closed.
        if channel and not channel.endswith('\n'):
            result = fold_parent_asks(channel.rsplit('\n', 1)[0] if '\n' in channel else '')
            result['status'] = 'unknown'
    except (OSError, UnicodeError):
        result = {'status': 'unknown', 'items': []}
    return {**result, 'observed_at': iso(now.timestamp())}


def atomic_write(output, snapshot):
    """A failed write leaves the last successful publication intact."""
    output = Path(output)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=output.parent,
                                         prefix='.' + output.name + '.', delete=False) as stream:
            temporary = stream.name
            json.dump(snapshot, stream, separators=(',', ':'))
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, output)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def collect(home, candidates, now):
    result = subprocess.run([str(Path(home) / 'bin/fm-fleet-snapshot.sh'), '--json'],
                            env={**os.environ, 'FM_HOME': home}, check=True,
                            capture_output=True, text=True, timeout=45)
    snapshot = json.loads(result.stdout)
    if snapshot.get('schema') != 'fm-fleet-snapshot.v1' or snapshot.get('fm_home') != home or not isinstance(snapshot.get('tasks'), list):
        raise ValueError('unexpected snapshot schema or home')
    snapshot['parent_asks'] = parent_asks(home, now)
    return augment(snapshot, candidates, now)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', help='machine-private JSON: sessions_root and homes [{home, output}]')
    parser.add_argument('--home', help='one First Mate home; prints JSON unless --output is supplied')
    parser.add_argument('--output', help='atomically replace this snapshot file')
    parser.add_argument('--sessions-root', help='defaults to $CODEX_HOME/sessions or ~/.codex/sessions')
    parser.add_argument('--state-dir', default=str(Path.home() / '.local/state/tinstar'))
    args = parser.parse_args()
    if bool(args.config) == bool(args.home) or (args.config and args.output):
        parser.error('use --config, or --home [--output]')
    state = Path(args.state_dir).expanduser()
    state.mkdir(parents=True, exist_ok=True)
    with (state / 'codex-activity.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0
        return run(args)


def run(args):
    config = json.loads(Path(args.config).read_text()) if args.config else {'homes': [{'home': args.home, 'output': args.output}]}
    root = args.sessions_root or config.get('sessions_root') or str(Path(os.environ.get('CODEX_HOME', '~/.codex')).expanduser() / 'sessions')
    now = datetime.now(timezone.utc)
    candidates = session_candidates(Path(root).expanduser(), now)
    failed = False
    for entry in config['homes']:
        try:
            snapshot = collect(entry['home'], candidates, now)
            if entry.get('output'):
                atomic_write(entry['output'], snapshot)
            else:
                print(json.dumps(snapshot, separators=(',', ':')))
        except (OSError, ValueError, subprocess.SubprocessError):
            # Do not echo subprocess output, logs or private configuration.
            print('Codex activity collection failed for home ' + entry['home'] + '; previous snapshot retained', file=sys.stderr)
            failed = True
    return int(failed)


if __name__ == '__main__':
    sys.exit(main())
