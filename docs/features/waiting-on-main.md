# Waiting on First Mate

Overview shows an independent **Waiting on First Mate** count and oldest age.
Click it to see each card or mate, key, age and request text. At four hours the
control turns red. It is global, independent of Overview filters.

Cards match `Waiting For` or `Waiting For ID`, case-insensitively: `First Mate`,
`First Mate (main)`, `Main:`, `via main`, or `main firstmate`. Matching lives in
`src/shared/waitingOnMain.ts`. Archived, trashed and Done cards are excluded.
Card age is an at-least estimate until Tin Star observes the wait start.
A card's age is a conservative **at least** value: its last edit when the wait
was first observed. Unrelated later edits do not reset that saved age; changed
wait text starts a new conservative age. Notion does not publish a property
change timestamp in the existing board read. An invalid age stays unknown.

Mate asks come from the existing published fleet snapshots. Set the main
source's reconciliation fleet `label` to `main` and retain each child's exact
`parentHome`. Only immediate children of that main source contribute their
parent asks. Missing parent identity is shown as unknown, not guessed from a
filesystem path. No main process, inbox delivery or terminal scraping is needed.

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
the same key or correlation. `working` and `done` do not close it. Missing or
unreadable channels, malformed keyed timestamps and incomplete appended lines
produce unknown coverage. An explicit readable empty channel proves no asks.
The collection time dates the read, not the ask; an old unchanged channel can
still provide current knowledge. Copying a snapshot does not refresh its time.
Snapshot or ask observations five minutes old are unknown. Ask coverage is
independent of unrelated task/backlog completeness.

Unknown/stale reads retain last-known items and show an incomplete count (`N+`
or `unknown`). Only a fresh complete source can remove an absent item. Unknown
items are never used to send an overdue notification.

## Owner alerts

An independent server sweep runs at startup and every minute, even with no
browser open. The existing paced `NotionApi` and integration key create a
**Notion comment mentioning William Gathright**, user
`84d29212-4a5b-49f1-91bf-92b7adeff516`. This uses Notion's owner inbox/push path;
actual push delivery depends on the owner's Notion notification settings.
Card alerts are comments on that card. Mate asks use the backstop card
`41550ce6d42281239fd4f9f20c901b80`. No First Mate delivery or new notification
service is involved.

On the first alert sweep, already-overdue items produce **one summary comment**
on the backstop card, listing every known overdue item with its key, age and
text (truncated to 200 characters per item). All included items record the delivery outcome and attempt time. Subsequent newly-overdue
items and four-hour repeats use individual comments. An empty initial known
census initializes normally. An entirely unknown census waits for readable data.

User-read failure or a definite mention rejection falls back to a plain Notion
comment, recorded as owner alert not delivered (mention failed) and shown red on the Overview item; the mentioned alert is retried at the normal once-per-four-hour cadence. A network timeout is ambiguous; it does
not cause an immediate second write. Each attempt is durably reserved before
posting and is eligible again four hours later, so crashes/restarts cannot spam
already-alerted items. Failed/unconfirmed delivery is shown in the expanded
Overview list. State read/write failure shows unknown and sends no comment,
preventing duplicate alerts after a lost throttle record. Restore a damaged
state file from backup, or move it aside to intentionally start a new summary.

State lives in `$TINSTAR_STATE_HOME/waiting-on-main.json`, defaulting to
`${XDG_STATE_HOME:-~/.local/state}/tinstar/waiting-on-main.json`, outside the
configuration directory. Preserve it across server releases. Previews/tests
must set a disposable `TINSTAR_STATE_HOME` and `waitingOnMain.deliveryEnabled:
false` in their isolated config. Config roots named `preview` and `NODE_ENV=test`
also disable delivery. Live installs default to enabled; the explicit setting
can disable comments without hiding the count.

## Deployment and proof

Firstmate owns merge, deployment and live proof. Update the Tin Star collector
on each publishing machine using the existing [collector install](codex-activity.md),
then confirm fresh `parent_asks` fields in the transported snapshots. No First
Mate repository change is required. Confirm main's fleet label and child parent
links before deploying the backend/client. Preserve alert state outside the
release/config trees. The first live enabled sweep sends the single startup
summary; tests and preview proof use synthetic data and never write real comments.

Tests: `src/server/reconciliation/__tests__/waitingOnMain.test.ts`,
`npm run test:codex-collector`, and `e2e/waiting-on-main.spec.ts` cover matching,
fold/closure, unknown retention, payload/fallback, startup summary, restart
throttling, count, click details, the red boundary and incomplete coverage.
