<p align="center">
  <img src="logo.png" alt="Tinstar" width="400" />
</p>

<h3 align="center">A cockpit for your First Mate fleet</h3>

Tinstar shows the workers First Mate is already running, the calls that need your attention, and provider quota in one view. First Mate remains responsible for dispatch, supervision, and worker lifecycle.

The left rail lists workers and **Needs You** cards for decisions, blocked or failed work, and pull requests ready to review. The main pane shows an overview grouped by state or one worker's objective, project, worktree, branch, pull request, and live terminal. Choose a worker in the rail or use **Ctrl+[** and **Ctrl+]** to cycle through them, including while the terminal has focus. Each worker keeps the same face and color across reloads.

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
