# Event Publisher

A standalone, read-only observer for First Mate tasks and worker incarnations.
It uses its own SQLite journal and runs on the farm host that can read the
configured First Mate homes and their local worker endpoints.

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

First attach captures a baseline. The tail shows changes as later polls commit
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
Watch and replay both accept the same filters. The text view marks replayed and
fixture events. In JSON mode the event's `source.mode` identifies live and fixture
data. Replay notices go to stderr so the JSON payloads stay identical.

## Re-observe and troubleshoot

Stop the publisher, run `events observe`, and check `events sources` before
restarting it. This performs one fresh read of each configured source and updates
the journal. A source with incomplete coverage or an unsuccessful read makes
the one-pass command exit with status 1. The continuous collector retries on
the next scheduled pass.

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
- `events sources` reports the last attempt and the last accepted inventory.
  The `pr_links_unobserved` count reports missing PR coverage for accepted
  task rows even when no event is emitted. Each home uses one fleet snapshot
  per pass for worker state and PR link coverage. A fresh fleet response
  that explicitly reports an absent backlog records `fleet_backlog_absent=1`
  and advances the fleet watermark independently of either inventory verdict.
  With a healthy tasks-axi read, the display shows partial task coverage and
  task fields can still advance. If tasks-axi fails, the absence count appears
  alongside the original task failure reason.
  Accepted inventories report remote exclusions and unverifiable local
  current states. An inventory with a missing local execution identity or
  an unconfirmed producer verdict is rejected. A timed-out, stale, or
  malformed read keeps prior snapshots. Within an accepted inventory, an unavailable worker
  state is recorded as unknown with its source and reason. Each incarnation
  keeps its last verified state and time for comparison with future reads.
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
current-state evidence have separate coverage. After initial attach, the first
verified state of an incarnation appears as `worker.observed`. Its evidence records whether the
incarnation was previously seen with unknown state. The historical status verb is retained as
provenance alongside the reconciler's current-state source. Raw details,
titles, hold reasons and status messages stay out of the journal. PR links
come from the fleet snapshot's structured backlog records and require exact
GitHub pull URLs without credentials, query strings, or fragments. When the
backlog link data is unavailable, the journal keeps the last verified links.
The next verified read establishes a new PR baseline without a link-change
event. Task field-change events can carry the PR coverage in their evidence.

Each home's collection pass commits its accepted snapshots and their events
in one SQLite transaction.
An event's `sequence` is the local journal cursor and `observation.batch_id`
groups changes witnessed by the same read. Worker and PR link events from the
same fleet response share a batch ID. Task inventory events have a separate
batch ID. `occurred_at` is null for a snapshot diff. `observed_between`
gives conservative bounds from the start of the prior saved observation,
when available, to the end of the read that witnessed the change.
A replay returns the same event IDs and payloads after a restart.

Slice A covers explicitly configured First Mate homes on the running host.
Local second mates with a task ID and generation are covered as worker
incarnations. Second mates without a generation are counted as
`secondmate_without_generation` in source coverage.
Remote endpoints, archive inventories and GitHub, Jira and deployment event
sources remain outside its coverage.

```sh
npm test
```
