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
- **Drag handle**: Thin 8px bar at top of widget, with centered 32px pill indicator
- **Resize handle**: 3x3px bottom-right corner, diagonal cyan gradient at 40% opacity
- **Drag threshold**: 5px (prevents accidental drags on click)
- **Zoom-aware deltas**: Mouse deltas divided by zoom for correct movement at any zoom level
- **Pointer capture**: setPointerCapture for reliable tracking outside the element

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
- Status colors:
  - active: green (#00ff88), pulsing glow
  - idle: amber (#ffaa00)
  - complete: cyan (#00f0ff)
  - failed: red (#ff3366)
  - queued: slate (#94a3b8)

### Left Panel — Touched Files
- File list with icons by kind (code, config, test, script, doc)
- Addition/deletion counters (green/red)
- Total additions/deletions in header
- Click to select a file (left border highlight)
- Collapsible — collapses to thin 6px vertical tab with rotated label
- Default selection: 3rd file if available

### Center Panel — Session (Recap / Raw Logs)
- **Recap tab**: Threaded messages
  - Agent messages: smart_toy icon, timestamps, inline diffs
  - User messages: person icon, right-aligned, bordered
  - Status messages: gradient divider with pulsing dot
- **Raw Logs tab**: Colored keywords (PASS=green, FAIL=red, bench:=amber)
- **Diff view**: Inline diffs with +/- coloring, filename header, chunk headers
- **Prompt input**: Bottom bar with ">_" prefix and send button
- Auto-scrolls to bottom on tab switch

### Right Panel — Procedures
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
- **Hover node**: Highlight background, reveal "+" add button
- **Click "+" button**: Add child of next type based on dimensions array (dynamic — e.g., if dimensions are `[initiative, task]`, initiative's child type is task) — logs to console, not wired
- **Root "+" button**: Adds a node of the first active dimension type

### Canvas → Sidebar Sync
- **Click a canvas widget**: Selects the corresponding run in the hierarchy and expands all ancestor nodes
- **Double-click a canvas widget**: Zoom-to-fit on that widget + select it in the hierarchy

### Visual Elements
- Expand/collapse chevrons: ▾ (expanded), ▸ (collapsed)
- Colored status dots on run nodes (2x2px, color matches run status)
- Run count badges on group nodes (bg-surface-raised, rounded-full)
- Selected node: primary/20 background, neon border, primary text
- Hovered node: surface-hover background
- Header: "Hierarchy" label with root-level "+" button

---

## Default Layout

- **3-phase recursive algorithm**:
  1. Bottom-up sizing: runs get 900×400, containers wrap children horizontally + padding
  2. Root grid packing: `ceil(sqrt(n))` columns, starting at (50, 50), 40px gap between roots
  3. Top-down absolutization: parent-relative → absolute canvas coordinates
- 3 initiative roots (from mock data), 14 runs across 10 tasks

---

## Persistence

- **Storage key**: `qala-uiv2-layouts-v3`
- **What's saved**: All widget and group container positions/sizes as JSON (keyed by tree node ID)
- **When saved**: On every layout change (via useEffect)
- **Load behavior**: Merge saved layouts with defaults for any missing entries
- **Dimension change detection**: If >20% of tree node IDs are missing from stored layouts, regenerate from scratch
- **Fallback**: Generate fresh default recursive layout on parse error

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

## Data Model

- **3 Initiatives**, **6 Epics**, **10 Tasks**, **4 Worktrees**, **14 Runs**
- Hierarchy: Initiative → Epic → Task → Run
- Each run has: touched files, recap entries, raw logs, procedures
- Run statuses: active, idle, complete, failed, queued
- Procedure statuses: idle, queued, running, complete, failed

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
| 4 | Resume (conversation ID) | `src/server/sessions/resume.ts` | **done** |
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

### Integration

| # | Feature | File | Status |
|---|---------|------|--------|
| 22 | Event bus types | `src/server/types.ts` | **done** |
| 23 | Server wiring + reconciliation loop | `src/server/index.ts` | **done** |
| 24 | CORS + DELETE method | `src/server/api/routes.ts` | **done** |

### Session Architecture

```
API Routes → Session CRUD → Backend (Docker | Tmux)
                          → Workspace (worktree creation)
                          → Resume (conversation ID detection)
                          → Config/Secrets (~/.config/tinstar/)
                          → SSE (state change events via EventBus)
```

### Session States
- **creating**: Initial setup
- **running**: Claude actively processing (hooks fire)
- **idle**: Claude finished, waiting (Stop hook fired)
- **needs_attention**: Stale >120s (likely waiting for user input)
- **stopped**: User stopped the session
- **terminated**: Backend process gone

### Config Directory Layout
```
~/.config/tinstar/
├── config.json          # Optional user overrides
├── projects.json        # Registered project name→path
├── .secrets/            # One file per env var
│   ├── CLAUDE_CODE_OAUTH_TOKEN
│   └── GH_TOKEN
└── sessions/
    └── <name>/
        ├── session.json # Session state
        └── claude-state/ # Claude conversation files
```
