# Tin Star Jira feasibility spike

Status: **independent investigation complete; live Jira proof pending access**. This is an interim findings report, not a passing feasibility result or an adapter proposal approved for implementation. Notion remains authoritative. No Jira project, fixture, workflow, webhook, or automation has been created by this worker.

Request: [owner-approved card 41550ce6d42281fe8811c56b97fdaacb](https://app.notion.com/p/41550ce6d42281fe8811c56b97fdaacb). Worker: home `/home/farm/fm-home`, task `tinstar-jira-spike`, first observed spawn generation `s1794368898.3320215.18175`. The live card's `tinstar.fm-links.v1` declaration confirmed that exact identity. Firstmate owns card writes and review routing.

Repository inspected: `except-pass/tinstar`, commit [`5c075dad647ae0034633ba858e4afd6c1abeb3ff`](https://github.com/except-pass/tinstar/commit/5c075dad647ae0034633ba858e4afd6c1abeb3ff), committed 2026-11-11T03:10:27Z. Branch: [`fm/tinstar-jira-spike`](https://github.com/except-pass/tinstar/tree/fm/tinstar-jira-spike). Only documentation and standalone proof scripts belong to this branch. The spike delivery override requires a pushed branch, no pull request, no no-mistakes run, and no merge.

Read repository instructions: `CLAUDE.md`, `docs/contributing.md`, `docs/conventions.md`; no root `AGENTS.md` or `CONTRIBUTING.md` was present. Read the current [board working instructions](https://app.notion.com/p/3f950ce6d42281d49db5d440a4732715) and [canonical board rules](https://app.notion.com/p/3f750ce6d42281758912c93f294a6344). The [simplified-workflow parent](https://app.notion.com/p/41450ce6d4228163a0bccf5da6e96437) and its outstanding acceptance/release work are untouched.

## 1. Exact configuration and primitive mapping

### Observed current source

The read-only Tin Star connector exposed nine tools, without `search_work`, `get_workflow_rules`, or `submit_handoff`. `list_ui_sessions` reported no connected tab. An explicitly returned scene ID still allowed `get_card_context` to read this authorized card; the card property observation was fresh/complete, while bounded body context was partial. Presentation connectivity and source availability are separate.

The configured source was then discovered from that exact card through the connected Notion read route: data source `30950ce6-d422-80b5-84d0-000b877283da`, database `30950ce6d42280d3a541cbd66c274f6a`. Fetching that collection supplied the complete property-name/type catalog and status/options metadata. This fallback was read-only. The default local Tin Star configuration `/home/farm/.config/tinstar/config.json` was absent, so the standalone schema helper could not authenticate locally; no credential search or guessed alternative home was used.

Observation date: 2026-11-11 UTC. Raw sanitized receipts and test output are outside the branch at `/home/farm/fm-home/data/tinstar-jira-spike/` (section 2). The following IDs are actual Notion REST property IDs from the live spike card, scoped to this data source; percent encoding is preserved.

| Property | Actual ID | Actual REST type |
| --- | --- | --- |
| Name | `title` | title |
| Status | `fuES` | select |
| Owner | `pXmY` | select |
| Last touched by | `Lpbs` | select |
| Will action | `%60CX%3F` | multi_select |
| Parent item | `CEM%5E` | relation |
| Sub-item | `_%3Arm` | relation |
| Link | `knEB` | url |
| Waiting For | `GZNK` | rich_text |
| Waiting For Type | `l%5C%3F%40` | select |
| Waiting For ID | `pj%7B%3C` | rich_text |
| Delegated To | `wCk%3D` | rich_text |
| Next check-in | `wEKw` | date |
| Due Date | `keVI` | date |
| Start Date | `~pya` | date |
| Priority | `hYKe` | select |
| Area | `LWUy` | select |
| Sub-area | `z%3AxG` | select |
| Attention | `kPwd` | select |
| Initiative | `Qs%5Bd` | select |
| Epic | `tIuc` | select |
| First Mate tasks | `NMo%5C` | rich_text |

The collection also exposes `Last edited` (system `last_edited_time`), `↩️ Back to In Progress` (button), and `✅ Done` (button). Their REST property IDs were not exposed by these read surfaces and are unresolved; they are not write targets. The collection connector labels REST rich text as `text`, independently reconciled against Tin Star's REST metadata above. Both hierarchy relations point to the same board collection. No record was rewritten to reconcile any ambiguity.

Actual Status options: Backlog, Todo, In Progress, Delegated to person, Done, Waiting For, Queued, Ready for Review, Archived, Spare tokens, In review, Waiting, Not started, Waiting for Prod Release. The last three aliases outside the board's canonical list remain visible; inspection does not normalize existing records. `Will action` options are Decision, Elevated command, Merge, Do. `Waiting For Type` options are Work, Actor, Event. Owner is a select, not People. Initiative and Epic are selects, not related portfolio entities. The board has **no Next action, Evidence, GitHub PRs, Requires production verification, or separate WorkType property** in this observation, even though code supports some optional properties of those names.

### Actual Jira configuration: not yet observed

| Required fact | Actual result / exact evidence still needed |
| --- | --- |
| Authorized site URL and cloud/site ID | Not supplied by Firstmate; none guessed. |
| Authenticated owner, integration, UI and REST actor account IDs | Unknown. An owner connector identity must not be presumed to be a Hulk REST/UI identity. |
| Product/plan, trial status, automation allowance, current usage, reset period and service limits | Unknown; capture tenant billing/usage readout, without enabling paid usage. |
| Create team-managed project permission | Unknown for the actual caller; another team's project proves nothing. |
| Project ID/key/type/template/access | Not created. At most one clearly labeled disposable private team-managed project is authorized. |
| Project-local work types, fields, statuses, transitions, workflow rules and automation administration | Unknown. Capture successful permitted actions and any denial separately for owner and integration. |
| Site restrictions | Unknown: creation policy, project-admin automation restriction, outbound domain restriction, integration/data access policy, native webhook administration. |
| Private membership / anonymous / ordinary uninvited-user access | Untested. Only owner and specifically needed existing test/integration actors may receive access. Site administrators are outside the privacy guarantee. |
| Existing approved callback and verification | Not supplied. Do not expose the console, open ports, register an arbitrary third-party receiver, or deploy a receiver. |

Every Jira field, option, work-type, status, transition, link-type and project ID below is **unresolved until live discovery**. Names are logical labels, never globally unique selectors. Capture an ID manifest scoped by actual site + project + work type; discovery must fail visibly on ambiguity rather than select the first matching display name. This is a safety boundary against writing another project's records, not a new business approval gate.

### Primitive mapping (complete baseline)

Classification: N = provider-native primitive, C = project configuration, X = domain metadata/policy retained in Tin Star/First Mate. A candidate is not a tenant capability claim. Source references are relative to the recorded commit.

| Name | Meaning / canonical shape | Current Notion implementation | Proposed Jira implementation | Classification | Evidence / unresolved gap |
| --- | --- | --- | --- | --- | --- |
| WorkSource | `{provider, instanceId, collectionId, scope}`; authority and bounded read scope | Configured data source; property queries and exact-card membership check | Actual site + project ID, optional declared subset; refresh scope independent of status | N+C | `notion.ts`, `workReader.ts`; Jira project/auth unknown. |
| WorkRef | `{provider, instanceId, itemId, displayKey?, url}`; immutable identity | Page UUID/URL; `card_id` and UUID schemas | Site + immutable issue ID; issue key only display/navigation | N+X | `shared/workflow.ts` hard-codes UUIDs; cannot reuse them as Jira identities. |
| ActorRef | `{kind: account/coordinator, authority, id}`; no execution identity | Owner labels; native comment author; authenticated caller for writes | Actual account ID for people; explicit coordinator key for Firstmate without inventing a Jira account | N+X | Live Owner is select. Account/coordinator correspondence needs explicit discovery. |
| WorkItem | Work with title, brief, acceptance, attributes, lifecycle and authority | Page properties + body + comments | Native issue summary/description and configured fields | N+C | `workflowContent.ts`; description limits/ADF and full contract are separate concerns. |
| WorkType | Explicit work kind | No board property; never infer kind from title | Task plus justified Decision and Wait types in isolated project | N+C | Creation/customization rights and actual type IDs untested. |
| WorkAttributes | `{area, subArea?, priority?, attention?}` | Select fields above; Attention has both plain and emoji aliases | Native priority; scoped Area/Sub-area/Attention fields; explicit option correspondence | N+C | No automatic label/emoji collapse. Field contexts and priority mapping pending. |
| WorkGrouping | `{initiative?, workstream?}` classification, not necessarily hierarchy | Initiative/Epic select labels | Scoped classification fields initially; native Epic only after a separate semantic decision | C | Current `Epic` means workstream; treating every value as a native Epic changes the design. |
| WorkRelation | Typed directed edges with stable endpoints and multiplicity | Parent/Sub-item relations; truncation/expansion handling | Native parent/subtask only where hierarchy fits; otherwise existing scoped issue links | N+C | `notion.ts`, `scene.ts`; arbitrary many parents do not fit one Jira parent. Keep explicit links for that case. |
| WorkflowState | Business lifecycle independent of execution, archive/trash and acceptance | Status select; historical aliases remain | Configured statuses preserving Backlog/Todo/Queued/In Progress/Waiting For/Ready for Review/Waiting for Prod Release/Done/Archived, plus relevant human/parked distinctions | N+C | Native category is not the business state. Do not collapse Queued/Todo or review/release into Done. |
| WorkflowTransition | Intent, required information, provider-native outcome | Serialized validate/recheck/PATCH/readback; direct Notion edits can bypass rules | Discover native transitions and required fields; invoke those transitions; retain only domain checks | N+C+X | `workflow.ts`; native UI and REST rejection, later-clear behavior all pending. No Tin Star transition graph. |
| Assignment | Accountable actor for next action; assignment is not execution | Owner select; Firstmate assignment forces Queued | Native assignee for an actual person OR Coordinator field; both set is ambiguous accountability | N+C+X | `workflow.ts` assign/start split; test native create/update and automation without dispatch. |
| ExecutionBinding | Ordered/sets of exact run references and provenance | Versioned First Mate tasks JSON; external JSON lines in Delegated To | Small versioned issue property of exact native identities, non-secret only | X | `workerLinks.ts`, `scene.ts`. Neither assignee nor issue history proves a live run. Metadata permission/size/concurrency tests pending. |
| ExecutionObservation | `{observedAt, freshness, coverage, activity, evidence}` from execution authority | First Mate source evidence / consumer-reported external evidence | Remains a joined First Mate/Tin Star observation; Jira stores references only | X | `workHealth.ts`, `scene.ts`; worker-source outage must stay unknown. |
| Blocker | `{id, dependent, kind: Work/Actor/Event, target, unblocksWhen, followUpActor, state}`; 0..many per work | Multi-line Waiting For; singular Type/ID. Writer and view can diverge | Native blocking edges. Prove two linked Wait issues with per-wait fields; Work wait additionally references prerequisite issue via existing link | N+C+X | `workflow.ts` wait appends text without Type/ID; `waitingFor.ts` needs singular typed ID. Exact link directions/IDs and local work-type rights pending. |
| Decision | Identified question/responder; options and explicit recommendation+rationale | Structured request comments, proposals, aggregate Will action | One linked Decision issue per request; native lifecycle; structured proposal issue property (not comment protocol) | N+C+X | `decisionResolution.ts`, `decisionProposal.ts`; native fields cannot alone validate dynamic per-request option membership. |
| DecisionResolution | Exact answer, selected option if any, intended next actor/state; recording separate from delivery/acceptance | Request/answer markers and explicit next Owner/Status/wait; source delivery receipt separate | Answer field + Answered transition and native actor/history; intended disposition fields; exact Decision ID | N+C+X | Answering D1 must leave D2/waits intact. Native transition does not acknowledge First Mate delivery or start a worker. |
| Schedule | Start, deadline, next meaningful check-in with date/time meaning | Start Date, Due Date, Next check-in | Native due date; suitable date/start field; timestamp Next check-in plus explicit input timezone/granularity metadata | N+C+X | `shared/checkIn.ts`; date-only means 9 AM America/New_York, not UTC midnight. Default Jira date semantics insufficient. |
| Checkpoint | Assessment/evidence/next action/appointment/attribution/request correlation | Structured comment; date property; optional Next action absent here | Native dated comment for human report; small structured checkpoint property; searchable Next check-in only | N+C+X | `checkInWatchdog.ts`; card edits/heartbeat never reset appointment by themselves. Native schedule may find due work, not judge progress. |
| HandoffContract | Entire approved specification, version, attribution and deliberate revision | Manifest/chunks/completion marker with exact lossless readback | Human description + versioned durable artifact/ref and manifest property; no service or new artifact store | N+X | `implementationContract.ts`, `workflowHandoff.ts`; existing durable artifact authority not identified yet. Editable description/history alone is insufficient. |
| WorkComment | Discussion/context, native author/time; untrusted data | Native comments and page prose | Native comments; no comment becomes a workflow command by appearing | N | `workflowContent.ts`, `cardContext.ts`; API pagination/deletion/event coverage pending. |
| ActivityEvent | Observed provider change with attribution and provenance | Structured operation notes, Last touched by, edit time | Native changelog/transition/comment history, plus only domain-specific receipts | N+X | `workflow.ts`, `workflowReceipts.ts`; provider history is not a cross-system execution/delivery ledger. |
| ArtifactReference | Explicit typed evidence/ref; source systems own truth | Link + body/comment refs; optional recognized fields absent here | Native remote/issue links or attachment when useful; exact repo/commit/run identity retained | N+X | `releases/reconcile.ts`; Jira link existence cannot prove effective merge, deploy or acceptance. |
| Acceptance (additional) | Review of an exact delivered/deployed revision, independently from Done | Review submission/response structured comments, durable narrow receipts | Review status/history + exact review evidence metadata/reference; owner response via shared intent | N+C+X | `workflowReview.ts`, `shared/reviews.ts`; accepting review currently requeues follow-through, not necessarily Done. |
| SourceCoverage (additional) | Known empty versus missing/stale/partial; observation times | `Observation<T>`, retained last-known cards, partial relation membership | Preserve same normalized coverage around scoped paginated API reads | X | `observation.ts`, `workReader.ts`; HTTP denial or incomplete pages never mean empty. |
| ChangeNotification (additional) | Verified hint → current scoped read → projection → warranted context update | Sweeps, changed callbacks, bounded context diffs/pickup latch | Prefer one native change refresh path; justified project automation only; same downstream reconciliation | N+C+X | `firstmateUpdates.ts`; live callback, auth, delivery IDs, latency and quota untested. |

### Proposed custom records and fields: exact contract draft

These are design recommendations to test, not created schema. All new values are project-local if the tenant supports that; no global field/scheme/link-type mutation is authorized. System fields use the live `fields` API identity, not assumed IDs. Work-type and status names must be resolved within the actual project. The ID column for **every** proposed Jira entry is currently `unresolved`; neither scripts nor report manufacture `customfield_*`, transition numbers, issue keys or actor IDs.

Recommend Task, Decision, Wait as three work types. Each issue has one immutable ID, one project and one current status. One primary Task can have 0..many independently linked Decisions and Waits. A Wait has exactly one dependent Task and one target. The uniform Wait record costs an extra issue per dependency but gives every blocker its own condition/follow-up identity. For pure work dependencies with no per-edge metadata, a native blocking edge alone is a later simplification option; it must not drop required follow-up information. The proof uses a Work Wait and an Actor Wait; Event is an optional additional fixture on the same project.

| Proposed custom location (Jira ID unresolved for each) | Type / cardinality | Writer / authoritative location | Relevant transition | Missing / ambiguous behavior |
| --- | --- | --- | --- | --- |
| Area | Single-select, 1 for new/assigned work | Owner/integration; issue field | Create/assign/start/wait | Reject relevant new transition if native rule supports; legacy reads show missing. |
| Sub-area, Attention, Initiative, Workstream (four fields) | Each single-select, 0..1 | Owner/integration; issue fields | Ordinary edit | Unset is empty only after complete field read; unknown options shown, never silently remapped. |
| Coordinator | Short text, 0..1 canonical coordinator key | Owner/integration; issue field | Assign/queue | Exactly one accountable assignee OR coordinator; both/neither is unresolved. No invented Jira user. |
| Next check-in | Timestamp, 0..1; required when applicable | Coordinator via meaningful checkpoint; issue field | Start/checkpoint/wait | Missing appointment is reported; activity cannot fill it automatically. Native structure does not enforce the ET ceiling. |
| Start date (only if suitable native field unavailable) | Date, 0..1 | Owner/integration; issue field | Plan/ordinary edit | No invented start date. Retain original date-only meaning. |
| Completion disposition | Paragraph, 0..1; required for Done | Explicit caller; issue field | Complete/close | Native missing-value rejection candidate; no new restrictive disposition vocabulary. |
| Completion evidence | Paragraph of explicit refs/findings, 0..1; required for Done | Explicit caller; issue field | Complete/close | Native presence check only. Content truth/acceptance remains outside Jira validator. |
| Wait kind | Single-select Work/Actor/Event, exactly 1 per Wait | Requester/coordinator; Wait field | Open/wait | Missing/unsupported kind is unknown; never infer from title. |
| Wait target | Short text canonical ActorRef/EventRef, 0..1 for Work, 1 for Actor/Event | Requester/coordinator; Wait field | Open/wait/resolve | Work target uses exact native issue link instead. Missing or multiple targets stays unresolved. |
| Unblocks when | Paragraph, exactly 1 per open Wait | Requester/coordinator; Wait field | Open/wait/resolve | No resolution inferred from generic activity; require declared condition and evidence. |
| Follow-up actor | Short text canonical ActorRef, exactly 1 per open Wait | Requester/coordinator; Wait field | Open/wait | Missing-value native rule candidate; no guessed follow-up owner. |
| Follow-up at | Timestamp, 0..1 | Requester/coordinator; Wait field | Open/wait/checkpoint | Missing is unscheduled, not overdue; real external date only. |
| Answer | Paragraph, 0..1; exactly 1 for Answered Decision | Authenticated responder; Decision field + native actor/history | Open → Answered | Reject missing natively if supported; clear-after-answer test discloses persistent gap. |
| Selected option | Short text stable option ID, 0..1 | Authenticated responder; Decision field | Answered | Optional free answer is distinct from option answer; nonmember/ambiguous selection cannot resolve an option. Membership stays domain policy unless native proof supports it. |
| Result owner | Short text ActorRef, exactly 1 when Answered | Responder/coordinator; Decision field | Answered | Answer records intended next actor; cannot silently change another record or impersonate assignment. Missing result remains incomplete. |
| Result state | Single-select explicit business states, exactly 1 when Answered | Responder/coordinator; Decision field | Answered | No worker/start inferred. Result `In Progress` still needs current execution evidence before Task transition. Source-bound implementation approval normally queues. |
| `tinstar.execution-bindings` issue property | Versioned JSON, one envelope, 0..many exact FM/external bindings | Existing trusted integration; item property; execution truth stays with source | Start/bind/correct | Absent/malformed/truncated = unknown; explicit empty list only means no declared binding. Exact home/task/generation preserved. |
| `tinstar.decision-proposal` issue property | One versioned proposal per Decision; full question; requested ActorRef; 1..5 `{id,label}` options when offered; explicit recommended ID+rationale; source request identity/version where bound | Requester/integration; Decision property | Open/request/revise | Request identity is immutable issue ID; missing recommendation or mismatched source/option is visible/incomplete. Human description is presentation, not a second authority. Free-answer asks may omit options; the proof must offer options and recommendation. |
| `tinstar.checkpoint` issue property | One latest versioned report with assessment, evidence, next action, confirmation, optional originating request ID, original timezone/granularity | Coordinator; property + native comment history for previous reports | Checkpoint | Report is distinct from delivery acknowledgment. Missing/ambiguous correlation cannot close an outstanding request. |
| `tinstar.schedule-input` issue property | One object for start/due/check-in source timezone and date/date-time granularity | Integration/owner; issue property | Date edit/checkpoint | Absent metadata means unknown input meaning; preserve read timestamp, do not invent timezone. |
| `tinstar.handoff-contract` issue property | One current manifest: version/submission/revision/actor, durable ref, content digest and prior version ref; referenced complete artifact holds approved text | Approved handoff writer; property plus existing durable artifact authority | Submit/revise/queue | Missing artifact/partial bytes is unverified contract; do not dispatch. No new storage service; artifact authority still unresolved. Digest protects exact approved text, not cosmetic Jira rendering. |
| `tinstar.review` issue property | One exact submission identity, evidence refs, delivered revision, response and remaining scope; previous reviews in native history/artifact refs | Integration records owner's explicit response; issue property | Submit/review/respond | Missing evidence/revision is unverified; an Answered Decision cannot substitute for acceptance. |

Question/answer history must remain retrievable after edits: native changelog coverage of custom fields and entity properties needs testing. If entity-property changes are absent from native history, retain immutable domain-specific proposal/answer/review records in the existing comment/artifact mechanism rather than claiming that all comment protocols retire. No secret belongs in issue properties. Per-decision metadata is ordinary versioned data, not a new database or workflow engine.

Native fields/links complete the shape: `summary`, `description`, `issuetype`, `status`, `assignee`, `priority`, due date, author/time/changelog, comments, and existing issue link types. Decision responder is its assignee for the owner-account fixture; the structured proposal holds its canonical requested ActorRef. Work Wait target is a native link to the prerequisite Task. Wait → dependent Task uses the tenant's existing blocks link; Decision → primary Task uses an existing neutral relationship link. Capture actual link IDs and directions. No new global link vocabulary is assumed. If a relation yields zero/multiple dependent or target items, the projection reports ambiguity.

### Native configuration questions that matter

Public documentation is design evidence only. The current team-managed rule catalog describes field-value transition restrictions; its rule-editing guidance and generic editor differ in terminology and limits. Test the tenant's actual editor and field/operator choices. Do not equate a reminder/form with a server-side validator. [Available team-managed rules](https://support.atlassian.com/jira-software-cloud/docs/available-workflow-rules-in-team-managed-projects/), [rule editor](https://support.atlassian.com/jira-software-cloud/docs/add-or-remove-workflow-rules-in-team-managed-projects/).

Atlassian documents a material limitation: team-managed People custom fields cannot currently be accessed or set by Automation. Recommended follow-up/coordination metadata therefore uses explicit actor references; test a People field separately only to determine whether this tenant differs, not as a hidden substitute. Human assignment still uses native assignee. [Automation limitations](https://support.atlassian.com/cloud-automation/docs/limitations-in-team-managed-projects-for-automation-rules/).

Paragraph, dropdown, date/timestamp and People are documented field categories, but the actual field can still be unavailable to a particular transition rule. Capture each field type and rule selector. [Custom field types](https://support.atlassian.com/jira-software-cloud/docs/available-custom-fields-for-team-managed-projects/).

## 2. Fixtures, reproducible tests and evidence

### Evidence already captured

| Evidence | Result / location |
| --- | --- |
| Isolation / baseline | `pwd -P` and Git top-level both `/home/farm/.treehouse/tinstar-9db33b/2/tinstar`; clean baseline `5c075dad647ae0034633ba858e4afd6c1abeb3ff` before branch/docs. |
| Live Notion property metadata | `/home/farm/fm-home/data/tinstar-jira-spike/notion-card-schema-receipt.json`; IDs/types only, fresh source; bounded card prose excluded from saved receipt. |
| Live collection schema | `/home/farm/fm-home/data/tinstar-jira-spike/notion-board-schema-receipt.json`; name/type catalog and relevant option URLs/counts, no live work copied. Collection-only read via connected Notion fallback. |
| Local helper failed start | Default local config absent, `ENOENT`, before any Notion HTTP request. See `independent-evidence.json`; do not mistake an empty redirected output file for a schema response. |
| Existing focused baseline tests | `/home/farm/fm-home/data/tinstar-jira-spike/baseline-focused-tests.log`; **3 files, 220 tests passed**, 9.67 seconds, at inspected commit with only unrelated spike docs/scripts added. No source modifications. |
| Synthetic reconciliation exercise | `/home/farm/fm-home/data/tinstar-jira-spike/local-replay-receipt.json`; **8 checks passed**, two recorded mock effects, zero Jira requests, zero real dispatches. Entirely local simulation. |
| Script syntax | `node --check` passed for both standalone `.mjs` files. |
| Jira UI screenshots, API rejection/success receipts, actual fixture IDs/URLs, callback logs/latency | **Not available. Not tested.** No fabricated screenshots or URLs. |

Reproduce the local simulation (no credentials, network, application server or persistent state):

```bash
node data/tinstar-jira-spike/replay-notifications.mjs \
  > /home/farm/fm-home/data/tinstar-jira-spike/local-replay-receipt.json
node --check data/tinstar-jira-spike/observe-notion.mjs
node --check data/tinstar-jira-spike/replay-notifications.mjs
node_modules/.bin/vitest run \
  src/reconciliation/__tests__/waitingFor.test.ts \
  src/server/reconciliation/__tests__/workflow.test.ts \
  src/server/reconciliation/__tests__/decisionResolution.test.ts \
  --exclude='e2e/**'
```

The simulation checks two independently open blockers, one-at-a-time resolution, two Decisions sharing the Decision category, exact answer scope, recorded answer versus delivery, unknown versus empty, source-read retry, out-of-scope/unverified hints, duplicate native/automation paths, stale event bodies, own-write hints, and leaving Queued. Its pickup latch covers one synthetic assignment only. It does **not** establish signature validation, API enforcement, restart persistence, live delivery or a correct future requeue/handoff-epoch policy. These are not new production tests or adapter code.

`observe-notion.mjs --config-root <existing-authorized-config-root> --card-id 41550ce6d42281fe8811c56b97fdaacb` is an optional read-only schema capture helper. It loads the existing token in-process, emits only schema/property metadata, and checks card source membership. It was syntax checked; a live success on Hulk is not claimed. No credential value is accepted in report text or committed fixtures.

### Live fixture manifest (all not created)

| Fixture purpose | Work type / required relation | Actual ID and URL |
| --- | --- | --- |
| Primary synthetic work | Task, assigned to coordinator, initially Queued; no worker | Unresolved — not created |
| Synthetic prerequisite | Task | Unresolved — not created |
| Work blocker B1 | Wait, Work; prerequisite blocks this Wait; this Wait blocks primary | Unresolved — not created |
| Actor blocker B2 | Wait, Actor; exact existing owner account reference; blocks primary | Unresolved — not created |
| D1: choose synthetic artifact | Decision linked to primary; A/B options, recommended A with rationale | Unresolved — not created |
| D2: choose synthetic review format | Decision linked to primary; same Decision attention category; separate identity | Unresolved — not created |
| Optional event wait | Wait, Event; synthetic event ID; same project only | Unresolved — not created; optional, does not replace B1/B2 |

Synthetic fixtures must be visibly labeled disposable. Do not copy this real spike card's content or worker binding into Jira as test work. The local identifiers prefixed `synthetic:` in the script are deliberately not Jira keys, issue IDs, actor accounts or live fixture references.

### Reproducible live configuration / API plan

First perform one read-only preflight at the frozen branch head: site and actor identity, caller permission to create team-managed, plan/privacy controls, exact field/work-type/status/link schemas, fixture isolation and approved receiver route. Record the commit, host, actors, clocks and any failed start. Only then create one labeled private project. Set owner and only necessary existing test/integration actors as members. Verify no public/uninvited read access with an available authorized independent actor; if that actor is unavailable, mark that portion unproven rather than recruiting another person.

For each operation below, save sanitized request method/path/body, HTTP status, response/error, before/after status and relevant field values, transition availability, changelog ID/actor/time, and a UI screenshot. Keep tokens, hidden-header values, cookies and signed URLs out of logs. Use `CHROME_DEVTOOLS_AXI_SESSION=tinstar-jira-spike` with `chrome-devtools-axi`; stop that session immediately after evidence capture. Never use the real First Mate dispatcher as receiver.

REST paths to discover through the authorized connection: current user `/rest/api/3/myself`; caller permissions `/rest/api/3/mypermissions`; created project `/rest/api/3/project/{actualId}`; actual project issue types/fields via the supported create/edit metadata APIs; exact item `/rest/api/3/issue/{actualId}`; `/transitions?expand=transitions.fields`; `/changelog`; `/comment`; issue properties under `/properties/{actualPropertyKey}`. Connector operations may use different transports. Capture API capability separately from what the connector exposes; absence of a tool is not a tenant denial. Templates are not executable until the real IDs/auth route are resolved.

For a transition trial: GET exact item and available transitions; attempt `POST .../transitions` with `{transition:{id:actualId}}` while required data is absent; GET again and prove status/history did not change. Then supply valid fields using supported transition fields or edit-then-transition, repeat and verify success. If transition fields are unsupported, record that valid data required a prior edit. An unavailable transition in UI/API is an observed restriction, not an HTTP validator error. Attempt the missing-data path directly using the known transition ID so hiding a form choice cannot stand in for enforcement.

For later clearing: after successful transition, `PUT .../issue/{actualId}` to clear each required field, then GET/history. Record if native enforcement prevents it or only validates transition entry. Also test a same-state edit and creation directly into terminal state if the tenant offers it. Do not disguise transition-only integrity as a persistent invariant; do not introduce a second validator engine to compensate.

| Trial | Exact candidate constraint / proof | Required UI and REST result | Current state |
| --- | --- | --- | --- |
| Autonomy | Owner adds/edits ordinary field, Decision/Wait type, one status, transition and rule within new project; checks automation administration | Record permitted actions/denials and actual IDs; no company-project changes | Pending |
| Privacy | Private membership, owner/integration can read; anonymous and authorized uninvited test actor cannot | Access configuration + read receipts; disclose admin visibility and absent independent actor test | Pending |
| Answered, blank answer | D1 Open → Answered requires Answer | Blank rejected without state/history change; then valid answer succeeds | Pending |
| Answered, result declaration | Require Result owner and Result state if native field/rule supports | Each missing independently rejected; valid structure accepted | Pending |
| Done | Primary → Done requires Completion disposition AND Completion evidence | Omit each separately through both paths; valid explicit disposition/evidence succeeds. No truth/acceptance claim | Pending |
| Waiting | Wait Open/Waiting transition requires kind, target where applicable, unblock condition, follow-up actor | Missing one at a time rejected. Work/Actor conditional field enforcement documented; no form-only claim | Pending |
| Persistent integrity | Clear Answer/Completion evidence/unblock data after valid transition; attempt terminal-state create where possible | Rejection or clearly reported accepted invalid state; disclose exact boundary | Pending |
| D1 versus D2 | Answer D1 by exact issue ID using recommendation/option; query both and B1/B2 | D1 answered; D2 still open; B1/B2 unchanged; primary not auto-started/completed | Local model passes; Jira pending |
| Blocker independence | Resolve B1, inspect B2/primary; then resolve B2 | Other blocker survives; no dependent auto-Done/start; closure may require explicit verified Wait resolution | Local model passes; Jira pending |
| Assignment/execution | Native assignee/coordinator changes and Queued notice | No worker execution inferred or created; unknown execution retained | Local model passes; Jira pending |
| Descriptions/comments | Edit description, add/edit comment and test removal if supported on own fixture; record events + current read | Identify coverage per event kind, including deletion/omissions | Pending |
| Notifications | Scoped status/field/issue-link changes, including leaving Queued and entering Done/Archived | Current-item read succeeds by immutable ID independent of operational view | Local model passes; Jira pending |
| Duplicates/order | Retry delivery or locally replay captured sanitized payload twice and older payload after new state | One logical mock effect from current truth; distinguish live retries from replay | Synthetic model passes; captured replay/live pending |
| Failure | API permission denial/timeout/unavailable linked item/partial pages | Unknown/partial with last-known context; no empty success/dispatch | Synthetic model passes; Jira pending |
| Own writes | Harness/integration write changes record; webhook + automation observe | Bounded refresh, no recursive writes/repeat pickup/reminders | Synthetic model passes; Jira pending |
| Routine follow-up | Read-only project-scoped overdue query with actual Next check-in field ID | Check timestamp/timezone, due scope and one reminder per original appointment; no auto-reset | Pending; no reminder rule enabled |

Do not run a Done/Answered rule as an asynchronous automation that accepts invalid state and moves it back. If the tenant cannot reject natively, record the capability failure and examine the company-managed equivalent before recommending a workaround. Native structural checks cannot establish evidence truth, current execution, or source-bound acceptance.

### Webhook versus Automation experiment

Preferred eventual shape: verified change notification → scoped current item and relevant links/comments read → one normalized projection/reconciliation → warranted First Mate context update. Notification bodies are data, never commands. There is one logical effect path. No receiver/service is deployed in this spike.

| Concern | Native change webhook candidate | Project Automation Send web request candidate | Evidence / test still needed |
| --- | --- | --- | --- |
| Ownership | Admin-managed webhook may need Jira administrator; app/dynamic webhooks depend on existing app auth/scopes | Project rule administration may be allowed locally or disabled globally | Identify registration route and actual permission; no new app installation |
| Scope | Project equality using actual stable project ID; no status restriction | Single project, specific event/condition; exact field/status IDs | Leave Queued/Waiting, change links, comments and terminal state; remain visible |
| Authentication | Secret-backed HMAC for applicable admin webhook, or existing app-specific bearer/JWT mechanism; verify actual selected route | Hidden authentication header to existing approved receiver; do not assume native webhook signature | Record mechanism and negative test, never secret; validate before source reads |
| Payload | Native event/change envelope; read current item by immutable ID | Small custom hint with actual project/item/event metadata | Save redacted raw bytes/header names and current-read receipt; include comment/link context as needed |
| Delivery identity / retry | Native documented identifier/retry headers; route-specific behavior | No assumption of same retry identity or retry contract | Capture live headers/audit IDs, trigger failure only at approved mock endpoint, distinguish local duplicate replay |
| Latency | Measure mutation → first verified receive → current read → recorded effect | Same measurement plus automation scheduling delay | Unknown; no invented latency/SLA result |
| Quota/cost | Native webhook route and REST limits require verification | Metered automation usage and service limits; repeated general changes can consume allowance | Capture actual tenant quota before/after bounded trials; no upgrade/paid opt-in |
| Business responsibility | One general refresh route, not direct dispatch | Consider only if needed for Queued, Answered, blocker-resolution hint or overdue query | Both paths must not independently dispatch or schedule work |

Atlassian documents native webhook HMAC secrets, stable delivery identifiers across retries, retry-count headers and retries for selected failures. Dynamic app registrations can require refresh after 30 days and have app-specific authentication/scopes. These are route-specific design considerations, not this tenant's measured behavior. [Native webhooks](https://developer.atlassian.com/cloud/jira/software/webhooks/).

Automation can send a custom body and hidden header values, and site administrators can restrict outbound domains. A project administrator can also be prevented globally from administering rules. Hidden secrets can be lost on rule export/duplication. [Send web request](https://support.atlassian.com/cloud-automation/docs/jira-automation-actions/), [automation administration](https://support.atlassian.com/cloud-automation/docs/permissions-required-for-jira-cloud-automation-rules/).

Do not hard-code historic monthly execution counts. Current official usage guidance describes a move to step-based usage/billing on December 3, 2026; the active tenant plan, effective date and allowance must be read before trials. [Usage calculation](https://support.atlassian.com/cloud-automation/docs/how-is-my-usage-calculated/).

For eventual duplicate prevention, distinguish transport delivery ID from logical request/assignment/answer ID. A repeated refresh may still be necessary after an earlier read failure; only a verified successful reconciliation can retire that hint. Source-bound answer identity and exact First Mate delivery receipt remain necessary. A current assignment/handoff epoch is needed for legitimate later requeue; a permanent item-only pickup latch would be wrong. The local script deliberately discloses that limit. Keep a minimal current-state backstop in the existing refresh process rather than relying exclusively on webhook history or adding a new scheduler.

Temporary fixture notifications: **none enabled by this worker**. When live trials are allowed, compare routes sequentially against the recording sink; log exact webhook/rule IDs, enable/disable time, final disabled status and any residual deliveries. Disable only the fixture notifications created for this spike; preserve project/fixtures/evidence for review and do not delete unrelated rules or records.

## 3. Code-retirement inventory and practical value

These are candidates for **Jira-backed work only after proof and a separately approved implementation**. Nothing is deleted in this spike. Supporting Notion means its adapter and behavior remain; total repository code may initially increase. No line-count savings are claimed from replacing an API client with another one.

| Current file / mechanism at inspected commit | Classification | Concrete retirement / reduction condition; retained cost |
| --- | --- | --- |
| `src/shared/workflow.ts`: UUID schemas, ordinary Notion property names, `next`, `workflowRules` | Retained Tin Star domain policy + reduced adapter code | Replace exposed UUID/property dictionary only in a later bounded slice. Shared UI/MCP intent, assignment/start, explicit completion/wait policy remain. Cleaner names alone save no mechanism. |
| `src/server/reconciliation/workReader.ts`: `WorkCard` alias, `scopeMatches`, cache/query/card/confirm | Reduced adapter code | Jira read removes Notion-property interpretation and truncated-relation membership repair for that provider. Scoped reads, membership, readback/cache invalidation, unavailable/stale coverage remain. |
| `notion.ts`: `notionPageId`, `property`, `notionCard`, `notionObservation`, `readNotionCard` | Native Jira replacement / reduced adapter code | Jira-backed work needs no Notion rich-text/select decoding, data-source query grammar or property-item relation expansion. New Jira pagination/ADF/field context mapping is still adapter code. Whole file stays for Notion. |
| `notionApi.ts`: paced requests/schema TTL/Retry-After | Reduced adapter code | Fixed Notion 350 ms pacing and Notion schema cache do not apply to Jira path. Jira still needs its own rate limits, 429 handling, coalescing and visibility of failure. |
| `workflow.ts`: `required`, `property`, `normalized`, `updatePlan` structural transition checks, read/validate/recheck/PATCH | Native Jira replacement where demonstrated | Native rejection could remove duplicate required-field/status structural enforcement from Jira path. ET policy, current worker verification, explicit dispositions, unrelated-state preservation and partial outcomes remain. Requires REST/later-edit evidence first. |
| `workflow.ts`: decision comment scanning/action-tag preservation/`resolve_wait` line equality | Native Jira replacement + retained domain policy | Separate Decision/Wait identities can retire aggregate tag bookkeeping and exact-line blocker deletion for Jira-backed work. Source binding, option membership, recommendations and intended resulting ownership remain. |
| `workflowContent.ts`: `richText`, `paragraph`, `section`, `notes`, `note`, managed markers/readback | Reduced adapter code | Notion rich-text chunk limits, paragraph marker lookup and section reassembly disappear on Jira path. Native comments/history reduce bookkeeping; ADF conversion, bounded reads, sensitive-data redaction and operation readback still exist. |
| `implementationContract.ts`: manifest/chunk/completion-marker machinery, `inventory`, `verify`, `write` | Reduced adapter code / unresolved artifact authority | Native Jira description does not retire exact approved-contract semantics. Only Notion block chunk transport/marker scanning could retire when an existing durable versioned artifact is proven. No new storage service justified. |
| `workflowHandoff.ts`: `HandoffOperations.submit` | Retained Tin Star domain policy | Full approved intent, explicit target/revision, record/assignment/delivery/execution separation, duplicate create ambiguity and Queued until execution remain. Provider transport code can shrink. |
| `workflowReceipts.ts`: `CreationReceipts`, handoff/review recovery | Retained policy/integration / unresolved | Native changelog is not a receipt for uncertain network writes or First Mate acceptance. Delete only a proven provider-specific receipt, not all idempotency or partial-save recovery. |
| `workerLinks.ts`: `readWorkerLinks`, `workerLinkRecord`, `parseWorkerLinks` | Reduced adapter code + retained First Mate integration | Rich-text parsing/chunking can disappear on Jira path. Exact native identity/provenance, unknown/empty distinction, conflict visibility and history preservation remain. Do not invent a Jira worker monitor. |
| `decisionResolution.ts`: `bindDecision`, `sourceState`, `decisionHistory`, `reconcileDecision` | Reduced protocol code + retained First Mate integration | Native per-request issues may remove marker-based question/answer history decoding. Exact home/request/card/generation binding and delivered/acknowledged/source-closed reconciliation remain. Entity-property history gap could require retained domain records. |
| `firstmateUpdates.ts`: `confirmed`, `observe`, `sweep`, pickup/context baselines and outstanding delivery latch | Reduced adapter discovery + retained First Mate integration | General verified events can reduce broad sweeps/body-diff discovery. Current-item reconciliation, own-write dedup, legitimate requeue epochs, missed-event backstop, exact delivery routing and outstanding receipts remain. Neither native events nor Automation may become a second dispatcher. |
| `checkInWatchdog.ts`: `checkInDecisions`, structured report parser, due census/delivery/follow-up | Native query reduction + retained domain/integration policy | JQL/one scoped schedule can discover overdue check-ins. ET ceiling, substantive progress, provisional/confirmed attribution, original appointment/request correlation, exact worker route and one-follow-up semantics remain. Do not run parallel reminder authorities. |
| `observation.ts`: `Observation`, `CachedObservation`, `retainMissing` | Retained Tin Star domain policy | Provider outages, incomplete pagination and stale observations still need explicit coverage. Native provider availability does not replace consumer coverage semantics. |
| `scene.ts`: `declaredLinks`, `expectation`, `reconcileScene` | Retained Tin Star / First Mate join with reduced provider decoding | Exact run joins, historical/conflicting/current claims, explicit accountability and unknown absence remain. Native Jira links simplify work relationship decoding only. |
| `src/reconciliation/waitingFor.ts`: `waitingForIssue`, `waitingForGroups`, `eventTarget` | Native link replacement / reduced adapter projection | Independent issue/link identities can retire free-text normalization, Notion UUID parsing and heuristic GitHub event target extraction for Jira path. Grouping, count/order, navigation and ambiguity display remain. |
| `src/reconciliation/overviewModel.ts`: `visibleOverviewCard`, source coverage and relation projection | Retained UI projection + reduced provider coupling | Business Archived and provider trash filters need normalized fields; coverage/unknown worker presentation remains. No UI redesign required. |
| `src/shared/workHealth.ts`: `workHealth`, `sceneWorkHealth` | Retained Tin Star domain policy | Active/blocked/stalled/unstaffed require fresh execution/readiness/accountability evidence. Jira status/assignee/comment cannot answer them. |
| `src/server/releases/reconcile.ts`: `reconcileReleases`, `ReleaseReconciler` | Retained GitHub/deployment integration | Exact merged commit/deployment receipt/ancestry/target/production verification still comes from source systems. Jira completion validator can require a reference, not prove it. |
| `workflowReview.ts`, `shared/reviews.ts` | Reduced provider protocol + retained acceptance policy | Native review lifecycle can carry structure/history. Exact deployed revision, remaining scope, owner response, uncertain writes and review versus completion distinction remain. Existing acceptance/release work stays open. |

The strongest possible value is concrete: independently addressable asks/waits can replace comment/line decoding; native structural rules can close direct-API holes; native relationships/history can reduce marker maintenance; verified events can reduce discovery polling. Three material costs remain: Jira tenant/admin/plan constraints, a provider-specific reader/metadata mapping, and cross-system execution/delivery/acceptance policy. Until live integrity and autonomy pass, the business case is plausible but unproven.

Existing brittle behavior observed in scope: exact wait-line matching plus a separate singular Type/ID projection can strand valid multi-wait text outside its intended group. Proposed simplification is independent blocker identities and native links on the Jira path; do not mass-rewrite legacy Notion waits. The approved-contract hash protects real content, but any future artifact migration should compare intended content/revisions rather than Jira-rendering cosmetics and retain a supported inspect/resume/supersede path. No new release/deploy gates are introduced.

## 4. Team-managed recommendation and company-managed comparison

**Current recommendation: no-go for implementing a production Jira backend or migrating work; continue only the already approved isolated live spike after access.** Team-managed remains the preferred candidate. This is a lack-of-evidence result, not a demonstrated tenant/platform rejection. There is no basis yet to claim the owner can privately administer the required configuration.

| Capability / material failure trigger | Team-managed proof needed | Company-managed comparison if failure occurs | Recommendation |
| --- | --- | --- | --- |
| Create/private access unavailable | Actual caller permission, project privacy, plan/site restriction | Creation and isolated permission scheme likely involve Jira admin; cannot bypass a plan restriction by changing project type | Report exact denial, owner/site admin and bounded action. No second project or silent switch. |
| Paragraph answer/evidence nonempty transition checks unavailable or REST bypasses | Exact supported fields/operators, native rule and later-clear behavior | Company-managed transition screens/required-field validators are a specific native alternative; generic editor docs describe pre-transition validation | Inspect existing authorized configuration/docs read-only; quantify extra admin/scheme coupling. No global scheme edits. |
| Conditional Work/Actor/Event wait validation unavailable | Field rule support for chosen fields and kinds | Company-managed validator availability depends on actual site configuration; no Marketplace add-on assumed | Report which checks would remain domain custom code and whether native integrity benefit is still material. |
| Team-managed People custom fields unusable in Automation | Actual tenant result, not native assignee conflation | Company-managed user-picker field/API/automation semantics differ; check actual native rule support | Prefer explicit actor ref metadata for coordinator/follow-up. Do not switch project type for cosmetic field names. |
| Local automation administration or outbound domain denied | Actual global restriction/actor permission | Company-managed project admin still subject to automation global restriction | Changing project type does not establish autonomy. Ask for exact permitted rule action, not broad admin. |
| Native webhook registration requires Jira admin | Exact selected route and required admin action | Same site-level issue may remain | Owner/site admin registers one scoped test webhook to existing sink, or compare permitted project Automation. No app installation. |
| Transition-only rather than persistent required-field enforcement | Direct later clearing API/UI results | Company-managed screens/validators may also be transition-only; persistent behavior must be tested | Disclose residual invalid-state risk; do not build a compensating asynchronous workflow engine. |

Company-managed validation is a documented comparison, **not a live test performed here**. Atlassian's generic editor describes validation before transition completion, while its training specifically distinguishes company-managed transition-screen capability from team-managed. The actual tenant editor must settle the question. [Workflow rule editor](https://support.atlassian.com/jira-cloud-administration/docs/edit-an-issue-workflow/), [native validation comparison](https://community.atlassian.com/learning/lesson/create-complex-workflows-in-jira).

Privacy and local administration must be verified under the active plan. Public instructions for private projects do not prove this caller can create one or that uninvited access is denied. [Private-project configuration](https://support.atlassian.com/jira/kb/create-a-private-jira-project-only-specific-users-can-access/). No plan upgrade, company policy change, new account or second project is approved.

## 5. Smallest follow-on, authority needs and review decision

The next step is still part of this spike: Firstmate obtains the owner's existing Atlassian connection and exact authorized site, establishes the usable owner/UI/API actors and project-creation/local-admin permissions, and supplies an already approved recording callback route if one exists. A tool listing alone does not establish that the connection is usable for this task or exposes project administration. Do not transfer plaintext credentials through this report, inbox commentary, commit, screenshot or status.

| Missing prerequisite | Responsible actor / exact bounded action | Trigger to resume / what can then be claimed |
| --- | --- | --- |
| Jira site + working authorized authentication route | Firstmate obtains from First Mate/owner's existing Atlassian connection; return site/cloud identity and approved access method, no new account | Authenticated read of current actor and scoped permissions succeeds; then create/configure the one private project if permitted |
| Project creation / local configuration if actual caller denied | Existing site administrator/owner supplies denial details or performs only the authorized isolated project setup; no company-policy change | Verify owner can administer required local fields/types/statuses/rules; otherwise record autonomy failure |
| UI and direct REST capability for the same isolated scope | Firstmate identifies usable existing browser session and API route/actor permissions; connector permission alone is insufficient | Both native transition paths can be tested and attributed |
| Approved callback/test receiver | Firstmate/owner identifies existing URL, verification contract and bounded recording mode with no real dispatch | Can measure live auth, retries/identity, latency and payload. If absent, complete other live tests and explicitly retain notification-delivery gap |
| Independent privacy-test actor | Existing authorized uninvited test actor if available; do not add broad project access | Can prove denial for that actor; otherwise configuration-only evidence stays qualified |
| Existing durable contract/artifact authority | Owner identifies an existing approved durable location, if adopting the contract alternative | Can assess actual contract transport retirement; until then retain current contract mechanism |

After live results, update this same report with actual ID manifest, all fixture URLs, UI/API receipts and final disabled notification IDs. Then stop and let Firstmate route the card to **Ready for Review** with a specific decision: accept or reject team-managed Jira as the target for a separately scoped read-path experiment, based on native integrity, local autonomy, privacy, measured notification coverage and actual retired-mechanism value. This worker does not set the card Done, implement an adapter, refactor production code, migrate work, change defaults or reopen the simplified-workflow acceptance task.

Only if the owner accepts the feasibility evidence, the smallest later implementation slice is a **read-only normalized projection for the synthetic project**: WorkSource/WorkRef, assignment/state/coverage, native links, and exact independently identified Decision/Wait records, consumed through the same read intent from UI/MCP. Keep the existing Notion behavior in its existing adapter. Do not abstract all writes, install a second transition graph, mirror records or introduce a new persistent service. First Mate retains dispatch, orchestration and exact worker identity. A later in-memory contract comparison could test the read boundary; it is not implemented here as a production abstraction.

Handoff bundle for Firstmate at the pushed head:

- **Code-ready:** findings and two isolated scripts on `fm/tinstar-jira-spike`; focused existing tests and local model pass; no production source changes; no pull request per delivery override.
- **Proven on this host:** read-only current Notion metadata and baseline behavior, plus explicitly synthetic reconciliation checks. Nothing is proven live on Jira.
- **Owner-only next action:** provide the existing authorized Atlassian site/access route and identify any existing approved recording endpoint. Native privacy/validation/autonomy/live-notification results remain pending; no broad migration or implementation approval is requested.
