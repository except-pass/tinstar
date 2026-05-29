# Constellations & capabilities

A constellation is a small cluster of widgets that move together on the canvas, share a numbered slot (1–9), and can discover and invoke each other through a lightweight capability system. For plugin authors, constellations are the primary composition primitive: the way your widget finds and talks to the session, file-editor, or other plugin widget it's been placed next to.

Capabilities are the RPC layer. A widget *publishes* a named capability with a handler; peers in the same constellation can *invoke* that capability by name. This keeps widgets decoupled — the invoking widget doesn't need to import or know the type of the publishing widget, only the capability name and its argument shape.

---

## Data flow: from proximity to cooperation

When a user drags one widget near another, the host renders a snap-zone halo. On drop inside a halo, both widgets join the same constellation slot (the next free slot from 1–9). From that moment on:

- Both widgets render a slot badge (`⌨ 3`) indicating membership.
- Dragging either widget moves both together.
- Pressing `3` on the keyboard fits the viewport to both widgets and sets the active constellation.
- Each widget's `usePeers()` hook re-renders with the other as a peer.
- Any capabilities the peer has published are visible in `peer.capabilities`.

If the user alt-drags a widget out of the halo, that widget pops free and leaves the constellation. The other members stay grouped. The capability registry updates immediately: the departed widget's capabilities vanish from its former peers' `usePeers()` results.

---

## The `api.constellations` surface

All `useX()` functions on `api.constellations` are React hooks. They must be called at component render top-level — the same rule as any hook. The closures they return (the actual `publish`, `invoke`, `fit`, etc. functions) are stable references and safe to call from event handlers, effects, and async callbacks.

### Reading this widget's membership

```tsx
const slot  = api.constellations.useMySlot()    // number | null
const slots = api.constellations.useMySlots()   // string[] — the raw slot keys, e.g. ['3']
const id    = api.constellations.useMyNodeId()  // full host node id, e.g. 'task-picker-abc'
```

`useMySlot()` returns the primary slot as a number (1–9) or `null` if the widget is not in any constellation.

### Discovering peers

```tsx
const peers = api.constellations.usePeers()
// returns: Array<{ id: string; kind: string; capabilities: string[] }>
```

Each peer has:
- `id` — the full host node id (use this as the first argument to `invoke`).
- `kind` — a coarse-grained widget kind derived from the id prefix (`run`, `file-editor`, `browser`, `image`, and so on, including any kind your own plugin introduces).
- `capabilities` — the names of capabilities the peer has currently published.

`usePeers()` re-renders whenever the constellation membership or capability registry changes. It returns `[]` when the widget is not in a constellation.

### Publishing a capability

```tsx
const publish = api.constellations.usePublishCapability()

useEffect(() => {
  return publish('my.capability', async (args) => {
    // args is whatever the invoker passed; cast to your expected shape
    const { value } = args as { value: string }
    return value.toUpperCase()
  }).dispose
}, [publish])
```

`publish` returns a `Disposable`. Return `.dispose` as the effect cleanup so the capability is removed when the widget unmounts or the effect re-runs with new deps.

**Naming convention:** `<domain>.<verb-or-noun>`, e.g. `session.prompt`, `file.path`, `task.select`. Keep names scoped and specific — they're strings, not namespaced at the registry level.

### Invoking a peer's capability

```tsx
const invoke = api.constellations.useInvokePeerCapability()

// later, inside an event handler or async function:
const result = await invoke(peerId, 'my.capability', { value: 'hello' })
```

`invoke` rejects if:
- The peer is not in the same constellation (it may have left after the last render).
- The peer hasn't published the named capability (or has unpublished it).

Always `await` inside a try/catch if the failure case matters to your UX.

### Action triggers

Each of these hooks returns a stable callback. Call the callback from anywhere — click handlers, keyboard handlers, effects.

```tsx
const fit    = api.constellations.useFitToMine()   // fit viewport to this constellation
const tidy   = api.constellations.useTidyMine()    // grid-arrange this constellation
const assign = api.constellations.useAssignToSlot() // assign(slot: number) — join slot 1-9
const leave  = api.constellations.useLeave()        // remove this widget from its constellation
```

All of these are no-ops when the widget is not in a constellation.

### Backward-compatible hooks

`useContext()` and `Badge` were the pre-V5 `api.hotgroups` surface. They're now on `api.constellations` with the same signatures:

```tsx
const { slotsForNode, nodesInSlot } = api.constellations.useContext()
// slotsForNode(nodeId): string[]  — which slots contain this node
// nodesInSlot(slot): string[]     — which nodes are in this slot
```

```tsx
<api.constellations.Badge
  slots={slots}
  testId="my-badge"
  onLeave={(slot) => leave()}
/>
```

`Badge` renders the `⌨ 3` chip. `onLeave` is optional — omitting it makes the badge display-only.

---

## Host-published capabilities

Two built-in widget types publish capabilities you can consume from any plugin widget in the same constellation:

| Host widget | Capability | Args | Returns | Notes |
|---|---|---|---|---|
| Run workspace | `session.prompt` | `{ text: string }` | `null` | Posts text to the underlying tmux session |
| File editor | `file.path` | none (`{}`) | `string` | The absolute file path being edited |

---

## Worked example: task picker + task detail

This example builds two cooperating plugin widgets: a **task picker** that lists work items and publishes `task.select`, and a **task detail** widget in the same constellation that shows details for whichever task is selected.

Neither widget imports the other. They talk through the capability.

### Task picker widget

```tsx
// src/plugins/stretchplan/src/TaskPickerWidget.tsx
import { useState, useEffect } from 'react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'

type Task = { id: string; title: string }

export function makeTaskPickerWidget(api: TinstarPluginAPI) {
  return function TaskPickerWidget({ data }: WidgetProps) {
    const [tasks, setTasks] = useState<Task[]>([])
    const [selectedId, setSelectedId] = useState<string | null>(null)

    const publish = api.constellations.usePublishCapability()
    const slot    = api.constellations.useMySlot()

    // Fetch tasks from the stretchplan API on mount
    useEffect(() => {
      api.http.fetch('/api/stretchplan/tasks')
        .then(r => r.json())
        .then((body: { tasks: Task[] }) => setTasks(body.tasks))
        .catch(err => api.logger.warn('failed to load tasks', err))
    }, [])

    // Publish task.select so peer widgets know which task is active.
    // We use a ref so the handler always reads the latest selectedId
    // without stale-closure issues (anti-pattern: don't capture setState).
    const selectedIdRef = { current: selectedId }
    selectedIdRef.current = selectedId

    useEffect(() => {
      return publish('task.select', async () => {
        return selectedIdRef.current
          ? tasks.find(t => t.id === selectedIdRef.current) ?? null
          : null
      }).dispose
    }, [publish, tasks])

    return (
      <div className="flex flex-col h-full overflow-hidden bg-surface-base">
        <div className="widget-drag-handle px-3 py-1.5 bg-surface-panel border-b border-white/10 text-xs text-slate-400">
          Tasks {slot !== null ? `· constellation ${slot}` : ''}
        </div>
        <ul className="flex-1 overflow-y-auto">
          {tasks.map(task => (
            <li
              key={task.id}
              onClick={() => setSelectedId(task.id)}
              className={`px-3 py-2 text-sm cursor-pointer border-b border-white/5
                ${task.id === selectedId ? 'bg-primary/20 text-white' : 'text-slate-300 hover:bg-white/5'}`}
            >
              {task.title}
            </li>
          ))}
          {tasks.length === 0 && (
            <li className="px-3 py-4 text-xs text-slate-500">No tasks found.</li>
          )}
        </ul>
      </div>
    )
  }
}
```

### Task detail widget

```tsx
// src/plugins/stretchplan/src/TaskDetailWidget.tsx
import { useState, useEffect, useRef } from 'react'
import type { TinstarPluginAPI, WidgetProps, ConstellationPeer } from '@tinstar/plugin-api'

type Task = { id: string; title: string }

export function makeTaskDetailWidget(api: TinstarPluginAPI) {
  return function TaskDetailWidget({ data }: WidgetProps) {
    const peers  = api.constellations.usePeers()
    const invoke = api.constellations.useInvokePeerCapability()

    const [task, setTask] = useState<Task | null>(null)
    const [error, setError] = useState<string | null>(null)

    // Find the peer that publishes task.select
    const pickerPeer: ConstellationPeer | undefined = peers.find(
      p => p.capabilities.includes('task.select'),
    )

    // Poll the picker peer for the currently selected task whenever peers change
    useEffect(() => {
      if (!pickerPeer) {
        setTask(null)
        return
      }

      let cancelled = false

      invoke(pickerPeer.id, 'task.select', {})
        .then(result => {
          if (!cancelled) setTask(result as Task | null)
          if (!cancelled) setError(null)
        })
        .catch(err => {
          if (!cancelled) setError(String(err))
        })

      return () => { cancelled = true }
    }, [pickerPeer?.id, pickerPeer?.capabilities.join(',')])

    if (!pickerPeer) {
      return (
        <div className="flex items-center justify-center h-full text-xs text-slate-500 px-4 text-center">
          Drop me next to a task picker to wire up.
        </div>
      )
    }

    return (
      <div className="flex flex-col h-full bg-surface-base overflow-hidden">
        <div className="widget-drag-handle px-3 py-1.5 bg-surface-panel border-b border-white/10 text-xs text-slate-400">
          Task detail
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <p className="text-xs text-red-400 mb-2">{error}</p>
          )}
          {task ? (
            <>
              <h2 className="text-sm font-semibold text-slate-200 mb-2">{task.title}</h2>
              <p className="text-xs text-slate-500">id: {task.id}</p>
            </>
          ) : (
            <p className="text-xs text-slate-500">Select a task in the picker.</p>
          )}
        </div>
      </div>
    )
  }
}
```

### Plugin entry

```tsx
// src/plugins/stretchplan/src/index.tsx
import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import { makeTaskPickerWidget }  from './TaskPickerWidget'
import { makeTaskDetailWidget }  from './TaskDetailWidget'

export function activate(api: TinstarPluginAPI) {
  api.logger.info('stretchplan plugin activating')
  return [
    api.widgets.register({
      type: 'stretchplan-task-picker',
      component: makeTaskPickerWidget(api),
      isContainer: false,
      defaultSize: { width: 280, height: 400 },
      minSize: { width: 200, height: 200 },
      dragHandleSelector: '.widget-drag-handle',
    }),
    api.widgets.register({
      type: 'stretchplan-task-detail',
      component: makeTaskDetailWidget(api),
      isContainer: false,
      defaultSize: { width: 340, height: 300 },
      minSize: { width: 240, height: 180 },
      dragHandleSelector: '.widget-drag-handle',
    }),
  ]
}
```

**What the user sees:**

1. Drop a task-picker and a task-detail widget onto the canvas near each other. The snap-zone halo appears; on release both join the same constellation.
2. The task-detail widget immediately exits its "drop me next to a picker" empty state because `usePeers()` now returns the picker.
3. Click any task row in the picker — the detail widget reflects the selection.
4. Press the constellation's digit key to fit the viewport to both widgets together.

---

## Capability lifecycle

Capabilities are in-memory only. There is no persistence layer.

- Published on widget mount (inside `useEffect`).
- Unpublished on widget unmount (the `dispose` cleanup).
- Re-published whenever the effect's deps change (e.g. the file path changes, the task list refreshes).

If a widget re-mounts after a hot-module replacement or a route transition, it re-publishes its capabilities. Peer widgets that are still mounted see the updated capability list without reloading.

---

## Capability naming conventions

Use the pattern `<domain>.<verb-or-noun>`:

- `session.prompt` — post text to a tmux session
- `file.path` — expose the current file path
- `task.select` — expose the currently selected task
- `image.url` — expose a generated image URL

Keep names specific enough to be unambiguous within a constellation. You don't need global uniqueness — names are scoped to peer-to-peer invocations.

---

## Failure modes

### Peer left the constellation between render and invoke

```
Error: peer "task-picker-abc" is not in the same constellation
```

This happens when the picker widget is alt-dragged out or the user dissolves the constellation between the last render of the detail widget and the `invoke` call. Catch and surface a user-friendly message or fall back to the empty state.

### Peer never published the capability

```
Error: capability not published: task-picker-abc/task.select
```

This can happen if the peer widget is still mounting (its `useEffect` hasn't run yet), if the effect errored, or if the peer called `dispose` early. In practice, peers show as having published capabilities in `usePeers()` before you'd normally invoke — but race conditions on first mount are possible. A short debounce or a "retry on error" pattern handles the transient case.

### Cross-constellation invocation

A widget cannot invoke capabilities of widgets in other constellations — the registry hard-rejects cross-constellation calls. There is intentionally no global peer discovery. If you need two constellations to cooperate, the host has no built-in mechanism for that; route through the server (`api.http`) instead.

---

## Anti-patterns

### Capturing `setState` inside a capability handler

```tsx
// WRONG — captures setState from a component that may have unmounted
useEffect(() => {
  return publish('my.capability', async () => {
    setResult('called') // React 18 will warn: state update on unmounted component
    return 'ok'
  }).dispose
}, [publish])
```

Use a ref to hold values the handler needs to read, and avoid calling `setState` from inside a capability handler:

```tsx
// RIGHT — handler reads from a ref, not captured setState
const latestRef = useRef(latestValue)
latestRef.current = latestValue

useEffect(() => {
  return publish('my.capability', async () => latestRef.current).dispose
}, [publish])
```

### Calling `usePublishCapability()` or `usePeers()` outside render

These are React hooks. They must be called unconditionally at the top level of your component function. Calling them inside an event handler, an effect, or a conditional will throw "invalid hook call". The closures they return — `publish(...)`, `invoke(...)` — are what you call from outside render.

### Keeping a stale peer reference across re-renders

`usePeers()` returns a new array on every re-render that involves membership or capability changes. Don't store the result in a `useRef` across renders — always read it from state or the hook return. Storing a stale peer id and invoking it is safe (the registry validates membership at invoke time), but you'll get a rejection if the peer has left.

---

## References

- Public types: [`packages/plugin-api/src/index.ts`](../../packages/plugin-api/src/index.ts)
- npm package README: [`packages/plugin-api/README.md`](../../packages/plugin-api/README.md)
- Plugin system overview: [`docs/plugins/README.md`](README.md)
- External plugin quickstart: [`docs/plugins/external-quickstart.md`](external-quickstart.md)
- Capability registry (host-internal): `src/core/constellationCapabilities.ts`
- Real usage — file editor publishes `file.path`: `src/plugins/file-editor/src/FileEditorWidget.tsx`
- Real usage — run workspace publishes `session.prompt`: `src/components/RunWorkspaceWidget/index.tsx`
