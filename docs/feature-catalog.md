# Tinstar Feature Catalog

Complete inventory of every feature and behavior in the Tinstar canvas workspace.

---

## Layout & Structure

- **WorkspaceShell**: Full-screen flex-col layout — top controls bar, then sidebar (240px) + canvas (flex-1)
- **Controls bar**: Top bar with GroupingControls (left) and run count status (right)
- **SelectionProvider**: Global React context for selection, hover, and expand/collapse state

---

## Infinite Canvas

### Pan & Zoom (Figma-style)
- **Scroll / two-finger swipe**: Pan the canvas
- **Ctrl+scroll / pinch**: Zoom in/out (10% – 400%), zooms toward cursor position
- **Space + drag**: Pan the canvas (cursor changes to grab/grabbing)
- **Middle-click + drag**: Alternative pan method
- **Alt+Z**: Reset zoom to 100% (keeps viewport center stable)
- **Zoom indicator**: Bottom-right overlay showing current zoom percentage
- **Dot grid background**: Cyan radial dots at 4% opacity, 24px spacing (scales with zoom)

### Camera Constants
- Min zoom: 0.1 (10%)
- Max zoom: 4.0 (400%)
- Zoom sensitivity: 0.003 per wheel delta
- Zoom-to-fit padding: 40px

---

## Grouping Controls

Draggable dimension pills that control the tree nesting hierarchy for both the sidebar and canvas.

### Behavior
- **Active pills**: Cyan pills showing current dimensions (e.g., Initiative, Epic, Task)
- **Remove dimension**: Click "×" on a pill to remove that nesting level (min 1 required — last pill has no × button)
- **Add dimension**: Click ghost "+ Dimension" button to add a nesting level (max 4)
- **Drag-to-reorder**: Pointer-based drag on pills swaps order when crossing neighbor midpoint
- **Default dimensions**: `['initiative', 'epic', 'task']`
- **Tree restructure**: Changing dimensions immediately restructures both sidebar and canvas

### Visual
- Active pills: `bg-primary/20 text-primary border-primary/40`, rounded-full
- Inactive buttons: `bg-surface-raised text-slate-500 border-white/10`, rounded-full
- Dragging pill: opacity-70, cursor-grabbing

---

## Group Containers (N-Level Nesting)

Group containers are recursive nesting boxes driven by the active grouping dimensions. Each dimension creates one level of containers. Runs are always leaf nodes at the deepest level.

### Behavior
- **Auto-expand**: Container grows automatically when a child is dragged or resized outside its bounds
- **Cascade expansion**: Auto-expand propagates up the entire ancestor chain (child → parent → grandparent)
- **Min-size enforcement**: User can resize a container larger, but never smaller than the bounding box of its children + padding
- **Shrink to fit**: Double-click a container to snap it to its minimum size (recursive bottom-up shrink)
- **Group drag**: Dragging a container header moves it and all descendants (children, grandchildren, etc.) by the same delta

### Entity Context Menu (⋮ Kebab)
- **Trigger**: Hover-revealed ⋮ button on sidebar nodes and canvas group container headers
- **Menu items**: Start Session (blue), Settings..., Rename, Add Child, Delete (red with inline confirmation)
- **Delete confirmation**: First click shows "Delete {name}? Children will be ungrouped." with Delete/Cancel buttons
- **Worktree nodes**: Hide "Start Session" and "Settings..." items (not applicable)
- **Positioning**: Fixed position below the anchor button, aligned left
- **Close behavior**: Click-outside or Escape key
- **Replaces**: Individual ✏/+/× buttons on sidebar and canvas (backward-compatible fallback when `onMenuOpen` not provided)

### Entity Settings & Inheritance
- **Dialog**: Modal opened via "Settings..." in entity context menu
- **Inheritance chain**: Task > Epic > Initiative (closest-ancestor-wins)
- **Settings**: Project, Backend (docker/tmux), Worktree (none/new/existing), Skip Permissions, Profile
- **Visual language**:
  - **Cyan**: Local override (set on this entity)
  - **Amber pill**: Inherited from ancestor (shows source entity name)
  - **Gray italic**: Not set at any level
- **Opt-in overrides**: Checkbox to enable local override, then value controls appear
- **Immediate save**: Every change PATCHes immediately (no save button)
- **Deep merge**: PATCH requests merge `settings` sub-object; `null` values clear overrides
- **API**: `GET /api/{initiatives|epics|tasks}/:id/settings` returns `{ resolved, sources, local }`
- **Prefill**: "Start Session" from context menu fetches resolved settings and pre-fills CreateSessionDialog

### Entity Deletion
- **Canvas**: Via context menu → Delete with confirmation
- **Sidebar**: Via context menu → Delete with confirmation
- **API**: `DELETE /api/{initiatives|epics|tasks|worktrees}/:id` — removes the entity from DocumentStore
- **Orphan behavior**: Children of deleted entities become orphans — they appear under the "Ungrouped" separator in the sidebar and float to root level on the canvas
- **No cascade**: Only the targeted entity is deleted; children, grandchildren, and runs are preserved

### Depth-Based Visual Styling
- Type icons: 🚀 initiative, 📦 epic, ✅ task, 🌿 worktree
- Border opacity by depth: `[0.15, 0.12, 0.08, 0.05]`
- Background opacity by depth: `[0.02, 0.015, 0.01, 0.005]`
- Header: 32px tall, type icon + label in uppercase primary/50 text
- Depth 0: rounded-lg; deeper: rounded-md
- Resize handle: 4x4px bottom-right corner, diagonal gradient

### Container Padding
- Horizontal (left/right): 30px
- Top: 50px at depth 0, 40px at deeper levels
- Bottom: 30px
- Gap between sibling containers: 40px
- Gap between sibling runs: 20px

---

## Canvas Widgets (Runs)

Each run is rendered as a CanvasWidget containing a full RunWorkspaceWidget.

### Drag & Resize
- **Drag handle**: Entire header bar is the drag handle (cursor-grab / cursor-grabbing)
- **Resize handle**: 3x3px bottom-right corner, diagonal cyan gradient at 40% opacity
- **Drag threshold**: 5px (prevents accidental drags on click)
- **Zoom-aware deltas**: Mouse deltas divided by zoom for correct movement at any zoom level
- **Pointer capture**: setPointerCapture for reliable tracking outside the element

### Drag-to-Reassign
- **Drag a widget over a group container**: Container highlights with cyan border (2px), brighter background, and glow box-shadow
- **Drop**: Opens a `ReassignDialog` confirmation modal showing run ID, target type, and target label
- **Confirm ("Move")**: PATCHes `run.taskId` via `PATCH /api/runs/:id`, repositions widget inside target container, auto-resizes target container to fit
- **Parent filtering**: Drop targets exclude the run's current parent container (no-op reassignment prevented via `buildParentMap()`)
- **Hit testing**: Canvas-level pointer coords converted via `clientToCanvas()`, tested against all group container bounds, deepest match wins
- **150ms transitions** on highlight border/background/box-shadow

### Sizing Defaults
- Default: 900 x 400 px
- Minimum: 300 x 150 px

### Visual
- Neon border (cyan glow)
- bg-surface-base background

---

## RunWorkspaceWidget (Inside Each Canvas Widget)

3-panel layout inside each run widget.

### Header (RunWorkspaceHeader)
- Terminal icon in bordered box
- Run ID (uppercase, neon text)
- Status badge with animated dot (pulses for active status)
- Breadcrumb: Initiative > Epic > Task
- Right side: Worktree and Repo metadata
- Status colors (SSOT: `SessionStatus` in `src/types.ts`):
  - creating: blue (#818cf8), pulsing glow
  - running: green (#00ff88), pulsing glow
  - idle: amber (#ffaa00)
  - needs_attention: orange (#f97316), pulsing glow
  - stopped: slate (#94a3b8)
  - terminated: red (#ff3366)

### Left Panel — Touched Files
- File list with icons by kind (code, config, test, script, doc)
- Addition/deletion counters (green/red) — only reconciled files count toward totals
- Total additions/deletions in header
- Click to select a file (left border highlight)
- Collapsible — collapses to thin 6px vertical tab with rotated label
- Default selection: 3rd file if available
- **Optimistic updates**: Files appear instantly via PostToolUse hook with shimmer animation on stats
- **Reconciliation**: Git diff resolves real +/- stats after 2s of hook silence; shimmer stops and stats fade in
- **Shimmer**: 1.5s ease-in-out pulse animation on pending file stats

### Center Panel — Session (Recap / Raw Logs / Terminal)
- **Terminal**: Embedded ttyd iframe showing the live Claude Code session via Caddy proxy (`/s/{sessionId}/`)
- **Recap tab**: Threaded messages populated from Claude Code's conversation transcript
  - Agent messages: smart_toy icon, timestamps, inline diffs
  - User messages: person icon, right-aligned, bordered
  - Status messages: gradient divider with pulsing dot
  - **Transcript parsing**: On Stop hook, reads JSONL transcript from `~/.claude/projects/{encoded-workdir}/{conversationId}.jsonl`, extracts user prompts and agent text blocks, skips tool_use/thinking/progress entries
  - **Incremental**: Tracks last-read offset per session; only parses new entries each time
  - **Zero token cost**: Reads existing transcript files, no API calls
- **Raw Logs tab**: Colored keywords (PASS=green, FAIL=red, bench:=amber)
- **Diff view**: Inline diffs with +/- coloring, filename header, chunk headers
- Auto-scrolls to bottom on tab switch

### Right Panel — Procedures (collapsed by default)
- Procedure cards with status-dependent display:
  - idle: play button
  - queued: spinning hourglass, "In Queue..." label
  - running: stop button, "Running..." label, amber highlight
  - complete: check button, "Done" label, green highlight
  - failed: close button, "Failed" label, red highlight
- Procedure name in uppercase neon text when active
- "New_Procedure" button (dashed border) at bottom
- Collapsible — collapses to thin 6px vertical tab with rotated label

---

## Hierarchy Sidebar

### Tree Display
- Hierarchical: Initiative → Epic → Task → Run
- Depth-based indentation: 16px per level
- Node icons: 🚀 initiative, 📦 epic, ✅ task, 🌿 worktree, ▶ run

### Interactions
- **Click node**: Select it; toggle expand/collapse if it has children
- **Double-click run node**: Center canvas viewport on that run (zoom-to-fit)
- **Hover node**: Highlight background, reveal ⋮ kebab menu button
- **Kebab menu (⋮)**: Context menu with Start Session, Settings, Rename, Add Child, Delete
- **Root "+" button**: Adds a node of the first active dimension type

### Drag-and-Drop Reordering
- **Drag start**: Click-hold + 4px movement on a non-run node starts drag
- **Floating drag card**: Shows entity icon + label at cursor position (opacity 0.85)
- **Drop targets**: Insert before/after (cyan line indicator) or nest inside (ring highlight)
- **Nest detection**: Cursor shifted right of indent zone or hovering center of row
- **Auto-expand**: Hovering over collapsed group for 500ms expands it
- **Edge scrolling**: Approaching top/bottom of panel auto-scrolls
- **Constraints**: Cannot drop into self or descendants
- **Reparent**: Drop triggers PATCH to update parent FK (e.g. epic.initiativeId, task.epicId)

### Canvas → Sidebar Sync
- **Click a canvas widget**: Selects the corresponding run in the hierarchy and expands all ancestor nodes
- **Double-click a canvas widget**: Zoom-to-fit on that widget + select it in the hierarchy

### Visual Elements
- Expand/collapse chevrons: ▾ (expanded), ▸ (collapsed)
- Colored status dots on run nodes (2x2px, color matches run status)
- Run count badges on group nodes (bg-surface-raised, rounded-full)
- Selected node: primary/20 background, neon border, primary text
- Hovered node: surface-hover background
- Header: Space switcher dropdown with root-level "+" button

### Keyboard Reordering
- **Cmd/Ctrl + Up**: Move item up within its level
- **Cmd/Ctrl + Down**: Move item down within its level
- **Tab**: Indent (nest inside previous sibling)
- **Shift + Tab**: Outdent (move to parent's level)

---

## Spaces

Named containers that isolate document store data (initiatives, epics, tasks, worktrees, runs). Users maintain separate working contexts — e.g., real project work vs. test data — without losing state when switching.

### Data Model
- **Space entity**: `id`, `name`, `createdAt` — flat, no nesting or hierarchy
- **Entity association**: Every entity gets a `spaceId` field linking it to a space
- **Sessions are global**: Sessions have no `spaceId`. Runs (which do have a `spaceId`) link sessions to spaces
- **Active space**: Server tracks `activeSpaceId` in memory, persisted to `~/.config/tinstar/config.json`
- **First boot**: Auto-creates "Work Space" and activates it — zero-setup landing

### API

```
GET    /api/spaces              # List all spaces
POST   /api/spaces              # Create { name } → returns created space (does NOT auto-activate)
PATCH  /api/spaces/:id          # Update { name }
DELETE /api/spaces/:id          # Delete (rules below)
POST   /api/spaces/:id/activate # Set as active space
```

**Deletion rules:**
- Cannot delete the active space → 400 ("Switch to another space first")
- Cannot delete the last space → 400 ("Must have at least one space")
- On delete: all entities with that `spaceId` are removed; runs removed but sessions keep running
- Response includes orphaned session count + management hint

**Entity creation:** API stamps `spaceId: activeSpaceId` automatically on all new entities.

### SSE Behavior
- **Snapshot**: Includes `activeSpaceId` + all spaces (unfiltered for dropdown) + entities filtered to active space
- **Deltas**: Entity deltas for non-active spaces are suppressed; space CRUD deltas always sent
- **Activation**: Triggers a fresh full snapshot (same as initial connection) — frontend replaces entire state

### Widget Layouts (Per-Space)
- localStorage key namespaced: `tinstar-layouts-v3-{spaceId}`
- Switching spaces restores exact widget positions for that space
- `tinstar-dimensions` remains global (grouping preferences apply across spaces)

### Space Switcher (UI)
- **Location**: Replaces "Hierarchy" label in sidebar header
- **Trigger**: Dropdown showing active space name with expand/collapse chevron
- **Popover**: Lists all spaces with cyan dot for active (+ checkmark), slate dot for inactive
- **"+ New Space"**: Inline text input at bottom of list; Enter to create, Escape to cancel
- **Right-click**: Context menu with Rename and Delete
- **Delete confirmation**: Shows orphaned session count before proceeding

### Simulator Integration
- `TINSTAR_FAST_SIM=1`: Creates/reuses `_simulator` space, activates it, clears entities, populates mock data
- E2E tests create a `_tinstar_e2e` space in `globalSetup`, tear it down in `globalTeardown`

---

## Default Layout

- **3-phase recursive algorithm**:
  1. Bottom-up sizing: runs get 900×400, containers wrap children horizontally + padding
  2. Root grid packing: `ceil(sqrt(n))` columns, starting at (50, 50), 40px gap between roots
  3. Top-down absolutization: parent-relative → absolute canvas coordinates
- 3 initiative roots (from mock data), 14 runs across 10 tasks

---

## Persistence

### Client-side (localStorage)
- **Layout storage key**: `tinstar-layouts-v3-{spaceId}` (per-space)
- **What's saved**: All widget and group container positions/sizes as JSON (keyed by tree node ID)
- **When saved**: On every layout change (via useEffect)
- **Load behavior**: Merge saved layouts with defaults for any missing entries
- **Dimension change detection**: If >20% of tree node IDs are missing from stored layouts, regenerate from scratch
- **Fallback**: Generate fresh default recursive layout on parse error
- **Dimension persistence key**: `tinstar-dimensions` — active grouping dimensions saved/restored across reloads

### Server-side (file-backed DocumentStore)
- **Storage file**: `~/.config/tinstar/docstore.json`
- **What's saved**: Full snapshot of all entities (initiatives, epics, tasks, worktrees) and runs
- **When saved**: Debounced 500ms after any change
- **Load behavior**: Restored on server startup via `enablePersistence()`
- **Rehydration fallback**: Sessions on disk without a run entry get one created from `session.json`
- **Survives**: Browser refresh, server restart, Vite HMR

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Space (hold) | Enable pan mode (grab cursor) |
| Space (release) | Disable pan mode |
| Scroll / two-finger swipe | Pan the canvas |
| Ctrl+scroll / pinch | Zoom in/out toward cursor |
| Alt+Z | Reset zoom to 100% |

---

## Dialogs

### CreateSessionDialog
- Modal for creating new Claude Code sessions
- **Backend selection**: Docker or Tmux toggle
- **Project picker**: Dropdown of registered projects (from `GET /api/projects`)
- **Worktree mode**: None / New / Existing — "New" creates a fresh git worktree, "Existing" lets you pick one
- **Initial prompt**: Optional text sent to Claude on session start
- **Task assignment**: Optional dropdown to assign session to a task
- **One-shot mode** (Docker only): Single-prompt execution, session auto-closes on completion
- **Skip permissions**: Toggle to pass `--dangerously-skip-permissions` to Claude
- **Submit**: `Ctrl/Cmd+Enter` keyboard shortcut

### CreateEntityDialog
- Generic modal for creating initiatives, epics, tasks, and worktrees
- Parent relationship selection based on entity type

### ReassignDialog
- Confirmation modal for drag-to-reassign operations
- Shows run ID, target entity type, and target name
- "Move" to confirm, "Cancel" to abort

### SettingsDialog
- Project management: view, add, and remove registered projects
- Each project shows name and path

---

## Real-Time Data (SSE)

### Server-Sent Events (`/api/events`)
- **Snapshot on connect**: Full state (initiatives, epics, tasks, worktrees, runs) sent immediately when client connects
- **Delta updates**: Incremental changes broadcast as `{ eventType, entity, id, data }` — supports create, update, and delete (data=null)
- **Heartbeat**: Every 15 seconds to keep connection alive
- **Client reconnection**: Browser EventSource auto-reconnects; gets fresh snapshot on reconnect

### Event Bus (`src/server/event-bus.ts`)
- Node.js EventEmitter wrapper with typed events
- Event types: `session.*`, `taxonomy.sync`, `run.*`, `otel.*`, `managed_session.*`
- Wildcard listener support

---

## Simulator (Dev/Test Mode)

- **Activation**: `TINSTAR_FAST_SIM=1` env var
- **Behavior**: Emits all mock events synchronously at startup (speedMultiplier=0)
- **Mock data**: 3 initiatives, 6 epics, 10 tasks, 4 worktrees, 14 runs with staggered creation times
- **Content**: Files, procedures, and recap entries trickle in with realistic timing offsets
- **API controls**: `POST /api/simulator/start` (manual start), `POST /api/simulator/reset` (clear and reset)
- **Persistence interaction**: When `TINSTAR_FAST_SIM=1`, clears persisted store before running to ensure clean mock state

---

## Observability (OTel)

- **Span storage**: `POST` spans via event bus → OTelStore
- **Query endpoints**: `GET /api/otel/spans` (optional `?traceId=`), `GET /api/otel/metrics` (optional `?name=`)
- **Processor**: `OTelProcessor` listens for `otel.*` events and stores in `OTelStore`

---

## Entity CRUD API

### Creation Routes
| Route | Method | Description |
|-------|--------|-------------|
| `/api/initiatives` | POST | Create initiative (name, color) |
| `/api/epics` | POST | Create epic (name, initiativeId) |
| `/api/tasks` | POST | Create task (name, epicId, initiativeId) |
| `/api/worktrees` | POST | Create worktree (name) |

### State Endpoint
| Route | Method | Description |
|-------|--------|-------------|
| `/api/state` | GET | Full document store snapshot |

---

## Data Model

- **Hierarchy**: Initiative → Epic → Task → Run
- Each run has: touched files, recap entries, raw logs, procedures
- **SessionStatus (SSOT)**: `'creating' | 'running' | 'idle' | 'needs_attention' | 'stopped' | 'terminated'` — single type in `src/types.ts`, aliased as `RunStatus` and `SessionState`
- Procedure statuses: idle, queued, running, complete, failed
- **Run ↔ Task resolution**: `run.taskId` → task → `task.epicId` → epic → `task.initiativeId` → initiative (resolved by `TaxonomyRepository.resolveDimension`)

---

## Design System

### Colors
- Primary: cyan (#00f0ff)
- Accent green: #00ff88
- Accent red: #ff3366
- Accent amber: #ffaa00
- Surface base/panel/hover/raised: dark grays

### Typography
- Font display: Chakra Petch (headers, labels)
- Font mono: JetBrains Mono (code, data, logs)
- Sizes: text-2xs (10px), text-xs (12px), text-sm (14px)

### Effects
- Neon border: cyan glow with box-shadow
- Neon text: text-shadow glow
- Pulsing dots: CSS animation on active status indicators
- Scrollbar-thin: Custom thin scrollbar styling

### Icons
- Material Symbols Outlined (Google Fonts)
- Used throughout: terminal, smart_toy, person, code, data_object, science, difference, chevron_left/right, play_arrow, stop, hourglass_empty, check, close, arrow_forward, add

---

## Session Management

### Core Modules

| # | Feature | File | Status |
|---|---------|------|--------|
| 1 | Config loading + secrets | `src/server/sessions/config.ts` | **done** |
| 2 | Session CRUD + persistence | `src/server/sessions/session.ts` | **done** |
| 3 | Workspace + project registry | `src/server/sessions/workspace.ts` | **done** |
| 4 | Resume (deterministic session IDs) | `src/server/sessions/session.ts` + backends | **done** |
| 5 | Docker backend | `src/server/sessions/backends/docker.ts` | **done** |
| 6 | Tmux backend | `src/server/sessions/backends/tmux.ts` | **done** |
| 7 | Reconciliation | `src/server/sessions/reconcile.ts` | **done** |
| 8 | Shell scripts | `src/server/sessions/scripts/` | **done** |
| 9 | Barrel export | `src/server/sessions/index.ts` | **done** |

### API Routes (in `src/server/api/routes.ts`)

| # | Route | Method | Status |
|---|-------|--------|--------|
| 10 | `/api/sessions` | GET | **done** |
| 11 | `/api/sessions/:name` | GET | **done** |
| 12 | `/api/sessions` | POST | **done** |
| 13 | `/api/sessions/:name/start` | POST | **done** |
| 14 | `/api/sessions/:name/stop` | POST | **done** |
| 15 | `/api/sessions/:name` | DELETE | **done** |
| 16 | `/api/hooks/idle` | POST | **done** |
| 17 | `/api/hooks/active` | POST | **done** |
| 18 | `/api/projects` | GET | **done** |
| 19 | `/api/projects` | POST | **done** |
| 20 | `/api/projects/:name/worktrees` | GET | **done** |
| 21 | `/api/projects/:name` | DELETE | **done** |
| 22b | `/api/runs/:id` | PATCH | **done** |
| 25 | `/api/initiatives/:id` | DELETE | **done** |
| 26 | `/api/epics/:id` | DELETE | **done** |
| 27 | `/api/tasks/:id` | DELETE | **done** |
| 28 | `/api/worktrees/:id` | DELETE | **done** |
| 29 | `/api/initiatives/:id` | PATCH | **done** |
| 30 | `/api/epics/:id` | PATCH | **done** |
| 31 | `/api/tasks/:id` | PATCH | **done** |
| 32 | `/api/worktrees/:id` | PATCH | **done** |
| 33a | `/api/initiatives/:id/settings` | GET | **done** |
| 33b | `/api/epics/:id/settings` | GET | **done** |
| 33c | `/api/tasks/:id/settings` | GET | **done** |
| 34 | `/api/hooks/file-touched` | POST | **done** |

### Integration

| # | Feature | File | Status |
|---|---------|------|--------|
| 22 | Event bus types | `src/server/types.ts` | **done** |
| 23 | Server wiring + reconciliation loop | `src/server/index.ts` | **done** |
| 24 | CORS + DELETE + PATCH methods | `src/server/api/routes.ts` | **done** |
| 33 | Orphan handling in grouping tree | `src/domain/grouping.ts` | **done** |
| 34 | Dimension persistence (localStorage) | `src/components/WorkspaceShell.tsx` | **done** |
| 35 | Inline rename (pencil icon) | `src/components/HierarchySidebar.tsx` | **done** |

### Session Architecture

```
API Routes → Session CRUD → Backend (Docker | Tmux)
                          → Workspace (worktree creation)
                          → Deterministic Session IDs (UUID on create, --resume on restart)
                          → Config/Secrets (~/.config/tinstar/)
                          → SSE (state change events via EventBus)
                          → Caddy route management (add on create + resume)
```

### Session States
- **creating**: Initial setup
- **running**: Claude actively processing (hooks fire)
- **idle**: Claude finished, waiting (Stop hook fired)
- **needs_attention**: Stale >120s (likely waiting for user input)
- **stopped**: User stopped the session
- **terminated**: Backend process gone (tmux session missing or Docker container missing)

### Deterministic Session IDs
- **On create**: `randomUUID()` generated and stored in `session.conversation.id`
- **First launch (tmux)**: `claude --session-id <uuid>` — dictates the Claude session ID
- **First launch (Docker)**: `SESSION_ID` env var → `claude --session-id <uuid>` (in `start-ttyd.sh`)
- **Resume (tmux)**: `claude --resume <uuid>` — resumes previous conversation
- **Resume (Docker)**: `RESUME_SESSION_ID` env var → `claude --resume <uuid>` (in `start-ttyd.sh`)
- **Missing ID guard**: Sessions created before this feature have `conversation.id: null` — resume returns `NO_SESSION_ID` error with instructions to delete and recreate
- **Orphaned ttyd cleanup**: On start, `lsof -ti :<port>` kills any stale ttyd process holding the port (survives server restarts)

### Resume & Delete (Terminated Sessions)
- **UI**: Terminated/stopped sessions show Resume and Delete button overlay in the session panel
- **Resume flow**: Validates workspace directory still exists, finds a port, creates new tmux/Docker session with `--resume <uuid>`, adds Caddy route, syncs port on run
- **Delete flow**: Kills tmux/Docker backend, removes session files, deletes the run from DocumentStore (widget disappears via SSE)

### Backend: Tmux (local)
- **Create**: `tmux new -d -s <prefix><name>`, configure status off + mouse on, inject env vars, send `claude --session-id <uuid>` command
- **Resume**: If tmux session exists, send `claude --resume <uuid>` via `send-keys`; if missing, recreate tmux session then send `claude --resume <uuid>`
- **Stop**: `tmux kill-session -t <name>`, release port, stop managed ttyd
- **ttyd**: Managed child process per session with auto-restart on unexpected exit, orphan cleanup via `lsof`
- **Port allocation**: Sequential scan from `ports.hostStart` (default 8681), claimed ports tracked in-memory

### Backend: Docker (containerized)
- **Create**: `docker run -d` with volume mounts (workspace, worktree .git, claude-state), then `docker exec -d` to launch `start-ttyd.sh` with `SESSION_ID` env var
- **Resume**: `docker start` (if stopped) or `docker run` (if missing), then `docker exec -d` with `RESUME_SESSION_ID` env var
- **Stop**: `docker stop -t 5 <name>`
- **Delete**: `docker rm -f <name>`
- **Shell script (`start-ttyd.sh`)**: Creates tmux session inside container, builds claude command from env vars (`SESSION_ID` → `--session-id`, `RESUME_SESSION_ID` → `--resume`), starts ttyd on port 7681
- **Volume mounts**: Workspace path, worktree base .git, claude-state dir for conversation persistence
- **One-shot mode**: `docker run --rm` with `-p` prompt flag, watcher process monitors exit

### Caddy Reverse Proxy
- **Purpose**: Consolidate dynamic ttyd ports behind a single port for terminal iframe access
- **Routing**: `/s/{name}/` → `localhost:{port}/` per session
- **Ports**: Caddy listens on 8088 (default), admin API on 2019
- **Vite proxy**: `/s/*` proxied to Caddy so only port 5273 needs forwarding
- **Lifecycle**: Started on server init (`ensureCaddy`), routes synced for surviving sessions, added/removed on session create/delete
- **Implementation**: `src/server/sessions/caddy.ts`

### Hook Architecture (Status Bridge)
- **Purpose**: Real-time session status updates without polling
- **Mechanism**: Claude Code hooks installed per workspace (`.claude/settings.json`)
- **Scoping**: `$TINSTAR_SESSION_NAME` env var injected per tmux session — hooks only fire for managed sessions
- **Pattern**: `if [ -n "$TINSTAR_SESSION_NAME" ]; then curl ...; fi` — always exits 0 to avoid hook errors
- **Hooks**:
  - `PreToolUse` → `POST /api/hooks/active` → sets status to `'running'`
  - `UserPromptSubmit` → `POST /api/hooks/active` → sets status to `'running'`
  - `Stop` → `POST /api/hooks/idle` → sets status to `'idle'`, triggers transcript parsing for recap entries
  - `PostToolUse` (Write|Edit) → `POST /api/hooks/file-touched` → adds file to touchedFiles with `pending: true`
- **Bridge**: Hook endpoints call both `setState()` (disk) and `docStore.updateRunStatus()` (in-memory + SSE)
- **Initial status**: New sessions start as `'creating'`, hooks transition to `'running'`/`'idle'`

### Config Directory Layout
```
~/.config/tinstar/
├── config.json          # Optional user overrides
├── projects.json        # Registered project name→path
├── docstore.json        # Persisted entities + runs (auto-saved)
├── .secrets/            # One file per env var
│   ├── CLAUDE_CODE_OAUTH_TOKEN
│   └── GH_TOKEN
└── sessions/
    └── <name>/
        ├── session.json # Session state (includes conversation.id UUID)
        └── claude-state/ # Claude conversation files (Docker volume mount)
```
