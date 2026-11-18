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
sidecars in a private directory outside the checkout.
The journal binds each home ID to its resolved path on first registration.
Existing journals retain that binding. Start a new journal to use the same ID
with a different path. The collector retries unresolved homes on subsequent
passes and checks the journal binding before reading them.

```sh
events serve --interval 20
```

The polling interval accepts whole seconds from 15 through 3600.

Leave one publisher running per journal. Use the same `EVENTS_DB` in a second
terminal and start the tail. Ctrl-C stops either process. The collector finishes
an in-progress bounded read before exiting.

```sh
events sources
events watch --source firstmate
events watch --type worker
events watch --entity 'firstmate:task:example-west:sample-a'
```

First attach captures a baseline. The tail shows changes as later polls commit
them, with one line per changed field. It also reports health changes to
stderr. Select a sequence or event ID from the tail for replay or inspection.

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
  advertised count against the decoded rows.
- For an unavailable worker source, check the local installation's
  `bin/fm-fleet-snapshot.sh --help` and the service account's access to its local
  worker-state reads. The collector sets `FM_HOME` explicitly. It gives the
  fleet command an empty temporary data root, which leaves the secondmate
  registry and its cross-home collectors out of the observation. It disables
  the fleet snapshot's remote-summary cache and the crew-state forge fallback.
  Worker state comes from the reconciler embedded in the fleet snapshot.
- `events sources` reports the last attempt and the last accepted inventory.
  The task verdict reflects the tasks-axi inventory. The
  `pr_links_unobserved` count reports missing PR coverage even when no event
  is emitted. Each home uses one fleet snapshot per pass for worker state
  and PR link coverage.
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
Ready uses the tasks-axi dispatch projection, including its public-followup
exclusion.

A worker ID includes the exact task ID and generation. A worker links to a
task when the same home has a matching active-backlog row in its latest
successful observation. Worker inventory and current-state evidence have
separate coverage. After initial attach, the first verified state of an
incarnation appears as `worker.observed`. Its evidence records whether the
incarnation was previously seen with unknown state. The historical status verb is retained as
provenance alongside the reconciler's current-state source. Raw details,
titles, hold reasons and status messages stay out of the journal. PR links
come from the fleet snapshot's structured backlog records and require exact
GitHub pull URLs without credentials, query strings or fragments. When the
backlog link data is unavailable, the journal keeps the last verified links.
The next verified read establishes a new PR baseline without a link-change
event. Task events from those reads include the PR coverage in their evidence.

Each accepted snapshot and its events commit in one SQLite transaction.
An event's `sequence` is the local journal cursor and `observation.batch_id`
groups fields from the same observation. `occurred_at` is null for a
snapshot diff. `observed_between` gives conservative bounds from the previous
read's start to the current read's end when both states were witnessed.
A replay returns the same event IDs and payloads after a restart.

Slice A covers explicitly configured First Mate homes on the running host.
Remote endpoints, archive inventories and GitHub, Jira and deployment event
sources remain outside its coverage.

```sh
npm test
```
