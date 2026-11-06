# Card Janitor: read-only operational audit

Card: https://app.notion.com/p/40f50ce6d42281729453e9771630e63a

Slice A is a repository CLI that proposes investigations of messy task cards. It
uses the existing Tin Star Notion/fleet source snapshot and reconciliation
projection. It makes no model calls, creates no Desk items, and has no Notion or
First Mate writer. Review, persistent review decisions, application, scheduling
and the local-model pilot are later slices.

## Run and replay

From a checkout with `npm ci`, read an existing Tin Star server:

```bash
npm run --silent janitor:report -- --server http://127.0.0.1:5273 \
  --save-input /tmp/janitor-input.json > /tmp/janitor-report.json
npm run --silent janitor:report -- --input /tmp/janitor-input.json --format summary
```

JSON is the default; `--format summary` prints counts and a few cited examples.
`--input` also accepts a raw `/api/reconciliation/sources` snapshot or its
`{ok:true,data:...}` envelope. `--save-input` preserves the snapshot plus collected
card contexts, using file mode 0600 for new files. Keep these local files private:
they contain company source metadata/prose. No credentials are required to replay.

The default evaluation time is the snapshot's `generatedAt`, so saved input
reproduces proposal IDs, evidence revisions, reasons, category results and scope.
`--at ISO_TIMESTAMP` explicitly reevaluates time-dependent metadata. Runtime and
cache/read metrics reflect that invocation and need not match between runs.

The CLI reads the existing GET sources endpoint once, then up to 12 candidate
contexts through GET `/api/reconciliation/card-context`. `--context-limit 0` is
properties-only/offline-safe; a limit of up to 40 is available for a bounded
sample. Repeated `--context-card PAGE_ID` prioritizes particular operational cards
inside that budget. The default order prioritizes duplicate/overlap candidates,
then cards without published next-action fields. Context failures remain unknown;
there is no paid inference fallback or whole-board body scan. `--help` lists all
options.

## Scope and evidence

The audit reuses the Overview's **operational preset** (not custom filters or
temporary selected/linked cards), defined by `operationalStatuses` in
[`src/shared/floorOrganization.ts`](../../src/shared/floorOrganization.ts).
Archived and trashed pages are excluded. The JSON lists every included page ID,
counts by included/excluded status, source counts, timestamps, schema/relation
omissions and independent fleet source health. Missing/unsupported statuses are
reported as exclusions. The live count is never assumed to be 145.

The existing collector can have older cards in its fetched data source. Janitor
does not add an archive scan. Such cards only participate as supporting evidence
for a concrete operational candidate and are identified separately. It does not
fetch unknown historical replacement targets; that coverage remains unknown.
Source freshness and pagination completeness are independent: a fully paginated
old snapshot is still old evidence.

All six categories have explicit candidate and unknown-coverage results:

| Category | Rules and limits |
| --- | --- |
| Duplicates | Exact normalized titles, or canonical PR/Jira identifiers with strong title overlap; connected components dedupe pair findings. Same title/reference is a candidate, never confirmation. |
| Overlapping scopes | Bounded title/identifier neighbors. Explicit ancestor/child relations, lettered/numeric implementation markers (including compound phase/slice names), different dated runs and different work identifiers retain their distinctions. Writer/reconciliation versus recovery roles stay distinct. |
| Potentially superseded | An explicit `superseded by`, `replaced by` or `consolidated into` assertion immediately naming an observed Notion card. Negated/conditional assertions and unavailable targets are not replacement conclusions. |
| Stale/no next action | Missing Next action / Next Action properties after checking published waits/delegation and bounded prose markers. Last edit age is context, never proof of progress, obsolescence or completion. Uncollected prose may contain a plan. |
| Check-in metadata | Missing, malformed or past published dates, using the board's New York date-only semantics. No working-hour/business-morning policy or PM Bot verdict is recreated; no commitment is reset. |
| Ownership/links | Missing supported Owner/Name, hierarchy issues, truncated relations, invalid URL fields and the existing authoritative worker-link diagnostics. Unknown worker is not proof of missing assignment; Janitor proposes no assignment or repair. |

Title neighbor retrieval is deterministic: each card selects up to eight ranked
neighbors, and pairs selected by either card are deduplicated. A card can therefore
participate in more than eight comparisons. Large common-word buckets are windowed;
the audit reports neighbor comparison counts. Completed duplicate clusters also
check every member pair for explicit distinctions; a distinction makes the cluster
an overlap candidate. This is a conservative candidate search, not exhaustive semantic analysis.
Prose uses the existing bounded/redacted CardContextReader; partial/unsupported
blocks and failed Notion/GitHub/First Mate reads do not establish absence. Source
instructions are treated as data and cannot call tools or authorize actions.

## Proposal contract and cost

Each proposal carries a stable `proposal_id`, approved action type, involved
page IDs/URLs, cited property/block values, observation/edit freshness, rule,
deterministic origin, confidence/abstention, proposed action, impact and protected
history/relationships. Relation citations link observed and unavailable targets.
`proposedSurvivor` stays null because these rules do not establish a safe survivor.
The exact property previews have identical before/after values: the proposed
operation is investigation, not a field edit. No exact metadata fix or substantive
rewrite is silently inferred.

Evidence revisions fingerprint content/edit versions independently of observation
refresh times. Worker-link diagnostics also cite the relevant fleet home observation,
execution identities and detector facts; their material evidence participates in
the revision, and their freshness/coverage contributes to abstention.
Preconditions record source fingerprints, source edit versions and
the future need for explicit approval, reread/drift checks, preservation and
readback/audit. `authorization: not-authorized` is descriptive; there is no apply
function behind it. An audit cannot be submitted as a write command.

The reusable auditor caches derived features by property/content version in a
bounded process-local cache. It still reevaluates time-sensitive observations and
source health. Existing server caches bound source reads. Each standalone CLI
starts with a fresh feature cache; saved input avoids all network reads. Metrics
include comparisons, context reads/budget, cache hits/misses and runtime, with
model calls/tokens, external inference calls and writes equal to zero. There is
no new persistent daemon or nag loop. The existing Desk queue is only projected
to record baseline decision counts; GitHub readiness is not refreshed or certified.

The local-model pilot is blocked on assignment of the actual 4070 host and its
reservation interface. The implementation host `hulk` exposes a T600 Laptop GPU
over PCI, without `nvidia-smi` or Ollama; its VRAM is unverified. Slice A works
without either GPU or model. No company data is sent to external inference.

## Verification

Behavioral tests execute the report, reusable auditor and CLI, including a spawned
offline replay. They cover operational exclusions, exact duplicate clusters,
parent/child and sibling distinctions, differing worker-link roles and dated
runs, explicit/negated/unknown-target supersession, published waits/prose actions,
invalid/date-only check-ins, stale/partial/failed sources, stable identity versus
evidence drift, cache reuse, 145-card comparison bounds, and a GET-only context
budget with zero inference/writes. Run:

```bash
npm exec -- vitest run --exclude='e2e/**' src/server/janitor/__tests__
npm run typecheck
npm run lint
```

The real-source baseline and verification bundle are retained at
`/home/farm/fm-home/data/tinstar-card-janitor/verification.md` for Firstmate; company
snapshots are not committed. The exact live counts and cited sample links are in
that bundle. Candidate counts are not adjudicated cleanup wins or false-positive
measurements. No review UI, Notion write, merge or deployment is included here.
