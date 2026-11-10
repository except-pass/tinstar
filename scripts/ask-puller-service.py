#!/usr/bin/env python3
"""Tin Star's deterministic Mac Ask service. No agents, models or shell eval."""
import argparse
from contextlib import contextmanager
import importlib.util
import hashlib
import json
import os
from pathlib import Path
import plistlib
import pwd
import shlex
import shutil
import signal
import subprocess
import sys
import time
import types
import urllib.parse
import uuid

SPEC = importlib.util.spec_from_file_location('ask_puller', Path(__file__).with_name('ask-puller.py'))
puller = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(puller)
LABEL = 'com.tinstar.ask-puller'
PACKAGE = Path(__file__).resolve().parent.parent
INTERVAL = 60
MAX_BACKOFF = 900
PASS_TIMEOUT = 50


def verified_adapter(release):
    """Verify before compile/exec; SHA protects against partial/corrupt downloads.

    HTTPS authenticates the server supplying both digest and executable bytes.
    bootstrap_api prevents a future adapter calling a different loader API.
    """
    if release['bootstrap_api'] != 1:
        raise ValueError('Unsupported bootstrap API')
    source = release['source']
    if hashlib.sha256(source.encode()).hexdigest() != release['sha256']:
        raise ValueError('Puller digest mismatch')
    module = types.ModuleType('updated_ask_puller')
    exec(compile(source, '<verified-tinstar-puller>', 'exec'), module.__dict__)
    if module.VERSION != release['version'] or not callable(module.pull_once) or not issubclass(module.PullerError, Exception):
        raise ValueError('Invalid puller release')
    return module


def update_adapter(root, settings, token, health):
    """One optional update per scheduled pass; retain working code on failure.

    A single private JSON file atomically stores source, digest and version so
    a killed swap cannot leave mismatched metadata. Never mutate npm's package.
    """
    current = puller
    cached = None
    cache_path = root / 'ask-puller-release.json'
    try:
        cached = read_json(cache_path)
        if cached and cached.get('origin') == settings['url']:
            current = verified_adapter(cached)
    except PassDeadlineError:
        raise
    except Exception:
        cached = None
        health['last_update_error_class'] = 'update-cache'
    try:
        # Never send the credential or download executable code over plaintext.
        if urllib.parse.urlsplit(settings['url']).scheme != 'https':
            raise ValueError('Updates require HTTPS')
        release = puller.api(settings['url'], token, path='/api/ask/bridge/puller', timeout=5)
        if not cached or cached.get('origin') != settings['url'] or release != {key: value for key, value in cached.items() if key != 'origin'}:
            candidate = verified_adapter(release)
            write_json(cache_path, {**release, 'origin': settings['url']})
            current = candidate
        health['last_update_error_class'] = None
    except PassDeadlineError:
        raise
    except Exception:
        # Errors are deliberately value-free: response and loader exceptions can
        # contain credentials or executable source. Poll with the current code.
        health['last_update_error_class'] = 'update-failed'
    health['puller_version'] = current.VERSION
    return current


def read_json(path, default=None):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return {} if default is None else default


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    with open(temporary, 'w', opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
    os.chmod(temporary, 0o600)
    temporary.replace(path)


class PassDeadlineError(Exception):
    pass


@contextmanager
def deadline(seconds):
    def expired(signum, frame):
        raise PassDeadlineError('Poll deadline reached')
    previous = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, seconds)
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, previous)


def tick(root, now=None):
    """One bounded pass, also executable on Linux for isolated integration proof.

    Backoff and counters persist across launchd ticks/restarts. Overlap and
    backoff skips do not touch credentials, network, inbox or health counters.
    """
    settings = read_json(root / 'ask-puller.json')
    if not settings.get('enabled'):
        return 'disabled'
    with puller.single_flight(Path(settings['home'])) as acquired:
        if not acquired:
            return 'overlap'
        health_path = root / 'ask-puller-health.json'
        health = read_json(health_path)
        for key in ('polls', 'noop_polls', 'work_polls', 'error_polls', 'captured', 'replied'):
            health.setdefault(key, 0)
        started = time.time() if now is None else now
        # launchd owns the normal cadence. Gate only failures: a successful
        # tick starting a few milliseconds early must not lose a whole minute.
        if health.get('consecutive_failures', 0) and started < health.get('next_poll_at', 0):
            return 'backoff'
        health['polls'] = health.get('polls', 0) + 1
        health['last_attempt_at'] = started
        # Persist the deadline before I/O, so a killed process remains visible.
        health['in_progress'] = True
        write_json(health_path, health)
        adapter = puller
        try:
            with deadline(PASS_TIMEOUT):
                token = puller.read_token(settings['token_key'], settings['clavis'])
                adapter = update_adapter(root, settings, token, health)
                result = adapter.pull_once(settings['url'], token, Path(settings['home']))
            worked = bool(result['captured'] or result['replied'] or result.get('failed'))
            key = 'work_polls' if worked else 'noop_polls'
            health[key] = health.get(key, 0) + 1
            for key in ('captured', 'replied'):
                health[key] = health.get(key, 0) + result[key]
            health.update(last_success_at=time.time() if now is None else now,
                          last_error_class=None, consecutive_failures=0,
                          minimum_puller_version=None,
                          queued=result['queued'], next_poll_at=started + INTERVAL)
            outcome = 'work' if worked else 'noop'
        except Exception as error:
            # Only fixed classes leave this process, never an exception string,
            # HTTP body, subprocess output, request text or credential.
            failures = health.get('consecutive_failures', 0) + 1
            delay = min(MAX_BACKOFF, INTERVAL * 2 ** min(failures - 1, 4))
            health.update(last_error_at=time.time() if now is None else now,
                          last_error_class='timeout' if isinstance(error, PassDeadlineError) else error.code if isinstance(error, (puller.PullerError, adapter.PullerError)) else 'local-state',
                          minimum_puller_version=error.minimum_version if isinstance(error, (puller.PullerError, adapter.PullerError)) else None,
                          consecutive_failures=failures, next_poll_at=started + delay)
            health['error_polls'] = health.get('error_polls', 0) + 1
            outcome = 'error'
        health['in_progress'] = False
        write_json(health_path, health)
        return outcome


def plist_path():
    return Path.home() / 'Library' / 'LaunchAgents' / (LABEL + '.plist')


def render_plist(root, settings):
    with (PACKAGE / 'services' / 'ask-puller' / 'agent.plist').open('rb') as stream:
        agent = plistlib.load(stream)
    agent['ProgramArguments'] = [sys.executable, str(PACKAGE / 'scripts' / 'ask-puller-service.py'),
                                 'tick', '--config-root', str(root)]
    # launchd does not inherit an interactive shell's PATH. Pin clavis itself
    # in private config and provide the inbox's ordinary executable search path.
    agent['EnvironmentVariables'] = {'PATH': settings['path'], 'FM_HOME': settings['home'],
                                     'TINSTAR_CONFIG_HOME': str(root)}
    agent['WorkingDirectory'] = str(root)
    return plistlib.dumps(agent)


def launchctl(args, check=True):
    result = subprocess.run(['/bin/launchctl', *args], capture_output=True, text=True, timeout=20)
    if check and result.returncode:
        raise puller.PullerError('launchctl failed; use ask-puller status', 'launchd')
    return result


def domain():
    return 'gui/' + str(os.getuid())


def unload():
    target = domain() + '/' + LABEL
    # A missing job is normal on first install/after reboot. Other bootout
    # failures must not be mistaken for a successful disable/uninstall.
    if launchctl(['print', target], check=False).returncode == 0:
        launchctl(['bootout', target])


def apply_agent(root, settings):
    path = plist_path()
    content = render_plist(root, settings)
    unchanged = path.exists() and path.read_bytes() == content
    loaded = launchctl(['print', domain() + '/' + LABEL], check=False).returncode == 0
    if not settings['enabled']:
        unload()
        return
    if not unchanged or not loaded:
        unload()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(0o600)
        launchctl(['enable', domain() + '/' + LABEL])
        launchctl(['bootstrap', domain(), str(path)])


def validate_settings(settings):
    url = urllib.parse.urlsplit(settings['url'])
    if url.scheme != 'https' or not url.hostname or url.username or url.password or url.query or url.fragment or url.path not in ('', '/'):
        raise puller.PullerError('Use an HTTPS origin without credentials', 'configuration')
    if not Path(settings['home']).is_absolute() or not (Path(settings['home']) / 'bin' / 'fm-inbox.sh').is_file():
        raise puller.PullerError('Home must contain bin/fm-inbox.sh', 'configuration')
    if not settings.get('token_key'):
        raise puller.PullerError('Specify the clavis reference, never its value', 'configuration')
    settings['url'] = settings['url'].rstrip('/')
    settings['clavis'] = shutil.which('clavis') or settings.get('clavis')
    if not settings['clavis'] or not Path(settings['clavis']).is_file():
        raise puller.PullerError('clavis must be installed and on PATH', 'configuration')
    settings['path'] = os.environ.get('PATH', '/usr/bin:/bin:/usr/sbin:/sbin')
    return settings


def journal_entries(home, retired=False):
    directory = home / 'state' / ('tinstar-ask-reply-receipts-retired' if retired else 'tinstar-ask-reply-receipts')
    for path in sorted(directory.glob('*/*.json' if retired else '*.json')):
        try:
            origin = puller.origin_identity(read_json(path)['origin'])
        except (OSError, ValueError, KeyError, TypeError):
            origin = 'unknown'
        yield path, origin


def journal_command(root, action, origin):
    return shlex.join(['env', 'TINSTAR_CONFIG_HOME=' + str(root), 'tinstar', 'ask-puller',
                       'journal', action, '--origin', origin, '--reason', '<operator reason>'])


def journal_status(root, settings):
    if not settings.get('home'):
        return {'pending_count': 0, 'stuck_count': 0, 'pending': [], 'retired_count': 0, 'retired': []}
    home = Path(settings['home'])
    try:
        current = puller.origin_identity(settings.get('url', ''))
    except ValueError:
        current = None
    result = {'stuck_count': 0, 'audit_log': str(home / 'state' / 'tinstar-ask-reply-journal-audit.jsonl')}
    for retired, label in ((False, 'pending'), (True, 'retired')):
        groups = {}
        for _, origin in journal_entries(home, retired):
            groups[origin] = groups.get(origin, 0) + 1
        result[label + '_count'] = sum(groups.values())
        result[label] = []
        for origin, count in sorted(groups.items()):
            row = {'origin': origin, 'count': count,
                   'command': journal_command(root, 'resume' if retired else 'retire', origin)}
            if not retired:
                row['stuck'] = origin != current
                if row['stuck']:
                    result['stuck_count'] += count
            result[label].append(row)
    return result


def journal_audit(home, event):
    # Log the explicit owner action before moving any private journal. An audit
    # write failure leaves the entries in place; retrying this command is safe.
    path = home / 'state' / 'tinstar-ask-reply-journal-audit.jsonl'
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, 'a', opener=lambda name, flags: os.open(name, flags, 0o600)) as stream:
        os.chmod(path, 0o600)
        stream.write(json.dumps({**event, 'at': time.time()}) + '\n')
        stream.flush()
        os.fsync(stream.fileno())


def manage_journal(root, settings, options):
    # Validate operator inputs before taking the nonblocking poll lock.
    if not settings.get('home') or not Path(settings['home']).is_absolute():
        raise puller.PullerError('Install needs a configured home', 'configuration')
    if not options.reason or not options.reason.strip() or not options.origin:
        raise puller.PullerError('Journal command needs --origin and --reason', 'configuration')
    try:
        origin = 'unknown' if options.origin == 'unknown' else puller.origin_identity(options.origin)
    except ValueError:
        raise puller.PullerError('Use a bridge origin or unknown', 'configuration') from None
    home = Path(settings['home'])
    event = {'operation': uuid.uuid4().hex, 'action': options.journal_action,
             'user': pwd.getpwuid(os.getuid()).pw_name, 'uid': os.getuid(),
             'origin': origin, 'reason': options.reason, 'count': 0}
    with puller.single_flight(home) as acquired:
        if not acquired:
            journal_audit(home, {**event, 'outcome': 'busy'})
            print(json.dumps({'outcome': 'busy', 'count': 0, 'warning': 'An active poll owns the journal; retry the same command.'}))
            return
        retiring = options.journal_action == 'retire'
        selected = [path for path, recorded_origin in journal_entries(home, retired=not retiring) if recorded_origin == origin]
        journal_audit(home, {**event, 'outcome': 'started', 'requested_count': len(selected)})
        target = home / 'state' / ('tinstar-ask-reply-receipts-retired' if retiring else 'tinstar-ask-reply-receipts')
        if retiring and selected:
            target.mkdir(parents=True, exist_ok=True, mode=0o700)
            target = target / event['operation']
        moved, skipped = 0, 0
        try:
            if selected:
                target.mkdir(parents=True, exist_ok=True, mode=0o700)
            for source in selected:
                destination = target / source.name
                if destination.exists():
                    # A resumed active entry wins; never overwrite a poll's
                    # progressed response or change its durable inbox ID.
                    skipped += 1
                    continue
                source.chmod(0o600)
                source.replace(destination)
                moved += 1
        except OSError:
            journal_audit(home, {**event, 'outcome': 'partial', 'count': moved, 'skipped': skipped})
            print(json.dumps({'outcome': 'partial', 'count': moved, 'warning': 'Some entries remain; check filesystem access and retry the same command.'}))
            return
        journal_audit(home, {**event, 'outcome': 'completed', 'count': moved, 'skipped': skipped})
        print(json.dumps({'outcome': 'completed', 'action': options.journal_action, 'count': moved,
                          'skipped': skipped,
                          'warning': 'Active entries were kept; use status to retire them before retrying resume if needed.' if skipped else None,
                          'next_action': 'Use tinstar ask-puller status for pending/retired entries and recovery commands.'}))


def manage(command, root, options):
    if command == 'tick':
        tick(root)
        return
    if command == 'journal':
        manage_journal(root, read_json(root / 'ask-puller.json'), options)
        return
    if command == 'status':
        settings = read_json(root / 'ask-puller.json')
        health = read_json(root / 'ask-puller-health.json')
        loaded = sys.platform == 'darwin' and launchctl(['print', domain() + '/' + LABEL], check=False).returncode == 0
        now = time.time()
        last = health.get('last_success_at')
        state = 'unconfigured' if not settings else 'disabled' if not settings.get('enabled') else 'not-loaded' if not loaded else 'starting' if not health else 'error' if health.get('last_error_class') else 'stale' if not last or now - last > INTERVAL * 3 else 'healthy'
        if settings.get('enabled') and loaded and health.get('in_progress'):
            state = 'polling' if now - health['last_attempt_at'] <= PASS_TIMEOUT else 'interrupted'
        advice = {
            'credential-expired': 'Renew the owner-scoped bridge credential in clavis; retries are automatic.',
            'credential-store': 'Unlock/check clavis and its configured key; retries are automatic.',
            'network': 'Check tailnet and bridge reachability; retries are automatic.',
            'inbox': 'Check the configured First Mate home and inbox readiness.',
            'timeout': 'Check bridge/inbox latency; the 50-second pass deadline was reached.',
            'puller-upgrade-required': 'Upgrade required: minimum puller ' + (health.get('minimum_puller_version') or 'see server') + '. Install the current Tin Star tarball and rerun tinstar ask-puller install; see the runbook.',
        }.get(health.get('last_error_class'), 'Use restart if the agent is missing or stale; check configuration and inbox readiness on errors.')
        print(json.dumps({'state': state, 'enabled': settings.get('enabled', False),
                          'loaded': loaded, 'health': health, 'journal': journal_status(root, settings),
                          'last_success_age_seconds': None if last is None else round(now - last),
                          'next_action': advice}, indent=2))
        return
    if sys.platform != 'darwin':
        raise puller.PullerError('Ask LaunchAgent installation/lifecycle requires macOS', 'platform')
    if command in ('install', 'upgrade', 'enable', 'restart') and (PACKAGE / '.git').exists():
        # npm ci in a developer checkout must not repoint a persistent agent
        # at a disposable worktree that can disappear after development.
        if command == 'upgrade':
            print('Ask puller: source checkout; keeping the installed LaunchAgent. Use the installed Tin Star CLI to update it.')
            return
        raise puller.PullerError('Use the installed Tin Star CLI', 'source-checkout')
    settings = read_json(root / 'ask-puller.json')
    if command in ('install', 'upgrade'):
        if command == 'upgrade' and not settings:
            env = os.environ
            if not all(env.get(key) for key in ('TINSTAR_ASK_URL', 'TINSTAR_ASK_HOME', 'TINSTAR_ASK_TOKEN_KEY')):
                return  # Unconfigured Macs are not puller hosts.
            settings = {'url': env['TINSTAR_ASK_URL'], 'home': env['TINSTAR_ASK_HOME'],
                        'token_key': env['TINSTAR_ASK_TOKEN_KEY'], 'enabled': True}
        if command == 'install':
            for key in ('url', 'home', 'token_key'):
                if getattr(options, key):
                    settings[key] = getattr(options, key)
            if not all(settings.get(key) for key in ('url', 'home', 'token_key')):
                raise puller.PullerError('Install needs --url, --home and --token-key', 'configuration')
            settings['enabled'] = True
        settings = validate_settings(settings)
        root.mkdir(parents=True, exist_ok=True)
        root.chmod(0o700)
        write_json(root / 'ask-puller.json', settings)
        apply_agent(root, settings)
    elif command == 'uninstall':
        if settings:
            settings['enabled'] = False
            write_json(root / 'ask-puller.json', settings)
        unload()
        plist_path().unlink(missing_ok=True)
        (root / 'ask-puller.json').unlink(missing_ok=True)
        # Keep private health and the kernel lock inode for diagnosis/safe overlap.
    else:
        if not settings:
            raise puller.PullerError('Run tinstar ask-puller install first', 'configuration')
        if command == 'disable':
            settings['enabled'] = False
            write_json(root / 'ask-puller.json', settings)
            launchctl(['disable', domain() + '/' + LABEL])
            unload()
        elif command in ('enable', 'restart'):
            settings['enabled'] = True
            write_json(root / 'ask-puller.json', settings)
            if command == 'restart':
                unload()
            apply_agent(root, settings)
    print('Ask puller ' + command + ' complete. Verify: tinstar ask-puller status')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['install', 'uninstall', 'enable', 'disable', 'status', 'restart', 'upgrade', 'tick', 'journal'])
    parser.add_argument('journal_action', nargs='?', choices=['retire', 'resume'])
    parser.add_argument('--config-root', type=Path, required=True)
    parser.add_argument('--url')
    parser.add_argument('--home')
    parser.add_argument('--token-key')
    parser.add_argument('--origin')
    parser.add_argument('--reason')
    options = parser.parse_args()
    if options.command == 'journal' and not options.journal_action:
        parser.error('journal requires retire or resume')
    try:
        manage(options.command, options.config_root.resolve(), options)
        return 0
    except Exception as error:
        # No tracebacks: inputs and subprocess failures can contain secrets.
        code = error.code if isinstance(error, puller.PullerError) else 'local-state'
        advice = 'Use the installed Tin Star CLI; see the runbook.' if code == 'source-checkout' else 'Check configuration, bridge access, clavis and launchd; see the runbook.'
        if options.command == 'journal':
            advice = 'Use journal retire|resume --origin URL --reason TEXT; status lists entries and recovery commands. Check audit-file/filesystem access and retry the same command.'
        print('Ask puller: ' + code + '. ' + advice, file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
