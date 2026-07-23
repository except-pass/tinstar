# Plan — A2UI diagram/graph primitive (Slate S1)

Date: 2026-07-22 · Slug: `2026-07-22-001-a2ui-diagram-primitive-plan`
Ships as ONE squash-merged PR (built/tested/merged by a downstream `/lightsout` run).

## Problem & Scope

Agent-authored Slate surfaces can only draw a flow as ASCII art inside a `Code`
block, because A2UI's catalog (`src/a2ui/catalog.tsx`) has no diagram primitive.
The acceptance case is the vppOps run: a 7-step pipeline with a fork at `ROUTE`
(matched → continue, unmatched → drop) must render as a real node/edge diagram
with layout and host theming, not text.

**In scope:** add exactly ONE new A2UI catalog component that renders an
agent-supplied diagram definition into a laid-out, dark-themed SVG, degrading
(never crashing the surface) on a bad definition. It must render inside any
A2UI body — Roundup notices *and* Slate surfaces (`DiagramSurface`,
`OpenPointsSurface`) all funnel through the shared `A2uiRenderer`, so one catalog
entry lights up everywhere at once.

**Not in scope:** a native nodes/edges/auto-layout `Graph` component, interactive
diagrams (click/pan/zoom), a `diagram` surface *kind* (that name already exists
and means something else — see Decisions), and any server-side change to the
Slate file-watch or projection path.

**Key grounding facts (verified against the tree):**

- `mermaid@^11.14.0` is **already a dependency** (`package.json` line 64) and is
  already dynamically imported in `src/plugins/file-editor/src/MarkdownRenderer.tsx`
  (`MermaidBlock`). No new package, no new top-of-bundle weight — vite already
  emits a lazy `mermaid-*.js` chunk that this feature reuses.
- The A2UI content schema is **passthrough** on both the component `type` string
  and its props. Verified at runtime:
  `AnyComponentSchema.safeParse({component:'Mermaid', id:'m1', source:'graph TD; A-->B'})`
  succeeds and preserves the `source` prop. So a new component type validates with
  **no `schema.ts` change** — the catalog alone decides what's drawable
  (`src/a2ui/catalog.tsx` header comment; `src/a2ui/schema.ts` lines 22-26).
- `catalog.tsx` is imported **only** by `A2uiRenderer.tsx` (client). The server
  (esbuild) bundle imports `a2ui/schema.ts`, `a2ui/controls.ts`, `a2ui/followUps.ts`
  — all React-free. Mermaid must stay strictly on the client side of that line.
- The renderer already has the safety net this feature must plug into
  (`src/a2ui/A2uiRenderer.tsx`): an unsupported type → inline `NodeFallback`
  marker; a per-surface React error boundary; a `MAX_NODES` walk budget. The new
  component counts as one node and must **self-degrade rather than throw**, exactly
  like the `Choice`/`Submit`/`FollowUp` control entries.

## Decisions

### D1 — Library: **Mermaid**, wrapped as ONE catalog component `Mermaid`. Committed.

**Tradeoff:** choosing Mermaid over a native `Graph` (nodes/edges/auto-layout).
Gains: zero new dependency (already installed + already chunk-split), a proven
in-repo rendering pattern to copy (`MermaidBlock`), and a trivial authoring path —
the fork example is `graph TD; ...; ROUTE -->|matched| ...; ROUTE -->|unmatched| DROP`.
Costs: the agent must emit valid Mermaid syntax (a string DSL) rather than a
structured `{nodes, edges}` object, and we don't own the layout engine. **Wrong if**
we needed programmatic per-node styling/binding from host data or interactive
graph editing — then react-flow's structured model wins. We don't: Slate diagrams
are read-only pictures (`DiagramSurface`: "a diagram is shown, not answered").

- **draw.io rejected:** it's an editor/embed, not a render-a-string primitive;
  wrong shape entirely for a read-only agent-authored surface.
- **react-flow rejected:** the composable ideal, but a large build (bring a layout
  engine — dagre/elkjs — plus node/edge React components) for a picture nobody
  interacts with. Precedent points the other way: Claude Artifacts render Mermaid
  natively. If a structured `Graph` is ever wanted it can be added later as a
  *second, additive* catalog entry without disturbing this one.

**Assumption:** agents can reliably emit Mermaid (they already do — it's the same
DSL they write into `.md` files that the file-editor renders today).

### D2 — It is a **catalog COMPONENT, not a surface KIND.** No kind work.

The existing `'diagram'` surface *kind* is a misnomer: `projectRunToSlate` sets
`kind: 'diagram'` whenever `anchor.kind === 'surface'`, meaning merely "a
standalone A2UI card + thread" (`src/domain/types.ts` lines 493-496;
`DiagramSurface.tsx`). It has nothing to do with drawing a diagram. This feature
adds a *component* the A2UI body can contain; it does **not** touch surface kinds,
`projectRunToSlate`, or `SlatePanel`'s renderer switch. A `Mermaid` component works
inside an `'open-point'` surface just as well as a `'diagram'`(=standalone) one.

### D3 — Component prop name: **`source`** (the Mermaid definition string).

Matches the existing `MermaidBlock` prop and reads unambiguously. Read via the
catalog's existing `str()` coercer, which forces a non-string/absent value to `''`
(→ the empty-source degrade path, D6). No other props in v1.

### D4 — **No schema.ts entry.** (Answering the explicit note.)

Because `AnyComponentSchema` is passthrough (verified above), adding a schema entry
would be dead code — the component and its `source` prop already validate. Adding
one would also risk pulling type-specific knowledge into the React-free server
module for no gain. Leave `schema.ts` untouched.

### D5 — Bundle weight + async render.

`import('mermaid')` inside the component's effect keeps mermaid in its existing
lazy chunk — it stays off the initial bundle and off the server bundle. Render is
async: the component holds the produced SVG in **state** (not a ref) and shows a
brief "Rendering diagram…" placeholder first. This mirrors `MermaidBlock` exactly,
including its documented ref-deadlock reasoning (the target div is unmounted while
loading, so a ref would be null the moment `render()` resolves). The effect keys on
`source` and uses a `cancelled` flag so a source change / unmount can't land a
stale SVG.

### D6 — Security: **`securityLevel: 'strict'`** explicitly, content is untrusted.

Slate/Roundup A2UI content is agent-authored and reaches the renderer through a
`.passthrough()` schema, so the `source` string is untrusted. Set
`securityLevel: 'strict'` in `mermaid.initialize` (encodes HTML in labels, disables
click-handlers/JS directives, and routes the output through mermaid's internal
DOMPurify sanitize before we inject it). We do **not** use `'sandbox'`: it renders
into an `<iframe>`, which breaks host theming, sizing, and the design language's
hairline aesthetic. The already-sanitized SVG string is injected via
`dangerouslySetInnerHTML` — the same trust posture as `MermaidBlock`, but with the
security level pinned explicitly rather than left to mermaid's default.

### D7 — Theme: pin to the **dark Slate surface tokens** — and correct a P4 violation.

Theme via `mermaid.initialize({ theme:'base', themeVariables:{…} })` using the
tokens in `tailwind.theme.js` (values below), so the diagram reads as part of the
dark card, not a stock white mermaid graphic:

| mermaid var | value | token / rationale |
|---|---|---|
| `primaryColor` (node fill) | `#141c24` | `surface.hover` — one lightness step above the card, so nodes read against `surface.raised #0f1419` (design: "depth = one hairline + a lightness step") |
| `primaryBorderColor` | `#5c6b74` | `ink.low` — **neutral, NOT cyan** |
| `lineColor` (edges) | `#5c6b74` | `ink.low` — neutral edges |
| `primaryTextColor` | `#eaf1f5` | `ink.high` — node labels |
| `secondaryColor` / `tertiaryColor` | `#0f1419` / `#0a0e12` | `surface.raised` / `surface.panel` |
| `fontFamily` | `"JetBrains Mono", monospace` | card defaults to mono; a diagram is structural, mono fits |
| `fontSize` | `11px` | matches Slate meta scale |

**P4 correction (design-language, load-bearing):** the existing `MermaidBlock`
uses `primaryBorderColor:'#00f0ff'` and `lineColor:'#00a5b0'` (cyan). The Slate
design language reserves `#00f0ff` for the **live edge only** — "Static surfaces
stay neutral so liveness stands out" (`docs/slate-design-language.md` P4, line 10).
A static diagram must therefore use **neutral hairline/ink borders**, not cyan.
This is a deliberate divergence from the file-editor precedent, not an oversight.

**Light theme:** the Slate/Roundup surfaces are dark-only today (design tokens are
a single dark palette; no `light`/`dark` class toggle exists in these widgets).
v1 pins the dark theme. Leave a single `TODO` comment naming the hook point (read a
theme signal → swap `themeVariables`) so a future light mode is a one-function
change; do **not** build a theme-detection mechanism that has nothing to detect.

**Assumption:** no light theme exists for these widgets in this repo today
(confirmed: no `prefers-color-scheme` / `data-theme` handling in the A2UI or Slate
components).

### D8 — Degrade: parse errors degrade like an A2UI node, never crash the surface.

Two failure modes, both handled inside the component (so a bad diagram is a small
inline notice, exactly like `NodeFallback`, and the surface's other nodes render):

1. **`mermaid.render()` throws** (invalid syntax) → catch, show an inline amber
   degrade line styled to match the renderer's `NodeFallback`
   (`text-xs italic text-amber-300/80`), carrying the mermaid error message.
2. **The mermaid chunk fails to load** (stale `/assets/*.js` after a rebuild) →
   `.catch` on the dynamic import, show the same degrade line with a "reload the
   page" hint. Without this the block hangs on "Rendering diagram…" forever (the
   exact bug `MermaidBlock` documents).

Set `suppressErrorRendering: true` so mermaid does not paint its "bomb" graphic
into `document.body` and orphan it over the canvas. The component **never throws**,
so it can't trip the per-surface error boundary; that boundary remains the
belt-and-suspenders backstop.

## Implementation Units

### U1 — `Mermaid` A2UI component (the renderer)

**Goal:** a client-only React component that turns a `source` string into a
dark-themed SVG, async, self-degrading.

**Files:**
- Create `src/a2ui/MermaidComponent.tsx` — the stateful renderer (kept out of
  `catalog.tsx`, mirroring how `controlComponents.tsx` is a separate import, so the
  catalog stays a thin presentational map).
- Test `src/a2ui/__tests__/MermaidComponent.test.tsx`

**Approach:**
- Port the `MermaidBlock` pattern from
  `src/plugins/file-editor/src/MarkdownRenderer.tsx` (lines 49-118): module-scoped
  monotonic id counter; SVG held in `useState`; `useEffect` keyed on `source` with a
  `cancelled` flag; `import('mermaid')` → `mermaid.initialize({...})` →
  `await mermaid.render(id, source)`.
- `initialize` config: `startOnLoad:false`, `suppressErrorRendering:true`,
  `securityLevel:'strict'` (D6), `theme:'base'` + the D7 `themeVariables`.
- Three render states: loading placeholder ("Rendering diagram…",
  `text-xs font-mono text-ink-low`), error degrade line (D8 styling), success
  (`<div dangerouslySetInnerHTML={{__html: svg}}>` in a
  `overflow-x-auto [&_svg]:max-w-full` wrapper so a wide diagram scrolls inside its
  own box and never widens the card).
- Empty/whitespace `source` → the error degrade line ("empty diagram"), no
  `mermaid.render` call.
- Export a named `MermaidComponent({ source }: { source: string })`.

**Test scenarios** (mock `mermaid` the way `MarkdownRenderer.test.tsx` does):
- loading → success: placeholder shows, then the injected SVG appears, placeholder
  gone.
- `render()` rejects → the amber degrade line shows the error message; no throw
  escapes (assert the test's own error boundary / `container` is intact).
- dynamic-import rejects → degrade line with the reload hint.
- empty `source` → degrade line, `render` never called.
- `initialize` is called with `securityLevel:'strict'` and a non-cyan
  `primaryBorderColor`/`lineColor` (guards the D6 + D7-P4 decisions against a
  future copy-paste of the cyan file-editor config).

**Verification:** `env -u NODE_ENV npx vitest run src/a2ui/__tests__/MermaidComponent.test.tsx --exclude='e2e/**'`

### U2 — Wire `Mermaid` into the catalog

**Goal:** the closed A2UI vocabulary gains exactly one type; `isSupported('Mermaid')`
becomes true and the renderer draws it.

**Files:**
- Modify `src/a2ui/catalog.tsx` — import `MermaidComponent`; add a `Mermaid`
  entry: `render: (node) => <MermaidComponent source={str(node.source)} />`. Extend
  the header comment to note this is the one async/stateful, still-read-only entry.
- Test `src/a2ui/__tests__/A2uiRenderer.test.tsx` (extend the existing file).

**Approach:**
- The entry is a one-liner alongside `Choice`/`TextInput`/`Submit`. `str()` already
  coerces a missing/non-string `source` to `''` (→ U1's empty degrade).
- `Mermaid` is a leaf: `childIdsOf` returns `[]` for it with no change (it has
  neither `children` nor `child`), so the walker treats it as a leaf automatically.
- No change to `schema.ts` (D4), `A2uiRenderer.tsx`, `DiagramSurface.tsx`, or any
  server file.

**Test scenarios:**
- An `A2uiRenderer` given `{root:'m', components:[{id:'m', component:'Mermaid',
  source:'graph TD; A-->B'}]}` renders the `MermaidComponent` (mock mermaid) rather
  than an "unsupported component" `NodeFallback`.
- `isSupported('Mermaid') === true`.
- A `Mermaid` node nested inside a `Column` alongside a `Text` node: both render;
  the diagram doesn't consume the sibling (walk budget / keying intact).
- **Acceptance (vppOps fork):** feed the 7-step pipeline with the `ROUTE` fork as a
  `graph TD` source; assert the component mounts and (with a mocked
  `render→{svg}`) the SVG lands — proving the fork example renders as a diagram, not
  a `Code` block.

**Verification:** `env -u NODE_ENV npx vitest run src/a2ui/__tests__/ --exclude='e2e/**'`
then the full `env -u NODE_ENV npx tsc --noEmit -p tsconfig.app.json`.

### U3 — Docs touch-up (small, in-repo)

**Goal:** keep the design language and any A2UI vocabulary note truthful.

**Files:**
- Modify `docs/slate-design-language.md` — one line under the A2UI-body section
  noting `Mermaid` is a supported catalog component that themes to the dark surface
  with **neutral (non-cyan) edges** per P4.
- (Only if an authored-catalog reference list exists and enumerates types) add
  `Mermaid { source }` to it. Do **not** create a new doc file.

**Approach:** minimal, factual; no code.

**Verification:** none (prose); covered by the PR's human/lightsout read.

## Scope Boundaries (non-goals)

- **No native `Graph`/nodes-edges component** and no layout engine (dagre/elkjs).
  If wanted later, it's a separate *additive* catalog entry.
- **No interactivity** — no click handlers, pan/zoom, or selection. `securityLevel`
  stays `'strict'`, which disables mermaid click directives anyway.
- **No surface-KIND changes** — `projectRunToSlate`, `SlatePanel`, and the
  `'diagram'` kind are untouched (D2).
- **No schema.ts / server changes** — validation is already passthrough (D4); the
  server bundle stays React-/mermaid-free.
- **No new dependency and no `package.json` version bump** (mermaid already present;
  conventions forbid the version bump).
- **No light-theme mechanism** — dark-only today; a labelled `TODO` hook only (D7).
- **No refactor of the file-editor `MermaidBlock`** into a shared module. Tempting,
  but it carries different (cyan) theming and a react-markdown coupling; sharing it
  would widen the PR and force the P4 correction onto the file-editor surface, which
  is out of this feature's scope. Copy the pattern, don't unify — a unification can
  be its own PR.

## Risks

- **R1 — Cyan copy-paste regression.** The obvious move is to paste `MermaidBlock`'s
  config, which uses cyan borders and violates P4. Mitigation: U1's test asserts the
  border/line vars are the neutral `ink.low` value, so a cyan paste fails CI.
- **R2 — SVG width blows out the card.** A wide diagram could force horizontal
  page scroll (forbidden). Mitigation: wrap in `overflow-x-auto` with
  `[&_svg]:max-w-full`; the diagram scrolls inside its own box.
- **R3 — Server bundle contamination.** If `MermaidComponent` (or a mermaid import)
  ever leaks into a module the server bundles, esbuild breaks. Mitigation: mermaid
  lives only in `MermaidComponent.tsx`, imported only by client-side `catalog.tsx`
  (verified: server imports `schema.ts`/`controls.ts`/`followUps.ts`, all
  React-free). Do not add mermaid imports to those.
- **R4 — Stale chunk hang.** After a rebuild the lazy `mermaid-*.js` can 404,
  hanging the block forever. Mitigation: the dynamic-import `.catch` (D8/U1) — a
  known, already-solved failure mode in this repo.
- **R5 — Test flake on async render.** The SVG lands after an awaited promise.
  Mitigation: drive the mock promise explicitly (resolve/reject in the test) and
  `waitFor` the outcome, per the existing `MarkdownRenderer.test.tsx` pattern — no
  fixed timeouts (CI is slower than local).
- **R6 — Agent emits invalid Mermaid.** Expected and handled: it degrades to a
  readable inline error, and the rest of the surface renders (D8). Not a crash.
