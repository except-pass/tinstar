# Reconciliation sources and scene (S1–S5)

The [Overview reference](overview.md) owns the current presentation and visual reference; the source and reconciliation contracts below remain active.

This reference covers the source, scene and Floor slices of the owner-approved [Reconciliation Floor card](https://app.notion.com/p/40d50ce6d422814aa741c102cd00aaae).
The [approved prototype 06](../design/reconciliation-floor-06.html) is a design reference, including its demonstrative identities, claims and local Assist simulation. It is not served as the production UI. Its preserved SHA-256 is `5020fbc3dc4b0e1379451ec440d9a87536359d10d48dbe7a0e795739a14b2818` (provenance, not a runtime gate).

S1 provides **live, read-only source collection** at `GET /api/reconciliation/sources`. S2 adds the server-side claim model and arrangement data at `GET /api/reconciliation/scene`, described below. The UI is now the primary Overview at `/`; old `?view=floor` links open the same Overview. S4 adds the [read-only desk queue and readiness API](reconciliation-queue.md). S5 adds [authenticated conversational MCP](reconciliation-mcp.md); the existing cockpit worker routes remain available. The source, scene and queue endpoints remain read-only; [shared workflow operations](workflow.md) own policy-aware Notion writes through Inspector and MCP.

## Observed First Mate contract

Observed on Hulk, 2026-11-03T18:32:18Z, using `/home/farm/fm-home/bin/fm-fleet-snapshot.sh --json`:

| Source field | Observed meaning |
| --- | --- |
| `schema` | `fm-fleet-snapshot.v1` |
| `generated` | Snapshot observation time, `2026-11-03T18:32:18Z`; fresh collection does not make an unknown worker state known |
| `fm_home`, `roots` | Canonical operational home `/home/farm/fm-home` and its state/data/config/projects roots |
| `tasks[]` | Eight task metadata records in this observation; not a durable fleet count |
| `tasks[].id`, `spawn_gen` | Task identity and attempt/generation; use the tuple `(fm_home, id, spawn_gen)`; never a list index or title |
| `kind`, `harness`, `mode`, `backend`, `branch`, `project` | Observed role/runtime and source context; `model` is absent in this task snapshot and remains unknown |
| `remote` | Null on this home's observed tasks. Producer supports `{host, root}` on remote secondmate rows; this describes that remote row, not the collecting home's machine |
| `current_state` | `state`, `source`, `detail`, `raw`, `observed_at`, `freshness`; this task reports **unknown**, source `pane`, freshness `fresh` |
| `endpoint` | `target`, `exists`, `agent_alive`, `status`, `observed_at`, `freshness`; this task exists, while agent state is not checked |
| `paths` | Metadata, status log, worktree, optional child home and report paths; status-log `last_event` is historical evidence |
| `backlog.records`, task `backlog` | Ordered intentions/in-flight/queued/done rows, holds, blockers, links and title/raw text; not proof a worker is running |
| `pr`, `hints`, `actions` | Source PR reference, decisions/status hints and operator command suggestions; suggestions are never executed by this reader |
| `main_inventory`, `contributions`, `scout_reports` | Inventory checks, cached contribution coverage and report pointers; independent coverage dimensions |
| `secondmate_current`, `secondmate_landed`, `secondmate_guidance` | Bounded registered-home summaries with their own provenance/freshness/omissions; they do not replace each home's full task snapshot |

The observed top-level object has **no canonical machine/host field**. Machine placement and parent-home relationships in S1 are optional configured metadata with `machineBasis: configured` (or `unknown`); they are not claimed as observed snapshot facts. A parent remote row's `remote.host` is preserved separately. A future collector can compare rather than silently equate them.

`src/server/fleet/snapshot.ts` extracts the cockpit's existing command invocation into one shared read adapter. The cockpit retains its 20-second poll, optional ledger watcher, messages and guarded terminal routes. Reconciliation adds file-backed snapshots without attaching remote sources to those domain-write/terminal paths.

The optional `<home>/state/fleet-ledger.jsonl` is a **change signal only**. The existing watcher consumes complete lines with byte offsets, detects shrink/inode replacement, and has a 3-second fallback poll. First Mate's `docs/fleet-ledger.md` documents at-least-once records, missing historical dispatch/relaunch records, no sequence number/gap detector, and possible loss. Never infer complete activity history from it. S1 reports local ledger byte length/mtime as a sampled cursor, not an acknowledged event-stream offset or activity count. File publishers have no collected ledger cursor. Snapshot `generated` and individual observation timestamps remain authoritative for freshness.

First Mate's documented snapshot command can update its own parent-side remote summary cache; Tin Star never writes that cache itself or edits lifecycle state. The command does not start, stop or supervise workers.

## Observed Notion contract

Read through the authorized discovery helper using API version `2025-09-03`, GET page/schema and POST query only:

- Database: `30950ce6-d422-80d3-a541-cbd66c274f6a`.
- Current data source: `30950ce6-d422-80b5-84d0-000b877283da`.
- Card: `40d50ce6-d422-814a-a741-c102cd00aaae`, normalized page ID `40d50ce6d422814aa741c102cd00aaae`.
- Card `last_edited_time`: `2026-11-03T18:23:00.000Z`. Reader fetch time means observation freshness; page edit time means source content freshness. Neither implies progress.

| Properties actually present | Type / interpretation |
| --- | --- |
| `Name` | `title` |
| `Status` | **select**, not Notion's status type; includes Backlog, Todo, In Progress, Queued, Waiting For, Ready for Review, Done, Archived, Spare tokens and other current options |
| `Owner`, `Last touched by` | `select`; observed card has Firstmate in both |
| `Will action` | `multi_select`: Decision, Elevated command, Merge; observed card empty; tags alone never prove action readiness |
| `Parent item`, `Sub-item` | Reciprocal relations to this data source; observed card has neither. Parent item limit 1, Sub-item unbounded |
| `Link` | `url`; observed card links the Tin Star repository |
| `Next check-in`, `Due Date`, `Start Date` | `date`; check-in is an accountability checkpoint, not a completion deadline |
| `Waiting For`, `Delegated To` | `rich_text`; retain source text without interpreting it as authorization |
| `Priority`, `Area`, `Sub-area`, `Attention` | `select` |
| `Last edited` | `last_edited_time`, also available as the page-level field |
| `✅ Done`, `↩️ Back to In Progress` | Buttons; not exposed as actions |

The first real query returned 100 pages, `has_more: true`, with 25 nonempty Parent item relations in that page of results. This is a sample, not a total board count. There was no observed dedicated Initiative/Epic property. Parent relations remain source hierarchy evidence; the [Overview reference](overview.md) owns the separate Initiative/Epic organizer contract. Notion can omit inaccessible related content; coverage always means the configured, authorized data source, not the entire workspace.

S1 returns selected card properties and schema identifiers/types. It retains relation IDs. A relation whose inline list has `hasMore` is read in full through the page property endpoint and replaces that list; a relation that stays truncated, an unfinished card query, or a missing expected schema property lowers coverage to partial. External relation target context, page bodies, commitments embedded in blocks and PM Bot progress assessments are not collected by S1. Full card context/readiness work must fetch these deliberately in later slices. No new management judgment loop is introduced.

The reader uses the supported [data source query](https://developers.notion.com/reference/query-a-data-source), [schema retrieval](https://developers.notion.com/reference/retrieve-a-data-source), and [page property item](https://developers.notion.com/reference/retrieve-a-page-property) interfaces. No dependency on a machine's discovery helper or its credential is shipped.

## Real card-to-execution evidence

On branch `fm/tinstar-recon-s1`, disposable worktree `/home/farm/.treehouse/tinstar-9db33b/1/tinstar`:

```text
Notion page: 40d50ce6d422814aa741c102cd00aaae
fm_home: /home/farm/fm-home
task id: tinstar-recon-s1
spawn_gen: s1793730121.3899554.27853
branch: fm/tinstar-recon-s1
harness: codex
backend: herdr
snapshot generated: 2026-11-03T18:32:18Z
```

Evidence: the live snapshot task's `backlog.title` and `backlog.raw` contain `(card 40d50ce6d422814aa741c102cd00aaae)`; `/home/farm/fm-home/data/backlog.md:2` carries that same task/card association; `/home/farm/fm-home/data/tinstar-recon-s1/brief.md:5` names the card URL. `/home/farm/fm-home/state/tinstar-recon-s1.meta` independently supplies task/worktree/branch/harness/spawn generation. The live snapshot and metadata agree on those execution fields.

**This mapping is textual, not an explicit structured run-to-card ID field, and must remain unverified under the confirmed-link semantics.** It is stronger evidence than title similarity but is not promoted to confirmed. Neither task metadata nor the observed snapshot exposes a dedicated Notion card ID, and `backlog.links` is empty. No First Mate state was edited to repair it.

For current authoritative linking, see [Notion-owned worker links](../notion-worker-links.md). Legacy worker metadata is corroboration only.

Discovery artifacts (outside the repository): `/home/farm/fm-home/data/tinstar-recon-s1/fleet-observed.json`, `notion-card-observed.json`, `notion-schema-observed.json`, `notion-query-observed.json`. These contain source observations, not credentials, and are not product fixtures.

## Whole-farm collection routes

The owner clarified that the view covers the **whole farm**, across homes and machines. The unit of collection is one home snapshot. Homes use canonical `fm_home` identities; child executions are not copied from a parent's aggregate and counted again.

`/home/farm/fm-home/data/secondmates.md` was absent at inspection. This worker has not inspected another home's endpoint namespace or connected to another machine. The following machine associations come from firstmate's `001.msg`, not independent probes:

| Home/role | Machine | Current route established in S1 |
| --- | --- | --- |
| Main First Mate | Owner's Mac | Canonical home path/publication destination unknown here; parent routing must supply it |
| hulk | Hulk | `/home/farm/fm-home`; local executable verified |
| cmsh | Unverified here | Canonical home path, machine and authorized publication route unverified |
| fleet | Unverified here | Canonical home path, machine and authorized publication route unverified |
| kdf | Bandit | Canonical home path and authorized publication route unverified |
| hilda | Optimus | Canonical home path and authorized publication route unverified |
| kd | Owner's Mac | Canonical home path and authorized publication route unverified |
| mcp | Owner's Mac | Canonical home path and authorized publication route unverified |
| obs | Owner's Mac | Canonical home path and authorized publication route unverified |

Proposed compatible route: each home's existing operator/return-channel transport runs the documented read and publishes its JSON atomically to a private file readable by the Hulk Tin Star backend. The parent already has remote home-summary collection/cache transport (documented in `fm-fleet-snapshot.sh`), which could carry full read-only snapshots with separate size/freshness disclosure; its existing summary alone is insufficient to enumerate every child. Firstmate must identify the authorized paths/transport and arrange publication. Tin Star itself adds no SSH credentials, remote command API, remote endpoint probing, or public listener. Local homes on Hulk can use local exec once firstmate supplies the canonical paths. A missing configured file produces an explicit unknown home; it never disappears as an empty fleet.

## Run and configure

Builds and tests run on Hulk. Use Node >=22.12 and the normal backend; no package version bump:

```sh
npm ci
npm run build:all
TINSTAR_CONFIG_HOME=/absolute/private/tinstar-config node bin/tinstar.js --host 127.0.0.1 --port 5281 --no-open
curl -s http://127.0.0.1:5281/api/reconciliation/sources
```

Merge this into that config root's `config.json` (example remote paths are placeholders that the operator must replace). Restrict credential-file permissions to the operator, e.g. `chmod 600 config.json`. The operator supplies a Notion integration token with read access to the data source; do not copy the discovery credential:

```json
{
  "firstmate": { "homes": ["/home/farm/fm-home"] },
  "reconciliation": {
    "fleet": [
      { "home": "/home/farm/fm-home", "machine": "hulk" },
      {
        "home": "/Users/OPERATOR/firstmate",
        "machine": "owner-mac",
        "snapshotFile": "/absolute/private/snapshots/main-firstmate.json"
      }
    ],
    "notion": {
      "dataSourceId": "30950ce6-d422-80b5-84d0-000b877283da",
      "token": "REPLACE_WITH_OPERATOR_READ_TOKEN"
    }
  }
}
```

Optional `label` supplies a display name; otherwise the home basename without a leading `fm-` is used. Labels never replace the full home path for identity or routing. Optional `parentHome` captures configured accountability without deriving it from titles. Every home should appear once. With no `reconciliation.fleet`, existing `firstmate.homes` supply local sources; an explicitly empty fleet remains empty with an unknown-coverage warning. Invalid configuration is reported, not silently treated as a verified empty fleet. Restart after configuration changes.

The response uses the application envelope `{ok:true,data:{generatedAt,scope,warnings,fleet,intentions}}`. Every home has its source configuration and an observation with `status`, `coverage`, `observedAt`, `attemptedAt`, `expiresAt`, `error`, and nullable `data`. `scope` is always `configured-homes-only`; successful reads do not certify that every farm home was configured. Intention coverage means configured source properties, not full card context.

- Demand-driven reads only: fleet cache 20 seconds, fresh age 300 seconds for `snapshotFile` homes and 60 seconds for local-exec homes; Notion fresh age 120 seconds; [workflow read contracts](workflow.md#read-contracts) own the shared Notion cache durations and query scopes. The file window tolerates snapshot generation and publication taking 2–3 minutes. Failures are cached too; concurrent clients coalesce reads. Manual refresh uses the same coalesced readers and bypasses their normal TTL. Incomplete Notion/home publications retain omitted last-known records until a complete read can establish their removal. When merged with cached data, the whole observation is stale and preserves its previous observation and expiry timestamps; repeated partial reads cannot renew retained evidence. A first partial read without cached data remains partial. Regression coverage lives in `src/server/reconciliation/__tests__/sources.test.ts`.
- Up to 32 configured homes, four reads at once; each local command has an 18-second timeout and 16 MiB output bound. File reads are bounded to 16 MiB; producers should publish by atomic rename and refresh within the stated age. A missing file, bad JSON, wrong `fm_home` or missing/invalid timestamp is an unavailable source. Complete inventory coverage requires explicit `backlog.present: true` and `main_inventory.valid: true`. Missing attempt IDs, unavailable/unstructured backlog inventory, duplicate task/backlog IDs, or reported inventory contradictions lower coverage to partial.
- Notion schema plus at most twenty 100-row card-query pages per refresh. Truncated relations use up to ten 100-item pages per property, with at most 20 relation requests per refresh. All requests share one 20-second deadline, a 4 MiB per-response bound and no retry. Page and relation truncation is explicit. A failed or bounded relation read retains its inline list and names the card/property in `truncatedRelations`. Legacy whole-board reads lower coverage to partial for truncated relations; scoped work reads measure completeness within the requested scope and disclose relation truncation separately. Card-query failure retains the preceding cached observation as stale; a first failed read is unknown with `data:null`.
- Freshness is evaluated from the snapshot's `generated` timestamp, not file mtime, file read time or response assembly time. At the freshness limit, a published file becomes stale even when read successfully; last-known data stays labeled and absence conclusions are suspended. Unavailable reads retain labeled last-known data in memory until server restart. No persistent source cache is written.
- The route accepts GET/OPTIONS, rejects writes and foreign browser origins, uses existing local/tailnet access and CORS policy, and sets `Cache-Control: no-store`. It does not open a listener or public endpoint. Existing access controls must protect any optional remote access; S1 is not the authenticated MCP interface.
- Raw transcripts, brief bodies, operator command suggestions and Notion credentials are omitted from the source response. Generic failure text avoids exposing fetch/exec diagnostics or secrets.

Acceptance for S1: inspect source IDs/timestamps, find the real card and task, stop refreshing a controlled published fixture and observe stale, supply a missing source and observe unknown, and verify GET produces no domain mutations. UI, queue decisions and MCP proofs remain explicitly unavailable until later slices.

## Reconciled scene (S2)

With the same server/configuration above, read:

```sh
curl -s http://127.0.0.1:5281/api/reconciliation/scene
```

The response retains the application envelope and the sources route's origin policy, GET/OPTIONS restriction, `no-store` header, bounded caches and source freshness rules. There is no new listener, source write or fleet lifecycle operation. Both routes share the same cached readers.

The scene contains:

- `coverage`: source timestamps, expiry, errors, each configured home (including failed homes), and whether configured-source absence conclusions are suppressed. `wholeFarm: not-certified` explicitly records that a configured list does not independently establish a census of the farm.
- `cards`: canonical Notion IDs, selected source properties, actual Parent item IDs/ancestry, missing/cyclic/truncated hierarchy issues, property-based execution expectations, named waiting/delegation text and independent checkpoint state. Card bodies and PM Bot progress assessments remain uncollected; `progressAssessment` is null.
- `executions`: IDs encoded from the tuple `[fm_home, task_id, spawn_gen]`, their home/parent-home accountability, source state and timestamps. Execution liveness and derived activity follow the [Floor UI liveness rules](#floor-ui-s3). Secondmate records are managers, not untracked ship workers.
- `backlog`: home-scoped task metadata with references and source coverage. Queued/held work can be accounted for without inventing a worker or spawn generation.
- `claims`: card-to-attempt relationships with basis, evidence field paths, observation time, accountability, verification and current/last-known/historical state. The authoritative association contract and candidate rules are in [Notion-owned worker links](../notion-worker-links.md).
- `claimHistory`: previously observed relationships with their attempt identity. Complete fresh observations can retire a missing attempt or an explicitly reassigned relationship. Failed reads keep previous relationships labeled last-known. History is in memory only, bounded to 24 hours/2,000 prior claims and reset on server restart. It is neither a complete event history nor proof of continuous execution. Historical relationships do not count toward current totals or arrangements.
- `findings`: semantic categories with card/execution/home IDs and explanatory evidence. Confirmed linking establishes a relationship, never progress or delivered behavior.
- `arrangements`: `initiative`, `secondMate`, and `machine` groups over the same card/execution/claim IDs. Initiative uses the observed Parent item chain, preserving missing-parent IDs rather than inventing initiative/epic names. Each arrangement has an explicit Unassigned / unknown group. Home grouping preserves configured parent-home accountability. Machine grouping uses a row's observed `remote.host` when present, otherwise the collecting home's configured machine, otherwise unknown; both the placement basis and configured machine remain visible. Failed configured homes retain their home/machine groups.
- `cardRollups` and `counts`: deduplicated descendant card, worker and attempt membership. Workers use `(home, task_id)` while attempts include `spawn_gen`; two homes sharing a task name remain distinct. Cards linked to multiple workers or referenced by multiple descendants count once per parent/group. Multi-parent or multi-machine membership can overlap; consumers must union IDs rather than sum group counts. Managers are excluded from worker counts and retained in attempt membership.

Finding rules:

| Finding | S2 evidence and limits |
| --- | --- |
| Confirmed link | See the authoritative [worker-link classifications](../notion-worker-links.md#classification). |
| Task execution gap | Firstmate-owned In Progress work with no published wait/future start; explicit home accountability from a confirmed attempt or in-flight structured backlog reference; fresh complete configured sources and sufficient [execution-liveness evidence](#floor-ui-s3); no execution, wait or unverified candidate accounting for it. Missing home accountability suppresses the conclusion because work could run elsewhere in the farm. The reason names the accountable home and configured scope. |
| Untracked worker | See the authoritative [worker-link classifications](../notion-worker-links.md#classification). |
| Unverified/conflicting | Textual/inferred/missing/contradictory IDs, unknown expectations, hierarchy issues, or a textual backlog wait. Contradictory standalone backlog references cannot establish home accountability or a legitimate wait and suppress execution-gap conclusions. No automatic repair. |
| Unknown/stale source | Partial, unavailable, expired, permission-limited observations, unknown runtime or insufficient accountability coverage. Last-known records remain labeled and absence conclusions are suppressed. |
| Legitimate wait/planned | Backlog, Todo, Queued, planned, review, waiting, completed/archived status, future Start Date or published Waiting For; observed worker wait through a current confirmed claim; or noncontradictory structured queued/held backlog reference. Inferred, textual or conflicting worker relationships remain unverified and suppress execution-gap conclusions; the worker's waiting activity remains visible independently. Source wait detail and card checkpoint remain available. |
| Outside coverage | Owner other than Firstmate (including PM Bot and humans). No missing-First-Mate-worker assertion. |

An overdue/missing checkpoint is independent accountability data. It does not imply a crashed worker; a future checkpoint does not excuse an otherwise evidenced execution gap. S2 does not assess PR readiness, delivery or the executive queue.

Controlled tests in `src/server/reconciliation/__tests__/scene.test.ts` cover explicit/textual/inferred/conflicting links, gap/accountability scope, untracked workers, planned/waiting/outside work, stale/partial/unavailable coverage, unknown placement/runtime, duplicate identity, multiple workers/attempts, identical IDs across homes, restart/reassignment history, Parent item chains and deduplicated grouping. Source HTTP tests cover the scene envelope, unknown coverage, foreign origins and rejected writes.

### Measured S2 proof on Hulk

At `2026-11-03T19:25:26.558Z`, the real Hulk snapshot and authenticated live Notion read produced 10 observed execution records and 854 authorized cards. These are observation counts, not product constants. The S2 execution was:

```text
fm_home: /home/farm/fm-home
task_id: tinstar-recon-s2
spawn_gen: s1793733334.1652833.9158
card: 40d50ce6d422814aa741c102cd00aaae
basis: textual; verification: unverified
evidence: task.backlog.title, task.backlog.raw, backlog.title, backlog.raw
```

The card/task remained reachable in initiative Unassigned, the Hulk home and configured Hulk machine groups. Notion was partial because two Sub-item relations were truncated; the fleet metadata was fresh while runtime states remained unknown. The scene correctly suppressed absence conclusions and produced zero execution-gap or untracked-worker assertions. No textual relationship was promoted to confirmed.

Evidence and rerunnable discovery proof: `/home/farm/fm-home/data/tinstar-recon-s2/live-proof.json` and `live-proof.ts` (outside the repository). The proof uses the authorized discovery helper for authenticated GET/schema and POST/query only, through an injected read bridge. No credential is read/copied into Tin Star, printed or committed. As in S1, a production Notion token and the other homes' authorized publication routes remain operator prerequisites. This proves the server-side reconciliation model with live sources, not whole-farm deployment, floor UI, queue readiness or MCP delivery.

## Measured source proof on Hulk

At 2026-11-03T18:43:17Z, the normalized fleet reader returned the real S1 task with fresh, complete home metadata/backlog coverage. The Notion reader retrieved 854 authorized pages across pagination (`hasMore: false`) and found the real card. It correctly reported **partial** coverage: Sub-item relations on pages `3fb50ce6d422812ea3fbfe3a4b2fae58` and `3f850ce6d4228145bf16d59da8ce4a3c` were truncated. No schema properties were missing. These are observed sample counts, not static product data.

Proof artifacts are `/home/farm/fm-home/data/tinstar-recon-s1/live-proof.ts` and `live-proof.json`. Notion requests in this development proof used an injected fetch bridge to the authorized discovery helper: the helper authenticated the actual GET/POST queries while retaining its own credential. This proves normalization of live source reads, **not** a configured production Notion deployment. The shipped default fetch transport uses only the operator's Tin Star configuration token.

## Floor UI (S3)

Start the existing web app with `npm run build:all && node bin/tinstar.js --no-open`, then open `http://127.0.0.1:5273/?view=floor` (use the actual port printed by the CLI). Desktop uses the same component and `apiFetch` transport. Configure the live fleet and Notion sources as above; no demo records are substituted when configuration or reads fail. Whole-farm publication routes and Notion credentials are operator prerequisites, not implied by a successful local read. The desk reads S4’s ordered readiness queue with explicit stale/unavailable treatment. S5 adds [authenticated MCP and browser acknowledgments](reconciliation-mcp.md).

The existing floor owner polls `GET /api/reconciliation/scene` sequentially, 30 seconds after the preceding read completes while Overview or Decisions is visible, with a 60-second request deadline and cancellation on unmount. Returning focus to an older view and the toolbar refresh icon use that same read with `?refresh=1` to bypass source TTLs. Repeated triggers share a pending read. The [Overview reference](overview.md) owns the refresh control and sync-label behavior. Failed reads retain the last scene and suspend absence conclusions. Source expiration also labels retained observations and findings as last-known. Partial coverage remains visible. There is no all-clear indicator.

`useFloorScene().refreshAfterMutation()` is the shared invalidation entry after a confirmed local card mutation. It discards a response started before that mutation and performs one forced follow-up before publishing. The [shared workflow actions](workflow.md) use this callback through the existing Desk workspace. Scene records, links, pattern predicates, dial counts and status summaries derive from each whole published scene; refresh preserves presentation preferences, grouping, selection and expansion.

Current grouping, counts, collapse behavior and independent stacks are described in [Overview](overview.md). Liveness remains an execution contract rather than a grouping inference.

Owner-facing membership, activity and History placement follow the
[recorded worker evidence contract](codex-activity.md), with displayed facts and
counts owned by [Overview](overview.md). The underlying scene retains snapshot
liveness through [`executionLiveness.ts`](../../src/shared/executionLiveness.ts);
that legacy classification is not authority for owner-facing worker state.
Second Mate child-outcome and inactive-outcome reports do not finish the manager
or supply its own state. Expired or unavailable observations retain records with
uncertainty labeling.

Finished and absent attempts cannot satisfy a card's execution requirement and cannot become untracked execution. Not-observed attempts also cannot satisfy that requirement, but suppress absence conclusions rather than proving an execution gap. A finished linked attempt can expose a gap when the card still expects execution and all configured absence evidence is sufficient; task completion is not automatically card delivery.

Presentation controls and inspector behavior follow [Overview](overview.md). IDs, source evidence and observation times remain available on selection; card prose is fetched on demand. The [MCP reference](reconciliation-mcp.md) owns semantic actions and acknowledgment behavior.

The inspector links eligible exact home/task identities to the existing guarded worker/terminal page in a separate tab. File-published homes do not acquire terminal access. Ambiguous basename routes are withheld to avoid opening the wrong home. Closing this page uses the existing viewer lifecycle and never stops the worker. No new domain-write route, orchestration, approval or claim repair is added.

Shared organization, filtering and semantic selection pass through the pure reducer in `src/shared/reconciliationPresentation.ts`, re-exported by `src/reconciliation/presentation.ts`. Density and inline relationship expansion follow the [Overview reference](overview.md). Historical or removed IDs remain selected with explicit unavailable labeling. S5 uses this reducer for shared controls and authenticated command delivery; see [the MCP presentation and acknowledgment contract](reconciliation-mcp.md).

### Click acceptance and controlled browser proof

Use the current [browser acceptance guidance](../testing.md#browser-regression-playwright) and [Overview reference](overview.md) for the replacement UI.

Shared scene fixtures live in `test-fixtures/reconciliation/scenes.ts`; individual tests also construct controlled variations. They cover gap, untracked worker, inferred claim, wait, backlog, outside ownership, multiple workers/machines, 857 cards/85 workers, and an unavailable home. They are imported only by tests, never the production UI. Browser tests use an isolated First Mate config and controlled read-only source responses; no production incident or source write is manufactured.

Run on Hulk:

```bash
npm run typecheck
npm run build:all
npx vitest run src/reconciliation/__tests__ src/server/reconciliation/__tests__ --exclude='e2e/**'
TINSTAR_FLOOR_SCREENSHOTS=/home/farm/fm-home/data/tinstar-recon-s3/screenshots npx playwright test --config playwright.cockpit.config.ts e2e/reconciliation-floor.spec.ts
```

Screenshots cover the current Overview controls, mobile/reduced motion, large unavailable coverage and failed-refresh retention. Existing cockpit browser regressions continue to test terminal and viewer-window survival separately. Real read-through UI evidence requires the configured operator source credentials/routes; controlled fixtures do not certify whole-farm deployment.
