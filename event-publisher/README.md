# Event Publisher

A standalone publisher for First Mate task and worker observations, signed
Jira ticket changes, GitHub pull requests, the running Tin Star floor revision,
and operator-recorded mate migrations. All sources share one SQLite journal and
terminal reader.

## Start on the farm host

Use Node 22.13 or later, GNU `timeout`, and the tools required by the configured
First Mate installation, including `jq` and `tasks-axi` on the service's PATH.

```sh
cd event-publisher
npm ci
export PATH="$PWD:$PATH"
export EVENTS_CONFIG="$HOME/srv/event-publisher/config.json"
export EVENTS_DB="$HOME/srv/event-publisher/journal.sqlite"
mkdir -p -m 700 "$HOME/srv/event-publisher"
```

Create the configuration at `$EVENTS_CONFIG`. Use one stable ID for each
independently readable home. The paths and ID below are synthetic.

```json
{
  "homes": [
    {
      "id": "example-west",
      "path": "/srv/example-west",
      "codeRoot": "/srv/firstmate-code"
    }
  ]
}
```

`codeRoot` defaults to the home path. Use the directory containing the installed
`bin/` read interfaces. A home defaults to live mode. For synthetic inputs, set
`"mode": "fixture"` and use a separate journal. Keep the database and its SQLite
sidecars in a private directory outside the checkout. The writer requires a
directory owned by the service account, with group and other write access
disabled. Use a path with no directory symlinks and with parent directories
protected from replacement by other users. This prevents another account from
replacing the checked journal or planting SQLite sidecars before SQLite opens
them. Existing journal and sidecar files must be regular files owned by the
service account with owner-only access.
The journal binds each home ID to its resolved path on first registration.
Existing journals retain that one-to-one binding. Start a new journal to
change the ID or path in a binding. The collector retries unresolved homes on subsequent
passes and checks the journal binding before reading them.

```sh
events serve --interval 20
```

The polling interval defaults to 20 seconds and accepts whole seconds from
15 through 3600.

Leave one publisher running per journal. In a second terminal, add the
`event-publisher` directory to `PATH` and export the same `EVENTS_DB` before
starting the tail. Ctrl-C stops either process. The collector finishes
an in-progress bounded read before exiting.

```sh
events sources
events watch --source firstmate
events watch --type worker
events watch --entity 'firstmate:task:example-west:sample-a'
```

First Mate captures a baseline on first attach. The tail shows changes as later polls commit
them, with one line per changed field. It also reports health changes to
stderr. Use the sequence number as a replay cursor. Pass the `event:…` ID
shown on the same line to `events inspect`.

```sh
events replay --last 100
events replay --after 42 --json
events watch --after 42 --json
events inspect 'event:61b7b914-c227-43fe-be7a-10754f266230'
events sources
```

`--after` is exclusive. A watch without it starts at the current journal tip.
Watch and replay both accept the same filters. The text view marks replays,
First Mate fixture events, and controlled migration receipts. In JSON mode,
`source.mode` identifies live and fixture data for polling sources and routing.
Replay notices go to stderr so the JSON payloads stay identical.

## Observe linked GitHub pull requests

Add an explicit repository allowlist to the First Mate configuration, for example
`"github": { "repositories": ["example/project", "sample-org/other-project"] }`.
Entries match exact repositories, ignoring case. The adapter appears as
unconnected when the allowlist is absent or empty.
The publisher uses the service account's authenticated `gh` CLI on PATH only
for allowlisted PRs with verified links in the accepted live backlog. During a
fleet outage, prior relationships remain in journal history and cannot authorize
fresh reads.

The collector rotates through at most four linked PRs per five-minute pass.
Each PR uses at most two REST GETs, one for the PR and one for the check runs
of its exact head SHA in the base repository. The collector keeps ETags in
memory and sends conditional requests. It pauses when the shared core quota
reaches a 1,000-request reserve and honors rate-limit retry instructions.
`events sources` reports the linked, observed, failed and deferred PR counts.
Long lists take multiple passes. Unavailable task-link discovery or check reads
are reported in source health. Verified PR fields are journaled even when check
reads fail, and the last verified check baseline is retained. Check statuses
posted only through the legacy commit-status API or another repository are
outside this coverage.
The service checks every accepted sample's exact repository and PR number.
PR identity is `owner/repo#number`, so a rename or transfer that changes the
slug starts a new identity.

```sh
events watch --source github --type pr
events replay --type pr --entity 'github:pr:example/project#12' --last 20
events inspect '<event-id-from-watch>'
```

The first verified sample reports `pr.observed`. Later samples can report
`pr.opened` (a closed PR observed open), `pr.closed`, `pr.merged`,
`pr.updated`, and check-run changes. A head change starts a new head-scoped
check observation. The envelope records the observed head SHA and includes
the merge SHA only for a merged PR. Titles, bodies and check output stay out of
the journal. Polls can miss changes between samples.

GitHub webhook ingestion is deferred. Registering a repository or organization
webhook requires repository or organization admin permission, a new shared
secret, and a new authenticated public route. None was granted for this phase.

1. Provision a dedicated public HTTPS POST route for GitHub deliveries and
   give the receiver a new shared secret through its runtime configuration.
2. Have an admin register the route and secret on the approved repositories or
   organization with JSON payloads for `pull_request`, `check_run`, and `release`.
3. Verify `X-Hub-Signature-256` over the exact request bytes before parsing.
   Enforce the approved repository allowlist and event types, including for
   organization-wide deliveries.
4. Deduplicate `X-GitHub-Delivery` in the same transaction as the normalized events.

[GitHub delivery verification](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)

## Observe the running floor revision

Set `"deployment": true` to enable the existing loopback GET at
`http://127.0.0.1:5281/api/deployment`. It can run independently or beside First
Mate. The endpoint reports the exact running build SHA for the local floor
target. The first read emits `deployment.running.observed`. Later differences
emit `deployment.revision.changed` with the previous and current SHA.

```sh
events sources
events watch --source deployment --type deployment
events replay --type deployment --last 10 --json
```

A verified read gives the running-revision source `ok` health. An unavailable
endpoint or unknown SHA leaves the last verified revision in the journal.
Deployment lifecycle (attempts, smoke, failure and rollback) stays unconnected
because the deploy audit is an owner-only file on the deployment host and
the publisher has no read-only reader there. The audit path is
`${TINSTAR_DEPLOY_BLOCK}.audit.jsonl`, defaulting to
`$TINSTAR_CONFIG_HOME/deploy.blocked.audit.jsonl`. PR membership remains unknown.

### Synthetic deployment lifecycle fixture

Run from the repository root. The parser reads synthetic audit JSONL and the
separate failure marker format. It emits `deployment.started` for deployment
receipts, `deployment.smoke_passed` for passing smoke, `deployment.gate_failed`
with the phase and revision from the failure marker, and
`deployment.block_clear_requested` for audited clear requests. A passing smoke
can come from a check-only run, so the audit cannot establish deployment
completion. Every replayed event is labeled `fixture`.

```sh
fixture_dir=$(mktemp -d)
node --input-type=module - "$fixture_dir/journal.sqlite" <<'EOF'
import { readFileSync } from 'node:fs'
import { parseFloorAudit } from './event-publisher/deployment.js'
import { Journal } from './event-publisher/journal.js'

const journal = new Journal(process.argv[2])
const source = {
  source_id: 'deployment:lifecycle-fixture', provider: 'deployment',
  type: 'deployment', mode: 'fixture', home_path: null,
  coverage: 'synthetic deployment audit and failure marker', command: 'fixture',
}
const fixtures = './event-publisher/test/fixtures'
const observations = parseFloorAudit(readFileSync(`${fixtures}/deployment-audit.synthetic.jsonl`, 'utf8'), {
  target: 'fixture-floor',
  failureMarker: readFileSync(`${fixtures}/deployment-failure.synthetic.txt`, 'utf8'),
})
journal.registerSources([source])
for (const { event_type, ...record } of observations) {
  const at = record.occurredAt
  journal.recordProviderPoll(source, {
    startedAt: at, observedAt: at, health: 'ok', reason: null, counts: { observed: 1 },
    entries: [{ ...record, startedAt: at, observedAt: at, related: [] }],
  }, (_before, after) => ({ changes: [{ event_type, change: { after } }] }))
}
journal.close()
EOF
event-publisher/events replay --db "$fixture_dir/journal.sqlite" --source deployment --last 10 --json
```

## Receive Jira ticket changes

Add one `jira` source to the publisher configuration. It can run alone or beside
`homes`. The IDs below are examples. Get the cloud, project and field IDs from
the real Jira project. The five required field mappings identify Owner, Decision Questions and
the three Waiting For fields.

```json
{
  "jira": {
    "site": "https://example.atlassian.net",
    "cloudId": "11111111-2222-4333-8444-555555555555",
    "projectId": "12345",
    "fields": {
      "owner": "customfield_12001",
      "decisions": "customfield_12002",
      "blockerType": "customfield_12003",
      "blockerTarget": "customfield_12004",
      "blockerCondition": "customfield_12005"
    }
  }
}
```

Inject the admin webhook secret into `EVENTS_JIRA_WEBHOOK_SECRET` at process
start from Clavis. Run `events serve` to open the fixed loopback listener at
`http://127.0.0.1:18573/webhooks/jira`.
Give Jira the approved public HTTPS URL
that proxies only this pathname, with the request bytes and Jira headers preserved.
The listener ignores query parameters such as Jira's `triggeredByUser`.
Use Jira JQL to restrict issue creation, issue updates, and comment creation to
one immutable project ID. Include the JSON body and also select
`issuelink_created` and `issuelink_deleted`. Either link event can arrive from
other projects, so the publisher checks project scope before writing to the
journal. [Atlassian webhook filtering](https://developer.atlassian.com/cloud/jira/platform/webhooks/#available-webhook-events)
Use a distinct secret for this registration. To retire or rotate it, disable or
update the registration before removing or replacing the Clavis value.
Inject the Tin Star Jira service account's read token into
`EVENTS_JIRA_READ_TOKEN` the same way. The publisher sends that token only as a Bearer credential on GET requests
for an issue's project and key. It is not written to the configuration, the
journal, or logs. Without it, the publisher warns at startup and returns
HTTP 503 for new issue-link deliveries that require lookups so Jira can retry.
Issue and comment deliveries still work. The publisher does not write to Jira.
[Atlassian admin webhook registration and signing](https://developer.atlassian.com/cloud/jira/platform/webhooks/#secure-admin-webhooks)

The receiver verifies SHA-256 HMAC over the raw body before JSON decoding. A
delivery must identify a ticket in the configured project. For issue and comment
webhooks, the payload supplies the project and any issue self URL must use the
configured site. Jira retries use the same delivery
ID. The journal commits the delivery receipt and its event group together, with
additional deduplication for native creation, changelog, comment and issue-link
identities when available. A native creation notice is the sole source for
`ticket.created`. An issue-link identity is `issuelink:created:<link id>` or
`issuelink:deleted:<link id>`.

Ticket change previews are redacted and bounded. The journal preserves the
immutable Jira issue ID, display key, source delivery ID, source timestamp when
supplied, and the available before and after values. Dedicated issue-link
webhooks are the sole source of link activity. The publisher ignores link
entries in issue update changelogs. For both link event types, the publisher skips the
`jira_subtask` and `jira_gh_epic_story` hierarchy styles without looking up
issues or writing to the journal. For a new ordinary link delivery with a
configured token, it fetches both issues over HTTPS from the configured Jira
cloud with `fields=project,key` and rejects redirects. It journals
`ticket.links.changed` for each issue whose returned ID matches the request,
whose key is usable, and whose project ID matches the configured project.
The link text is the after value for creation and the before value for removal.
The other side is
`blocks WORK-2` style text when that side is in the same project, using the
link type's outward name on the source issue and inward name on the destination
issue. When the other side belongs to another project, returns HTTP 404, or
provides unusable issue data, the text uses the literal `[redacted]` and the
journal and logs omit that issue's key, summary, and id. When neither side can
be verified in the configured project, the publisher acknowledges the delivery
without writing to the journal. If either lookup fails with HTTP 401, 403, 408, 429,
5xx, a redirect, or a network error or timeout, the publisher returns HTTP 503 without
writing to the journal. Link removals caused by deleting a TSW issue are
outside the scope of link activity coverage.
A missing changelog is reported as partial coverage. Custom field changes are identified by their configured Jira field IDs. Hulk journal readers inherit the owner's TSW visibility and may receive restricted comment IDs, times, actions and author account IDs. Restricted comment bodies are omitted. If an unrestricted comment contains unsupported rich content, its available prose is preserved and the delivery reports partial coverage. The source shows signed Jira observations. Runtime-specific
MCP and UI proof must be correlated with the actual ticket changes.

```sh
events watch --source jira --type ticket
events replay --source jira --last 20 --json
events replay --source jira --after 42
events inspect '<event-id-from-watch>'
events sources
```

Run `npm test -- --test-concurrency=2` from this directory. The Jira tests use synthetic deliveries and a temporary journal. They cover the loopback boundary, HMAC, redaction, transaction rollback,
restart and replay. Validate native issue, comment and link delivery coverage
against the actual project before accepting the integration.

## Record a mate migration

Use a stable `mate_id` that stays the same across machine, runtime, and provider
changes. The effective start is when the destination began handling work. Give
it a timezone and cite the operator, handoff, or source record that establishes
the change. Record each intervening move so the previous destination matches
the next receipt's old route. Backfill missing receipts to restore coverage.
Use the existing service account's journal access.

The following receipt is a controlled example. Save it as `receipt.json` and
use a separate private journal selected explicitly with `--db`. The recorder
rejects controlled receipts for the default journal, the journal configured by
`EVENTS_DB`, or a journal with registered live First Mate or Jira sources.

```json
{
  "mate_id": "controlled-hulk-worker",
  "old": { "machine": "Hulk", "runtime": "Cursor", "provider": "Grok" },
  "new": { "machine": "Hulk", "runtime": "Codex", "provider": "OpenAI" },
  "effective_start_at": "2026-11-23T19:34:00Z",
  "recorded_by": "example-operator",
  "source_reference": "controlled proof",
  "controlled": true
}
```

```sh
proof_dir=$(mktemp -d)
events record-migration receipt.json --db "$proof_dir/journal.sqlite"
events replay --db "$proof_dir/journal.sqlite" --source routing --type mate --after 0 --json
```

The command returns the durable `mate.migration.recorded` receipt. The mate ID,
old and new contexts, normalized effective instant, and source mode determine the event ID.
Repeating the command returns the original receipt with its first provenance
and observation time. For actual migrations, omit `controlled` and supply the
real operator and source reference. Use a source identifier or link without
credentials.

### Exclude replayed routing timestamps from metrics

After merge, First Mate wires the external twice-weekly report to pass rows
from `/srv/fleet-ledger/routing/routing.jsonl` through `routing-metrics-input`
and use stdout before selecting first-ready observations or calculating any
metric. For route matching, supply `observation_id`, `mate_id`,
`route.machine`, `route.runtime`, `route.provider`, and `occurred_at`
(the original timestamp for the metric, with a timezone). Rows can carry
additional report fields.

```sh
events routing-metrics-input < /srv/fleet-ledger/routing/routing.jsonl
```

For the controlled example, save these rows as `routing-observations.jsonl`.

```json
{"observation_id":"controlled-ready-replay","mate_id":"controlled-hulk-worker","route":{"machine":"Hulk","runtime":"Codex","provider":"OpenAI"},"occurred_at":"2026-11-23T19:33:59Z"}
{"observation_id":"controlled-ready-current","mate_id":"controlled-hulk-worker","route":{"machine":"Hulk","runtime":"Codex","provider":"OpenAI"},"occurred_at":"2026-11-23T19:34:00Z"}
```

```sh
events routing-metrics-input --db "$proof_dir/journal.sqlite" < routing-observations.jsonl
```

The first row yields a JSON warning on stderr with its identity, original
time, and the cutoff and receipt ID. The second row passes through to stdout.
The recorder requires a change in machine, runtime, or provider. The filter
orders each mate's migration receipts by effective start. Receipts sharing an
instant are chained from the previous destination, and ambiguous sets are
unsupported and should be recorded at distinct instants. The
first old route is active before the first cutover, and each destination is
active from its cutover until the next one when that receipt's old route
matches the destination. A mismatch after ordering leaves the span from the
earlier cutover up to the later cutover uncovered. The filter excludes every
row for that mate whose original timestamp falls in the span and names
both receipts in the stderr warning. Gap detection requires only a valid mate
ID and timestamp. The warning includes the observation ID when valid.
Outside uncovered spans, a timestamp in any visit to the exact route passes
through. A timestamp outside every visit
to a known route is warned about and excluded. Rows with unknown routes or
insufficient attribution pass through for the report's existing handling.
Blank lines are ignored. Invalid JSON produces a warning with its line number
and the running count of skipped malformed rows, and the filter continues.
The filter opens the journal read-only and leaves the activity ledger intact.

## Re-observe and troubleshoot

Stop the publisher, run `events observe`, and check `events sources` before
restarting it. This performs one pass of the configured polling sources and
updates the journal. Use `events serve` for Jira webhooks. The one-pass command
exits with status 1 if a read fails or has incomplete coverage. It still uses
the GitHub batch limit. The continuous collector retries on the next scheduled
pass.

- If GitHub reports unavailable, verify `gh auth status --hostname github.com`
  as the service account, then check its pull request and check read access for
  the affected repository. If the quota reserve was reached, wait for the shared
  budget to replenish.
- For deployment coverage, check the local floor endpoint before changing
  service configuration. A healthy read shows the exact current build SHA.
- For an unavailable task source, check that the service account can execute
  `bin/fm-tasks-axi.sh` and read its backlog, and that `tasks-axi` is on PATH.
  With `FM_HOME` explicitly set to that home, check the wrapper's `--help` and
  `list --help`. The observer runs an unfiltered `list` and validates its
  advertised count against the decoded rows. The default list projection
  supplies the task kind used to derive readiness.
- For an unavailable worker source, check the local installation's
  `bin/fm-fleet-snapshot.sh --help` and the service account's access to its local
  worker-state reads. The collector uses the configured `FM_HOME` and its
  real data root. The fleet reader can read summaries from registered homes
  when polling a parent. Worker and PR events use the configured home's
  worker inventory and backlog projections, with identities keyed by its
  configured home ID. The collector disables the fleet snapshot's
  remote-summary cache and the crew-state forge fallback.
  Worker state comes from the reconciler embedded in the fleet snapshot.
- For First Mate sources, `events sources` reports the last attempt and the
  last accepted inventory.
  The `pr_links_unobserved` count reports missing PR coverage for accepted
  task rows even when no event is emitted. Each home uses one fleet snapshot
  per pass for worker state and PR link coverage. A fresh fleet response
  that explicitly reports an absent backlog records `fleet_backlog_absent=1`
  and advances the fleet watermark independently of either inventory verdict.
  With a healthy tasks-axi read, the display shows partial task coverage and
  task fields can still advance. If tasks-axi fails, the absence count appears
  alongside the original task failure reason.
  Accepted inventories report remote exclusions and unverifiable local
  current states. A local second mate with a valid task ID and a missing
  generation makes worker coverage partial and is counted as
  `secondmate_without_generation`. The journal preserves prior
  membership for that task ID and records verified observations for other
  workers. Other invalid or missing local execution identities and unconfirmed
  producer verdicts cause the inventory to be rejected. Rejected, timed-out,
  stale, or malformed reads keep prior snapshots. Within an accepted inventory,
  an unavailable worker state is recorded as unknown with its source and
  reason. Each incarnation keeps its last verified state and time for
  comparison with future reads.
- On a home you have verified uses the wrapper's pinned
  `<home>/data/backlog.md` Markdown backend, you can set
  `"markdownFastPath": true`. Matching file fingerprints reuse that day's last
  parsed result for up to 60 seconds, then the collector refreshes through the
  CLI. A local date rollover bypasses the cache so due holds update without
  a file write. A configuration-file change disables reuse until restart.

## Coverage and event semantics

Task coverage is the configured home's active tasks-axi inventory, including
its retained Done rows. An absent row can have been archived or moved. The
journal retains its last observation and only changes that state when the row
is observed again. A task appearing after the baseline is `task.observed`,
with its source creation date when available. This identifies first observation
in the home. State, dates, priority, structured hold fields, dependencies,
canonical PR links, and derived blocked, held and ready fields are diffed.
On a newly observed task, a verified nonempty PR link set appears as a separate
`task.pull_requests.observed` event in the fleet batch.
Ready uses the tasks-axi dispatch projection, including its public-followup
exclusion.

A worker ID includes the exact task ID and generation. A worker links to a
task when the same home has a matching row in its latest accepted active
backlog and the task inventory verdict is healthy. Worker inventory and
current-state evidence have separate coverage. After initial attach, a newly
identified incarnation in an accepted inventory appears as `worker.observed`.
It includes the observed state, or `unknown` with the reason. The first later
verified state appears as `worker.current_state.changed` from `unknown`.
An incarnation whose absence is confirmed by the next accepted inventory produces
`worker.inventory.left`, which records absence within that inventory's coverage.
The same incarnation returning produces `worker.inventory.entered`. See
[troubleshooting](#re-observe-and-troubleshoot) for how worker coverage affects
membership acceptance. Departures cite the last snapshot that identified the
incarnation. Appearances and returns omit the prior snapshot and leave the lower
time bound unknown when the previous inventory cannot establish prior absence.
The historical status verb is retained as
provenance alongside the reconciler's current-state source. Raw details,
titles, hold reasons and status messages stay out of the journal. PR links
come from the fleet snapshot's structured backlog records and require exact
GitHub pull URLs without credentials, query strings, or fragments. When the
backlog link data is unavailable, the journal keeps the last verified links.
The next verified read establishes a new PR baseline without a link-change
event. Task field-change events can carry the PR coverage in their evidence.

Each home's collection pass commits its accepted snapshots and their events
in one SQLite transaction.
An event's `sequence` is the local journal cursor. For snapshot observations,
`observation.batch_id` groups changes witnessed by the same read. Worker and PR link events from the
same fleet response share a batch ID. Task inventory events have a separate
batch ID. `occurred_at` is null for a snapshot diff. `observed_between`
gives conservative bounds from the start of the prior saved observation,
when available, to the end of the read that witnessed the change.
A replay returns the same event IDs and payloads after a restart.

First Mate coverage includes explicitly configured homes on the running host
and local second mates with a task ID and generation. Remote endpoints and
archive inventories are outside that coverage. Jira, GitHub and floor coverage
use the separate source scopes described above.

```sh
npm test
```
