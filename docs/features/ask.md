# Ask First Mate: slice 1

Slice 1 is one work card, text, **Sent / Delivered / Answered**, approved by
First Mate 2026-11-05 22:54Z. **Failed** reports a known delivery failure.
This PR implements this approved slice of the parent card.

A left drag on a Notion task opens a text composer with that task's canonical
page ID. The visible **Ask about a task** button provides the same action without
a gesture; Detailed Inspector also has **Ask First Mate about this task**.
Release opens the composer; only **Send question** sends. The task chip is
removable and a task must be selected before sending. Right/voice, workers and
relationships are later slices of the touch-to-ask card, not implemented here.

Movement under 12 CSS pixels stays a tap. At 12 pixels, left movement must be at
least 1.4 times vertical movement to lock to text. Release requires 48 pixels.
Vertical, diagonal and right movement stay native. A left drag that can scroll a
horizontal overflow ancestor stays native; at its right edge, a left drag can
open Ask. Use the visible action anywhere without changing the floor's scroll
position. Pointer/touch cancellation never opens a composer.

Operational decision/request items render before Ask questions in the existing
Desk on desktop and mobile. The
slice's states are **Sent** (Tin Star retained it), **Delivered** (First Mate
captured its note), **Answered** (correlated primary reply), and **Failed** (known
capture failure). No readiness/announcement/acknowledgement is misrepresented as
investigation progress. A missing puller or slow answer leaves a visible delay
message; retry uses the same logical request ID. Wake failure is shown even when
the note is delivered. New answers are unread; viewing marks them read. Dismiss
moves only the Ask into searchable history. It does not dismiss a decision,
change Notion, approve work, merge or deploy.

Tapping an item resolves its stable page ID against the current scene, invokes
existing semantic navigate-card reveal/scroll/flash, and opens a compact answer
sheet over the floor. Questions and answer previews are clamped at rest; **Full
answer & evidence** expands the retained detail, references and suggestions. The
compact sheet leaves the returned task visible above it on mobile. Current grouping and filters remain intact; the navigation
exception reveals the task. A missing task gets the captured canonical source
link rather than another object. Follow-up creates a new request in the same
conversation and retains the original captured context. No raw audio is stored.

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
token grants access to all Ask requests and answers in this instance, so give it
only to the designated primary-home puller.

## Outbound-only Mac puller

`scripts/ask-puller.py` is a Python 3 standard-library, single-pass adapter. It
runs on the main First Mate home host. The Mac initiates HTTPS requests to Tin
Star; Tin Star never executes a remote shell or an arbitrary command. Install
and schedule it through the operator's existing Mac mechanisms after review.
There is no embedded scheduler or daemon. For example (substitute the approved
HTTPS origin, main home and clavis reference; the reference is not the secret):

```sh
python3 /absolute/path/to/ask-puller.py \
  --url https://approved-tinstar-tailnet-origin \
  --home /absolute/path/to/main-firstmate-home \
  --token-key tinstar-ask.token
```

It reads the token using `clavis get <reference>` into process memory. It never
passes the value in subprocess argv or prints it. Redirects are refused so the
bearer cannot be forwarded to another host. It makes one pass and prints only
capture/reply counts, or a generic error. Inbox stderr, other primary notes and
API payloads are not logged. A failed run can be run again; errors do not lose
Tin Star's retained request or the inbox's durable note. Check the exit status
in the existing scheduler and make failures visible through that scheduler.

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
   rejected mapped reply do not block other mapped replies; after processing
   them, the pass exits with a generic failure to report incomplete coverage. It posts
   `{request_id, reply:{id,at,body,cursor}}`; `id` must match the retained note,
   `at` is UTC ISO time and `cursor` is the inbox's per-home sequence string.
   Duplicate/older sequences are no-ops. A conflicting later immutable answer
   is rejected. Delayed delivery/error acknowledgements cannot regress Answered.

The Ask body contains `tinstar.ask.v1`, logical request/conversation IDs,
authenticated principal, question/input mode/time and structured captured context.
The server derives page ID, canonical URL, label and freshness from its authorized
scene; labels are snapshot evidence. The primary should re-read authoritative
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
  "suggested_actions": ["Suggested next step requiring its usual approval"]
}
```

Only credential-free HTTPS reference links are accepted. Plain text is displayed
as text, never executable HTML. Limits include a 4,000-character question,
32,000-character answer, 20 references and 10 suggested actions. API JSON bodies
are bounded to 256 KiB; the puller has process/network timeouts and bounded reads.

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

- Worker context with stable logical identity and observed attempt/home; verified
  Link context with provenance and both endpoints, explicit relationship targets,
  and removable additional context chips.
- Right-drag voice entry, activation-only microphone permission, transcription
  review/edit, text fallback and discoverable accessible voice controls.
- Queued, Investigating and Needs input/decision lifecycle updates, progress and
  revision-aware delivery; unified priority for decisions, unread answers,
  investigations and failures.
- Worker/Link return navigation and highlighting of both endpoints and the link,
  with truthful reassignment, stale, missing and inaccessible context handling.
- Full parent-card failure, permissions, accessibility and reduced-motion proof;
  physical iPhone Safari and Android Chrome touch/microphone verification remains
  an explicit review gate when devices are available.
