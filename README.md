<p align="center">
  <img src="logo.png" alt="Tinstar" width="400" />
</p>

<h3 align="center">A cockpit for your First Mate fleet</h3>

Tinstar shows the workers First Mate is already running, the calls that need your attention, and provider quota in one view. First Mate remains responsible for dispatch, supervision, and worker lifecycle.

The left rail lists workers and **Needs You** cards for decisions, blocked or failed work, and pull requests ready to review. The main pane shows an overview grouped on two levels, chosen from status, project, and direct or managed, or one worker's live terminal at full height, with its objective, project, worktree, branch, and pull request in a rail beside it (a slim header with a **Details** toggle on windows 1200px wide or narrower). A filter at the top of the overview matches each worker's name and objective as you type; Escape clears it. Choose a worker in the rail or use **Ctrl+[** and **Ctrl+]** to cycle through them, including while the terminal has focus. Mark a worker **Direct** from its overview card or detail rail to show you are working with it yourself; First Mate gets an inbox note when the mark changes. Each worker keeps the same face and color across reloads.

## Worker links

The open worker and the overview filter are part of the page URL, so a view can be opened directly or shared. Opening a worker or returning to the overview adds a browser history entry; typing in the filter and cycling with **Ctrl+[** / **Ctrl+]** update the current entry instead.

| URL | Opens |
| --- | --- |
| `/?q=text` | The overview, limited to workers whose name or objective fuzzy-matches `text`. |
| `/?worker=TASK_ID` | That worker's detail, including on a fresh load. `TASK_ID` is the First Mate task id. |
| `/?worker=TASK_ID&q=text` | That worker's detail. The filter is still applied when you return to the overview. |
| `/?worker=TASK_ID&home=HOME` | The worker with that task id in the First Mate home whose folder name is `HOME` (for `/path/to/firstmate`, `firstmate`). The cockpit adds `home` only when the task id is in more than one configured home. If two homes share a folder name, the first configured one opens. |

An id that is not in the fleet, or that is in more than one home when no `home` is given, shows **No such worker**. If a fleet update failed, the **Fleet update delayed** notice appears above it, since the worker may be in a home that has not loaded yet.

Decision answers and “Tell First Mate about this” messages go through First Mate's inbox. The cockpit shows when a message is saved, acknowledged, and resolved; saving a message does not claim that First Mate has acted on it. Quota meters at the bottom of the rail show observed provider quota and say when a feed is stale or unavailable.

## Quick start

Requires Node.js 22.12 or newer, a working [First Mate](https://github.com/kunchenguid/firstmate) home, `tmux`, `ttyd`, and Python 3. Start Tinstar with:

```bash
npx tinstar
```

Open `http://localhost:5273`. The CLI offers to install the Claude Code statusline hook, which supplies Claude quota observations. `npx tinstar doctor` checks local dependencies and configured First Mate homes.

Configure the home in `~/.config/tinstar/config.json`:

```json
{
  "firstmate": {
    "homes": ["/path/to/firstmate"]
  }
}
```

The home must contain First Mate's `bin/fm-fleet-snapshot.sh` and `bin/fm-inbox.sh`. Tinstar reads the fleet snapshot and opens private terminal views linked to worker windows. It does not create or stop workers. See [the integration reference](docs/features/firstmate-observer.md) for the current boundary.

## Access and configuration

The server binds to loopback by default. For a separately authorized address, use `tinstar --host <address>`; terminal services remain on loopback behind the Tinstar proxy. [Reach](docs/release-notes-v5-4.md#if-you-were-reaching-tinstar-from-another-device) can provide tailnet access without widening the listener.

| Setting | Purpose |
|---------|---------|
| `TINSTAR_CONFIG_HOME` | Use a separate config root instead of `~/.config/tinstar`. |
| `TINSTAR_HOST` | Additional bind addresses, equivalent to `--host`. |
| `TINSTAR_TELEMETRY=0` | Disable the embedded observability stack. |

The server and API use port 5273 by default. Worker view ttyd processes use loopback ports from `firstmate.ports` (default 8781–8830), proxied through the server.

## Provider quota

Claude quota comes from the optional statusline hook. To install it later:

```bash
npx tinstar install-statusline
```

The hook copies a shim under the Tinstar config root and updates `~/.claude/settings.json`. The rail distinguishes fresh readings from stale or unavailable ones. Other providers appear only where a usable observation exists; a missing feed is never shown as zero usage.

## About plugins

The V5 plugin host was removed in 6.0.0. The separately published `@tinstar/plugin-api` package has no runtime host in this release.

## License

Released under the [MIT License](LICENSE).
