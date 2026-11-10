# Ask First Mate

Ask/Inspect and the persistent Discuss share the existing owner-scoped request
store and First Mate bridge.

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
hover, focus, touch and selection gestures; see [local voice](voice.md) for microphone input.

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
overflow ancestor in that direction stays native. Work cards, worker cards and
relationship detail rows share an in-place reveal: the card body follows the
drag inside a clipping box, exposing teal Ask on a left swipe or blue Inspector
on a right swipe. The rail is clipped to the exposed strip during dragging and
spring return, preserving transparent content on cards, blocks and table cells.
Travel resists past the arm point and stays within 80% of the
card width. Only an armed action shows its label and release prompt.
Ask arms at 72 pixels left and disarms
at 58, Inspector arms at 72 pixels right and disarms at 58. Release uses the
current arm, not the farthest point, and reversing through a disarm threshold
clears that prompt immediately. Ask release opens the composer and does not
send. Inspector release opens the Inspector where that surface provides an
Inspector action; elsewhere, rightward drags stay native and show no Inspector
release prompt. Pointer cancellation, lost capture, scroll, Escape, window blur,
visibility loss, an opening blocking modal and additional touches cancel without
an action. Neutral release and cancellation spring the body back in 220 ms;
reduced motion restores it immediately. The reveal stays inside its own card
without a portal. Desktop drags can start on semantic fields while leaving
text selection native; an active selection prevents an
item swipe from opening Ask or Inspector. Nested surfaces give the nearest
item ownership of its swipe.

Discuss has one application-level owner in `src/ask/DeskWorkspace.tsx`, above
Overview, Decisions, PRs, Releases and worker navigation. Section changes, rail collapse and
mobile close keep the inbox, history, composer draft and answer selection mounted.
The existing owner-scoped store, 5-second Ask refresh and First Mate bridge are
unchanged. UI-command bridge availability follows the
[MCP session contract](reconciliation-mcp.md#start-and-connect).

Desktop Discuss opens by default. Drag the visible divider to resize, or focus it
and use Left/Right (16px) and Home/End (bounds). Double-click the divider to
restore the default width. Width and collapsed state persist per browser/device in
`tinstar.desk.preferences`; unavailable storage uses usable defaults. Effective
width clamps to the available workspace without erasing the preferred width.
At 850px and below, a single global Discuss button opens the same inbox in a sheet;
mobile open/close does not change the remembered desktop preference. Unread
answers and actionable/failed items remain counted on the collapsed entry.
The compact header contains only **Discuss** and collapse/close. PRs' Discuss button opens this
workspace directly. Source health remains an on-demand Overview view; worker
switching stays available in worker detail.

**Needs you**, **Waiting** and **History** provide one compact text control with
conversation counts. The Needs you badge counts unread answers, failed deliveries and current structured actions; read, completed answers remain in its list without contributing to the badge. Formal requests remain in Decisions and do not contribute to Discuss counts.
Waiting contains questions whose latest turn has no answer, unless an unread
answer or known failure still needs attention. History contains only dismissed
conversations and supports search across their questions, source names and answers.
Restore and Undo clear dismissal without changing read state.
Follow-up turns count as one conversation and retain their own request identities.
Expired source evidence or failed queue reads never contribute ready decisions.

Ordinary Ask copy is **Waiting for answer**, **New answer**, **Answered** or
**Delivery failed**. Listing or counting an answer does not read it; intentionally
opening its conversation uses the existing persisted read path. Opening an
unanswered question shows the thread and delivery diagnostics. **Sent** and
**Delivered** remain available in expanded **Technical details**; only a true
failed delivery offers **Retry delivery**, using the same request ID.
A delivered question waiting for an answer has no retry button. An open thread
follows a reply/read transition between views without replacing its composer.
The card's **Archive conversation** button immediately moves every turn into
searchable History and offers **Undo**. In History, **Restore to inbox** restores
the conversation. The authenticated `POST /api/ask/requests/:request_id/dismiss`
and `/restore` actions update every stored turn in that owner's conversation,
including turns absent from the browser snapshot. The browser serializes these
visibility actions and reconciles polling after pending mutations settle.
These visibility changes persist across reloads and devices; they do not cancel delivery, delete content, dismiss a source decision, change
Notion, send instructions, execute suggestions, approve work, merge or deploy.
A genuine new reply clears that turn's archived state and resurfaces its
conversation as **New answer**, leaving unrelated archived conversations alone.
For source response receipt inspection and retry, see the
[queue contract](reconciliation-queue.md).

Collapsed cards show status/time, question, source name and an available answer
snippet; expand inline for the full thread. An unopened answer has a teal left
accent with a gentle 2.5-second pulse and a **New answer** label. Opening the
conversation marks the answers present at that opening read and removes their
pulse; a reply arriving later remains unread until intentionally opened, even
if the conversation was already expanded. Read answers stay quiet. History never pulses,
and `prefers-reduced-motion` keeps the accent static. The archive button remains
available on touch and becomes more prominent on hover or keyboard focus;
left/right swipes retain their Ask/Inspector meanings.

Opening an item reveals its originating context, switching sections when
necessary, while retaining the conversation in Discuss. Work items use existing
[Discuss navigation](overview.md); inline answers and return controls are described
[below](#typed-artifact-origins-and-returns).
Link items retain the exact claim ID, reveal its endpoints and scroll to its card;
the flash targets that relationship, including unverified Detailed lines, rather
than every confirmed connection on the card. Inbox questions and answer previews
wrap legibly. Worker
answers reveal and highlight the exact originating execution. Questions from a
worker terminal also retain its home/task identity in `view.worker`; Return to
source reopens that terminal only when exactly one current worker matches.
Otherwise it returns to Overview with the captured origin. Active and
history items use the same return path. A task that cannot be shown gets the
captured canonical source link rather than another object. Follow-up creates a new request in the same
conversation and retains the original captured context. Audio handling is documented
in [local voice retention](voice.md#boundary-resource-use-and-retention).

## Typed artifact origins and returns

The same composer supports PRs, action receipts, deployment targets and deployment receipts.
PR rows in both PRs and Releases ask about the actual GitHub PR. Right-click a
PR CI/review/changes field or deployment/receipt text to prepare an editable
question. Blank Ask icons remain blank, and native links outside semantic Ask
fields, selection, inspection and table scrolling retain their existing
interaction rules.

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

Discuss returns to a PR with its captured query/sort intact, temporarily reveals,
expands and focuses the canonical row, and keeps the answer open. A closed PR
is read individually through owner-only `GET /api/pulls/origin?url=…`; this does
not add closed PRs to the open inventory. The same configured repository and
owned/authored/explicitly-associated relevance scope applies. Changed heads are
labelled; failed or inaccessible reads retain the answer and original GitHub
link. “Show all PRs in this view” removes only the temporary reveal.

Answers expand inline in the persistent Discuss, with neighboring conversation
previews still available in one click. Correlated follow-ups share one thread;
collapse, history, unread status, dismiss, references and suggested actions retain
the existing request/permission boundaries. See [continuous text conversations](#continuous-text-conversations)
for the shared composer and inline reply behavior.
On mobile, opening a conversation keeps the Discuss sheet open; close it to see
the revealed origin in the main workspace.

Normal browser history entries store the previous section's query, sort, filters
and grouping before a Discuss jump. Back (or the thread's Back to previous view
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
local access without the trusted owner header cannot use this owner Discuss.

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
capture/reply/failure/queued counts, or a fixed error with upgrade guidance when
required (see the [bridge contract](ask-puller-service.md#bridge-contract-and-automatic-adapter-updates)). Inbox stderr, other primary notes and
API payloads are not logged. A failed run can be run again; errors do not lose
Tin Star's retained request or the inbox's durable note. Direct adapter invocations
report their exit status; managed service health is described in the runbook.

1. `GET /api/ask/bridge` with server-side bearer returns up to 50 pending
   owner requests (`request_id`, `inbox_request_id`, text `body`) plus tracked note
   mappings. Sent requests are retried on the next pass. Capture failures await
   the owner's **Retry delivery**; saved-but-unannounced failures also expose
   retry. An uncertain HTTP response is retried with the same ID.
   The same response also carries system check-ins; their separate persistence,
   batch bounds and automatic retry policy are owned by the
   [watchdog reference](check-in-watchdog.md#delivery-and-persistence).
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
[`ask-actions.ts`](../../src/shared/ask-actions.ts), which owns identifier syntax,
per-answer uniqueness and text length limits. Labels and instructions must be
nonblank single-line text. Both fields allow ordinary punctuation, parentheses, quotes,
semicolons and version numbers. They reject control/line-separator characters,
backticks/code fences, HTML tags and URLs/link syntax; URLs belong in references.
Instructions are inert text and are never executed by Tin Star.
A recommendation may also carry one optional `merge` object, exactly
`{ "pr_url": "https://github.com/owner/repo/pull/1" }`. No head SHA and no other
fields. The installed puller forwards that object inside the reply body unchanged.
For click behavior, head binding, refusals and retries, see
[Send selected PRs to Clawson](../pr-actions.md#send-selected-prs-to-clawson-for-admin-merge).
A malformed `merge` value is omitted like any other invalid suggestion and
returned in `reply_warnings`; the owner does not see the rejection text.
Historical string suggestions still display as inert text.
Malformed structured reply content is accepted with `reply.degraded: true`.
String summaries and details are truncated to their schema limits; a missing or
invalid summary falls back to the first 240 characters of the reply body, and a
non-string detail falls back to the full bounded reply body. Only the first 20
valid references are retained. A suggestion that fails on its own, such as a
URL in the instruction, is omitted and the remaining valid suggestions stay
buttons. If the remaining valid suggestions have duplicate IDs or exceed 10,
the collection is dropped as a whole, creating no buttons and preventing an
ambiguous recommendation from being promoted. Either omission
cannot delay other answers in the installed puller. `reply.rejected_actions`
records a reason for each omitted entry, with its index and string ID when
available, or a collection-level reason when the field is not an array. Discuss
shows the answer and valid buttons without raw validation errors in the message.
Technical details retains diagnostics; when no valid action survives, Request new choices
prepares an editable follow-up. The stored reply and later conversation
history keep the rejection details. Bridge POST receipts return the same
details in `data.reply_warnings` (including on delivery retries), so pullers
can surface them to First Mate. The published 6.0.0 puller ignores this extra field;
updated adapters deliver them through the
[First Mate warning-receipt flow](ask-puller-service.md#rejected-action-receipts-for-first-mate).
Request/note correlation and immutable-answer conflicts still
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
a second pass, and Discuss return-to-context screenshots at one frozen commit.
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

- Worker context enriched with observed attempt beyond the execution ID
  anchor and terminal home/task identity; removable additional context chips beyond the single originating
  Work, Worker or Link context.
- Queued, Investigating and Needs input/decision lifecycle updates, progress and
  revision-aware delivery and priority for investigations beyond the current
  Discuss views described above.
- Richer reassignment, stale and inaccessible context handling beyond the
  current scene availability check and captured source-link fallback.
- Full parent-card failure, permissions, accessibility and reduced-motion proof;
  physical iPhone Safari and Android Chrome touch/microphone verification remains
  an explicit review gate when devices are available.

## Shared element entry points

`useElementAsk` and `askElement` in `src/ask/` provide one field contract for
Overview cards (including expanded relationship hints and card/execution
Inspector fields), PR rows/details, Releases rows/evidence, and Discuss items. Manager, group and First Mate Inspector selections
do not expose element Ask. Existing `data-ask-field`
markup works with the same hook. Right-click, Shift+F10, the Context Menu key,
and a stationary 550 ms touch hold open the semantic draft directly from the
same context builder and existing field templates. Hovering or focusing a field
does not reveal a floating control. Moving more than 10 px, scrolling,
cancellation or a second touch cancels the hold; a successful hold cancels the
item swipe and its synthetic click. Selecting text inside one item offers
**Ask about this**, a selection-triggered control rather than a hover bubble.
Inside an open modal that control stays in the modal. A selection crossing
item boundaries or outside an item does not.

The optional `element` metadata in the create/context schemas captures the
displayed label (e.g. `Overdue 3d` plus the formatted check-in), value and
deterministic question type. The authoritative shape and limits live in
`askElementSchema` in `src/shared/ask.ts`. Existing `field_key` / `field_value`,
server-owned item origins, bridge delivery, inline threads and Discuss returns
remain the same path. The sheet shows the captured element and an editable
suggestion, using the composer keyboard controls described above.

## Continuous text conversations

Expanded Discuss conversations include a persistent **Reply to First Mate** field.
It uses the same text composer as card, worker, relationship, PR and Release Ask
entry: Enter sends, Shift+Enter adds a line, and composing with an IME does not
send. Escape closes a new-question dialog; in an inline reply it returns focus
to the conversation's collapse control and preserves the draft. Semantic Ask on
Discuss advice also replies in that conversation. Section switches preserve the
mounted thread and draft; server history survives reload and another browser.
Microphone input uses this same conversation path; see [local voice](voice.md).

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

Recommendations without `merge` use the operator-request flow below; merge
recommendations use the [Clawson handoff](../pr-actions.md#send-selected-prs-to-clawson-for-admin-merge).

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


## Discuss and Decisions presentation

Discuss is the existing persistent conversation rail, renamed without changing Ask
routes, storage keys, bridge correlation or permissions. Rows show status/time,
the newest meaningful user question, source and one short answer preview. A thread
orders individual user and First Mate messages by their timestamps; summaries
that prefix the full answer are shown once. Markdown links remain links. Validated
structured actions stay with the proposing answer and remain disabled after a
superseding answer. Selection receipts report Requested, Delivered or Result
received; First Mate's ordinary reply supplies the actual outcome.

A latest reply whose actions failed validation shows **One-click action unavailable**
and **Request new choices**, which prepares an editable follow-up in the same
conversation. Validation reasons and raw request evidence live in **Technical
details**. Existing legacy text suggestions remain inert. Old user messages quoting
the former validator wall retain the full original under Technical details.

Decisions retains the existing queue and canonical identities. It has one compact
row per request, even when several cards support it. Evidence and existing response
controls open in its detail pane; conditional and unverified requests display their
limits before any action. Legacy encoded text is decoded before readiness checks,
so a request beginning “After the next prod release” remains conditional. Aggregate
“Owner calls via main” records remain operational coordination in diagnostics,
with no omnibus acceptance. Source warnings and retained worker notes are
available on demand near the footer. No new queue, approval engine, poller or
model call is introduced.
