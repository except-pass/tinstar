# Ask First Mate

Slice 1 is one work card, text, **Sent / Delivered / Answered**, approved by
First Mate 2026-11-05 22:54Z. **Failed** reports a known delivery failure.
The compact Ask/Inspect refinement reuses this request store and bridge.

A left drag on a task, worker, or relationship opens a text composer for that
item. A right drag opens the same Inspector as the Inspect icon. The Ask speech-bubble icon in the existing Work/Worker header opens a blank,
focused overlay for exactly that entity. [Overview](overview.md) describes Inspect
and card expansion. The overlay does not change
card or relationship geometry and fits the phone viewport.

Right-click a task title, status, next check-in, Waiting For, owner, priority or
edit time for an editable deterministic draft. Right-click the background for a
blank question; right-click a relationship for a draft about its two endpoints.
Relationship paths also support Enter/Space. Dedicated Inspector claim Ask
icons target only claims in the current scene claims collection. Connection
fields and history text use the enclosing card/execution element context.
Links and controls outside these targets keep their native context menus.
Enter sends unless IME composition is active, Shift+Enter inserts a newline,
and Escape closes. Send question is available for touch. Right-click never
sends. See [shared element entry points](#shared-element-entry-points) for
hover, focus, touch and selection gestures; voice is outside this refinement.

The existing create endpoint still accepts `card_id` for work. An optional typed
`target` identifies a canonical execution, claim or artifact instead (see
[typed artifact origins](#typed-artifact-origins-and-returns)). Optional `field_key`
and `field_value` retain the clicked field; relationship endpoint IDs, basis,
verification and provenance are resolved from the server scene, never supplied
by the draft. Worker anchors retain the canonical execution ID in the legacy
`anchor.page_id` slot and have no external Notion URL. Fresh authoritative state,
not a draft or captured field value, remains First Mate's evidence.

Movement under 12 CSS pixels stays a tap. At 12 pixels, horizontal movement
must be at least 1.4 times vertical movement to lock. Vertical and diagonal
movement stay native and scroll. A horizontal drag that can still scroll an
overflow ancestor in that direction stays native. Once locked, a floating rail
stays anchored near the pointer-down point while its thumb tracks displacement:
Ask arms at 72 pixels left and disarms
at 58, Inspector arms at 72 pixels right and disarms at 58. Release uses the
current arm, not the farthest point, and reversing through a disarm threshold
clears that prompt immediately. Ask release opens the composer and does not
send. Inspector release opens the Inspector where that surface provides an
Inspector action; elsewhere, rightward drags stay native and show no Inspector
release prompt. Pointer cancellation, lost capture, scroll, Escape, window blur,
visibility loss and additional touches cancel without an action. Neutral release
and cancellation return the rail thumb to center before dismissal; reduced
motion dismisses it immediately. The rail sits above touch/pen contact or beside
the mouse origin, repositions within the visual viewport, and stays inside the
owning open dialog when present. Desktop drags on
semantic fields leave text selection native; an active selection prevents an
item swipe from opening Ask or Inspector. Nested surfaces give the nearest
item ownership of its swipe.

Your Desk has one application-level owner in `src/ask/DeskWorkspace.tsx`, above
Overview, PRs, Releases and worker navigation. Section changes, rail collapse and
mobile close keep the inbox, history, composer draft and answer selection mounted.
The existing owner-scoped store, 5-second Ask refresh and First Mate bridge are
unchanged. The Overview UI-command bridge disconnects while Overview is hidden
and reconnects on return without clearing its presentation state.

Desktop Desk opens by default. Drag the visible divider to resize, or focus it
and use Left/Right (16px) and Home/End (bounds). **Desk size → Reset Desk size**
restores the default. Width and collapsed state persist per browser/device in
`tinstar.desk.preferences`; unavailable storage uses usable defaults. Effective
width clamps to the available workspace without erasing the preferred width.
At 850px and below, a single global Desk button opens the same inbox in a sheet;
mobile open/close does not change the remembered desktop preference. Unread
answers and actionable/failed items remain counted on the collapsed entry.
Find worker and Message receipts remain accessible from the Desk header; on
mobile they close the sheet before opening the existing panel. PRs' Desk button
opens this workspace directly. Source health remains an on-demand Overview view.

Your Desk starts with readable question/answer records, followed by supported
actionable decision/request records. Operational queue introductions and counts
are omitted; decision controls and routing remain intact. The Ask states are **Sent** (Tin Star retained it), **Delivered** (First Mate
captured its note), **Answered** (correlated primary reply), and **Failed** (known
capture failure). No readiness/announcement/acknowledgement is misrepresented as
investigation progress. A missing puller or slow answer leaves a visible delay
message; retry uses the same logical request ID. Wake failure is shown even when
the note is delivered. New answers are unread; viewing marks them read. Dismiss
under the secondary Actions menu moves only the Ask into searchable history.
It does not dismiss a decision,
change Notion, approve work, merge or deploy.

Opening an item reveals its originating context, switching sections when
necessary, while retaining the conversation in Desk. Work items use existing
[Desk navigation](overview.md); inline answers and return controls are described
[below](#typed-artifact-origins-and-returns).
Link items retain the exact claim ID, reveal its endpoints and scroll to its card;
the flash targets that relationship, including unverified Detailed lines, rather
than every confirmed connection on the card. Inbox questions and answer previews
wrap legibly. Worker
answers reveal and highlight the exact originating execution. Active and
history items use the same return path. A task that cannot be shown gets the
captured canonical source link rather than another object. Follow-up creates a new request in the same
conversation and retains the original captured context. No raw audio is stored.

## Typed artifact origins and returns

The same composer supports PRs, action receipts, deployment targets and deployment receipts.
PR rows in both PRs and Releases ask about the actual GitHub PR. Right-click a
PR CI/review/changes field or deployment/receipt text to prepare an editable
question. Blank Ask icons remain blank, and native links outside semantic Ask
fields, selection, inspection, table scrolling and unavailable voice behavior
retain their existing interaction rules.

PR inspection uses the same editable semantic Ask surface for description,
footprint, card links and contributor evidence. Focus a semantic field and use
Shift+F10 (or the Context Menu key), or right-click it; the row Ask icon stays
blank. Semantic questions on these card links stay anchored to the PR; ordinary
left-click still navigates to the Notion card.
The shared Ask context optionally records server-resolved `relationships`:
active card IDs with association provenance, and exact current/retained worker
IDs, attempts, freshness and claims. Captured field text is a hint, never authority.

New contexts optionally carry `schema_version: 2`, a typed target, server-owned
source observation, and a canonical `return_to` locator. PR targets use the
canonical lowercase `repository#number` plus captured head when available.
Action receipt origins add `action_receipt_id` to the PR target. The server verifies
that the retained receipt belongs to that PR and supplies its action, installed
version/digest, actor, outcome, captured identity and result in `action_receipt`.
See the [installed PR actions guide](../pr-actions.md) for execution boundaries.
Deployment targets add target/component; receipt targets also carry the immutable
receipt ID. Shared `src/shared/ask.ts` owns this contract. Source metadata and
return targets are resolved through the same PR/Releases projections used by the
screens or the scoped individual PR read described below, after the existing
Ask owner authentication. Client field text and head are hints; First Mate still
investigates fresh authoritative sources. A missing,
superseded or out-of-scope object is reported honestly. No linkage is inferred
from names or titles.

Existing stored Work/Worker/Link contexts remain readable without a migration;
legacy return navigation is derived as Overview. The request IDs, client retry
keys, follow-up correlation, owner scoping, `tinstar.ask.v1` bridge envelope and
reply callback remain unchanged. New receipt/PR follow-ups retain their original
captured context even if the source disappears later. Client-supplied provenance
or return locators are not accepted by the create endpoint.

Opening an artifact conversation uses the existing browser history and a typed
URL locator to reveal the exact authorized PR or release row despite the current
filter. Deployment/receipt origins reveal their read-only evidence inline in the
main workspace. Action receipt origins open and focus the matching retained receipt
in PRs or Releases. Source removal, receipt replacement and changed PR heads have
visible fallback messages; source links remain available in the answer. Manual
section navigation or clearing the origin ends pending focus.

Desk returns to a PR with its captured query/sort intact, temporarily reveals,
expands and focuses the canonical row, and keeps the answer open. A closed PR
is read individually through owner-only `GET /api/pulls/origin?url=…`; this does
not add closed PRs to the open inventory. The same configured repository and
owned/authored/explicitly-associated relevance scope applies. Changed heads are
labelled; failed or inaccessible reads retain the answer and original GitHub
link. “Show all PRs in this view” removes only the temporary reveal.

Answers expand inline in the persistent Desk, with neighboring conversation
previews still available in one click. Correlated follow-ups share one thread;
collapse, history, unread status, dismiss, references and suggested actions retain
the existing request/permission boundaries. See [continuous text conversations](#continuous-text-conversations)
for the shared composer and inline reply behavior.
On mobile, opening a conversation keeps the Desk sheet open; close it to see
the revealed origin in the main workspace.

Normal browser history entries store the previous section's query, sort, filters
and grouping before a Desk jump. Back (or the thread's Back to previous view
control) restores those fields once source data is ready. Pending restoration
cannot be overwritten by a departing loading view. Selection, collapsed groups,
expanded rows, detail data and scroll positions are not restored across history.
The expanded conversation stays visible during navigation and the one-step return.
Unresolved source origins retry while current; newer navigation cancels that work.

## Configuration and trust boundary

Use the existing `config.json` under `getConfigRoot()` (normally
`~/.config/tinstar`, overridden by `TINSTAR_CONFIG_HOME`). Add an `ask` object:

```json
{
  "ask": {
    "ownerLogins": ["owner@example.com"],
    "bridgeToken": "<server-only random secret of at least 32 characters>"
  }
}
```

The operator provisions the same bridge token into the Mac's clavis vault.
Protect config and state with the server account's filesystem permissions.
Neither the API nor frontend returns this token. Do not place it in a URL,
command argument, screenshot, source control or log.

Serve this instance through **tailnet-only tailscale serve, never Funnel**, with
the backend bound to loopback and inaccessible directly from other hosts. The
browser owner comes exclusively from the `Tailscale-User-Login` header injected
and overwritten by serve and must exactly match a configured login. Missing or
unlisted logins fail closed. Ask rejects non-loopback browser API peers to prevent
remote direct clients from spoofing the header. Local OS users are inside the
host trust boundary; do not expose the backend through an unauthenticated proxy
that preserves a client-supplied header. CORS is not authentication. Tauri/direct
local access without the trusted owner header cannot use this owner Desk.

Browser requests require `X-Tinstar-UI: 1` in addition to owner identity. Any
supplied Origin must be allowlisted; an absent Origin is accepted. No
browser-provided principal is accepted in submission bodies. The
bridge uses its own bearer token and accepts no browser Origin. The configured
owner boundary and bearer authentication are deliberately separate. The bridge
token grants access to all Ask requests and answers in this instance, so restrict
it to the designated primary-home puller and the trusted
[post-deploy smoke helper](floor-deploy.md#synthetic-ask-isolation). That reference
owns the synthetic partition protocol and its additional authentication requirements.

## Outbound-only Mac puller

`scripts/ask-puller.py` is a Python 3 standard-library, single-pass adapter. It
runs on the main First Mate home host. The Mac initiates HTTPS requests to Tin
Star; Tin Star never executes a remote shell or an arbitrary command. Tin Star
ships a managed Mac LaunchAgent; see the [service install and runbook](ask-puller-service.md)
for installation, lifecycle commands, upgrades, health and whole-pass deadline behavior.

The adapter reads the token using `clavis get <reference>` into process memory. It never
passes the value in subprocess argv or prints it. Redirects are refused so the
bearer cannot be forwarded to another host. It makes one pass and prints only
capture/reply/failure/queued counts, or a generic error. Inbox stderr, other primary notes and
API payloads are not logged. A failed run can be run again; errors do not lose
Tin Star's retained request or the inbox's durable note. Direct adapter invocations
report their exit status; managed service health is described in the runbook.

1. `GET /api/ask/bridge` with server-side bearer returns up to 50 pending
   requests (`request_id`, `inbox_request_id`, text `body`) plus tracked note
   mappings. Sent requests are retried on the next pass. Capture failures await
   the owner's **Retry delivery**; saved-but-unannounced failures also expose
   retry. An uncertain HTTP response is retried with the same ID.
2. For each pending request the puller invokes, locally and with body on stdin:
   `FM_HOME=<home> <home>/bin/fm-inbox.sh note --request-id
   tinstar-ask-<request-UUID> --json -`. Exit 0 is captured; exit 3 is saved but
   the primary was not woken. `note --request-id` replays/repairs without a new
   note or duplicate wake. No `ask` side-model call is used.
3. `POST /api/ask/bridge` sends `{request_id, note}` with the
   `fm-inbox-note.v1` capture result. Tin Star validates the request binding,
   retains the separate note ID and marks Delivered. A capture failure sends
   `{request_id, error:"capture-failed"}`; wake failure uses `"wake-failed"`.
   Public errors are fixed messages, never unfiltered command output.
4. The primary investigates and publishes its real answer with
   `fm-inbox.sh reply <note-id> -`. That protocol permits one immutable reply
   per note. A follow-up has a fresh request/note and the same conversation ID.
5. The puller reads `fm-inbox.sh receipts --all-pending --all-handled
   --all-replies`. It joins only tracked notes and verifies `request_id`.
   Unrelated inbox content is never posted to Tin Star. Omitted receipts or a
   rejected mapped reply do not block other mapped replies within the service's
   whole-pass deadline; after processing
   them, the pass exits with a generic failure to report incomplete coverage. It posts
   `{request_id, reply:{id,at,body,cursor}}`; `id` must match the retained note,
   `at` is UTC ISO time and `cursor` is the inbox's per-home sequence string.
   Duplicate/older sequences are no-ops. A conflicting later immutable answer
   is rejected. Delayed delivery/error acknowledgements cannot regress Answered.

The Ask body contains `tinstar.ask.v1`, logical request/conversation IDs,
authenticated principal, question/input mode/time and structured captured context.
The server derives anchor identity, canonical URL, label and freshness from its
authorized scene or artifact projection; labels are snapshot evidence. The primary should re-read authoritative
sources and distinguish their freshness from that snapshot.

Plain-text primary replies work. For evidence and suggested actions the primary
can publish this JSON as its reply body (fill IDs/content, no credentials):

```json
{
  "schema": "tinstar.ask-reply.v1",
  "request_id": "<Tin Star request UUID>",
  "summary": "Short answer",
  "detail": "Full explanation grounded in current evidence",
  "references": [{"label": "Source", "url": "https://example.com/evidence"}],
  "suggested_actions": [
    {"id": "close-done", "label": "Close as Done", "instruction": "Post the Feed verdict and set the linked Notion card Done"},
    {"id": "keep-open", "label": "Keep open", "instruction": "Retain the card until Feed recovery is verified"}
  ]
}
```

Only credential-free HTTPS reference links are retained. Plain text is displayed
as text, never executable HTML. Limits include a 4,000-character question,
32,000-character answer, 20 references and 10 suggested actions. API JSON bodies
are bounded to 256 KiB; the puller has process/network timeouts and bounded reads.

Structured recommendations use the strict bounded prose schema in
[`ask-actions.ts`](../../src/shared/ask-actions.ts): per-answer unique IDs,
short labels and instructions without links or source-code containers.
Historical string suggestions still display as inert text.
Malformed structured reply content is accepted with `reply.degraded: true`.
String summaries and details are truncated to their schema limits; a missing or
invalid summary falls back to the first 240 characters of the reply body, and a
non-string detail falls back to the full bounded reply body. Only the first 20
valid references are retained. An invalid suggested-action collection is dropped
as a whole, so it creates no buttons and cannot delay other answers in the
installed puller. Request/note correlation and immutable-answer conflicts still
reject delivery.
The first three structured choices appear as compact buttons immediately after
the answer; remaining choices use a “More choices” disclosure.
The shared inline composer remains available for free-form clarification.

## Persistence and verification

`ask-requests.json` under the config root is an atomic, serialized, mode-0600
server store, separate from the legacy fleet outbox. It retains questions,
answers, read state and dismissed history indefinitely by default. There is no
automatic 24-hour expiry or prune-on-reply. Operator-directed data deletion is a
separate explicit maintenance action; dismissal only changes inbox visibility.
Back up this file using the server account's normal private state backup.
Browser reloads and a second device read the same owner-scoped retained state.
If storage is unreadable, Ask fails visibly rather than replacing it with an
empty file. The standalone server's singleton makes one process the writer.

Automated proof runs the HTTP API and the executable puller with isolated homes,
inbox/clavis stand-ins; it is adapter behavior proof, not a real primary answer.
The full real proof requires the operator to install/configure the puller, an
owner-authenticated question created through Tin Star, a primary-published reply,
a second pass, and Desk return-to-context screenshots at one frozen commit.
Physical iPhone Safari/Android Chrome behavior must be documented separately
when devices are available; simulated touch does not prove physical mic paths.

```sh
npm run typecheck
npm run lint
npm run build:all
npm run test:unit
```

The unit suite includes gesture lock/thresholds, UI context/return/history,
owner/auth isolation, retry/correlation/out-of-order persistence, the HTTP/puller
integration, and Python CLI safety tests. Existing Overview/compact/link/queue
and MCP behavior remains part of the regression suite.


## Follow-up slices

The remaining parent-card items are follow-up slices:

- Worker context enriched with observed attempt/home beyond the execution ID
  anchor; removable additional context chips beyond the single originating
  Work, Worker or Link context.
- Discoverable microphone controls with press-and-hold and accessible tap-toggle
  recording, local transcription, cancellation and text fallback. Voice remains
  a separate slice on the composer microphone. Right drag is the Inspector rail
  above, not a second voice gesture.
- Queued, Investigating and Needs input/decision lifecycle updates, progress and
  revision-aware delivery; unified priority for decisions, unread answers,
  investigations and failures.
- Richer reassignment, stale and inaccessible context handling beyond the
  current scene availability check and captured source-link fallback.
- Full parent-card failure, permissions, accessibility and reduced-motion proof;
  physical iPhone Safari and Android Chrome touch/microphone verification remains
  an explicit review gate when devices are available.

## Shared element entry points

`useElementAsk` and `askElement` in `src/ask/` provide one field contract for
Overview cards (including expanded relationship hints and card/execution
Inspector fields), PR rows/details, Releases rows/evidence, and Desk items
including Card context text. Manager, group and First Mate Inspector selections
do not expose element Ask. Existing `data-ask-field`
markup works with the same hook. Hover or focus a field to reveal the floating
Ask control without changing layout. Tab from a focused field reaches that
control; Shift+F10 / Context Menu still opens the semantic draft directly.
Inside an open modal, the floating control stays in that modal.
Right-click and a stationary 550 ms touch hold use the same context builder and
existing field templates. Moving more than 10 px, scrolling, cancellation or a
second touch cancels the hold; a successful hold cancels the item swipe and its
synthetic click. Selecting text inside one item offers **Ask about this**. A
selection crossing item boundaries or outside an item does not.

The optional `element` metadata in the create/context schemas captures the
displayed label (e.g. `Overdue 3d` plus the formatted check-in), value and
deterministic question type. The authoritative shape and limits live in
`askElementSchema` in `src/shared/ask.ts`. Existing `field_key` / `field_value`,
server-owned item origins, bridge delivery, inline threads and Desk returns
remain the same path. The sheet shows the captured element and an editable
suggestion, using the composer keyboard controls described above.

## Continuous text conversations

Expanded Desk conversations include a persistent **Reply to First Mate** field.
It uses the same text composer as card, worker, relationship, PR and Release Ask
entry: Enter sends, Shift+Enter adds a line, and composing with an IME does not
send. Escape closes a new-question dialog; in an inline reply it returns focus
to the conversation's collapse control and preserves the draft. Semantic Ask on
Desk advice also replies in that conversation. Section switches preserve the
mounted thread and draft; server history survives reload and another browser.
Voice capture/transcription is a separate feature slice.

A follow-up persists its exact `follow_up_to`, the stable conversation ID and the
original typed source context. Its literal question is sent with ordered prior
user questions, First Mate replies (including references and suggested actions),
and any operator action selections. Each history turn retains its request ID,
timestamp and provenance. Legacy answers without a recorded reply timestamp use
the request timestamp, explicitly marked `timestamp_basis: legacy_request`.
History is quoted prior conversation, never fresh evidence or authorization.

Semantic replies retain the selected element and field hints separately as
`captured_selection`, without replacing the original source context. The
selection accompanies the current dispatch and its persisted user history turn.
A successful send consumes the suggested draft and selection; an uncertain
retry retains the original submission envelope.

The existing `tinstar.ask.v1` inbox JSON adds
`conversation: {schema: "tinstar.ask-conversation.v1", turns, omitted, retrieval}`.
The current question stays outside prior turns. Bodies freeze at request creation
(legacy pending requests freeze on first bridge read) so a lost acknowledgment,
retry or delayed answer cannot change a note under its idempotency ID. The
installed `scripts/ask-puller.py` continues forwarding `pending[].body` verbatim;
no Mac puller update, parallel bridge or scheduler is needed.

Dispatched history retains a contiguous suffix of complete turns within **24 KiB
of serialized UTF-8 JSON**, including escaping. When older turns do not fit,
`omitted` identifies their count, first/last turn IDs and timestamps. It never
silently truncates a message or supplies an invented summary. Captured context
has its own 24 KiB budget: excessive saved view state and optional evidence are
omitted with explicit field names, while the canonical typed anchor survives.
Full unpruned history and captured context are retrievable through:

- `GET /api/ask/conversations/<conversation_id>` with the existing owner/UI authentication.
- `GET /api/ask/bridge?conversation_id=<conversation_id>` with the existing bridge bearer authentication.

Retrieval may contain newer turns; match the omitted IDs. If full history cannot
be retrieved, ask for it before relying on the missing content. Pending batches
account for outer JSON escaping and stay below the installed puller's 2 MiB read
bound. The store remains the only persisted conversation source; private frozen
bodies and retry-key aliases never enter browser records.

The shared selected-action seam is
`AskStore.createActionSelection(owner, {answer_id, action_id, client_key}, lookupAction)`.
The host supplies canonical membership lookup from the stored answer. The store
checks owner, answered request, current-answer freshness and single-choice
consumption atomically. Same-key retries and another device's same action recover
one request before staleness checks; competing choices conflict. Converged device
keys remain bound to that request across reloads.

A selection creates a normal correlated bridge request, with canonical instruction
as its question and `action_selection` metadata identifying selection, answer,
action, label, authenticated actor and selection time. History labels it
`role: action_selection`, provenance `operator_selection`, distinct from model
recommendation and free text. Tin Star executes nothing. Its statuses describe
sent/delivered/answered/failed delivery; First Mate's ordinary immutable answer
supplies the outcome.

The owner-authenticated `POST /api/ask/selections` accepts only
`{answer_id, action_id, client_key}`; the server resolves the canonical instruction
from the saved typed recommendation under the store lock.
The browser supplies neither actor nor instruction text.
Clicking once creates that request without a dialog or another Send click.
The UI maps persisted Sent to Requested, then shows Delivered or Answered only
when the corresponding bridge evidence exists.
Answered means First Mate replied; read that reply for completion, a permission
block or an uncertain effect requiring reconciliation.
No execution outcome is inferred by Tin Star.
Historical buttons remain visible and disabled after a later assistant reply,
with an explanation that those recommendations are outdated.
An unknown network acknowledgement offers a retry of the same selection/key;
a definitive stale or conflicting selection reports the server's rejection.
Existing delivery retry controls retain the selected request's note identity.
