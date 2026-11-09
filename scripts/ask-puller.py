#!/usr/bin/env python3
"""One outbound-only Tin Star / First Mate inbox reconciliation pass.
Run periodically on the main Mac home; no raw audio, token files or shell eval.
Only clavis stdout supplies the bearer token. Errors never echo response bodies,
subprocess output, request content or credentials. See docs/features/ask.md.
"""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

VERSION = '6.0.1'


class PullerError(Exception):
    def __init__(self, message, code='bridge-error', minimum_version=None):
        super().__init__(message)
        self.code = code
        self.minimum_version = minimum_version


@contextmanager
def single_flight(home):
    """Kernel-owned lock: process death releases it; never unlink a live inode."""
    state = home / 'state'
    state.mkdir(parents=True, exist_ok=True)
    with (state / 'tinstar-ask-puller.lock').open('a') as lock:
        os.chmod(lock.name, 0o600)
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            yield False
            return
        try:
            yield True
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)


def read_token(key, executable='clavis'):
    try:
        secret = subprocess.run([executable, 'get', key], text=True, capture_output=True, timeout=15)
        if secret.returncode or not secret.stdout.strip():
            raise PullerError('Could not read bridge credential', 'credential-store')
        return secret.stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        raise PullerError('Could not read bridge credential', 'credential-store') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    # Do not forward the bearer to a redirected host.
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def api(base, token, payload=None, path='/api/ask/bridge', timeout=20):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, headers={
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
        'X-Tinstar-Puller-Version': VERSION,
    })
    try:
        with urllib.request.build_opener(NoRedirect).open(req, timeout=timeout) as response:
            raw = response.read(2 * 1024 * 1024 + 1)
        if len(raw) > 2 * 1024 * 1024:
            raise PullerError('Bridge response exceeded the read bound')
        result = json.loads(raw)
        if result.get('ok') is not True:
            raise PullerError('Bridge rejected the operation')
        return result['data']
    except urllib.error.HTTPError as error:
        if error.code == 426:
            minimum = error.headers.get('X-Tinstar-Minimum-Puller-Version', '')
            # Only a version, never an arbitrary server string, reaches status.
            if not minimum or len(minimum) > 32 or not all(part.isdigit() for part in minimum.split('.')) or len(minimum.split('.')) != 3:
                minimum = None
            raise PullerError('Upgrade the Tin Star Ask puller', 'puller-upgrade-required', minimum) from None
        raise PullerError('Bridge rejected the operation', 'credential-expired' if error.code in (401, 403) else 'bridge-http') from None
    except (urllib.error.URLError, TimeoutError):
        raise PullerError('Bridge unavailable', 'network') from None
    except (ValueError, KeyError):
        raise PullerError('Bridge unavailable or returned an invalid response') from None


def inbox(home, args, body=None):
    # The configured home is an operator argument, never a remote payload path.
    env = dict(os.environ, FM_HOME=str(home))
    try:
        result = subprocess.run([str(home / 'bin' / 'fm-inbox.sh'), *args], input=body,
                                text=True, capture_output=True, timeout=30, env=env)
        if result.returncode not in (0, 3):
            raise PullerError('Inbox command failed', 'inbox')
        return json.loads(result.stdout), result.returncode
    except (OSError, subprocess.TimeoutExpired, ValueError):
        raise PullerError('Inbox unavailable or returned an invalid response', 'inbox') from None


def save_receipt(path, record):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with open(temporary, 'w', opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        json.dump(record, stream)
    os.chmod(temporary, 0o600)
    temporary.replace(path)


def deliver_receipt(base, token, home, path, record):
    # Journal before POST: after an uncertain HTTP response the server's
    # idempotent reply replay recovers the same warnings, even after untracking.
    # A retargeted service must not send a previous server's private reply to
    # its new origin. Keep it visible as incomplete until the operator restores
    # that origin or removes the obsolete receipt journal.
    if record['origin'] != base:
        raise PullerError('Receipt belongs to a different bridge', 'configuration')
    if 'response' not in record:
        record['response'] = api(base, token, record['payload'])
        save_receipt(path, record)
    warnings = record['response'].get('reply_warnings')
    if warnings:
        request_id = 'tinstar-ask-receipt-' + path.stem
        body = ('Tin Star Ask reply receipt\n' + json.dumps({
            'request_id': record['payload']['request_id'],
            'note_id': record['payload']['reply']['id'],
            'reply_warnings': warnings,
        }, ensure_ascii=False) + '\nRejected suggested actions were not offered to the owner. Review these warnings before suggesting a replacement.')
        note, code = inbox(home, ['note', '--request-id', request_id, '--json', '-'], body)
        if code or note.get('saved') is not True or note.get('request_id') != request_id:
            raise PullerError('Reply warning receipt delivery is incomplete', 'inbox')
    path.unlink()


def pull_once(base, token, home):
    receipts_path = home / 'state' / 'tinstar-ask-reply-receipts'
    attempted = set()
    incomplete = False
    for path in sorted(receipts_path.glob('*.json')):
        attempted.add(path)
        try:
            deliver_receipt(base, token, home, path, json.loads(path.read_text()))
        except PullerError as error:
            if error.code == 'puller-upgrade-required':
                raise
            incomplete = True
    work = api(base, token)
    tracked = {row['note_id']: row['request_id'] for row in work['tracked']}
    captured = 0
    failed = 0
    queued = {row['request_id'] for row in work['pending'] + work['tracked']}
    for request in work['pending']:
        request_id = request['request_id']
        try:
            note, code = inbox(home, ['note', '--request-id', request['inbox_request_id'], '--json', '-'], request['body'])
        except PullerError:
            api(base, token, {'request_id': request_id, 'error': 'capture-failed'})
            failed += 1
            continue
        if note.get('saved') is not True or note.get('request_id') != request['inbox_request_id']:
            raise PullerError('Inbox capture correlation failed')
        api(base, token, {'request_id': request_id, 'note': note})
        tracked[note['id']] = request_id
        captured += 1
        if code == 3:
            # A same-ID note retry repairs announcement under fm-inbox's lock.
            # Mark the public failure so the owner can explicitly retry it.
            api(base, token, {'request_id': request_id, 'error': 'wake-failed'})
    replied = 0
    if tracked:
        receipts, _ = inbox(home, ['receipts', '--all-pending', '--all-handled', '--all-replies'])
        if receipts.get('schema') != 'fm-inbox-receipts.v1':
            raise PullerError('Inbox receipt read is incomplete')
        incomplete = incomplete or bool(receipts.get('omitted'))
        for receipt in receipts.get('pending', []) + receipts.get('handled', []):
            note_id = receipt.get('id')
            request_id = tracked.get(note_id)
            if not request_id or not receipt.get('reply'):
                continue
            try:
                if receipt.get('request_id') != 'tinstar-ask-' + request_id:
                    raise PullerError('Inbox receipt correlation failed')
                payload = {'request_id': request_id, 'reply': receipt['reply']}
                # A hash of the immutable reply gives a filesystem-safe stable
                # inbox ID, so uncertain delivery never creates duplicate notes.
                key = hashlib.sha256(json.dumps(payload, sort_keys=True).encode()).hexdigest()
                path = receipts_path / (key + '.json')
                if path in attempted:
                    continue
                record = {'origin': base, 'payload': payload}
                save_receipt(path, record)
                deliver_receipt(base, token, home, path, record)
                replied += 1
                queued.discard(request_id)
            except PullerError as error:
                if error.code == 'puller-upgrade-required':
                    raise
                incomplete = True
    if incomplete:
        raise PullerError('Inbox receipt delivery is incomplete', 'inbox')
    return {'captured': captured, 'replied': replied, 'failed': failed, 'queued': len(queued)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', required=True, help='Tin Star tailnet HTTPS origin')
    parser.add_argument('--home', required=True, type=Path, help='Main First Mate home')
    parser.add_argument('--token-key', required=True, help='clavis secret.key reference (not the secret value)')
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.url)
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        parser.error('--url must be an HTTPS origin without credentials')
    if not args.home.is_absolute():
        parser.error('--home must be absolute')
    try:
        with single_flight(args.home) as acquired:
            if not acquired:
                return 0
            result = pull_once(args.url.rstrip('/'), read_token(args.token_key), args.home)
        print(json.dumps(result))
        return 0
    except (PullerError, OSError, subprocess.TimeoutExpired) as error:
        if isinstance(error, PullerError) and error.code == 'puller-upgrade-required':
            print('Ask puller upgrade required; minimum version: ' + (error.minimum_version or 'see server') + '. Install the current release and rerun tinstar ask-puller install.', file=sys.stderr)
        else:
            print('Ask puller did not complete; check bridge access, clavis and inbox readiness.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
