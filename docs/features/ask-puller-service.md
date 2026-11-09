# Automatic Mac Ask delivery

Tin Star ships its existing outbound-only Ask adapter, a 60-second launchd
LaunchAgent, lifecycle CLI and npm update hook together. Only the designated Mac
First Mate login enables this service. The browser/server can run on Linux.

## Install on the Mac

Prerequisites: a logged-in macOS user session (LaunchAgent, not LaunchDaemon),
Node supported by Tin Star, Python 3, clavis on PATH, and an installed First Mate
home with `bin/fm-inbox.sh`. Provision the **existing owner-scoped bridge token**
into clavis using the approved credential workflow; these commands take only its
reference. The Tin Star server must already have matching Ask authentication.
Do not pass a token value in an argument, environment variable, plist or log.

Firstmate coordinates retirement of the old registered check before enabling
this service. There must be exactly one active puller. This installer does not
edit First Mate registrations. The shared home lock also protects accidental
manual execution of the shipped adapter.

Tin Star is not published on the npm registry. Install or replace the global
package from the release tarball on the designated Mac. Use the same
login/config root that will run the service; do not use sudo:

```sh
npm install -g ./tinstar-<ver>.tgz
```

npm 11.19 and newer may skip Tin Star's postinstall under the allow-scripts
gate. `npm update -g` skips that hook the same way unless allow-scripts
includes tinstar, so a global install or update does not by itself set up the
LaunchAgent. After every `npm install -g` or `npm update -g`, run the
canonical idempotent service install (substitute origin, home and key
reference). Rerunning `tinstar ask-puller install` re-enables a disabled
installation: it sets `enabled=true` and reloads the agent. When updating a
deliberately disabled installation, skip this install step or run
`tinstar ask-puller disable` again afterward:

```sh
tinstar ask-puller install --url https://your-tinstar.example.ts.net:8450 --home "$HOME/repo/firstmate" --token-key tinstar.ask-bridge
```

`TINSTAR_CONFIG_HOME` (or legacy `TINSTAR_DATA_DIR`) selects the Mac's private
config root, default `~/.config/tinstar`. This is the **Mac** configuration, not
the remote Tin Star server config. Install persists only origin, home, key
reference, executable search path, clavis path and enabled state in mode-0600
`ask-puller.json`. The LaunchAgent uses the installed package's Python service
path and interpreter, never a copied worktree script. That service loads the
server-matched adapter as described below. Its PATH is captured at
install so clavis and the inbox work without an interactive shell.

Confirm the service:

```sh
tinstar ask-puller status
```

`healthy` means the LaunchAgent is loaded and the last success is within
three minutes.

Letting the postinstall enable the service is secondary. It works only when
npm actually runs the hook. For a global install, npm 11.19 accepts
`--allow-scripts=tinstar` on the command, or a persisted user setting,
`npm config set allow-scripts=tinstar --location=user`, before a later
install or update. `npm approve-scripts` only edits a project `package.json`
and fails for a global install (`-g` returns EGLOBAL). npm matches each
allow-scripts name to the package's resolved identity, not the name the
package reports. With the hook allowed, pass the same settings in the
environment:

```sh
TINSTAR_ASK_URL=https://your-tinstar.example.ts.net:8450 TINSTAR_ASK_HOME="$HOME/repo/firstmate" TINSTAR_ASK_TOKEN_KEY=tinstar.ask-bridge npm install -g --allow-scripts=tinstar ./tinstar-<ver>.tgz
```

If status is not healthy, follow the canonical procedure in
[Install on the Mac](#install-on-the-mac), including its disabled-installation
guidance.

## One-time update to 6.0.1 on the existing Mac

Copy the `tinstar-6.0.1.tgz` release tarball to the Mac, then run these exact
commands from its directory as the same login that owns the existing service:

```sh
npm install -g ./tinstar-6.0.1.tgz
tinstar ask-puller install
tinstar ask-puller status
```

The install command reuses the saved URL, First Mate home and clavis key
reference. Use the same `TINSTAR_CONFIG_HOME` if the original install used an
override. It re-enables and reloads the agent, including when npm skips
postinstall. If this is a first install, use the full `--url`, `--home` and
`--token-key` command above. No token values belong in these commands.
The 6.0.0 service cannot bootstrap automatic updates itself; this one package
update and service install is required. Mac installation and login proof remain
operator steps; Linux tests do not establish them.

## Bridge contract and automatic adapter updates

The authenticated bridge advertises `contract_version: 1` and
`minimum_puller_version: "6.0.0"` in GET work data, and
`X-Tinstar-Bridge-Contract` / `X-Tinstar-Minimum-Puller-Version` headers on
bridge responses. New pullers send `X-Tinstar-Puller-Version`. A missing header
means **6.0.0**, which remains supported. Versions below the minimum (or
malformed versions) receive HTTP **426**, with envelope error code
`puller-upgrade-required` and the minimum and contract version in `error.details`.
The server rejects these clients before reading or changing work. Raising the
minimum is an explicit retirement; additive changes must keep the 6.0.0 CI
fixture passing. Conversation responses keep their existing shape and carry
the version headers.

Starting with 6.0.1, each eligible LaunchAgent pass uses its existing lock,
credential and deadline to GET `/api/ask/bridge/puller` before reconciling. The
endpoint requires the same bridge bearer, rejects browser Origins, and remains
available to obsolete pullers so they can update. It serves the server package's
standalone `ask-puller.py`, package version, SHA-256 and `bootstrap_api: 1` in the
normal data envelope. It never serves an arbitrary filesystem path.

The installed service is a small stable bootstrap. It checks SHA-256 **before
compiling or executing** downloaded code, validates the bootstrap API and version,
and atomically replaces a mode-0600 `ask-puller-release.json` under the Mac config
root. Source, digest, version and server origin are in that one file: a partial
swap cannot pair code with the wrong metadata. The service verifies cached bytes
again before loading them. Code runs in the existing Python pass; there is no
new daemon, shell evaluation, package manager invocation or package mutation.
The standalone adapter API is `VERSION`, `PullerError`, and
`pull_once(base, token, home)`, using only Python's standard library. Changing
that bootstrap interface requires a package update through the same install path.

HTTPS certificate verification authenticates the server supplying executable
code; the digest detects corrupt/incomplete code, and is not an independent
signature. The configured server is trusted to distribute puller code. Redirects
are refused so the bearer cannot be forwarded to a different host. Downloads
have a five-second network timeout, a 2 MiB response bound, and share the
50-second pass deadline. A failed download, verification, load or atomic write
keeps the prior verified cached adapter, or the packaged one on first use, and
still polls. Status exposes `health.puller_version` and a value-free
`health.last_update_error_class`. A valid server rollback also replaces the
adapter, even at a lower version: it matches that server's contract rather than
an unrelated package registry. Removing a broken cache is unnecessary; a later
successful download repairs it.

If polling receives the upgrade error, status records
`last_error_class: "puller-upgrade-required"`, `minimum_puller_version`, and an
explicit install action. An incompatible server bootstrap API leaves the current
adapter running; if the server has retired that adapter, install its current
release tarball and rerun `tinstar ask-puller install`. Installing an older
package and rerunning install restores that package's service, but a service
with automatic updates still loads the configured server's adapter. To roll
back that adapter, roll back the server package supplying it. Disabled services
perform no download or poll.

## Rejected-action receipts for First Mate

After posting a reply, the updated adapter forwards nonempty `reply_warnings`
from the POST data into a follow-up inbox note containing `request_id`,
`note_id`, and the warnings verbatim as JSON. It uses the installed inbox's
supported `note --request-id <stable-id> --json -` command, not an invented
receipt mutation command. This makes rejected suggestions visible to First Mate
through its normal durable inbox and wake path.

Before POST, the adapter journals the outgoing reply in mode-0600 files under
`<First Mate home>/state/tinstar-ask-reply-receipts/`. It saves the POST result
before writing the warning note. A lost POST response retries the identical
reply (the server replays the stored rejection warnings); a saved note with a
failed wake retries its same request ID. A later pass drains this journal even
when the server has already stopped tracking the answered request. Only a
successful receipt removes its journal entry. Independent replies still proceed
when one delivery fails; status reports the incomplete inbox delivery. Empty
warnings create no follow-up note. No credentials are persisted in this journal. Entries are bound to the server
origin: retargeting a service leaves old entries incomplete rather than sending
private replies to the new server. Restore the original origin to drain them,
or use the audited journal retirement command below.

## Retire or resume receipt journals

Receipt identity uses the bridge origin, mapped request/note identity and reply
sequence. It excludes reply timestamps, body formatting and JSON key order.
Equivalent URL spellings and zero-padded sequences compare by meaning. Existing
journals remain readable at their original names, preserving their durable inbox
request IDs through retries, retirement and resume.

Status lists pending and retired journal counts grouped by origin. Pending
entries for a different origin are marked `stuck`; unreadable entries use
`unknown`. Each group includes its exact recovery command with the config root
and shell quoting already supplied. Fill in an operator reason:

```sh
tinstar ask-puller journal retire --origin https://old-tinstar.example.ts.net:8450 --reason "Old bridge retired; preserve its unsent receipts"
tinstar ask-puller status
tinstar ask-puller journal resume --origin https://old-tinstar.example.ts.net:8450 --reason "Original bridge restored; resume its receipts"
```

These filesystem commands are available on macOS and Linux and do not call
launchd, clavis, the bridge or the inbox. They validate the origin and required
reason before attempting the same nonblocking lock as a poll. A busy poll produces
a visible warning and an audit entry; retry the same command afterward.

Retire atomically moves matching entries into private operation directories under
`<home>/state/tinstar-ask-reply-receipts-retired/`. Retired answers are skipped by
automatic polling until resumed, including if the server still tracks the answer.
Resume restores the original filenames and inbox IDs, allowing ordinary same-ID
replay without a second warning note. It retains an existing active filename and
reports a visible warning instead of overwriting progressed state. Status provides
the active entry's retirement command if replacement is intended. Cross-origin
sending stays refused; resume an old origin after restoring its service URL/key
configuration, or leave its entries retired.

Both commands append time, OS user/UID, origin, action, operation ID, count and
operator reason to mode-0600 `<home>/state/tinstar-ask-reply-journal-audit.jsonl`.
A started record is flushed before any move and a completed/partial record reports
how many moved. Replies, warning bodies and credentials are excluded from the
audit; keep credentials out of the operator reason too. An audit write failure
moves no entries before the initial record. Interrupted or partial moves leave
entries in their original or retired directories; status lists both and the same
command can be retried. No hand-edited records or deleted lock files are needed.
`--origin unknown` supplies the same audited close/resume path for unreadable
entries. Retired files are retained for deliberate recovery, not deleted.

## Verify and operate

```sh
tinstar ask-puller status
tinstar ask-puller disable
tinstar ask-puller enable
tinstar ask-puller restart
tinstar ask-puller uninstall
```

Status is the unobtrusive local system health surface: enabled/loaded state,
last attempt/success/error times (Unix seconds), success age, last fixed error
class, next eligible poll, consecutive failures, last observed outstanding
`queued` count, captured/replied totals, and no-op/work/error poll counters.
`queued` counts unanswered pending/tracked requests at the end of the last successful
pass; it is not a current server queue while disconnected. `healthy`
requires a loaded agent and success within three minutes. An interrupted or
stale pass is visible; health never claims an answer is investigating. Status
also gives the next diagnostic action. No continuous agent watches the status.

The plist lives at `~/Library/LaunchAgents/com.tinstar.ask-puller.plist` and
launchd loads it into `gui/<uid>`. Login/reboot restores the enabled agent.
Disable unloads and persists disabled state across automatic postinstall
upgrades and login. Manual `tinstar ask-puller install` re-enables it; skip
that step or disable again afterward to keep it disabled. Enable or restart
loads it again; restart preserves backoff. Uninstall unloads and
removes the plist/config; it retains private health for diagnosis and the lock
inode for safe overlap. Never delete a lock inode to clear a stale-looking PID:
the kernel releases the lock on process death.

When npm runs the shipped postinstall, a configured Mac regenerates and
reloads the service when installed paths or configuration change, and ensures
an enabled agent is loaded. For the required update procedure and how to keep
a deliberately disabled installation disabled, see
[Install on the Mac](#install-on-the-mac). Unconfigured Macs without the
setup environment variables and all non-Mac installs do nothing. Source
checkouts also skip automatic service updates so `npm ci` cannot repoint an
installed LaunchAgent at a disposable worktree; lifecycle setup commands
require the installed Tin Star CLI. Status, disable and uninstall remain
available. `--ignore-scripts` also skips the hook. If the hook is skipped or
reports failure, follow the same install procedure linked above, including its
disabled-installation guidance, using the installed package. No separate
service checkout or manually maintained plist is involved. Desktop-only and
browser-only installs do not designate a Mac puller.

## Idle cost, failure and retry behavior

Every launchd tick is a plain Python process. It obtains the nonblocking kernel
lock shared with the single-pass adapter, reads persisted backoff, reads the
credential from clavis, and calls the existing authenticated bridge. Empty work
with no outstanding warning journal never invokes the inbox. Delivered questions
with no reply only read stored receipts. Pending questions call
`note --request-id tinstar-ask-<UUID>`; mapped replies are posted. Warning journals
also trigger the follow-up inbox delivery described in
[Rejected-action receipts for First Mate](#rejected-action-receipts-for-first-mate).
The inbox's durable same-ID replay prevents
new notes/wakes after uncertain HTTP delivery or restart. There is no model,
reasoning session, worker spawn or model retry/investigation on these paths.
Actual new user questions can wake First Mate through its ordinary inbox.

The pass has a 50-second total deadline, in addition to the adapter's individual
network/process/read bounds. Expiry stops the entire pass, including remaining
captures and mapped reply posts, and records a `timeout` health error with backoff.
A deadline-interrupted capture is not marked `capture-failed` solely for expiry;
the next eligible pass reconciles it with the same request ID. Launchd schedules normal successful passes about
60 seconds apart; successful polls tolerate timer jitter. Failures back off
60, 120, 240, 480, then at most 900 seconds;
launchd continues checking eligibility every 60 seconds without network, clavis
or inbox work during backoff. Overlapping ticks exit without work or counter
writes. Process death releases the lock and retains an interrupted health marker.
Retries use the same request IDs; no automatic model investigation is started.
Inbox capture/wake failures retain the existing Desk error and explicit Retry
delivery behavior. Renew expired credentials in clavis, check connectivity for
network errors, or check inbox readiness; deterministic polling recovers after
the next eligible tick. Diagnostics never echo secrets, bodies or subprocess
output. Status keeps the last successful result during failures.

## Validation and deployment evidence

Run `python3 -m unittest discover -s scripts/tests -p 'test_ask_puller*.py'`
(or the Ask Vitest suite) for plistlib round-trip, lifecycle command construction,
upgrade/disable persistence, locking/process-death, deadline, idle/slow-reply,
backoff/recovery and Linux packaging-hook behavior. These use isolated fixtures,
not a real vault, First Mate primary or launchd. `npm pack --dry-run --json`
must include both puller scripts, `services/ask-puller/agent.plist`, this runbook,
the CLI and postinstall hook. The package manifest explicitly includes them.

Before a real rollout, Firstmate records the PR and dev proof on the existing
[touch-to-ask card](https://app.notion.com/p/40f50ce6d42281b5a6b1c7058c0cde54).
The Mac operator owns actual install/login/reboot proof: retire the registered
check, run the install command, verify healthy status and increasing no-op counts
for ten minutes with no new notes/wakes, then send one owner-authenticated Ask.
Confirm one real inbox note, real primary reply, Answered in Desk, and return to
the source card/PR with its original filters. Reinstall and reboot/login, verify
continued health without duplicate delivery, then exercise disable/enable and
uninstall if required. Linux fixture evidence cannot establish launchd, clavis
unlock at login or a real primary answer; record those Mac results separately.
