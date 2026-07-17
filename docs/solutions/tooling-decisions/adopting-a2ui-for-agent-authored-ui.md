---
title: "Adopting A2UI for agent-authored UI: schema-not-runtime, and two safety traps"
date: 2026-07-17
category: tooling-decisions
module: roundup
problem_type: architecture
component: a2ui_rendering
severity: medium
applies_when:
  - Adopting @a2ui/web_core (or any declarative agent-authored UI protocol) in this repo
  - Rendering an agent-authored component tree the user's agents produce
  - Deciding whether to adopt a dependency's schema vs its full runtime
---

# Adopting A2UI for agent-authored UI

Landed while building the Roundup's A2UI rendering slice (`src/plugins/roundup/src/a2ui/`). Three durable learnings: the de-risk outcome, and two safety traps specific to rendering agent-authored declarative UI.

## `@a2ui/web_core` installs and bundles cleanly on React 18 — pin it, adopt the schema not the runtime

The A2UI family's React renderer (`@a2ui/react`) requires React 19 and dropped React 18 in a *patch* release, so it's unusable here. But `@a2ui/web_core` (the framework-agnostic protocol layer) has **no React peer** — it installs on React 18 with zero peer errors, and bundles cleanly in **both** toolchains (vite client + esbuild server). Its `sideEffects: false` lets both bundlers tree-shake the unused runtime (`MessageProcessor`, `basic_catalog`) while keeping the schema atoms you import.

- **Pin it exactly** (`"@a2ui/web_core": "0.10.4"`, not `^`) — the family is volatile (a React major dropped in a patch). Add `zod` as a direct pinned dep too if you import it directly for validation.
- **Import from the version barrel** (`@a2ui/web_core/v0_9`) — the package's exports map has no per-file subpaths.
- **Adopt the schema, not the runtime.** For read-only rendering, use its v0_9 zod schemas (`AnyComponentSchema`, `ComponentIdSchema`) to validate, and render with your own host-themed React walker. The `MessageProcessor`/`ComponentContext`/`GenericBinder` runtime is for live, stateful, interactive surfaces (streaming messages, a data model, an action path) — adopt it only when interactivity needs it. Its `basic_catalog` ships its own styles, which defeats host theming — don't use it.

## Trap 1: the component schema is `.passthrough()` — validate URLs (and any prop the renderer trusts) yourself

A2UI's `AnyComponentSchema` is `.passthrough()`: it validates the `component` type and structure but lets arbitrary props (`url`, `text`, `children`) through unchecked. So schema validation at the API does NOT sanitize a `url`. An agent-authored `url: "javascript:…"` reaches `<a href={url}>` and executes in the app's origin (React warns but still renders it). **Allowlist schemes at the render boundary** — only `http:`/`https:` and same-origin relative paths (leading `/` or `#`); everything else falls back to a non-link span. Any prop the renderer feeds somewhere trust-sensitive needs the same treatment.

## Trap 2: bounding recursion depth does NOT bound total nodes — a diamond ref explodes

A walker that guards recursion *depth* and *cycles-on-the-current-path* still isn't safe against a **shared (diamond) reference**: a node whose children list the same child twice is fully re-walked on each incoming edge, so a shallow description (`c_i.children = [c_{i+1}, c_{i+1}]`, ~30 levels) expands to 2³⁰ renders and hangs the tab — well under any byte-size cap. **Bound the TOTAL node count** with a shared counter decremented on every visit (including re-visits), routing to a fallback when exhausted. Depth and per-path cycle detection are necessary but not sufficient. This matters doubly for agent-authored content, where the input is adversarial-by-accident.

## Related

- Both traps were caught by the roborev sweep, not the initial build — agent-authored declarative UI is a security surface; review it as one.
- `docs/solutions/conventions/adding-a-docstore-entity-and-plugin-widget.md` — the widget rendering this content still follows the two-place plugin-registration rule and the same deploy trap.
- The read-only rendering slice deliberately defers interactivity (controls, submit-back, the A2UI action path) — that's where web_core's runtime gets adopted and de-risked.
