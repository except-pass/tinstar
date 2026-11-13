# Waiting on First Mate

Overview does not show waits on First Mate by default. Each fresh wait sends
First Mate one inbox nudge on the existing check-in and workflow-notice bridge.
The note carries the card id, or the mate and key, plus the wait text and age.
The same open item is nudged again at most every two hours after a successful
announcement. Age-only updates and unrelated card edits preserve the pending
request and its original body across sweeps and restarts. Wait identity uses
the item ID, wait text and label, so age changes do not reset the nudge clock.
Each request ID keeps an immutable payload and membership. When
due waits or their text change, the sweep retires the pending request and reserves
a new ID. Closed, resolved, owner, and no-longer-fresh waits are excluded from
the new batch; an empty batch sends nothing. Retired requests are never offered
again, but late receipts remain accepted and update clocks only for waits whose
content matches the delivered note. An already captured retired request can
leave one extra note alongside its successor.
Only fresh items are nudged; incomplete coverage elsewhere does not block them. Dedup lives in the
same state file as the owner alerts and survives a restart.

The startup/60-second sweep computes and persists the due nudge. Bridge pulls
only read that local state file: they never refresh a snapshot, read the board
or fleet, or wait for the sweep. Source changes and delivery-disable settings
take effect on the next sweep. Receipt writes serialize only local state
updates; source reads and Notion comment delivery hold no state-write lock.
A slow owner alert cannot delay the bridge or overwrite an accepted receipt.

The owner's Overview shows a quiet "First Mate nudge still open" line only when
some still-open item was first nudged at least two hours ago. That line is not
a red banner and does not show coverage. Opening it shows the item detail.
The reconciliation scene still carries the full list. It stays global and
independent of Overview filters.

Cards match a trimmed, whole `Waiting For ID` of `First Mate`, `First Mate (main)`,
`Main`, or `main firstmate`, case-insensitively. First Mate with any parenthesized home label, mate identities, and configured
fleet labels also route to the inbox unless the card has an owner signal.
An active `Will action` tag or a dependency naming Will in either the ID or
wait text takes precedence over mate routing, including a stale mate ID.
Empty tags and `none`, `no`, `false`, `n/a`, `answered` or `resolved` are not
active owner signals. Otherwise, a populated dependency ID takes precedence
over the wait text. Each retained text line is parsed separately: workflow entries use only `Dependency: X`
before the first `|`, while legacy entries use `X: ...`, `X - ...`, or `via main`.
Follow-up owners and unblock conditions do not name the dependency. A prose mention alone never
matches; `Firstmate` and `firstmate maintainer` are different actors. Main identity matching
lives in `src/shared/waitingOnMain.ts`; candidate audience classification lives
in `src/server/reconciliation/waitingOnMain.ts`. Archived, trashed and Done cards are excluded.
Card age is an at-least estimate until Tin Star observes the wait start.
The initial estimate uses the card's last edit when the wait was first observed.
Unrelated later edits do not reset that saved age; changed
wait text starts a new conservative age. Notion does not publish a property
change timestamp in the existing board read. An invalid age stays unknown.

Mate asks come from the existing published fleet snapshots. Set the main
source's reconciliation fleet `label` to `main` and retain each child's exact
`parentHome`. Only immediate children of that main source contribute their
parent asks. Missing parent identity is shown as unknown, not guessed from a
filesystem path. Collecting the asks needs no main process, inbox read, or
terminal scraping.

The Tin Star collector `scripts/collectors/codex-activity.py` adds:

```json
{
  "parent_asks": {
    "status": "known",
    "observed_at": "2026-11-11T12:00:00Z",
    "items": [{"key": "api-choice", "corr": "1234567890abcdef", "state": "needs-decision", "at": 1794398400, "text": "Choose the API"}]
  }
}
```

It folds `state/parent-replies.status` in append order. The latest keyed
`blocked` or `needs-decision` line remains open until a later `resolved` with
the same key or correlation. `working` and `done` do not close it. A timestamp
is `[at=<epoch>]`, or a bare ` at=<epoch>` after the bracket metadata
(`needs-decision [key=k] at=1794498392: ...`). Either form ages the ask. Missing or
unreadable channels and incomplete appended lines produce unknown coverage.
An open keyed ask with a missing/malformed timestamp or malformed line stays
visible with a null timestamp and unknown age; it makes coverage unknown only
until it is resolved or replaced by a valid timestamped ask. Resolved historical
asks do not affect coverage. An explicit readable empty channel proves no asks.
The collection time dates the read, not the ask; an old unchanged channel can
still provide current knowledge. Copying a snapshot does not refresh its time.
Snapshot or ask observations five minutes old are unknown. Ask coverage is
independent of unrelated task/backlog completeness.

Main answers a keyed ask with `fm-send --resolve-key`. That appends
`resolved [key=…] [at=…]` to the mate's `state/<id>.status` in the parent home,
for a remote secondmate the same as for a local mate, and does not copy the line
into the mate's `state/parent-replies.status`. When the collected home has
secondmates, the collector also publishes `parent_resolutions`: each mate id,
the keys main resolved, and each line's `[at=]` time. The backstop drops an ask
when that mate's own channel already has a later resolved line for the key, or
when a fresh `parent_resolutions` entry for the mate shows the key resolved at
or after the ask's `[at=]`. The mate is the secondmate task on main's snapshot
whose home path is the child's fleet home. A missing publication, a stale one,
or an unknown entry for that mate closes nothing. Main's resolution cannot close
an ask with no timestamp or one reopened after the resolution.

Unknown/stale reads retain last-known items on the scene. The owner's default
view does not show an incomplete count. A fresh complete source can remove an
absent item. A matching
fresh main resolution also removes a saved mate ask, even when the child's
parent-ask coverage is unknown, stale, failed or missing; unrelated saved asks
remain. Unknown items are never used to send an overdue notification.

## Owner alerts

An independent server sweep runs at startup and every minute, even with no
browser open. The existing paced `NotionApi` and integration key create a
**Notion comment mentioning William Gathright**, user
`84d29212-4a5b-49f1-91bf-92b7adeff516`, only for waits classified as his under
the card classification rules above. Cards routed to First
Mate use the inbox nudge instead. This uses Notion's owner inbox/push
path; actual push delivery depends on the owner's Notion notification settings.
Owner-wait alerts are comments on that card. The nudge is offered on the
existing Ask bridge pull. No new notification service is involved.

On the first alert sweep, already-overdue owner waits produce **one summary comment**
on the backstop card `41550ce6d42281239fd4f9f20c901b80`, listing every known overdue owner wait with its key, age and
text (truncated to 200 characters per item). All included items record the
delivery outcome and attempt time. Subsequent newly-overdue
items and four-hour repeats use individual comments. An empty initial known
census initializes normally. An entirely unknown census waits for readable data.

User-read failure or a definite mention rejection falls back to a plain Notion
comment, recorded as owner alert not delivered (mention failed) in the saved
state; the mentioned alert is retried at the normal
once-per-four-hour cadence. A network timeout is ambiguous; it does
not cause an immediate second write. Each attempt is durably reserved before
posting and is eligible again four hours later, so crashes/restarts cannot spam
already-alerted items. Owner waits and their delivery status are excluded from
the Waiting on First Mate list. State read/write failure shows unknown and sends no comment,
preventing duplicate alerts after a lost throttle record. Restore a damaged
state file from backup, or move it aside to intentionally start a new summary.
Bridge state-read failures preserve the damaged file and return no nudge work
or ownership, so unrelated Ask work and receipts can still proceed.

State lives in `$TINSTAR_STATE_HOME/waiting-on-main.json`, defaulting to
`${XDG_STATE_HOME:-~/.local/state}/tinstar/waiting-on-main.json`, outside the
configuration directory. Preserve it across server releases. Previews/tests
must set a disposable `TINSTAR_STATE_HOME` and `waitingOnMain.deliveryEnabled:
false` in their isolated config. Config roots named `preview` and `NODE_ENV=test`
also disable delivery. Live installs default to enabled; the explicit setting
can disable both the owner comments and the inbox nudges. Waits stay on the
scene either way.

## Deployment and proof

Firstmate owns merge, deployment and live proof. Update the Tin Star collector
on each publishing machine using the existing [collector install](codex-activity.md),
then confirm fresh `parent_asks` fields in the transported child snapshots and
`parent_resolutions` in main's snapshot. Main's publishing machine must also run
the updated collector before its answers leave the backstop. No First
Mate repository change is required. Confirm main's fleet label and child parent
links before deploying the backend/client. Preserve alert state outside the
release/config trees. The first live enabled sweep sends the startup summary
if owner waits are already overdue and queues fresh First Mate waits for inbox
delivery; tests and preview proof use synthetic data and never write real comments.

Tests: `src/server/reconciliation/__tests__/waitingOnMain.test.ts`,
`npm run test:codex-collector`, and `e2e/waiting-on-main.spec.ts` cover matching,
fold/closure, unknown retention, payload/fallback, startup summary, restart
throttling, count, click details, inbox nudge dedup, the quiet two-hour indicator, and
incomplete coverage.
