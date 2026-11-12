<p align="center">
  <img src="logo.png" alt="Tinstar" width="400" />
</p>

<h3 align="center">A cockpit for your First Mate fleet</h3>

Tinstar shows the workers First Mate is already running, the calls that need your attention, and provider quota in one view. First Mate remains responsible for dispatch, supervision, and worker lifecycle.

Overview is the primary home: independent Workers and Notion cards share groups controlled by organizer presets and Customize in the compact toolbar, with relationships between the columns. See the [Overview reference](docs/features/overview.md) for grouping, filtering and presentation behavior and the [source setup](docs/features/reconciliation-floor.md#run-and-configure) for fleet and Notion configuration. The optional [Jira adapter pilot](docs/features/jira-adapter.md) supports isolated synthetic work.

Waits on First Mate are nudged to First Mate automatically. Overview keeps that list off the default view; see [Waiting on First Mate](docs/features/waiting-on-main.md).

For Codex worker-state collection and machine-local setup, see the
[Codex activity reference](docs/features/codex-activity.md).

**Discuss** stays available across Overview, Decisions, PRs, Releases and worker views, retaining questions, drafts and answers while you navigate. Collapse or resize its desktop rail, or open it from the mobile Discuss button. See the [Ask reference](docs/features/ask.md) for sizing controls and saved preferences.

Use **Update work** in a card’s Inspector to record assignments, checkpoints, waits, decisions and completion. Use **Start work** to link an executing worker. Authenticated agents create and update cards through MCP; see [shared workflow operations](docs/features/workflow.md) for requirements, readback and retained dependencies.

For worker-to-card associations, see [Notion-owned worker links](docs/notion-worker-links.md) for setup, verification and the First Mate workflow.

Use **Search** in the Overview toolbar or **Cmd/Ctrl+K** to find names, IDs and text. Use the adjacent Pattern Dial for operational patterns. See [Smart Search](docs/features/overview.md#smart-search-core) for matching, coverage and restore behavior.

Use the [Releases page](docs/features/releases.md) to inspect Changes, Acceptance and draft Release notes. The reference explains Plan and Verify, the GitHub-native source and its evidence limits.

For actions on selected PRs in PR Operations, see the [PR actions guide](docs/pr-actions.md).

The [Card Janitor reference](docs/features/card-janitor.md) covers the read-only operational-card audit, offline JSON replay and opt-in local semantic pilot.

The [Next check-in watchdog](docs/features/check-in-watchdog.md) requests overdue status updates through First Mate and shows a quiet line on the relevant card until Notion readback verifies the answer.

Open a **Decisions** request to review First Mate’s published recommendation, choose an action or discuss the request with text or voice. See the [queue reference](docs/features/reconciliation-queue.md#decisions-tab) for the workbench, readiness and source identity rules.

Use the speech-bubble **Ask** icon on a task, worker, PR, deployment target or receipt to open a blank question, or right-click a supported field or relationship for an editable draft. Review the question, then send. Questions and answers appear in **Discuss**, under **Needs you**, **Waiting** or **History**; opening an item returns to its originating context. The [Ask reference](docs/features/ask.md) covers gestures, semantic targeting, answer return, and the required owner-authenticated setup and outbound puller.

Expand a Discuss conversation and use **Reply to First Mate** to continue inline with its prior questions and answers. Enter sends; Shift+Enter adds a line. The same composer is embedded in expanded Inspectors, PR details and Releases. Hold **Talk** and release to transcribe and send, or tap to start/stop; Cancel never sends. See the [local voice runbook](docs/features/voice.md) for setup, limits and text fallback.

Use **Open in ChatGPT** on an Overview work card or PR row for an external discussion. See the [Open in ChatGPT reference](docs/features/open-in-chatgpt.md) for URL prefill limits, copy-prompt recovery and metadata privacy.

The activity strip provides **Overview**, **Decisions**, **PRs**, **Releases** and **Review Ready**. Use **Review Ready** to open the existing context panel, inspect a deliverable's live feature and evidence, and approve it or request changes. See [deployed feature review](docs/features/workflow.md#deployed-feature-review) for acceptance scope and recovery rules. [Decisions](docs/features/reconciliation-queue.md#decisions-tab) provides a searchable queue with shared card selection and MCP flash. The [PR Operations reference](docs/features/pr-operations.md) covers the review table, repository scope and required owner access. The **Discuss** header contains its title and collapse control. From worker detail, use **Switch worker**, or **Ctrl+[** and **Ctrl+]** to cycle, including while the terminal has focus.

A worker opens a live terminal with its objective, project, worktree, branch and pull request in a detail rail (**Details** on windows 1200px wide or narrower). In the collapsible prompt composer, **Ctrl+Enter** (or **Cmd+Enter**) pastes the prompt into the worker's pane and presses Enter. It retains recent prompts, stash slots and quick menu keys. Paste a screenshot or drop a file to upload it under the config root's `screenshots/` folder and insert its `@path`. Mark a worker **Direct** in the detail rail to indicate you are working with it yourself; First Mate receives an inbox note when the mark changes. A snapshot kind of `secondmate` shows a **Second mate** badge in that rail. Each worker keeps the same face and color across reloads.

## Worker links

The open worker is part of the page URL, so a view can be opened directly or shared. Opening a worker or returning to Overview adds a browser history entry; cycling with **Ctrl+[** / **Ctrl+]** updates the current entry instead. Legacy `q` filter parameters are retained in the URL but do not filter the two-column Overview.

| URL | Opens |
| --- | --- |
| `/?view=decisions` | Decisions queue. |
| `/?view=pulls` | PR Operations review table. |
| `/?view=releases` | Releases page. |
| `/?card=NOTION_PAGE_ID` | Reveal that authorized card in Overview. |
| `/?q=text` | Overview; the legacy filter parameter is retained. |
| `/?worker=TASK_ID` | That worker's detail, including on a fresh load. `TASK_ID` is the First Mate task id. |
| `/?worker=TASK_ID&q=text` | That worker's detail. The legacy filter parameter is retained when you return to Overview. |
| `/?worker=TASK_ID&home=HOME` | The worker with that task id in the First Mate home whose folder name is `HOME` (for `/path/to/firstmate`, `firstmate`). The cockpit adds `home` only when the task id is in more than one configured home. If two homes share a folder name, the first configured one opens. |

An id that is not in the fleet, or that is in more than one home when no `home` is given, shows **No such worker**. If a fleet update failed, the **Fleet update delayed** notice appears above it, since the worker may be in a home that has not loaded yet.

For Decisions response delivery inspection, see the [queue reference](docs/features/reconciliation-queue.md). Worker notes and replies appear under **Tell First Mate about this** in worker detail; when the worker leaves the fleet, its retained notes remain available under the Decisions diagnostics. The [integration reference](docs/features/firstmate-observer.md) covers retention and retry.

## Quick start

For automatic Ask delivery on the designated Mac First Mate host, use the
[Tin Star Ask LaunchAgent installer and runbook](docs/features/ask-puller-service.md).

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

For conversational control of Overview and Decisions and shared work, PR and release reads, use the [authenticated MCP connection instructions](docs/features/reconciliation-mcp.md#start-and-connect), including the [scoped outbound facade for ChatGPT](docs/features/reconciliation-mcp.md#scoped-outbound-tunnel-facade). The [PR and release read contract](docs/features/reconciliation-mcp.md#pr-and-release-reads-slice-b) describes availability and authorization requirements.

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
