# ADR 0002 — Plugin API boundary

**Status:** Implemented (2026-05-23)
**Date:** 2026-05-23
**Builds on:** [ADR 0001 — Response envelope](./0001-response-envelope.md) (introduces the precedent of a closed contract enforced at the type level)

---

## Context

The V5.0 audit caught that built-in plugins (`src/plugins/<name>/`) directly import host modules:
`registerActionHandler`, `fitWidgetToViewport`, `useFileWatch`, `useImageWatch`, `useHotgroupContext`, `HotgroupBadge`, `resolveRunAccent`, `hexToRgba`, `apiFetch`, `EV` (window-events registry), and the widget-specific domain types.

Across the four plugins (`browser`, `file-editor`, `image-viewer`, `nats-traffic`) that's **11 distinct host imports**, ~25 import lines total. `docs/architecture.md` currently calls the boundary "aspirational" — meaning extracting any plugin to its own package would fail to compile.

The published `@tinstar/plugin-api` surface only covers `widgets.register`, `http.fetch`, `events.subscribe`, and `logger`. Real plugin needs (canvas integration, hotkeys, file watching, theming) are unaddressed, so plugin authors reach into host internals out of necessity.

Per the project memory, the V5 plugin system exists to integrate sibling projects (papershore, stretchplan), not a third-party marketplace. The boundary is load-bearing for those integrations — they will not have access to the host source tree.

## Decision

Expand `@tinstar/plugin-api` to cover everything built-in plugins use, migrate the built-ins to consume the API instead of importing internals, and **enforce the boundary with an ESLint rule.**

### The new API surface

Each is keyed to a current host import. Added to `TinstarPluginAPI` in `packages/plugin-api/src/index.ts`:

```ts
interface TinstarPluginAPI {
  // existing
  readonly pluginId: string
  readonly version: string
  widgets: { register(reg: WidgetRegistration): Disposable }
  http: PluginHttpApi
  events: PluginEventsApi
  logger: PluginLogger

  // new in this ADR
  hotkeys: {
    /** Register an action handler for a widget. The host's focus-path router
     *  dispatches action strings (e.g. 'fit-viewport') to this handler when
     *  the matching binding fires while the widget has focus. */
    onAction(widgetId: string, handler: (action: string) => void): Disposable
  }
  canvas: {
    /** Zoom and pan the canvas so the given widget fits in the viewport. */
    fitWidget(widgetId: string): void
  }
  hotgroups: {
    /** React hook: read which keyboard hotgroup slots this widget belongs to. */
    useContext(): {
      slotsForNode: (nodeId: string) => string[]
      nodesInSlot: (slot: string) => string[]
    }
    /** Renders ⌨ 1 3 5 chip for the given slot list. */
    Badge: ComponentType<{ slots: string[]; testId?: string }>
  }
  watch: {
    /** React hook: subscribes to file content updates for a workspace path. */
    file(sessionId: string, filePath: string): {
      content: string | null
      connected: boolean
      lastUpdatedAt: Date | null
    }
    /** React hook: subscribes to image-change notifications. */
    image(sessionId: string, filePath: string): {
      connected: boolean
      lastUpdatedAt: Date | null
    }
  }
  theme: {
    accent: {
      resolve(color?: string): string
      hexToRgba(hex: string, alpha: number): string
    }
  }
}
```

### `WidgetProps<T>` becomes generic

Currently `WidgetProps.data` is `unknown`. Plugins cast at use-site. Change to:

```ts
export interface WidgetProps<T = unknown> {
  data: T
  zoom: number
  isSelected: boolean
  isDragging: boolean
  isHovered: boolean
  isDropTarget: boolean
}
```

Default `T = unknown` preserves backwards compatibility for the host registry; plugins narrow with `WidgetProps<BrowserWidget>`.

### Domain types stay where they are (for now)

`src/domain/types.ts` declares `BrowserWidget`, `EditorWidget`, etc. The docstore stores them in typed per-plugin maps. Refactoring to generic storage (`Map<{type, id}, unknown>`) is a separate effort — defer until an external plugin (not already in `domain/types.ts`) needs a slot.

**Allowed exception**: built-in plugins MAY `import type` from `src/domain/types`. This is the lone allowed host import and is documented in each plugin's file header.

### Boundary enforcement

An ESLint rule under `src/plugins/*/src/**` forbids `import` (runtime) from:
- `src/components/*`
- `src/hooks/*`
- `src/hotkeys/*`
- `src/widgets/*`
- `src/apiClient`
- `src/lib/*`

`import type` from `src/domain/types` stays allowed.

External plugins (npm/path-loaded via `externalLoader`) only see `@tinstar/plugin-api`. The ESLint rule formalizes that built-in plugins must follow the same constraint, sans the typed widget data exception.

### What's NOT in this ADR

These are valid follow-ups but explicitly deferred:

- **Generic widget storage.** Plugins still register typed widgets via the host's per-type maps. Defer until external plugins need it.
- **Hotkey action declaration in manifest.** Each plugin handles one action (`'fit-viewport'`) today. Defer until > 3 actions per plugin.
- **Capability scoping / permissions.** Every plugin gets every API. Defer until untrusted plugins exist.

## Consequences

### Positive

- The plugin boundary becomes enforced, not aspirational.
- `docs/architecture.md` claim ("no first/second class tier") becomes true.
- Sibling projects (papershore, stretchplan) get a stable contract.
- Built-in plugins become extractable into their own packages without rewriting.
- Future API additions follow the existing pattern, no new design needed.

### Costs

- 4 plugins × ~30-line migrations = ~130 lines of mechanical refactor work.
- New API surface: ~150 lines + ~200 lines of tests.
- `useFileWatch` and `useImageWatch` wrappers need careful lifecycle preservation — regression risk for live file editing.
- ESLint rule adds friction for legitimate refactors that move host code (have to update the allowlist).

### Migration safety

- Each plugin migration is a single commit, revertible.
- API additions land before migrations — old plugin code keeps working until per-plugin migration.
- Manual smoke after the file-editor migration: open a file-editor widget, edit the watched file, verify content updates + connected dot.

## Implementation plan

See `docs/superpowers/plans/2026-05-23-plugin-api-boundary.md` (gitignored scratch). The plan is structured in four phases:

1. **Phase 1 — API surface.** Add the new methods to `@tinstar/plugin-api` and `createApi.ts`, with tests. No plugin changes yet.
2. **Phase 2 — Migrate built-in plugins.** One plugin per commit, replacing host imports with `api.*` calls.
3. **Phase 3 — Enforce the boundary.** ESLint rule + docs flip.
4. **Phase 4 — (Optional) Contract test.** Vitest unit that scans plugin source for forbidden imports.

Phase 3 lands the ADR's "boundary is enforced" promise. Phase 4 is belt-and-suspenders.
