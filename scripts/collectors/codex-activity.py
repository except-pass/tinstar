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
        augment_open_decisions(task)
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


def fold_open_decisions(lines):
    """Task decisions close only on resolved with the same key."""
    opened = {}
    for line in lines.splitlines():
        match = re.match(r'^(blocked|needs-decision|resolved)\b(.*)$', line)
        if not match:
            continue
        verb, content = match.groups()
        metadata, separator, summary = content.partition(':')
        fields = dict(re.findall(r'\[(key)=([^\]]+)\]', metadata))
        key = fields.get('key')
        if not key:
            continue
        if verb == 'resolved':
            opened.pop(key, None)
        else:
            opened[key] = {'key': key, 'verb': verb,
                           'summary': summary.lstrip() if separator else content.strip()}
    return list(opened.values())


def augment_open_decisions(task):
    """Recover status-log decisions hidden by an unavailable pane state read."""
    state = task.get('current_state', {})
    hints = task.get('hints', {})
    if state.get('state') != 'unknown' or state.get('source') != 'pane' or hints.get('open_decisions'):
        return
    path = task.get('paths', {}).get('status_log', {}).get('path')
    if not path:
        return
    try:
        lines = Path(path).read_text()
    except (OSError, UnicodeError):
        return
    # Ignore an in-progress append, especially a partial resolution.
    if lines and not lines.endswith('\n'):
        lines = lines.rsplit('\n', 1)[0] if '\n' in lines else ''
    decisions = fold_open_decisions(lines)
    task['hints'] = {**hints, 'open_decisions': decisions,
                     'pending_decision': any(item['verb'] == 'needs-decision' for item in decisions),
                     'blocked_event': any(item['verb'] == 'blocked' for item in decisions),
                     'open_decisions_source': 'tinstar-status-fold'}


def parent_ask_stamp(metadata):
    """A valid bracket timestamp wins; otherwise accept a bare at=<epoch>."""
    stamps = re.findall(r'\[at=([^\]]+)\]', metadata)
    if stamps and stamps[-1].isdigit():
        return stamps[-1]
    bare = re.search(r'(?:^|\s)at=(\d+)(?=\s|$)', metadata)
    return bare[1] if bare else ''


_PARENT_EVENT = re.compile(r'^(blocked|needs-decision|resolved|done)\b(.*)$')
_PARENT_HEADER_FIELDS = re.compile(r'\[(key|corr|at)=([^\]]+)\]')
_PARENT_CORR = re.compile(r'(?<!\w)corr=([0-9A-Fa-f]{16})(?!\w)')


def parent_event(line):
    match = _PARENT_EVENT.match(line)
    if not match:
        return None
    state, content = match.groups()
    metadata, separator, note = content.partition(':')
    if state == 'done':
        prefix = metadata.partition('[')[0]
        if any(not re.fullmatch(r'at=\d+', word) for word in prefix.split()):
            return None
    fields = _PARENT_HEADER_FIELDS.findall(metadata)
    keys = [value for field, value in fields if field == 'key']
    header_corrs = [value for field, value in fields if field == 'corr']
    corrs = header_corrs[-1:] + _PARENT_CORR.findall(note)
    return state, metadata, keys, corrs, note.lstrip() if separator else content.strip(), bool(separator)


def fold_parent_asks(lines):
    """Resolve by key or close with an explicit correlation, in append order."""
    opened = {}
    for line in lines.splitlines():
        event = parent_event(line)
        if not event:
            continue
        state, metadata, keys, corrs, text, has_note = event
        key = keys[-1] if keys else None
        if state in ('resolved', 'done'):
            if state == 'resolved' and key:
                opened.pop(key, None)
            if corrs:
                opened = {identity: ask for identity, ask in opened.items() if ask['corr'] not in corrs}
        elif key:
            stamp = parent_ask_stamp(metadata)
            # Keep ageless/malformed asks so later resolutions can close them.
            # Only unresolved unknown ages make the final coverage unknown.
            opened[key] = {'key': key, 'corr': corrs[0] if corrs else None, 'state': state,
                           'at': int(stamp) if has_note and stamp.isdigit() else None, 'text': text}
    known = all(ask['at'] is not None for ask in opened.values())
    return {'status': 'known' if known else 'unknown', 'items': list(opened.values())}


def secondmate_ids(snapshot):
    """Task ids whose parent ledger is state/<id>.status. Kind, role, or a current record."""
    ids, seen = [], set()

    def add(mate_id):
        if isinstance(mate_id, str) and mate_id not in seen:
            seen.add(mate_id)
            ids.append(mate_id)

    current = snapshot.get('secondmate_current')
    records = current.get('records') if isinstance(current, dict) else None
    if isinstance(records, list):
        for row in records:
            if isinstance(row, dict):
                add(row.get('id'))
    for task in snapshot.get('tasks') or []:
        if isinstance(task, dict) and (task.get('kind') == 'secondmate' or task.get('role') == 'secondmate'):
            add(task.get('id'))
    return ids


def mate_status_file(home, mate_id):
    """The parent writes --resolve-key closes to state/<mate-id>.status. A slash leaves that directory."""
    if not isinstance(mate_id, str) or not mate_id or '/' in mate_id or mate_id in ('.', '..'):
        return None
    return Path(home) / 'state' / (mate_id + '.status')


def resolved_parent_asks(lines):
    """Last timestamped close by key or correlation for a mate on the parent."""
    if lines and not lines.endswith('\n'):
        lines = lines.rsplit('\n', 1)[0] if '\n' in lines else ''
    by_key, by_corr = {}, {}
    for line in lines.splitlines():
        event = parent_event(line)
        if not event:
            continue
        state, metadata, keys, corrs, _, has_note = event
        if state not in ('resolved', 'done') or not has_note:
            continue
        stamps = re.findall(r'\[at=([^\]]+)\]', metadata)
        if len(stamps) != 1:
            continue
        stamp = stamps[0]
        if stamp.isdigit() and len(stamp) <= 12 and stamp == str(int(stamp)):
            at = int(stamp)
            if state == 'resolved' and len(keys) == 1:
                by_key[keys[0]] = at
            by_corr.update((corr, at) for corr in corrs)
    return {'keys': [{'key': key, 'at': at} for key, at in sorted(by_key.items())],
            'corrs': [{'corr': corr, 'at': at} for corr, at in sorted(by_corr.items())]}


def parent_resolutions(home, snapshot, now):
    """Resolved keys this home recorded for its secondmates. Absent when it has none."""
    ids = secondmate_ids(snapshot)
    if not ids:
        return None
    mates, known = {}, True
    for mate_id in ids:
        path = mate_status_file(home, mate_id)
        if path is None:
            mates[mate_id] = {'status': 'unknown', 'keys': []}
            known = False
            continue
        try:
            text = path.read_text()
        except FileNotFoundError:
            mates[mate_id] = {'status': 'known', 'keys': []}
            continue
        except (OSError, UnicodeError):
            mates[mate_id] = {'status': 'unknown', 'keys': []}
            known = False
            continue
        mates[mate_id] = {'status': 'known', **resolved_parent_asks(text)}
    return {'status': 'known' if known else 'unknown', 'observed_at': iso(now.timestamp()), 'mates': mates}


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
    resolutions = parent_resolutions(home, snapshot, now)
    if resolutions is not None:
        snapshot['parent_resolutions'] = resolutions
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
