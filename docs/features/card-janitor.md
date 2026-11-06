# Card Janitor: read-only operational audit

Card: https://app.notion.com/p/40f50ce6d42281729453e9771630e63a

Slice A is a repository CLI that proposes investigations of messy task cards. It
uses the existing Tin Star Notion/fleet source snapshot and reconciliation
projection. By default it makes no model calls, creates no Desk items, and has no Notion or First Mate writer.
Slice B adds an opt-in local semantic pilot over the same candidate clusters.
Review, persistent review decisions, application and automatic scheduling are later slices.

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

## Local semantic proposals (slice B)

Run `janitor:report` with `--semantic` to append a separate `semantic` result to its JSON.
The deterministic report still runs first and remains available when the model is unreachable, busy, timed out or rejects output.
The default endpoint is the tailnet-only `http://eframe.taile890bc.ts.net:11434`, using `qwen3.5:9b`.
Override these with `--endpoint` / `--model` or `TINSTAR_JANITOR_ENDPOINT` / `TINSTAR_JANITOR_MODEL`.
Only credential-free loopback, private IPv4 or tailnet origins are accepted, and HTTP redirects are disabled to prevent company prose reaching a hosted endpoint.
There is no hosted-model fallback or model tool interface.

```bash
npm run --silent janitor:report -- --input /tmp/janitor-input.json --semantic \
  --model-calls 4 --model-tokens 32000 --model-time-ms 120000
```

Semantic retrieval uses slice A candidate clusters and its explicit distinctions, deduplicated by page membership.
A singleton may attach up to two explicitly linked parent/sub-item pages already present in the source snapshot as supporting evidence, including historical work.
This adds no historical scan or second title matcher.
Only allowlisted source properties and bounded, already collected card prose enter the model request; worker records, transcripts and credentials are not needed.
The existing credential scrubber and an email scrubber minimize local inputs.
Requests contain at most eight cards and 20 KB of messages; larger clusters abstain rather than silently dropping cards.
The first four available prose blocks per page supplement deterministic citations; each value is capped at 1200 characters.
Omitted or partial evidence remains visible as incomplete coverage.

[`semantic.ts`](../../src/server/janitor/semantic.ts) owns the strict Zod reply schema and generates the Ollama JSON Schema from that same contract.
The client validates nested objects, enums, required fields, every cited page/evidence pair, survivor and draft targets against the actual cluster input.
Missing citations, invented references, unsupported classifications and unstructured prose URLs/IDs are rejected.
Duplicate, overlap and supersession suggestions also require deterministic corroboration from the input evidence: a shared canonical PR/Jira identifier, a direct observed relation between input pages, or an explicit source assertion naming a real input target.
Matching titles and a shared outside parent do not qualify, because the live pilot showed that they can describe separate executions.
A valid positive reply without corroboration becomes an explicit needs-review abstention, with no survivor or draft.
The reply schema and ID validation still apply before this downgrade.
Explicit deterministic distinctions prevent duplicate/supersession suggestions that erase sibling or parent/child boundaries.
Known role/instruction override patterns in source prose cause abstention before inference; other prose is delimited as a JSON data envelope under a system policy that treats it as untrusted.
These checks constrain references and available operations; semantic correctness still requires review and measured evaluation.

Results include stable proposal identity, source versions, cited evidence with freshness, confidence, explicit abstention, optional survivor and plain-language description/current-state/next-action drafts.
Previews show the exact cited source before and the separate proposed draft after; they are not executable Notion property patches.
The deterministic protected fields and unauthorized apply preconditions accompany every semantic proposal.
Nothing changes status, ownership, links, history, the Desk or Notion.

### Resources, admission and cache

This is an operator-invoked opportunistic pilot, not an automatic GPU scheduler.
Run after checking the host's CI reservations and GPU workload; automatic sweep/admission integration belongs to the ongoing janitor slice.
An operator reservation marker supplied by `--busy-file` or `TINSTAR_JANITOR_BUSY_FILE` defers inference while it exists.
Other resident Ollama models also defer the run.
Requests are serial, with a config-home run lock preventing overlapping pilots sharing that home, two inference CPU threads, temperature zero, an 8192-token context and a 30-second model keep-alive.
Defaults are four calls, a conservative 32000-token budget, 120 seconds per run and 45 seconds per request.
Token admission reserves UTF-8 prompt bytes plus the output cap, while metrics separately report Ollama's actual token counts.
Timeouts/unavailability stop additional requests for that run and persist exponential backoff from one minute to fifteen minutes; no retry storm or paid fallback occurs.

Private runtime cache lives under `getConfigRoot()/janitor/semantic/`, honoring `TINSTAR_CONFIG_HOME`.
It is never committed.
Cache identity includes card content/property fingerprints and edit versions, bounded evidence content/coverage, model/endpoint and prompt/schema protocol.
Observation-time/freshness refreshes alone do not re-ask unchanged clusters; returned citations still carry current snapshot freshness and future apply must reread the sources.
Valid classifications, model abstentions and rejected replies are cached, so unchanged rejected output also avoids repeated inference.
Network failures use backoff rather than a permanent cached verdict.
Cache failure produces abstention and a visible warning while deterministic findings remain usable.
If a process is killed, inspect `run.lock/owner.json` and confirm that process has exited before removing that runtime lock.
Removing cached JSON deliberately permits reprocessing; it does not change source data.

### Curated evaluation

Save the audit input, then independently record 25-40 unique cluster labels before calling the model.
[`pilot.ts`](../../src/server/janitor/pilot.ts) owns the sample schema: snapshot timestamp, label-recording timestamp, notes, and cases with cluster ID, expected classifications, review group and rationale.
The runner rejects missing/duplicate candidate identities and mismatched snapshots before inference.
Use separate cases for duplicate candidates, sibling work, independent work, historical supporting work and stale-looking active cards; an unknown ground truth is an abstention label, never an invented duplicate.

```bash
npm run --silent janitor:pilot -- --input /tmp/janitor-input.json \
  --sample /tmp/janitor-labels.json --output /tmp/janitor-evaluation.json \
  --max-calls 30 --max-tokens 1000000 --max-time-ms 900000
```

The evaluation preserves labels, source/sample fingerprints, results and per-call latency.
It reports false suggestions, false-positive rate on negative cases, total and model-only abstention, schema/reference reject rates, cache hits and actual tokens.
A budget-deferred or rejected case counts as abstention, with its separate outcome retained.
Ollama prompt/evaluation durations report GPU-backed inference time; this is not an exclusive device-occupancy measurement or paid billing estimate.
Read these rates alongside sample coverage and actual calls: all abstentions cannot demonstrate duplicate recall, and an absent positive control must be reported explicitly.
Local samples/results contain company data and belong in private task evidence rather than git.
The four positive-control pairs in [`semanticControls.ts`](../../test-fixtures/janitor/semanticControls.ts) are explicitly SYNTHETIC, with invented IDs/example PRs and paraphrased bodies in the same card structure.
They pass through slice A and the same semantic pipeline; record their expected labels before a live control run and report their recall separately.
Synthetic recall does not measure true-positive quality on the real board, which remains unmeasured when no confirmed real duplicate exists in the current candidate set.

## Verification

Behavioral tests execute the report, reusable auditor, semantic runner, sample evaluator and CLI, including a spawned
offline replay. They cover operational exclusions, exact duplicate clusters,
parent/child and sibling distinctions, differing worker-link roles and dated
runs, explicit/negated/unknown-target supersession, published waits/prose actions,
invalid/date-only check-ins, stale/partial/failed sources, stable identity versus
evidence drift, cache reuse, 145-card comparison bounds, and a GET-only context
budget with zero inference/writes by default.
Semantic stubs also cover strict schemas, hallucinated IDs, injected prose, abstention, persistent cache reuse/drift, concurrent admission, workload deferral, unavailable-model fallback and prelabelled evaluation metrics.
Run:

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
