---
name: tinstar-screenshot
description: Take a clean, framed screenshot of a single Tinstar canvas widget (a run-workspace card or one of its panels) for docs, essays, changelogs, or QA. Use when you need a real picture of a live run on the canvas — not a mock. Drives headless Playwright against the running dashboard, defeats the canvas overlap traps, and saves a PNG you then LOOK at.
---

# Tinstar Screenshot

Capture one run-workspace card (or a sub-panel) from the live Tinstar canvas as a clean PNG. The infinite canvas makes naïve screenshots messy — widgets cluster and overlap, terminal iframes float above neighbours, fixed shell panels bleed into clips, and live SSE updates wipe any inline DOM tweaks. This skill's script (`capture-widget.mjs`) handles all of that.

The repo ships Playwright (`node_modules/.bin/playwright`); the script finds it automatically when run from inside the tinstar repo.

## When to use

- Illustrating docs/essays/changelogs with a real run card or panel.
- Visual QA of the run-workspace widget (status light, changed-files, telemetry).
- Any "show me what it actually looks like" where a mock won't do.

For showing the *user* an existing image on their canvas, use an image-widget or an HTML artifact (see the `tinstar` skill) — that's delivery, not capture.

## The five traps (why a plain screenshot fails)

1. **`networkidle` never fires** — Tinstar holds SSE streams open. Load with `domcontentloaded` and wait for `[data-widget-id]`. (Handled.)
2. **Inline hides get wiped ~1×/sec** — SSE snapshots re-render React and reset inline `style`. Hide neighbours with an **injected stylesheet** (`addStyleTag`), which persists. (Handled.)
3. **Foreign terminal iframes float above** — a neighbour's ttyd terminal is an `<iframe>` that is often a *sibling* of `[data-widget-id]`, so hiding the widget div doesn't hide it. Match by src instead: keep only `iframe[src*="session=<id>"]`, hide the rest. (Handled.)
4. **Fixed shell overlays bleed in** — the CanvasHud (top-right) and the left `sidebar-slot` overlap element clips. Hidden via CSS + a wide viewport so the card sits left of the right dock. (Handled.)
5. **Telemetry isn't in the API** — context %, cost, and tokens are client-fetched by the panel, not in `/api/state`. The only way to know what rendered is to **open the PNG and look.** (Your job.)

## Procedure

1. **Pick / make a target run.** It must be in the **active space** — spaces scope which runs render on the canvas (`GET /api/state` → `activeSpaceId`; `GET /api/spaces`). For a guaranteed-clean shot, give the demo its own space so nothing can overlap it (see Isolation).
   To generate real traffic, create a session (see the `tinstar` skill) with a real task; the run id usually equals the session name.
2. **Capture**, from the tinstar repo root:
   ```bash
   node .claude/skills/tinstar-screenshot/capture-widget.mjs \
     --widget <runId> --out /tmp/card.png
   ```
3. **LOOK at the PNG** (read the image). Check framing, status, and that no neighbour bled in. Iterate flags as needed.

## Recipes

```bash
S=.claude/skills/tinstar-screenshot/capture-widget.mjs

# Full run card, Recap tab (the hero)
node $S --widget essay-demo --out images/card.png --tab recap

# Same card, live Terminal tab (agent mid-work)
node $S --widget essay-demo --out images/terminal.png --tab terminal

# Header strip only (avatar, status light, WORKTREE/REPO, controls)
node $S --widget essay-demo --out images/header.png --sub header --rpad 0 --pad 6

# Changed-files panel (crop the empty tail)
node $S --widget essay-demo --out images/files.png --sub focus-zone-file-list --maxh 360

# Telemetry / context-meter panel
node $S --widget essay-demo --out images/telemetry.png --sub focus-zone-right-panel --rpad 8
```

Useful `data-testid` sub-targets: `header` (the card header), `focus-zone-file-list` (changed files), `focus-zone-right-panel` (telemetry/context), `focus-zone-center-tabs` (recap/terminal body). Crop further with ImageMagick if a panel is tall: `convert in.png -crop WxH+0+0 +repage out.png`.

## Isolation (guaranteed-clean shots)

A run's `spaceId` is set to the **active space at run-creation**. To make the target the only widget on its canvas:

```bash
SP=$(curl -s -X POST localhost:5273/api/spaces -d '{"name":"Shots"}' | jq -r .data.id)
PREV=$(curl -s localhost:5273/api/state | jq -r .activeSpaceId)   # remember to restore
curl -s -X POST localhost:5273/api/spaces/$SP/activate >/dev/null
# ...create the demo session now (born into $SP), let it work, then capture...
curl -s -X POST localhost:5273/api/spaces/$PREV/activate >/dev/null # RESTORE the user's view
```

**Activating a space is global** — it moves the user's live canvas. Always capture in one batch and **restore `$PREV`** immediately. Deleting a space can also bump the active space, so re-check and restore at the end.

## Cleanup

Delete demo sessions/worktrees you created (`DELETE /api/sessions/<name>`, then `git worktree remove --force` + `git branch -D` if the auto-clean didn't), remove any temp space, and restore the user's active space. Don't leave demo cards cluttering a real workspace.

## Notes

- `--widget` is the run id (`data-widget-id`), which equals the session name for normal runs.
- Framing uses the canvas's own `widget:flash-focus` event (`InfiniteCanvas`), so it pans/zooms exactly like the inbox does.
- `deviceScaleFactor: 2` → crisp 2× PNGs; expect large dimensions for the full card.
