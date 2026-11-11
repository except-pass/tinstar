# Jira adapter pilot

This is the bounded implementation for [the approved minimum adapter](https://app.notion.com/p/41550ce6d42281c791f8ca0f471c52b5).
Notion remains authoritative for existing work. Jira is an explicitly configured,
independent source of **synthetic issues in TSSPIKE (10638)**. There is no sync,
dual write, migration, production deployment, automatic pickup or default switch.
The spike (`681f796a:data/tinstar-jira-spike/report.md`) is evidence, not the base.

Configure an isolated preview's `TINSTAR_CONFIG_HOME/config.json`:

```json
{
  "reconciliation": {
    "fleet": [],
    "jira": {
      "url": "https://fortresspower-jira.atlassian.net",
      "projectId": "10638"
    }
  }
}
```

Supply `TINSTAR_JIRA_EMAIL` and `TINSTAR_JIRA_TOKEN` in the server environment at
runtime, or the `email`/`token` settings in its private config. Never commit those
values. Credentials are server-side only. Existing `reconciliation.notion`
configuration is unchanged and can coexist; each card routes by its own identity.
Omitting `create_work.provider` still means Notion. Creating in Jira requires
`"provider":"jira"`; an unconfigured provider fails without falling back.

The fixed site/project boundary prevents this authorized pilot from writing real
work elsewhere. The adapter has only project reads and issue-level operations;
it has no configuration mutation APIs. Every issue write is preceded by a fresh
read confirming project ID/key and the `tinstar-synthetic` label. Creation reads
the exact project and Task status metadata first. Removing the label stops further
Tin Star writes; it does not delete the issue. No generic comment is a decision.

## Field mapping

| Existing work value | Jira persistence and readback |
| --- | --- |
| Source/database | Explicit site + project 10638. Queries include only `tinstar-synthetic` issues. Enhanced search has a five-property limit; a bounded exact issue read supplies the complete metadata for each result. |
| Card identity | `jira:fortresspower-jira.atlassian.net:10638:<immutable issue ID>`; mutable issue key is display/navigation only. Notion UUIDs remain unchanged. |
| Name | Native Summary. Task remains native Task `10582`; no Decision/Wait types. |
| Status | Native status and discovered native transition. The approved spelling mappings are **To Do = Todo**, **In Review = In review**. Other names remain distinct. Missing destinations fail explicitly. |
| Brief, acceptance, ordinary page prose | Managed paragraphs in native ADF Description; unrelated ADF nodes survive edits. This is not the full approved contract. |
| Due Date / Start Date | Native `duedate` / `customfield_10015`. Jira fields accept date-only; timestamp writes report an incompatibility rather than truncating. Next check-in retains a full timestamp separately. |
| Owner | Coordinator metadata, preserving Firstmate/other existing select values. A coordinator is not a Jira account; Assignee is not fabricated or used as worker proof. |
| Last touched by, Area, Priority, Sub-area, Attention, Initiative, Epic, Link, Next action | Corresponding typed issue properties `tinstar.workflow.<encoded property name>`. Existing native create/edit metadata does not expose these logical custom fields. Priority/Epic do not silently become Jira's different priority/hierarchy semantics. |
| Will action | Multi-value issue metadata. Structured existing request/answer markers remain in native comments. Answering one request preserves other requests/actions. |
| Waiting For / Type / ID | Separate issue metadata, retaining existing multiline waits and explicit identifiers. Answer clears only the exact requested wait. The existing wait operation's behavior is preserved; it does not invent Type/ID values. No wait issues. |
| First Mate tasks | Exact `tinstar.fm-links.v1` JSON in issue metadata, with home/task/spawn-generation readback. Existing worker validation and source freshness still apply. |
| Delegated To | Separate exact external-worker/context metadata; consumer reports remain attributed and are not independent execution proof. |
| Next check-in | Date metadata including timezone, through existing checkpoint semantics. |
| Parent item / Sub-item | Same-provider qualified IDs in issue metadata. Arbitrary multi-parent relations are not silently reduced to Jira's single native parent. |
| History/comments | Native Jira comments using ADF and the existing receipt/decision markers, authenticated recorder and complete bounded history reads. |
| Approved handoff, including executive brief and large contract | Native JSON attachment batches containing the existing ordered raw-text sections. Existing immutable version manifests, SHA-256/byte/length verification, completion marker, previous versions, durable uncertain-append latch and paginated exact reader are reused. No text is truncated into Description. |

Actual gaps are native field exposure, date-only native dates and status setup.
Issue properties are a minimal metadata compatibility seam, **not custom fields
visible in Jira's ordinary field editor or independently indexed JQL fields**.
Each property's Jira limit is 32 KiB of serialized JSON; oversize metadata reports
the exact field and limit. Approved contracts use attachments, retain the
[shared contract bounds](workflow.md#one-call-approved-implementation-handoffs), and are
loaded only on explicit exact reads.
Native attachment upload/download permission must be available for that path.
Unsupported ADF or incomplete history cannot establish absence of a receipt.

## Shared operations and fixture safety

The existing `WorkflowOperations`, Inspector forms, UI endpoint and MCP tools
share validation, serialization, decision scope and confirmed readback. Jira
metadata editing and native transition are separate writes: a failure reports
partial state and exact confirmed fields, never transactional success. A failed
post-write read, including HTTP 429, remains partial/unconfirmed and retains
independently confirmed fields. There is no write retry loop. Creation validates
property limits, native date mappings and status availability before recording
an attempted creation. A creation receipt prevents duplicates after ambiguous
responses; a found incomplete creation remains partial on retry.

Synthetic Jira cards suppress Firstmate pickup/update notifications and source
request delivery. They can retain a worker identity from an explicitly configured
synthetic fleet snapshot; no assignment, label or stored worker link is proof of
a real worker. Real dispatch and supervision remain First Mate's responsibility.
Notion pickup, review and release behavior remains unchanged. This pilot does not
create guarded deployment evidence or bypass existing review requirements.

The owner configured native Queued (`10984`) and Waiting For (`10985`). Fresh
Task workflow/transition reads on 2026-11-11 confirm the proof can use Queued,
Waiting For, In Progress and Done, plus To Do = Todo and In Review = In review.
Ready for Review, Backlog and Archived remain absent. Operations needing them
return an explicit incompatibility; the first proof does not need them. Native
Review is **not** a stand-in for Ready for Review. Further configuration requires
the supported TSSPIKE UI and separate confirmation; no bulk workflow/status API
or global field operation is allowed.

## Reproducible proof

Fixture coverage runs without Jira credentials or configuration writes:

```sh
npx vitest run src/server/reconciliation/__tests__/jira.test.ts src/server/reconciliation/__tests__/workflow.test.ts --exclude='e2e/**'
```

The Jira fixtures use the real shared UI HTTP and authenticated MCP transports,
including create/edit, assignment, native transitions, comments, request/answer,
multiple waits, worker provenance, failures and exact contract attachments.
They complement the existing Notion suite; they are not a claimed live proof.

For the live proof, build this branch and run an isolated preview on 5293–5296.
The focused preview mounts production `ReconciliationSources`, UI workflow/MCP
handlers, and the built client; it does not start the standalone server's unrelated
telemetry listeners or any First Mate lifecycle services:

```sh
npx tsx scripts/jira-workflow-proof.ts --config-home /absolute/private/proof-config --prepare
# Supply the runtime Jira credential environment through the approved secret route.
TINSTAR_CONFIG_HOME=/absolute/private/proof-config npx tsx scripts/jira-workflow-preview.ts --port 5293
npx tsx scripts/jira-workflow-proof.ts --config-home /absolute/private/proof-config --server http://127.0.0.1:5293 --output /absolute/private/proof.json --operation-prefix UNIQUE
```

Use a private config root and a synthetic snapshot file; never configure a real
First Mate home or enable inbox delivery. After native status setup is confirmed,
run `scripts/jira-workflow-proof.ts` against that preview, then use the existing
Inspector to inspect/edit the returned card and capture it with the task's named
`chrome-devtools-axi` session. Keep receipts/screenshots outside the repository.
Stop the browser session immediately after capture. Keep the one synthetic issue
as review evidence. Do not deploy or expand the pilot after the first proof.

## Later simplifications

Jira-native required fields and transitions could replace Notion-specific select
validation, native links/history can replace custom relation/history mechanics,
and project custom fields can replace the small metadata seam once configured.
Native automation/webhooks may later replace polling and notification latches.
None are rollout prerequisites or implemented parallel frameworks in this slice.
