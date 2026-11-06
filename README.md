<p align="center">
  <img src="logo.png" alt="Tinstar" width="400" />
</p>

<h3 align="center">A cockpit for your First Mate fleet</h3>

Tinstar shows the workers First Mate is already running, the calls that need your attention, and provider quota in one view. First Mate remains responsible for dispatch, supervision, and worker lifecycle.

Overview is the primary home: independent Workers and Notion cards share groups controlled by organizer presets and Customize in a single-row toolbar with linked status donuts, with relationships between the columns and one contextual **Your desk** panel. See the [Overview reference](docs/features/overview.md) for grouping, filtering and presentation behavior and the [source setup](docs/features/reconciliation-floor.md#run-and-configure) for fleet and Notion configuration.

For worker-to-card associations, see [Notion-owned worker links](docs/notion-worker-links.md) for setup, verification and the First Mate workflow.

Use **Search** in the Overview toolbar or **Cmd/Ctrl+K** to find names, IDs and text. Use the adjacent Pattern Dial for operational patterns. See [Smart Search](docs/features/overview.md#smart-search-core) for matching, coverage and restore behavior.

The [Card Janitor CLI](docs/features/card-janitor.md) produces a read-only operational-card audit with cited cleanup candidates and offline JSON replay. It creates no Desk items and makes no model calls or Notion writes.

Open a Desk request's source inspector to answer or dismiss a ready First Mate request, open its existing terminal when available, or read its Notion card. See the [queue reference](docs/features/reconciliation-queue.md) for readiness and source identity rules.

Use the speech-bubble **Ask** icon in a task or worker header to open a blank question, or right-click a supported task field or relationship for an editable draft. Review the question, then send. Questions and answers appear first in **Your desk**; opening an item returns to its originating context. The [Ask reference](docs/features/ask.md) covers gestures, semantic targeting, answer return, and the required owner-authenticated setup and outbound puller.

The activity strip provides **Overview**, **Receipts** and **Workers**. Receipts and the worker switcher open in a collapsible side panel; below 1100px it opens as a drawer. Quota meters stay at the panel's bottom. Choose a worker in **Workers**, whose search narrows the list by id or project (Enter opens the first match), or use **Ctrl+[** and **Ctrl+]** to cycle, including while the terminal has focus.

A worker opens a live terminal with its objective, project, worktree, branch and pull request in a detail rail (**Details** on windows 1200px wide or narrower). In the collapsible prompt composer, **Ctrl+Enter** (or **Cmd+Enter**) pastes the prompt into the worker's pane and presses Enter. It retains recent prompts, stash slots and quick menu keys. Paste a screenshot or drop a file to upload it under the config root's `screenshots/` folder and insert its `@path`. Mark a worker **Direct** in the detail rail to indicate you are working with it yourself; First Mate receives an inbox note when the mark changes. A snapshot kind of `secondmate` shows a **Second mate** badge in that rail. Each worker keeps the same face and color across reloads.

## Worker links

The open worker is part of the page URL, so a view can be opened directly or shared. Opening a worker or returning to Overview adds a browser history entry; cycling with **Ctrl+[** / **Ctrl+]** updates the current entry instead. Legacy `q` filter parameters are retained in the URL but do not filter the two-column Overview.

| URL | Opens |
| --- | --- |
| `/?q=text` | Overview; the legacy filter parameter is retained. |
| `/?worker=TASK_ID` | That worker's detail, including on a fresh load. `TASK_ID` is the First Mate task id. |
| `/?worker=TASK_ID&q=text` | That worker's detail. The legacy filter parameter is retained when you return to Overview. |
| `/?worker=TASK_ID&home=HOME` | The worker with that task id in the First Mate home whose folder name is `HOME` (for `/path/to/firstmate`, `firstmate`). The cockpit adds `home` only when the task id is in more than one configured home. If two homes share a folder name, the first configured one opens. |

An id that is not in the fleet, or that is in more than one home when no `home` is given, shows **No such worker**. If a fleet update failed, the **Fleet update delayed** notice appears above it, since the worker may be in a home that has not loaded yet.

**Receipts** shows whether existing messages were saved, acknowledged or resolved; saving a message does not claim First Mate has acted on it. The retained inbox and dismissal APIs are described in the [integration reference](docs/features/firstmate-observer.md).

## Quick start

Requires Node.js 22.12 or newer, a working [First Mate](https://github.com/kunchenguid/firstmate) home, `tmux`, `ttyd`, and Python 3. Start Tinstar with:

```bash
npx tinstar
```

Open `http://localhost:5273`. Provider quota in the side panel comes from a local `quota-axi` reading. `npx tinstar doctor` checks local dependencies and configured First Mate homes.

Configure the home in `~/.config/tinstar/config.json`:

```json
{
  "firstmate": {
    "homes": ["/path/to/firstmate"]
  }
}
```

The home must contain First Mate's `bin/fm-fleet-snapshot.sh` and `bin/fm-inbox.sh`. Direct dismiss also runs `bin/fm-captain-hold.sh` or `bin/fm-send.sh` from that same directory. Tinstar reads the fleet snapshot and opens private terminal views linked to worker windows. It does not create or stop workers. See [the integration reference](docs/features/firstmate-observer.md) for the current boundary.

For conversational control of Overview, use the [authenticated MCP connection instructions](docs/features/reconciliation-mcp.md#start-and-connect).

## Access and configuration

The server binds to loopback by default. For a separately authorized address, use `tinstar --host <address>`; terminal services remain on loopback behind the Tinstar proxy. [Reach](docs/release-notes-v5-4.md#if-you-were-reaching-tinstar-from-another-device) can provide tailnet access without widening the listener.

| Setting | Purpose |
|---------|---------|
| `TINSTAR_CONFIG_HOME` | Use a separate config root instead of `~/.config/tinstar`. |
| `TINSTAR_HOST` | Additional bind addresses, equivalent to `--host`. |
| `TINSTAR_TELEMETRY=0` | Disable the embedded observability stack. |

The server and API use port 5273 by default. Worker view ttyd processes use loopback ports from `firstmate.ports` (default 8781–8830), proxied through the server.

## Provider quota

The server runs `quota-axi --json --full --no-credential-refresh` about every two minutes and caches the result. It does not ask `quota-axi` to refresh a vendor login. Each weekly quota meter shows a calendar strip of the Sunday-to-Saturday weeks its window touches (one or two rows): weekday labels, a bar for quota still left that ends at the reset, and a vertical line at now. The 5-hour window, when reported, sits beside the strip as a small readout. Cursor instead gets a bar across its own usage cycle (usually monthly) with a vertical line at now and the reset date. Grok Bot, when Cursor reports that weekly window, gets its own calendar strip and stays off the Cursor cycle. Before you sign in to Cursor, its row reads **Sign in**. Cursor and Grok Bot are not in the activity strip's quota summary. When one to four other signed-in providers are present and the viewport has room, the activity strip shows their quota summary. Providers with no weekly window appear as compact icons on the quota rail even when that summary is hidden. Hover or keyboard focus opens the remaining percent, limiting window, reset time, projected run-out, plan, and how long ago the reading refreshed. A provider that fails shows that error on its own icon. A missing reading is not drawn as zero.

## About plugins

The V5 plugin host was removed in 6.0.0. The separately published `@tinstar/plugin-api` package has no runtime host in this release.

## License

Released under the [MIT License](LICENSE).
