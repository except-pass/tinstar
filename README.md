<p align="center">
  <img src="logo.png" alt="Tinstar" width="400" />
</p>

<h3 align="center">A cockpit for your First Mate fleet</h3>

Tinstar shows the workers First Mate is already running, the calls that need your attention, and provider quota in one view. First Mate remains responsible for dispatch, supervision, and worker lifecycle.

A narrow activity strip switches among Overview, Needs You, Messages, and Workers. Needs You, message receipts, and the worker switcher each open in one side panel, which can collapse. At 1100px and wider it docks beside the canvas and starts open; below 1100px it starts closed and opens over the canvas as a drawer; weekly quota strips stay at the bottom of the panel. The main pane shows an overview grouped on two levels, chosen from status, project, and direct or managed, or one worker's live terminal filling the height above its prompt composer, with its objective, project, worktree, branch, and pull request in a rail beside it (a slim header with a **Details** toggle on windows 1200px wide or narrower). In the collapsible composer, **Ctrl+Enter** (or **Cmd+Enter**) pastes the prompt into the worker's pane and presses Enter; it also keeps recent prompts, stash slots, and quick keys for menu answers. Paste a screenshot or drop a file onto it to upload it under the config root's `screenshots/` folder and insert its `@path` into the prompt. A filter at the top of the overview matches each worker's name and objective as you type; Escape clears it. Choose a worker in the Workers panel, whose search box narrows the list by id or project (Enter opens the first match), or use **Ctrl+[** and **Ctrl+]** to cycle through them, including while the terminal has focus. Mark a worker **Direct** from its overview card or detail rail to show you are working with it yourself; First Mate gets an inbox note when the mark changes. A worker whose snapshot kind is `secondmate` shows a **Second mate** badge on its overview card and in that detail rail. Other kinds, including ship and scout, show no role badge. Each worker keeps the same face and color across reloads.

## Worker links

The open worker and the overview filter are part of the page URL, so a view can be opened directly or shared. Opening a worker or returning to the overview adds a browser history entry; typing in the filter and cycling with **Ctrl+[** / **Ctrl+]** update the current entry instead.

| URL | Opens |
| --- | --- |
| `/?q=text` | The overview, limited to workers whose name or objective fuzzy-matches `text`. |
| `/?worker=TASK_ID` | That worker's detail, including on a fresh load. `TASK_ID` is the First Mate task id. |
| `/?worker=TASK_ID&q=text` | That worker's detail. The filter is still applied when you return to the overview. |
| `/?worker=TASK_ID&home=HOME` | The worker with that task id in the First Mate home whose folder name is `HOME` (for `/path/to/firstmate`, `firstmate`). The cockpit adds `home` only when the task id is in more than one configured home. If two homes share a folder name, the first configured one opens. |

An id that is not in the fleet, or that is in more than one home when no `home` is given, shows **No such worker**. If a fleet update failed, the **Fleet update delayed** notice appears above it, since the worker may be in a home that has not loaded yet.

Decision answers and “Tell First Mate about this” messages go through First Mate's inbox. Sliding a classified decision to dismiss closes it in the Tin Star server: a captain-held backlog task is answered with that home's `fm-captain-hold.sh` (with `--release` when the hold is on a live worker's own task, so the held work resumes), and a keyed needs-decision line is closed with `fm-send.sh --resolve-key`, which also tells the waiting worker. Blocked cards have no dismiss. The card reads dismissing while the script runs, dismissed when it exits 0, and shows the script's error, with the slider still there, when it does not. A decision the snapshot cannot classify still sends one inbox answer and reads dismissing while that answer is open. The slider comes back if First Mate replies to that note, if the answer expires while the decision is still open, or if the same decision returns later. The cockpit shows when a message is saved, acknowledged, and resolved; saving a message does not claim that First Mate has acted on it. Quota meters at the bottom of the side panel show observed provider quota and say when a feed is stale or unavailable.

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

## Access and configuration

The server binds to loopback by default. For a separately authorized address, use `tinstar --host <address>`; terminal services remain on loopback behind the Tinstar proxy. [Reach](docs/release-notes-v5-4.md#if-you-were-reaching-tinstar-from-another-device) can provide tailnet access without widening the listener.

| Setting | Purpose |
|---------|---------|
| `TINSTAR_CONFIG_HOME` | Use a separate config root instead of `~/.config/tinstar`. |
| `TINSTAR_HOST` | Additional bind addresses, equivalent to `--host`. |
| `TINSTAR_TELEMETRY=0` | Disable the embedded observability stack. |

The server and API use port 5273 by default. Worker view ttyd processes use loopback ports from `firstmate.ports` (default 8781–8830), proxied through the server.

## Provider quota

The server runs `quota-axi --json --full --no-credential-refresh` about every two minutes and caches the result. It does not ask `quota-axi` to refresh a vendor login. Each provider that reports a weekly window shows a calendar strip of the Sunday-to-Saturday weeks that window touches (one or two rows): weekday labels, a bar for quota still left that ends at the reset, and a vertical line at now. The 5-hour window, when reported, sits beside the strip as a small readout. Providers with no weekly window stay compact icons. Hover or keyboard focus opens the remaining percent, limiting window, reset time, projected run-out, plan, and how long ago the reading refreshed. A provider that fails shows that error on its own icon. A missing reading is not drawn as zero.

## About plugins

The V5 plugin host was removed in 6.0.0. The separately published `@tinstar/plugin-api` package has no runtime host in this release.

## License

Released under the [MIT License](LICENSE).
