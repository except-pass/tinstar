# Decision Desk preparation foundation (P1)

This is the first backend slice of the Decision Desk sequence. It advances the
backend portions of acceptance criteria **1 and 2**, and foundations for **3, 8,
12 and 14** on [the Decision Desk card](https://www.notion.so/41950ce6d42281068ca9dc6d065fc210).
P2–P6 follow: review sessions/prepared claims, submission coordination,
preparation workers, the two-view UI, and integrated acceptance/activation.
Existing Decisions screens, generic claims, source answers, receipts and
`search_work` filters/coverage retain their behavior.

P1 starts no workers, dispatches no jobs and spends nothing on preparation.
Automatic replenishment is stored ON by default, ready depth 10 (1–30), maximum
preparers 3 (1–8). These are persisted owner policy values, not a hidden activation
flag. The preparer/runtime/spending and first activation decisions remain separate.

## Storage and readiness

`DecisionPackets` uses the **existing `CardLeases` database**,
`card-leases.sqlite`, through its internal read/transaction helpers. The generic
lease algorithm is unchanged. This puts future READY selection and canonical
card reservation within one possible local transaction; P1 implements no such
claim operation. No provider I/O belongs inside packet transactions.

- `decision_packets` stores immutable packet bodies, schema, semantic hash,
  source-scoped version, publication operation identity, preparer and timestamps.
  Identical publication retries return the original packet; different meaning
  with the same actor/operation is a conflict. A deliberate new publication
  increments the version. Older bodies remain readable and superseded versions
  cannot become Ready.
- `decision_packet_dependencies` indexes exact dependency kind/key/revision.
  Kinds are request, card, answer, PR head, worker, release and evidence. Changes
  invalidate only dependent packets. No whole-snapshot digest or timestamp-only
  invalidation is used. Source closure/conflicting answer can withdraw a
  dependency without asserting a replacement revision.
- `decision_packet_events` and `decision_packet_validations` are append-only
  service records for publication, validation/freshness/coverage, invalidation
  causes and policy changes. They are operational records, never a source answer.
  Known dependency changes prevent an older cached revalidation from restoring
  readiness. A withdrawn/expired dependency needs a later observation before
  unchanged-source revalidation can restore eligibility.
- `decision_desk_policy` persists versioned effective settings per configured
  board. Authorized owners share that board's policy. Failed/stale saves are
  explicit and preserve the stored version.

The packet schema contains one **existing** exact source request, its canonical
card, source paragraph/comment ID, source tuple, question/generation/revision,
source-supported option IDs/labels, recommendation, background/rationale,
confidence/uncertainty/material unknowns, risk/likelihood/blast radius, reversibility/rollback/residual
exposure, consequences/affected parties/prerequisites, authorization/next owner
and status/gates, references, dependencies and review freshness policy. P1 does
not normalize sources, invent alternatives or add a multipart grouping schema.
Risk/confidence prose is preparer advice, not an independent verification or
authorization. Publication is currently an **internal service method**; a
job-scoped publisher API belongs to the later preparer contract.

Semantic hashing normalizes object keys, set-like option/reference/dependency
ordering and line endings. Publication/observation timestamps are outside the
hashed packet meaning. A changed request, option, risk, recommendation or bound
dependency revision changes meaning. Evidence attestations can be appended to
the same immutable packet when source meaning is unchanged.

`validateDecisionPacket` is pure. It requires exact source/card/option/question
membership, complete fresh unexpired material evidence, and an unanswered source.
Declared material unknowns also block eligibility; ordinary advisory uncertainty
remains visible. Missing, partial, stale, ambiguous or mismatched evidence supplies reasons rather
than permission. `DecisionPackets.read(id, evidence)` additionally requires a
successful unexpired persisted validation, the latest packet version, unexpired
packet freshness and **no active canonical review lease**. It evaluates lease
and expiry at read time; there is no permanent Ready flag. Reading without current
source evidence never asserts readiness. No counts of pending preparations or
leases are presented as Ready.

## Read-only preparer evidence

`ReconciliationSources.preparationEvidence(cardId)` projects already-observed
board/fleet metadata and cached card-body and comment history. It does **not**
refresh sources, call the mutating queue refresh, reconcile receipts, answer,
repair source links, or take a lease. On a cold cache it honestly reports missing
coverage. Existing source readers/view refreshes may separately populate caches;
looking at this projection never renews their timestamps. Both history caches
must be resolved, complete and unexpired for readiness; the earlier cache expiry
bounds their combined freshness. Missing, partial or expired history blocks
readiness rather than establishing that a request is unanswered. Legacy paragraph
answers and conflicting body publications remain part of that history.

The dependency map checks request meaning, card closure/authorization context,
answer history, and worker attempt/state. Linked PRs appear as unverified PR-head
dependencies until an authorized reader provides current evidence. PR/release
proof collection is an explicit omission, not assumed verification.
Cross-channel Ask publication coverage is also not supplied by this cache-only
projection: a typed proposal that needs that coverage is blocked with an explicit
reason. Cached workflow history still rejects superseded/conflicting formal
publications. Later evidence collection must supply complete publication coverage
before such a packet can become Ready; P1 does not weaken existing selection rules.
The schema/index also supports release/other evidence dependencies for future
preparers, without claiming those observations have already been collected.

This is bounded observation of upstream systems, not a distributed lock over
Notion/First Mate/GitHub. The later submission coordinator must force exact source
readback before writing. A recommendation never permits production/device writes.

## Owner-authenticated API

Routes use the existing trusted loopback Tailscale owner authorization check,
origin allowlist and `X-Tinstar-UI: 1` handshake. A caller-supplied owner name alone
is not authorization outside that existing loopback/proxy trust boundary. No
install, bridge or lease token is returned by these routes.

| Method and path under `/api/reconciliation/decision-desk` | Result |
|---|---|
| `GET /policy` | Persisted/default effective board policy and version |
| `PUT /policy` | Save `{expected_version, values:{target_ready,max_preparers,automatic_replenishment}}`; 409 on version conflict, 400 on invalid values, 503 on unconfirmed storage |
| `GET /evidence?card_id=...` | Pure cached source projection with exact bindings, dependencies, reasons and omissions |
| `GET /packets` | Bounded publication inventory (at most 50), explicitly **not** a Ready counter |
| `GET /packet?id=...` | Immutable body/metadata plus current evidence and lease/expiry eligibility |
| `GET /events?after=0` | At most 50 durable instrumentation events in sequence order |

There is no packet mutation/answer/claim/worker endpoint in P1. Unsupported methods
return 405. Source text is redacted at the API output boundary, independently of
the exact source data used for validation. Existing `coverage.intentions` and
`search_work` scope fields are unchanged.

## Isolated proof and baseline screenshots

Build the client and run the explicit fixture-backed preview:

```sh
npx vite build --outDir dist/client
node --import tsx scripts/decision-desk-preview.ts /absolute/task-proof-dir
```

The script creates a fresh private config root beneath that directory and binds
an ephemeral loopback port. It enrolls no First Mate home, live credential,
provider source transport or job dispatcher. `p1-preview.json` identifies the
instance and synthetic source packet. API requests use the fixture owner
`preview-owner@example.test` and the UI handshake. Its SQLite/API code and current
client bundle are real; its business evidence is explicitly controlled test data.
Stop that script process after proof. Never aim this harness at a live config root.

Open the returned URL with `?view=decisions` in
`CHROME_DEVTOOLS_AXI_SESSION=tinstar-decision-desk-design`. Capture 390×844,
768×1024 and 1440×900, label them **P1 baseline — unchanged Decisions UI,
isolated fixtures**, and stop that AXI browser session afterward. P1 changes no
screen. These images are the baseline for P5, not a claim of prototype fidelity
or final Decision Desk acceptance.

The generic-lock contention measurement is reproducible without source access:

```sh
node --import tsx scripts/decision-desk-contention.ts /absolute/task-proof-dir
```

It records HEAD and raw samples: six rounds at each simulated source-write delay
(25ms and 1000ms), one writer plus five independent `CardLeases` instances,
30 claim samples and six write samples per scenario. It measures lock contention,
not HTTP/render latency or the future prepared path. Output is
`p1-contention.json`; report actual p50/p95, sample counts and this scope in the
implementation review description. It decides no lease redesign in P1.

Focused tests cover semantic hashing, source/card/options changes, partial/stale
evidence, immutable retry/versioning, dependency invalidation/revalidation,
expiry/held-card exclusion, restart persistence, concurrent policy-save conflicts,
real owner-authenticated API calls and no source access/reconciliation from the
evidence path. Run existing lease/proposal/workflow regressions as well.
