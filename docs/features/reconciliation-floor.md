# Reconciliation Floor: source integration (S1)

This is the first slice of the owner-approved [Reconciliation Floor card](https://app.notion.com/p/40d50ce6d422814aa741c102cd00aaae).
The [approved prototype 06](../design/reconciliation-floor-06.html) is a design reference, including its demonstrative identities, claims and local Assist simulation. It is not served as the production UI. Its preserved SHA-256 is `5020fbc3dc4b0e1379451ec440d9a87536359d10d48dbe7a0e795739a14b2818` (provenance, not a runtime gate).

S1 provides **live, read-only source collection** at `GET /api/reconciliation/sources`. The cockpit UI still uses its existing routes. Claim reconciliation, arrangements, desk readiness, authenticated conversational MCP and browser acceptance belong to subsequent slices. This endpoint makes no gap/orphan/progress/readiness judgments and supplies no orchestration or Notion-write action.

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

The first real query returned 100 pages, `has_more: true`, with 25 nonempty Parent item relations in that page of results. This is a sample, not a total board count. There is no observed dedicated initiative/epic relation property: use actual parent relations when available, retain unassigned cards and do not derive a new canonical hierarchy from Area/Sub-area or prototype labels. Notion can omit inaccessible related content; coverage always means the configured, authorized data source, not the entire workspace.

S1 returns selected card properties and schema identifiers/types. It retains relation IDs and `hasMore`; truncated property relations or a missing expected schema property lower coverage to partial. External relation target context, page bodies, commitments embedded in blocks and PM Bot progress assessments are not collected by S1. Full card context/readiness work must fetch these deliberately in later slices. No new management judgment loop is introduced.

The reader uses the supported [data source query](https://developers.notion.com/reference/query-a-data-source) and [schema retrieval](https://developers.notion.com/reference/retrieve-a-data-source) interfaces. No dependency on a machine's discovery helper or its credential is shipped.

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

Smallest compatible upstream proposal: let the supported intake/dispatch boundary accept optional `notion_page_id`, normalize it to the canonical page ID, persist it as additive task metadata, and publish it unchanged in the snapshot beside `id` and `spawn_gen`. Preserve the existing brief/backlog text and support absent IDs. A dispatch with several cards should accept multiple source references rather than forcing title matching. This requires First Mate's existing review authority; it is documented here, not implemented behind its back.

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

Optional `parentHome` captures configured accountability without deriving it from titles. Every home should appear once. With no `reconciliation.fleet`, existing `firstmate.homes` supply local sources; an explicitly empty fleet remains empty with an unknown-coverage warning. Invalid configuration is reported, not silently treated as a verified empty fleet. Restart after configuration changes.

The response uses the application envelope `{ok:true,data:{generatedAt,scope,warnings,fleet,intentions}}`. Every home has its source configuration and an observation with `status`, `coverage`, `observedAt`, `attemptedAt`, `expiresAt`, `error`, and nullable `data`. `scope` is always `configured-homes-only`; successful reads do not certify that every farm home was configured. Intention coverage means configured source properties, not full card context.

- Demand-driven reads only: fleet cache 20 seconds, fresh age 60 seconds; Notion cache 60 seconds, fresh age 120 seconds. Failures are cached too; concurrent clients coalesce reads. There are no retries or new pollers.
- Up to 32 configured homes, four reads at once; each local command has an 18-second timeout and 16 MiB output bound. File reads are bounded to 16 MiB; producers should publish by atomic rename and refresh within the stated age. A missing file, bad JSON, wrong `fm_home` or missing/invalid timestamp is an unavailable source. Missing attempt IDs, unavailable/unstructured backlog inventory, or reported inventory contradictions lower coverage to partial.
- Notion schema plus at most ten 100-row pages per refresh, one 20-second deadline, 4 MiB per response, no retry. Page and relation truncation is explicit. Pagination failure retains the preceding complete cache as stale; a first failed read is unknown with `data:null`.
- Freshness is evaluated from source timestamps, not file mtime or response assembly time. An old published file remains stale even when read successfully. Unavailable reads retain labeled last-known data in memory until server restart. No persistent source cache is written.
- The route accepts GET/OPTIONS, rejects writes and foreign browser origins, uses existing local/tailnet access and CORS policy, and sets `Cache-Control: no-store`. It does not open a listener or public endpoint. Existing access controls must protect any optional remote access; S1 is not the authenticated MCP interface.
- Raw transcripts, brief bodies, operator command suggestions and Notion credentials are omitted from the source response. Generic failure text avoids exposing fetch/exec diagnostics or secrets.

Acceptance for S1: inspect source IDs/timestamps, find the real card and task, stop refreshing a controlled published fixture and observe stale, supply a missing source and observe unknown, and verify GET produces no domain mutations. UI, queue decisions and MCP proofs remain explicitly unavailable until later slices.

## Measured source proof on Hulk

At 2026-11-03T18:43:17Z, the normalized fleet reader returned the real S1 task with fresh, complete home metadata/backlog coverage. The Notion reader retrieved 854 authorized pages across pagination (`hasMore: false`) and found the real card. It correctly reported **partial** coverage: Sub-item relations on pages `3fb50ce6d422812ea3fbfe3a4b2fae58` and `3f850ce6d4228145bf16d59da8ce4a3c` were truncated. No schema properties were missing. These are observed sample counts, not static product data.

Proof artifacts are `/home/farm/fm-home/data/tinstar-recon-s1/live-proof.ts` and `live-proof.json`. Notion requests in this development proof used an injected fetch bridge to the authorized discovery helper: the helper authenticated the actual GET/POST queries while retaining its own credential. This proves normalization of live source reads, **not** a configured production Notion deployment. The shipped default fetch transport uses only the operator's Tin Star configuration token.
