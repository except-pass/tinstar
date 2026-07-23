# The Slate — Surface Design Language

One visual language for every surface an agent (or the user) authors on a run's Slate, so each new surface inherits a beautiful, legible look instead of being styled from scratch. Keeps Tinstar's dark-terminal soul; evolves it with stronger hierarchy, calmer color, more room to breathe. (Source: the "Slate Surface Design Language" design artifact, grounded in a live run's real surfaces.)

## Principles

- **P1 · Content first, chrome quiet.** The authored words are the surface. Borders, controls, and stamps sit at the edges in low contrast; **color is spent on meaning** (status, author, liveness), never decoration.
- **P2 · One system, N surfaces.** Every surface — grouped list, standalone card, thread — shares the same card shell, type scale, and spacing rhythm. A new surface kind should look like it always belonged.
- **P3 · Sharp is the identity.** Tight **3–4px radii** and **hairline borders** read as terminal, not consumer-app. Earn depth with a single hairline + a lightness step, not soft shadows or neon everywhere.
- **P4 · Cyan means live.** `#00f0ff` glow is reserved for the **live edge**: focus, an in-flight refresh, the active agent. Static surfaces stay neutral so liveness stands out.

## Foundations

### Surface & ink (all already in the theme)
| Role | Token | Hex |
|---|---|---|
| Canvas base | `surface.base` | `#06080a` |
| Slate column | `surface.panel` | `#0a0e12` |
| Surface card | `surface.raised` | `#0f1419` |
| Hover / inset / nested card | `surface.hover` | `#141c24` |
| High ink (headlines) | — | `#eaf1f5` |
| Mid ink (body) | — | `#9fb0bd` |
| Low ink (meta / labels / controls) | — | `#5c6b74` (controls `#4f5e67`) |
| Primary (live only) | `primary` | `#00f0ff` |

### Semantic hues — one hue per meaning (~14% fill / ~22% border / bright text)
`open` → **indigo** (a live question) · `discussing` → **amber** (agent / in progress / stale) · `waiting` → **sky** (blocked on someone) · `resolved` → **emerald** (settled) · `dismissed` → **slate** (off-track, dimmed) · `error` → **red** (failed action only). Never mix two meanings in one hue.

### Type — three faces, three jobs
- **Chakra Petch** (`font-display`) — surface headlines + section titles.
- **JetBrains Mono** (`font-mono`) — labels, meta, pills, code.
- **Neutral system sans** — reading body. Author-written prose never uses the display face. **Load-bearing:** the run card defaults to mono (its terminal aesthetic), so every prose primitive must pin `font-sans` explicitly — it does NOT inherit sans. Body/caption/List/Link pin it; only labels (h4/h5), Code, and headlines override to mono/display.

| Role | Spec |
|---|---|
| Headline | Chakra **15 / 1.3 / 600**, `#eaf1f5` |
| Section H4 | Mono **11px, caps**, wide tracking |
| Body | sans **14 / 1.6**, `#9fb0bd` |
| Caption | **12.5px** |
| Meta / label | Mono **10–11px, caps** |

### Space, radius, elevation (4px grid: 4 · 8 · 12 · 16 · 24)
- **Card padding 14**, **gap between surfaces 12**, **gap inside a surface 8** (loosened one step from the old 8/8/4 — the Slate is now a primary surface).
- **Radius:** chip 2 · pill 3 · card 4.
- **Depth = one hairline** `rgba(130,175,195,.10)` + a lightness step. The neon glow is a **state**, not a resting style.

## Standalone card — anatomy

The base unit every non-list surface inherits: a quiet shell around agent-authored A2UI, controls + freshness pinned to the edges so the content owns the middle.

1. **Headline + controls** — Chakra 15/600. Controls (⟳ refresh, **– minimize**, ✕ hide) top-right at `#4f5e67`, brightening only on hover. Never compete with the title.
2. **A2UI body** — rendered through the shared catalog. A **hairline divider** separates the headline from the body and any internal H4 sections.
3. **Thread** — collapsed to a single mono affordance with a count; expands in place, reply input inside. Quiet until needed.
4. **Freshness stamp** — bottom-right, mono, low ink. Turns **amber past the 15-minute stale horizon** — a "worth a refresh?" cue, never a claim of wrongness.
5. **Collapsed card** (– minimize) — the shell, the controls (now ⟳ / **+ restore** / ✕) and the freshness stamp stay; only the body goes. The collapsed title uses the **Meta / label ramp** (mono 10–11 caps) on purpose — a collapsed card is a label, not a heading — and falls back to the surface id when there's no headline. State cues survive the collapse: a refresh still pulses (the pulse lives on the shell) and an unreachable refresh still shows its ⚠ marker. **Do:** keep minimize non-destructive and per-browser, exactly like hide. **Don't:** treat it as a second hide — a minimized card keeps its slot.

**Keyboard focus ring** — the focused row/card (see *Panel keys*) wears `ring-1 ring-primary/70`. Cyan, because keyboard focus is a live, moving thing (P4); on the **ring** specifically so it can never collide with the refresh pulse, which lives on the border and the shadow.

**Do:** keep the shell identical across every surface kind; let the authored body vary. **Don't:** give each surface its own accent border / bg tint / radius to differentiate — differentiation is the headline's job, not the frame's.

## A2UI primitives (style once, in the catalog — JSON carries structure, never color/spacing)

- **Text** — h1–h5 (Chakra section headings) · caption (quieter aside) · body (default reading sans).
- **Column / Row** — flex, gap 8 / 12, layout only (no visible box).
- **List** — ordered / unordered.
- **Card** — nested container, one child; nested cards step to `surface.hover` so nesting reads by lightness.
- **Divider / Link** — rule; safe href (only http(s) / same-origin resolve to a link, else plain text).
- **Code** — monospace block.
- **Mermaid** — `{ source, theme? }`, a Mermaid definition string rendered to a themed SVG. Nodes always fill `surface.hover` with `ink.high` labels; the author picks the accent treatment per diagram: **`ink` (default) keeps borders and edges neutral `ink.low`**, `hue` opts into the semantic `hue.*` palette for complex flows that need color to stay legible. **Neither may use cyan** — P4 reserves it for the live edge. Unknown `theme` values fall back to `ink`.
- **Diagram sizing** — the column is 260–560px, so a diagram renders **scaled to fit** it, never at natural size and never with a horizontal scrollbar (the #126 guard). Clicking opens an expanded view at readable size, portaled to `document.body` so the canvas transform doesn't displace it. A bad, empty, or over-long source degrades to a small inline amber line (like any other node fallback), never a crash.
- **The host owns the diagram's look** — mermaid lets a definition carry its own config, via `%%{init: …}%%` directives and YAML front matter. Both are **stripped from `source`**: either one could otherwise reintroduce the reserved cyan or turn off scale-to-fit (which makes `overflow-hidden` clip the diagram instead of shrinking it). The author picks a look with `theme`, and only with `theme`.
- **Stepper** — `{ steps: [{ label, status, detail? }] }`, a vertical **status track**: the catalog-level, N-phase generalization of the open-points lifecycle track. `done` → `hue.resolved` emerald with a `✓` · `active` → **live cyan** + the `0 0 14 rgba(0,240,255,.1)` glow (the active phase *is* the live edge — this is the one place an authored surface earns cyan, per P4) · `pending` → the faint `primary/12` rail, low ink · `skipped` → `hue.dismissed`, dimmed and struck through. Labels are mono (meta), the optional `detail` caption is reading sans. Unknown statuses coerce to `pending`; unusable `steps` degrade to a small inline amber line.
- **Don't** fake a diagram with ASCII inside Code — use **Mermaid**. **Don't** fake progress with `[x]` / `[ ]` inside Text or List — use **Stepper**; a checklist typed as prose is monochrome and throws away the status vocabulary. (Both were known gaps; both are now closed.)
- A **progress tracker** is not a new surface kind — it's a `diagram` surface (`anchor: { kind: 'surface' }`) whose body is a `Stepper`, rewritten in place per phase. See `docs/solutions/conventions/authoring-a-skill-progress-tracker-surface.md`.

## Interactive controls
Read-only until the surface is answerable; the chosen/focused accent is the **live cyan**. A read-only control shows static at **55% opacity**, no cyan. **FollowUp** renders nothing inline — it becomes a chip in the ask panel beside the surface.

## Open-points list — the hero surface
Every open point shares one grouped surface. Each row: author + status pill, a **lifecycle track**, a soft resolve, an expandable thread, and a body when declared. One add-a-point input at the foot.
- **Status track:** four dots, filled up to the current stage in the stage's hue; the terminal `resolved` dot goes emerald; unlit dots use `primary/12`. Dismissed = off-track, dimmed row.
- **Reorder (⠿ ▲▼):** a live row carries a thumb-pad grip plus two chevrons at control ink `#4f5e67`, right of the headline. The grip is decorative (`aria-hidden`); the chevrons do the work and carry real `aria-label`s. At the ends of the list they are **disabled, not hidden**, so the row's shape doesn't jump as points move. Resolved/dismissed rows sink by rank, so they get no grip at all — nudging one would be a lie.
- **Do:** sink resolved/dismissed rows to the bottom and dim them; live points stay at top. **Don't:** make resolve destructive-looking — it's a soft checkbox; reopening is one click.

## Objective — the pinned card

The run's goal, and the only surface the **user** writes. Same shell as every other card (hairline, raised surface, 14px padding) — it earns its distinction from **position and voice**, not from a special frame.

1. **Position** — pinned *between the header strip and the scroll body*, outside the grid. It never scrolls away under the surfaces it governs, and it sits outside the search / count / refresh-all / hide machinery: it is not an authored, refreshable surface.
2. **Type ramp** — mono `Objective` label (caps, low ink) over **reading sans 14/1.6 at `ink.mid`**. The run card defaults to mono, so the prose *must* pin `font-sans` — otherwise a person's sentence renders as terminal output.
3. **Empty state** — one dashed-hairline mono line, `+ Set an objective`. An empty card would be chrome with nothing to read (P1); a single quiet line is an invitation.
4. **`unapplied`** — a mono marker beside the label the moment the draft diverges from the saved text. It is the visible half of the rule that typing never nudges the agent.
5. **Apply is the only cyan on the card** — committing an objective is the one *generative* move here (P4), the same reason the composer's **Create** carries it. Edit / Cancel / clear stay at control ink. The helper line under the buttons — "Nothing reaches the agent until you Apply." — states the contract in the one place it matters.
6. **Unreachable** — the same quiet note the authored surfaces use, plus a ✕: nothing re-checks reachability, so the user retires it.

**Do:** keep the pin at the top and the voice human. **Don't:** give it an accent border, a second cyan, or a save-on-blur — the deliberate press *is* the design.

## Surface states (same shell across lifecycle; state signalled at the edges + freshness stamp, body never moves)
- **Refreshing** — cyan = live: a **slow 1.8s breathe** between `0 0 14 rgba(0,240,255,.1)` / border `.4` and `0 0 22 rgba(0,240,255,.28)` / border `.55`, plus "refreshing…". The same cue on a surface card and on an open-point row — they must read identically. Under `prefers-reduced-motion` it settles to the static glow: the state is still readable, just still.
- **Stale** — amber past 15m, "⚠ updated 47m ago".
- **Unreachable** — a note, not an error: "Sent — but that session isn't reachable right now."
- **Hidden** — dimmed to 50%, revealed only via the header toggle.
- **Empty** — an invitation, never a dead end: the composer itself renders **inline**, right where the surfaces would be, under a one-liner ("Nothing on the Slate yet — describe a surface, or ✦ Explain the session."). An inline composer has nothing to close back to, so it drops its Cancel, its drop shadow, and its Esc / outside-click self-close; a successful submit clears the form and says "Sent — the agent is authoring it" rather than sitting there looking dead. While it holds a draft the header's ✕ stands down — collapsing the column would destroy typed text.

## Workbench — a question SERIES, laid out sideways
A set of related open-points (same file-owned `group`, 2+ **live** members) leaves the vertical list and becomes one horizontal band inside it. The band is layout, not a new surface kind: every column is an ordinary point with its own answer form.
- **Band label:** the mono-caps meta ramp — `Questions · N` low ink at left, an `M of L answered` progress count in **control ink** (`#4f5e67`) at right. `N` counts the columns on screen; `L` counts only the ones still being asked, so a dismissed question leaves **both** sides and the count can always reach its ceiling. The count is the only running state the band owns, so it must also track the columns in **both directions** — a failed submit unlocks its column and the count goes back down with it.
- **Column:** a fixed `240px`, `shrink-0` card in the standard shell (radius 4, hairline, `surface.hover`), long tokens wrapping inside it (`overflow-wrap: anywhere`) rather than pushing the panel sideways. Headline is Chakra 13/600; body is the authored A2UI.
- **Answered posture:** swap the hairline for `hue.resolved/30` — **not** a dim. A dim reads *disabled*; an answered question is **done**, and the two must not look alike. Dimming to 50% stays reserved for `dismissed` / hidden, exactly as on the row.
- **Scroll (#126):** the band owns its own `overflow-x-auto` and carries `data-scrollable`. The panel's scroll body is `overflow-x-hidden`, so a horizontal scrollbar on a child of it would be unreachable — and the canvas wheel handler walks out through the `data-scrollable` chain for one that can actually consume the wheel, so a vertical wheel over the band still scrolls the panel instead of panning the canvas. **Consequence worth knowing:** the handler consults that chain *before* its zoom branch, so whenever the chain can take the delta a ctrl/⌘+wheel over the band yields too — reaching the browser's (or Tauri webview's) own ctrl+wheel handling, which zooms the whole app chrome, rather than the canvas zoom. When nothing in the chain can consume it (panel pinned at an edge, or not overflowing) it still zooms the canvas. Same behavior as every other `data-scrollable` panel, and a deliberate **open item** pinned by a test at `handleWheel` — see the `findWheelYieldTarget` docstring before changing it.
- **Do:** keep the column to the question — headline, body, controls. **Don't:** rebuild the row inside it (thread, resolve, reorder, hide all stay on the row, which is where the point lives once the file drops its `group`).
- **Off-the-table members, two different rules.** A **hidden** point never joins a band at all — a column has no unhide, so it would be stranded. A **dismissed** one doesn't *hold a band open* (a lone survivor would be a chrome-less column) but does ride along, dimmed, in a band its live siblings already justify — the set stays legible as a set. Both leave the progress count entirely.

## Panel chrome
The column's header strip is the only always-visible chrome: a mono label left, quiet actions right. **Do:** keep header actions mono + low-contrast; give only **✦ Explain** and the primary **Create** the cyan (the generative moves). **Don't:** pack the strip with icon buttons — text actions read faster and survive the 260px collapsed width.

- **Composer placement** — a popover beneath the header once the Slate has surfaces; on a blank Slate it is inline in the body instead (above). The two are mutually exclusive — never two composers on one panel.
- **Search (⌕)** — collapsed to a single glyph until asked for (`/`), then a narrow mono field. Maintenance, not generative: control ink, never cyan. It matches the **rendered body text** as well as headline/id/kind, because an expanded card never shows its headline. A filter that matches nothing says so ("No surface matches …") rather than looking like an empty Slate, and while a filter is on, ⟳ *Refresh all* renames itself to the matching count instead of promising "every surface".

## Panel keys
`j` / `k` walk a focus ring down and up the rendered rows (clamped, never wrapping) · `x` hides the focused one · `r` refreshes it · `c` opens the composer · `/` opens search · `?` the cheatsheet. All seven are live only while the Slate zone holds the card's focus; a key that isn't answered falls through untouched rather than flashing a false confirmation. The cheatsheet is a **reference card, not a live edge** — mono keycaps and labels, hairline border, control ink, no cyan.

## Token cheat-sheet
`column #0a0e12` · `card #0f1419` · `hairline rgba(130,175,195,.10)` · headline `Chakra 15/600 #eaf1f5` · body `sans 14/1.6 #9fb0bd` · meta/pill `Mono 10–11 caps` · card padding `14` · surface gap `12` · radius card/pill `4 / 3` · live glow `0 0 14 rgba(0,240,255,.1)` · stale after `15m → amber` · reflow 1→2 col `≥ 420px`.
