#!/usr/bin/env python3
"""Read First Mate snapshots and Codex turn metadata; never operate workers."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace('+00:00', 'Z')


def session_index(root, now):
    """Only today's and yesterday's UTC directories, newest modified file first."""
    files = []
    for offset in (0, 1):
        directory = root / (now - timedelta(days=offset)).strftime('%Y/%m/%d')
        for path in directory.glob('rollout-*.jsonl'):
            try:
                files.append((path.stat().st_mtime, path))
            except OSError:
                continue
    index = {}
    for modified, path in sorted(files, key=lambda item: item[0], reverse=True):
        try:
            with path.open() as stream:
                header = json.loads(stream.readline())
            cwd = header.get('payload', {}).get('cwd') if header.get('type') == 'session_meta' else None
            if isinstance(cwd, str):
                index.setdefault(cwd, (path, modified))
        except (OSError, ValueError, AttributeError):
            continue
    return index


def session_turn(path):
    turn = None
    with path.open() as stream:
        # Header already inspected by the index. Message bodies are never accessed
        # or emitted: only the envelope type and event payload type are used.
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


def augment(snapshot, index, now):
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
        match = index.get(folder)
        if not match:
            task['codex_reason'] = 'no_matching_session_today_or_yesterday'
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


def collect(home, index, now):
    result = subprocess.run([str(Path(home) / 'bin/fm-fleet-snapshot.sh'), '--json'],
                            env={**os.environ, 'FM_HOME': home}, check=True,
                            capture_output=True, text=True, timeout=45)
    snapshot = json.loads(result.stdout)
    if snapshot.get('schema') != 'fm-fleet-snapshot.v1' or snapshot.get('fm_home') != home or not isinstance(snapshot.get('tasks'), list):
        raise ValueError('unexpected snapshot schema or home')
    return augment(snapshot, index, now)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', help='machine-private JSON: sessions_root and homes [{home, output}]')
    parser.add_argument('--home', help='one First Mate home; prints JSON unless --output is supplied')
    parser.add_argument('--output', help='atomically replace this snapshot file')
    parser.add_argument('--sessions-root', help='defaults to $CODEX_HOME/sessions or ~/.codex/sessions')
    args = parser.parse_args()
    if bool(args.config) == bool(args.home) or (args.config and args.output):
        parser.error('use --config, or --home [--output]')
    config = json.loads(Path(args.config).read_text()) if args.config else {'homes': [{'home': args.home, 'output': args.output}]}
    root = args.sessions_root or config.get('sessions_root') or str(Path(os.environ.get('CODEX_HOME', '~/.codex')).expanduser() / 'sessions')
    now = datetime.now(timezone.utc)
    index = session_index(Path(root).expanduser(), now)
    failed = False
    for entry in config['homes']:
        try:
            snapshot = collect(entry['home'], index, now)
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
