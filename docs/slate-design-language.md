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

1. **Headline + controls** — Chakra 15/600. Controls (⟳ refresh, ✕ hide) top-right at `#4f5e67`, brightening only on hover. Never compete with the title.
2. **A2UI body** — rendered through the shared catalog. A **hairline divider** separates the headline from the body and any internal H4 sections.
3. **Thread** — collapsed to a single mono affordance with a count; expands in place, reply input inside. Quiet until needed.
4. **Freshness stamp** — bottom-right, mono, low ink. Turns **amber past the 15-minute stale horizon** — a "worth a refresh?" cue, never a claim of wrongness.

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
- **Do:** sink resolved/dismissed rows to the bottom and dim them; live points stay at top. **Don't:** make resolve destructive-looking — it's a soft checkbox; reopening is one click.

## Surface states (same shell across lifecycle; state signalled at the edges + freshness stamp, body never moves)
- **Refreshing** — cyan glow = live (`0 0 14 rgba(0,240,255,.1)`), "refreshing…".
- **Stale** — amber past 15m, "⚠ updated 47m ago".
- **Unreachable** — a note, not an error: "Sent — but that session isn't reachable right now."
- **Hidden** — dimmed to 50%, revealed only via the header toggle.
- **Empty** — an invitation, never a dead end: "Nothing on the Slate yet. ✦ Explain the session, or + Add a surface to fill it."

## Panel chrome
The column's header strip is the only always-visible chrome: a mono label left, quiet actions right; the composer opens as a popover beneath. **Do:** keep header actions mono + low-contrast; give only **✦ Explain** and the primary **Create** the cyan (the generative moves). **Don't:** pack the strip with icon buttons — text actions read faster and survive the 260px collapsed width.

## Token cheat-sheet
`column #0a0e12` · `card #0f1419` · `hairline rgba(130,175,195,.10)` · headline `Chakra 15/600 #eaf1f5` · body `sans 14/1.6 #9fb0bd` · meta/pill `Mono 10–11 caps` · card padding `14` · surface gap `12` · radius card/pill `4 / 3` · live glow `0 0 14 rgba(0,240,255,.1)` · stale after `15m → amber` · reflow 1→2 col `≥ 420px`.
