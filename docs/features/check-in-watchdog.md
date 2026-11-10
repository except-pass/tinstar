# Next check-in watchdog

Tin Star checks overdue **status-update appointments**, not delivery deadlines.
The existing fleet source-refresh interval calls the watchdog; it runs at most
once every five minutes, skipping an overlapping scan. There is no separate
service, model call, browser timer, or Notion writer for this feature.

Only the configured Notion data source and `Owner: Firstmate` cards in
`In Progress` or `Waiting For` qualify. Blank/invalid check-ins are not overdue.
All other statuses, archived/trash cards and other owners are excluded.
Date-only appointments mean **9 AM America/New_York**, including DST changes.
Timestamp offsets and Notion's explicit date timezone are respected. At the
exact appointment instant a card is not yet overdue.

An exact canonical `First Mate tasks` declaration, confirmed/current claim and
fresh running execution can name one worker **via First Mate**. Candidate title
matches, missing workers, multiple canonical workers, conflicting generations,
parked/finished workers and stale/unknown sources all request reconciliation
from First Mate. The latest scheduler snapshot is aged again before selecting
the route; a missing graph after restart also routes to First Mate. Waiting For
asks whether the named dependency changed, not why coding has not progressed.

## Delivery and persistence

System check-ins have their own private `check-in-requests.json` beside
`ask-requests.json` under `getConfigRoot()`. They never create an owner Ask,
owner approval, Desk conversation or worker dispatch. Records retain the exact
original checkpoint and use canonical card ID + appointment instant as the
idempotency key (equivalent timezone renderings are the same epoch).

Tin Star's existing backend singleton owns each config root. A serialized
writer reloads the system store and atomically replaces a mode-0600 file. The
request UUID, body and offered time are durable before the existing
authenticated `/api/ask/bridge` returns them. The unchanged Mac puller uses its
existing durable `fm-inbox.sh note --request-id` replay mechanism. Lost responses,
capture failures, failed wakes, restarts and repeated UI reads reuse the same
request and immutable body. One outstanding original request and at most one
follow-up exist per appointment. Failed deliveries retry automatically through
the same bridge. There is no separate retry daemon.

Before exposing a pending request, Tin Star performs an uncached GET of the
exact Notion page and verifies both page ID and configured data source. Changed
owner, status, checkpoint, trash or archive suppress the original request.
Preflight reads have a five-second timeout; bridge batches attempt at most
three pages and rotate so one failed page does not starve the rest. This keeps
the existing puller's 20-second HTTP read bound. Fleet refreshes stay on the
source-refresh path rather than delaying bridge work. A suppressed appointment
never silently acquires another request ID.

After two hours without a substantive acknowledgement, a single persisted
follow-up flags the unresolved request to First Mate. An unsupported "still
working" reply does not stop it. Moving the date without verified evidence
also does not evade this one follow-up on a still-active integrated card: its
body includes both original and current checkpoints. Closed/out-of-scope cards
receive no new request. The old exception remains visible until a legitimate
readback. Ordinary waiting never creates owner alerts or approvals.

Defaults require no new live config. Optional `config.json` settings:

```json
{
  "checkInWatchdog": {
    "graceMs": 7200000,
    "deliveryEnabled": true,
    "previewDeliveryEnabled": false
  }
}
```

Delivery is disabled by default when `NODE_ENV=test` or the config-root basename
contains `preview`. Preview opt-in is explicit; use isolated fake bridge tokens
and a fake First Mate inbox. `deliveryEnabled:false` pauses delivery without
discarding accepted state; turning it back on resumes those same IDs. No live
configuration edit is needed to enable the ordinary installed service.

## Notion closure and repair

First Mate owns the investigation and uses its existing authorized writer to
post a concise dated update to the **original card** and set `Last touched by`.
The inbox request supplies this human-readable checkpoint shape, together in
one paragraph or unresolved page comment:

```text
Check-in request: <original request UUID>
Date: 2026-11-10T15:10:00Z
By: Firstmate
Progress: Completed the reader; a failed fixture delayed the checkpoint.
Evidence: <PR, test receipt, report, or concrete substantive finding>
Blocker/owner: none; Firstmate
Next action: Validate delivery against the recorded receipt
Next check-in: 2026-11-10T17:00:00Z
```

First Mate replies through the ordinary inbox reply command, ideally with the
same completed text. Tin Star records that immutable reply separately from
resolution. It verifies an uncached Notion paragraph/comment with the original
request ID, a valid date after the request, substantive progress/evidence,
blocker/owner, next action, attribution matching `Last touched by`, and next
checkpoint matching the current property. An active In Progress checkpoint
must fit the board ceiling (four hours during business-day 8 AM–8 PM ET working
hours, otherwise 10 AM the next business morning). A real dependency date on
Waiting For may be later. Done/Archived can use `Next check-in: closed` with a
dated evidence-backed closing checkpoint.

The system never writes a property or comment, moves a card, or overwrites a
newer edit. A reply, commit, status move, or date change alone does not resolve
the old appointment. Its quiet card line retains the original timestamp;
replies say **Answered; Notion update pending** until verification succeeds.

A partial read can establish a complete matching checkpoint that it actually
contains; absent/truncated data never establishes closure. Comments require
the existing integration's read-comments permission and only unresolved page
comments are listed by [Notion's comments API](https://developers.notion.com/reference/list-comments). If unavailable, use a card paragraph instead.
Readers are bounded; put the checkpoint in accessible card prose, not a code
block or unsupported embed. These are source limitations, not model judgments
about progress. First Mate remains responsible for the truth of the evidence.

To repair a pending verification, First Mate corrects/adds the attributed dated
checkpoint on the same card; the next sweep verifies it even after a plain
immutable inbox reply. A mismatched/newer property never gets overwritten.
The single follow-up can also carry the missing answer, using the original
request ID for the Notion checkpoint. No hand-edit of the private store or
second Ask is needed. A genuinely new scheduled instant is a new epoch, and
becomes eligible only when that time passes.

## Read-only proof seam

```sh
npm run --silent check-in:report -- --config-home /path/to/authorized/config
npm run --silent check-in:report -- --snapshot /tmp/sources.json --at 2026-11-10T15:00:00Z
```

The report lists each card's eligibility/due reason and deterministic recipient.
It constructs neither a watchdog store nor a bridge client, starts no timer,
and cannot deliver requests. A saved snapshot needs no live credentials. Treat
reports as private task evidence because source card IDs/dependencies appear.

## Firstmate-owned live proof after merge and guarded deploy

Candidate cards, read through Notion at 2026-11-10 01:02Z, **not changed for tests**:

| Case | Candidate and observed properties | Proof prerequisite |
| --- | --- | --- |
| A | [This watchdog implementation](https://app.notion.com/p/41450ce6d42281bf93f3c87f9417169c), In Progress, Firstmate, next `2026-11-10T15:00:00.000Z`; canonical task `tinstar-checkin-watchdog` | Reconfirm one fresh active worker at proof time; if this implementation has finished, choose another existing low-risk In Progress card with an exact confirmed live worker. A completed implementation must not masquerade as the live-worker control. |
| B | [Touch-to-ask](https://app.notion.com/p/40f50ce6d42281b5a6b1c7058c0cde54), Waiting For, Firstmate, next `2026-11-10T15:00:00.000Z`; recorded dependency is Mac Ask puller update policy | Re-read the dependency because the historical owner decision may already have changed; confirm no running worker from fresh configured snapshots. Multiple parked/finished historical links should route reconciliation to First Mate. |
| C | [Desk v2](https://app.notion.com/p/41350ce6d42281d7b7b3eb2d899d7b17), Ready for Review, Firstmate, next `2026-11-09T22:00:00.000Z` | Keep excluded despite its already-past timestamp; no request or follow-up. |

Candidate source limitation: Notion's SQL Query Data Source entitlement limit
was reached; direct page fetches established these properties. They are a
candidate plan, not runtime-liveness proof. Fresh report/snapshot readbacks at
the deployed head are required. Do not change a production/customer date to
manufacture an overdue appointment. Wait for a genuine low-risk appointment,
or obtain an explicit safe test plan through Firstmate.

1. Freeze the merged/deployed head and verify candidate statuses, data source,
   worker facts, read permissions and Mac puller health before the proof. Use
   the report-only CLI to capture A/B/C decisions without delivering. Preview
   UI proof, if needed, uses free ports 5293–5296 and their matching private
   `/home/farm/srv/tinstar-preview-config-N` roots with delivery disabled.
2. For a real overdue eligible appointment, capture the exact original property
   with timezone, Status/Owner/Waiting For, canonical worker tuple, observation
   timestamps/freshness, last relevant checkpoint and a before screenshot.
3. Let the deployed service's existing refresh tick run. Capture store key,
   original request UUID/body, offered time, inbox request ID, durable note ID
   and announcement result. Verify one system note, no owner Ask/approval or
   direct worker dispatch. For B the prompt names the dependency. For C record
   exclusion and absence of any store/bridge request.
4. First Mate routes A if appropriate, investigates B itself, then writes the
   dated evidence/blocker/owner/next-action checkpoint on the same card through
   its existing authorized writer. Capture the immutable reply receipt and
   cursor, raw Notion paragraph/comment, exact next property, `Last touched by`
   and page edit time. Capture the **Answered; Notion update pending** line
   before readback completes, then the cleared line afterward.
5. Repeated refreshes/two UI windows and a Firstmate-controlled guarded service
   restart must retain the same request/receipt and resolved verification, with
   no duplicate note. Record head, restart times, persisted verifiedAt/block ID,
   screenshots and no additional inbox IDs. Let a genuine new appointment pass
   before expecting a second epoch. Unit fixtures cover transient failure,
   overlapping scans, one grace follow-up, invalid replies and changed cards;
   do not fabricate a two-hour live miss solely for testing.
6. Firstmate records PR/CI/deploy receipts, A/B/C before/after values, request and
   response IDs, exact Notion readback, screenshots and source limitations on
   the original watchdog work card. This worker does not merge, deploy, operate
   the live puller, or claim that fixture proof establishes the live result.
