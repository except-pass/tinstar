# Context Treemap Telemetry Panel

**Date:** 2026-04-11
**Status:** Approved

## Overview

Add a telemetry section to the right panel of the RunWorkspaceWidget, below the existing Procedures panel. The first telemetry widget is a treemap visualizing Claude Code context window usage — showing how much of the 200K token context is consumed by messages, tools, skills, memory files, etc.

Data is sourced by spawning a sidecar Claude Code process that forks the running session's conversation and queries its `get_context_usage` control endpoint.

## Panel Layout

The right panel (currently just `ProceduresPanel` at `w-40` / 160px) splits into two sections:

- **Top:** Procedures (existing, unchanged)
- **Bottom:** Telemetry (new)
- **Divider:** Draggable horizontal resize handle between them, defaulting to 50/50 split
- The divider follows the same pointer-drag pattern used by the files panel width resizer (`resizeDragRef` in `index.tsx`)
- The outer collapse toggle (thin "Procs" bar) still hides the entire right panel as it does today

### Divider behavior
- `onPointerDown` on the divider captures start Y and starting heights
- `onPointerMove` on `document` adjusts the two flex basis values
- `onPointerUp` clears the drag ref
- Minimum height for either section: 60px
- Drag handle styled as a 4px horizontal bar with a centered grip indicator, `cursor: row-resize`

## Telemetry Section

### Header
Standard `.panel-header` / `.panel-label` with text "TELEMETRY", matching the Procedures header.

### States

**Empty (no data loaded):**
A centered "Load Context" button — dashed border style matching the "Add / Remove" button in Procedures. Material icon `query_stats`.

**Loading (~14 seconds):**
The treemap area shows a pulsing shimmer animation (similar to the `PendingRow` shimmer in ProceduresPanel). The "Load Context" button is replaced by a "Loading..." label.

**Loaded:**
- Treemap fills the available space
- Footer below treemap: humanized timestamp ("loaded 2m ago") + refresh icon button (`refresh` material symbol)
- Timestamp updates every 30 seconds via `setInterval`

**Error:**
Brief error message with a retry button.

## Treemap

### Rendering
Uses the `squarify` npm package (~2KB) for layout math only. It takes category values and a bounding rectangle and returns `{x, y, dx, dy}` for each cell — proven squarified treemap algorithm that produces near-square cells.

Rendering is custom: a `position: relative` container with each cell as an `position: absolute` div positioned by the squarify output (converted to percentages). This gives full control over colors, labels, and tooltips while the layout algorithm handles the hard problem of aspect ratios and packing.

1. Filter out categories with 0 tokens
2. Sort by token count descending
3. Call `squarify(values, {x0: 0, y0: 0, x1: containerWidth, y1: containerHeight})`
4. Render each rectangle as an absolutely-positioned div with percentage-based left/top/width/height
5. Gap: 2px (applied as padding/margin on cells). Border-radius: 2px on each cell.

### Dependency
`squarify` — layout math only, no DOM/React dependency. ~2KB. Handles the edge cases (tiny slivers, rounding, aspect ratios) that make hand-rolled treemap layout fragile in a 160px panel.

### Colors
Derived from the run's accent color (`resolveRunAccent(run.color)`). Each category gets the accent color at a different opacity based on its rank:

| Rank | Opacity | Used for |
|------|---------|----------|
| 1 (biggest) | 0.55 | Usually Messages |
| 2 | 0.45 | |
| 3 | 0.35 | |
| 4 | 0.28 | |
| 5 | 0.22 | |
| 6 | 0.18 | |
| 7+ | 0.12 | Small categories |
| Free space | 0.04 | Always last, barely visible |
| Autocompact buffer | 0.10 | Infrastructure, always low |

Implementation: `hexToRgba(runAccent, opacity)` — reuses the existing helper from `runAccent.ts`.

### Labels
- Cells large enough (roughly >8% of total) show: category name (abbreviated) + percentage
- Font: `text-2xs font-mono` (matching sidebar conventions)
- Color: `rgba(255,255,255, 0.7)` for high-opacity cells, `rgba(255,255,255, 0.4)` for low-opacity cells
- Cells too small for text show nothing — the tooltip handles it

### Tooltips
On hover, a tooltip appears above the cell (clamped to panel bounds) containing:

**Line 1 (bold):** Category name
**Line 2:** Token count + percentage — e.g., "75,166 tokens (37.6%)"
**Line 3 (muted):** Explanatory description

Category descriptions:

| Category | Description |
|----------|-------------|
| Messages | Conversation history — prompts, responses, and tool call/result pairs |
| System prompt | Base instructions Claude Code uses for every turn |
| System tools | Built-in tool definitions (Bash, Read, Edit, Grep, etc.) |
| MCP tools | Model Context Protocol tools from connected external servers |
| Custom agents | Subagent type definitions from plugins |
| Memory files | Project instructions (CLAUDE.md), auto-memory, and user-level config files |
| Skills | Skill frontmatter loaded from plugins and user commands |
| Autocompact buffer | Reserved headroom — when context hits this threshold, older messages are summarized |
| Free space | Available context remaining before autocompact triggers |
| MCP tools (deferred) | MCP tools available on-demand but not yet loaded into context |
| System tools (deferred) | Built-in tools available on-demand via ToolSearch |

Tooltip styling: `bg-slate-900 border border-slate-700 rounded px-2 py-1.5 text-2xs shadow-lg`, positioned with `position: absolute` relative to the treemap container.

### Timestamp footer
Below the treemap: a small footer row with:
- Left: humanized time — "loaded just now", "loaded 30s ago", "loaded 2m ago", "loaded 15m ago"
- Right: refresh button (material icon `refresh`, same style as collapse chevrons)
- Updates via `setInterval` every 30 seconds
- Clicking refresh re-triggers the API call (enters Loading state)

## Backend

### New file: `src/server/sessions/context-usage.ts`

**`getDetailedUsage(conversationId: string): Promise<ContextData>`**

Spawns a sidecar Claude Code process:
```
claude --print \
  --resume <conversationId> \
  --fork-session \
  --input-format stream-json \
  --output-format stream-json \
  --verbose \
  --max-turns 1 \
  --model claude-haiku-4-5-20251001
```

Sends two lines to stdin:
1. `{"type":"control_request","request_id":"<uuid>","request":{"subtype":"get_context_usage"}}`
2. `{"type":"user","message":{"role":"user","content":"x"},"session_id":"","parent_tool_use_id":null}`

Parses stdout line-by-line. The first `control_response` line contains the full context data. Kills the process after receiving it (or after timeout).

**Concurrency guard:** Only one sidecar per session at a time. If a request arrives while one is in-flight, return the in-flight promise. Cache the last successful result for 30 seconds — subsequent requests within the TTL return the cached data.

**Timeout:** Kill the sidecar after 45 seconds if no response received.

**Return shape:** The `categories`, `totalTokens`, `maxTokens`, `percentage`, `model`, `memoryFiles`, `mcpTools`, `agents`, `skills`, `messageBreakdown`, `isAutoCompactEnabled`, `autoCompactThreshold` fields from the `control_response.response.response` object.

### Route: `GET /api/sessions/:name/context`

Added to `routes.ts` after the existing `GET /api/sessions/:name/files` block.

1. Look up session by name
2. Validate `session.conversation?.id` exists (404 if not)
3. Call `getDetailedUsage(session.conversation.id)`
4. Return `{ ok: true, data: <context data> }`
5. On error: `{ ok: false, error: { code: 'CONTEXT_FETCH_FAILED', message: '...' } }`

### Auth consideration
The sidecar inherits the same OAuth session as the running Claude Code processes (same user, same machine). No extra auth configuration needed.

### Session guard
- Only works for sessions with `adapter: 'claude'` (or null/default). Codex sessions return 400.
- Only works when `conversation.id` is set. Sessions that haven't started yet return 404.

## Frontend

### New file: `src/components/RunWorkspaceWidget/TelemetryPanel.tsx`

Props:
```typescript
interface TelemetryPanelProps {
  sessionId: string
  runAccent: string  // hex color from resolveRunAccent
}
```

Internal state:
- `data: ContextData | null` — last loaded context data
- `loading: boolean`
- `error: string | null`
- `loadedAt: number | null` — timestamp of last successful load (for humanized display)

### Modified file: `src/components/RunWorkspaceWidget/index.tsx`

- Add `telemetryHeight` state (number, default: 50% of available height)
- Add `resizeTelemetryRef` for drag tracking
- Wrap ProceduresPanel and TelemetryPanel in a flex-col container with the divider between them
- Pass `runAccent` to TelemetryPanel

### Unchanged: `src/components/RunWorkspaceWidget/ProceduresPanel.tsx`

No changes needed. It just gets less vertical space.

## Files Changed

| File | Change |
|------|--------|
| `src/server/sessions/context-usage.ts` | New — sidecar spawner + cache |
| `src/server/api/routes.ts` | Add `GET /api/sessions/:name/context` route |
| `src/components/RunWorkspaceWidget/TelemetryPanel.tsx` | New — telemetry panel with treemap |
| `src/components/RunWorkspaceWidget/index.tsx` | Split right panel, add divider + telemetry state |
