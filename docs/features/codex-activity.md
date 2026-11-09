# Codex turn collection

Tin Star can augment the existing `fm-fleet-snapshot.v1` publication with Codex
turn facts. The collector lives in this repository; it does not change First
Mate, read terminal screens, control workers, or contact another machine.
Python 3 (standard library only) and each home's existing
`bin/fm-fleet-snapshot.sh --json` are the only requirements.

For every Codex task, `paths.worktree.path` is matched exactly against the first
`session_meta.payload.cwd` in session logs. The scan covers today's and
yesterday's UTC directories below `$CODEX_HOME/sessions` (default
`~/.codex/sessions`), newest file mtime first. Only the matching session's
`event_msg.payload.type` values `task_started` / `task_complete` establish an open
or closed turn. Other payloads, prompts and outputs are never accessed or copied
into the publication. A partial final JSON line is ignored until the next run.
An older-directory session is outside this bounded scan, even if it was recently
modified; the result remains unknown. No inference is made from a quiet log.

Each Codex task receives:

```json
{
  "codex": {
    "last_activity_at": "2026-11-09T21:52:00Z",
    "turn_open": true,
    "session_file": "rollout-example.jsonl",
    "observed_at": "2026-11-09T21:52:06Z"
  },
  "codex_reason": null
}
```

No matching log produces `codex: null` and a `codex_reason` such as
`no_matching_session_today_or_yesterday` or `worker_folder_missing`. A log without
turn events retains its activity timestamp with `turn_open: null` and
`codex_reason: "no_turn_events"`. An unreadable log leaves the signal unknown.
Known crew state takes precedence. Unknown crew state uses a known turn only
while the collector observation is less than five minutes old and the home
observation is fresh. Open means running; closed means waiting. Log mtime is
shown as **Last activity**, independently of turn state; there is no hung-worker
timeout. This is evidence for the normal worker counts, Active/Stalled readiness
and per-card unavailable facts, without changing the existing readiness census.

## Private machine config

Install one collector per machine under the same account that owns the Codex
session logs. Paths below are examples with the deployment's actual home names.
No config, session log, generated snapshot or credentials should be committed.

```sh
install -d -m 700 "$HOME/.config/tinstar" "$HOME/.local/share/tinstar" "$HOME/.local/state/tinstar/fleet-snapshots"
install -m 755 scripts/collectors/codex-activity.py "$HOME/.local/share/tinstar/codex-activity.py"
```

Create `$HOME/.config/tinstar/codex-activity.json` using the appropriate row set
below. `sessions_root` can be overridden for a nondefault Codex home. Each output
directory must already exist. Outputs are atomically replaced with private
permissions; a failed home leaves its prior snapshot to age out and does not
prevent other homes from being collected.

Hulk (the existing local summary directory):

```json
{
  "sessions_root": "/home/farm/.codex/sessions",
  "homes": [
    {"home": "/home/farm/fm-home", "output": "/home/farm/srv/fm-snapshots/hulk.json"},
    {"home": "/home/farm/fm-cmsh", "output": "/home/farm/srv/fm-snapshots/cmsh.json"},
    {"home": "/home/farm/fm-catalog", "output": "/home/farm/srv/fm-snapshots/catalog.json"}
  ]
}
```

Bandit:

```json
{
  "sessions_root": "/home/farm/.codex/sessions",
  "homes": [
    {"home": "/home/farm/fm-kdf", "output": "/home/farm/.local/state/tinstar/fleet-snapshots/kdf.json"},
    {"home": "/home/farm/fm-fleet", "output": "/home/farm/.local/state/tinstar/fleet-snapshots/fleet.json"}
  ]
}
```

Optimus (its published label is `hilda`):

```json
{
  "sessions_root": "/home/farm/.codex/sessions",
  "homes": [
    {"home": "/home/farm/fm-hilda", "output": "/home/farm/.local/state/tinstar/fleet-snapshots/hilda.json"}
  ]
}
```

The catalog home exists at `/home/farm/fm-catalog` but is not present
in the old publisher's configured home list. Add its Tin Star source alongside
the others with `home`, `machine: "hulk"`, `label: "catalog"` and
`snapshotFile: "/home/farm/srv/fm-snapshots/catalog.json"` in the private
`config.json` reconciliation fleet array. Retain its actual parent-home identity.

## Linux install (firstmate, after merge)

Run these commands on **each machine locally** from the merged Tin Star checkout,
after creating that machine's JSON config. This worker does not perform live
installs. Preserve the publisher's existing backend environment in the service:

```sh
cat > "$HOME/.config/tinstar/codex-activity.env" <<EOF_ENV
PATH=$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
HERDR_SESSION=fm-remote
FM_BACKEND_HERDR_CLIENT_SESSION=fm-remote
HERDR_SOCKET_PATH=$HOME/.config/herdr/sessions/fm-remote/herdr.sock
EOF_ENV
chmod 600 "$HOME/.config/tinstar/codex-activity.json" "$HOME/.config/tinstar/codex-activity.env"
install -d -m 700 "$HOME/.config/systemd/user"
install -m 644 services/codex-activity/tinstar-codex-activity.service services/codex-activity/tinstar-codex-activity.timer "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user start tinstar-codex-activity.service
systemctl --user status tinstar-codex-activity.service --no-pager
```

**Switch the old publisher before enabling the timer**, so it cannot overwrite
augmented local snapshots with raw snapshots. The existing Hulk transport script
`/home/farm/srv/fm-snapshot-publish.sh` is deployment config, not a First Mate
script. Keep its existing pinned SSH settings and scheduling. Remove its local
`publish hulk ...` and `publish cmsh ...` calls (the collector now owns those
files); replace its remote snapshot commands with reads of the machine-local
augmented files. For example, replace its `publish` function and call list with:

```bash
pull() { # label host; existing dir and ssh_opts remain unchanged
    local name=$1 host=$2 tmp
    tmp=$(mktemp "$dir/.$name.XXXXXX") || return
    if timeout 45 ssh "${ssh_opts[@]}" "farm@$host" \
        "cat /home/farm/.local/state/tinstar/fleet-snapshots/$name.json" > "$tmp"; then
        if python3 -c 'import json,sys; s=json.load(open(sys.argv[1])); assert s["schema"] == "fm-fleet-snapshot.v1" and isinstance(s["tasks"], list)' "$tmp"; then
            chmod 600 "$tmp"
            mv -f "$tmp" "$dir/$name.json"
        else rm -f "$tmp"; fi
    else rm -f "$tmp"; fi
}
pull fleet bandit &
pull kdf bandit &
pull hilda optimus &
wait
```

A failed remote read retains the previous file. Transport never changes
`generated` or `codex.observed_at`, so old data cannot be refreshed by copying.
Keep Mac pushes to the same `main.json` destination but send the augmented
machine-local file described below. Tin Star itself continues reading only
configured snapshot files; it never logs into a remote machine.

Then on each Linux machine:

```sh
systemctl --user enable --now tinstar-codex-activity.timer
systemctl --user list-timers tinstar-codex-activity.timer --no-pager
journalctl --user -u tinstar-codex-activity.service -n 20 --no-pager
```

The user manager must persist while logged out. If it is not available, the
machine operator runs `sudo loginctl enable-linger farm`; in the farm account
set `export XDG_RUNTIME_DIR=/run/user/$(id -u)` before the `systemctl --user`
commands above. This sets up the account's persistent systemd user manager.
Do not change any First Mate script or worker lifecycle setting.

## Owner Mac bundle (parent installs)

Send these three files from the final merged commit to the parent:

- `scripts/collectors/codex-activity.py`
- `services/codex-activity/com.tinstar.codex-activity.plist`
- this document

On the Mac, from the unpacked bundle or Tin Star checkout, run the common
`install` commands above, then:

```sh
python3 - <<'PY_CONFIG'
import json, os
from pathlib import Path
root = Path.home()
config = {'sessions_root': str(Path(os.environ.get('CODEX_HOME', str(root / '.codex'))) / 'sessions'),
          'homes': [{'home': '/Users/wtg/repo/firstmate',
                     'output': str(root / '.local/state/tinstar/fleet-snapshots/main.json')}]}
path = root / '.config/tinstar/codex-activity.json'
path.write_text(json.dumps(config, indent=2) + '\n')
path.chmod(0o600)
PY_CONFIG
install -d -m 700 "$HOME/Library/LaunchAgents"
python3 - <<'PY_PLIST'
import plistlib, shutil
from pathlib import Path
root = Path.home()
template = Path('services/codex-activity/com.tinstar.codex-activity.plist').read_text()
# plistlib escapes paths correctly, including spaces and XML punctuation.
config = plistlib.loads(template.encode())
python = shutil.which('python3')
config['ProgramArguments'] = [python if item == '@PYTHON@' else item.replace('@HOME@', str(root)) for item in config['ProgramArguments']]
for key in ('StandardOutPath', 'StandardErrorPath'):
    config[key] = config[key].replace('@HOME@', str(root))
config['EnvironmentVariables']['PATH'] = config['EnvironmentVariables']['PATH'].replace('@HOME@', str(root))
(root / 'Library/LaunchAgents/com.tinstar.codex-activity.plist').write_bytes(plistlib.dumps(config))
PY_PLIST
python3 "$HOME/.local/share/tinstar/codex-activity.py" --config "$HOME/.config/tinstar/codex-activity.json"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.tinstar.codex-activity.plist"
launchctl print "gui/$(id -u)/com.tinstar.codex-activity"
```

Preserve any environment required by the Mac's existing snapshot invocation in
the plist `EnvironmentVariables`. Replace the existing raw-snapshot Mac push
input with `$HOME/.local/state/tinstar/fleet-snapshots/main.json`; preserve its
authenticated push route and atomic remote destination. A local Tin Star instance
using this home must set its source's `snapshotFile` to that augmented local file.
An already loaded agent
can be replaced by `launchctl bootout "gui/$(id -u)/com.tinstar.codex-activity"`
followed by the `bootstrap` command. This operates only the Tin Star collector.

## Proof and rollback

Before switching a publisher, run once to a temporary destination:

```sh
python3 scripts/collectors/codex-activity.py --home /home/farm/fm-home --output /tmp/hulk-codex-preview.json
```

Use the publisher's environment when invoking this command. Check file freshness
and unknown/running/waiting counts **per home** using the same Tin Star readiness
projection as the live view, and capture the dial plus worker cards with last
activity. Record the deployed commit and evidence on the work card:
https://app.notion.com/p/41350ce6d422816e9b82d2f025091ceb . Firstmate performs live
installs and records the final per-machine freshness/count evidence after merge.

To roll back, disable the collector timer (`systemctl --user disable --now
tinstar-codex-activity.timer`) or unload its Mac launch agent with `bootout`, then
restore the prior publisher invocation. Existing snapshots remain readable;
without fresh Codex observations the turn fallback expires normally.

Tests: `npm run test:codex-collector`, the fleet source tests, work-health tests
and worker-card rendering tests. Collector fixtures are synthetic and private
message content is never saved from real Codex logs.
