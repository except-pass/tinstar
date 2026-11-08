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

For a fresh normal npm install on the designated Mac, one command installs and
enables the service as part of Tin Star (substitute origin, home and key reference):

```sh
TINSTAR_ASK_URL=https://your-tinstar.example.ts.net:8450 TINSTAR_ASK_HOME="$HOME/repo/firstmate" TINSTAR_ASK_TOKEN_KEY=tinstar.ask-bridge npm install -g tinstar@<release>
```

Use the same login/config root that will run the service; do not use sudo. For
an existing installed Tin Star, the canonical one-command service install is:

```sh
tinstar ask-puller install --url https://your-tinstar.example.ts.net:8450 --home "$HOME/repo/firstmate" --token-key tinstar.ask-bridge
```

`TINSTAR_CONFIG_HOME` (or legacy `TINSTAR_DATA_DIR`) selects the Mac's private
config root, default `~/.config/tinstar`. This is the **Mac** configuration, not
the remote Tin Star server config. Install persists only origin, home, key
reference, executable search path, clavis path and enabled state in mode-0600
`ask-puller.json`. The LaunchAgent uses the installed package's Python service
path and interpreter, never a copied worktree script. Its PATH is captured at
install so clavis and the inbox work without an interactive shell.

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
`queued` counts unanswered pending/tracked requests in the last successful
bridge read; it is not a current server queue while disconnected. `healthy`
requires a loaded agent and success within three minutes. An interrupted or
stale pass is visible; health never claims an answer is investigating. Status
also gives the next diagnostic action. No continuous agent watches the status.

The plist lives at `~/Library/LaunchAgents/com.tinstar.ask-puller.plist` and
launchd loads it into `gui/<uid>`. Login/reboot restores the enabled agent.
Disable unloads and persists disabled state across upgrades and login. Enable
or restart loads it again; restart preserves backoff. Uninstall unloads and
removes the plist/config; it retains private health for diagnosis and the lock
inode for safe overlap. Never delete a lock inode to clear a stale-looking PID:
the kernel releases the lock on process death.

Normal `npm install -g tinstar@<release>` / `npm update -g tinstar` runs the shipped
postinstall hook. A configured Mac regenerates/reloads the service when installed
paths or configuration change and ensures an enabled agent is loaded. Reinstall
is idempotent. Disabled installations stay disabled; unconfigured Macs and all
non-Mac installs do nothing. `--ignore-scripts` suppresses this npm integration;
after such an update, rerun the canonical install command with the saved settings.
A failed update hook reports failure; run the CLI and status from the installed
package to repair it. No separate service checkout or manually maintained plist
is involved. Desktop-only/browser-only installs do not designate a Mac puller.

## Idle cost, failure and retry behavior

Every launchd tick is a plain Python process. It obtains the nonblocking kernel
lock shared with the single-pass adapter, reads persisted backoff, reads the
credential from clavis, and calls the existing authenticated bridge. Empty work
never invokes the inbox. Delivered questions with no reply only read stored
receipts. Only pending questions call `note --request-id tinstar-ask-<UUID>`;
only mapped replies are posted. The inbox's durable same-ID replay prevents
new notes/wakes after uncertain HTTP delivery or restart. There is no model,
reasoning session, worker spawn or model retry/investigation on these paths.
Actual new user questions can wake First Mate through its ordinary inbox.

The pass has a 50-second total deadline, in addition to the adapter's individual
network/process/read bounds. A nonoverlapping successful pass is eligible again
after 60 seconds. Failures back off 60, 120, 240, 480, then at most 900 seconds;
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
