# Run Workspace Header Redesign

**Date:** 2026-03-22
**File:** `src/components/RunWorkspaceWidget/RunWorkspaceHeader.tsx`

## Goal

Replace the icon-only action buttons in the run workspace title bar with full-height labeled buttons that fill the header vertically. Improve visual grouping, add labels, and clarify the refresh button's purpose via tooltip.

## Layout

The header is a single horizontal strip (`<header>`). It has two zones:

### Left zone — identity (unchanged)

- Run icon (backend type)
- Run name (`Run_ID`) + status dot/label
- Breadcrumb nav (initiative › epic › task)
- Hotgroup badge

### Right zone — redesigned

From left to right, all children use `align-items: stretch` so they fill the full header height:

| Slot | Element | Notes |
|------|---------|-------|
| 1 | WORKTREE / REPO text block | Non-interactive; existing two-line stacked labels; padding `0 12px` |
| 2 | Thin vertical separator | `1px`, color `rgba(255,255,255,0.1)`, full height |
| 3 | **Color** button | `palette` icon + "COLOR" label; accent-colored; opens color palette on click |
| 4 | **Browser** button | `language` icon + "BROWSER" label; accent-colored; draggable (`draggable` attr, `onDragStart` sets transfer data) |
| 5 | Thin vertical separator | |
| 6 | **Refresh** button | `refresh` icon + "REFRESH" label; accent-colored; tooltip: `"Refresh — re-registers the proxy route so the browser widget can reach this session's port"` |
| 7 | Thin vertical separator | |
| 8 | **Stop** button | `stop_circle` icon + "STOP" label; danger hover (red); shows when session `isLive`; otherwise shows **Resume** (`play_circle` + "RESUME", green hover) |
| 9 | **Delete** button | `delete` icon + "DELETE" label; danger hover (red); no separator from Stop |

Stop and Delete are adjacent with no separator between them, forming a visual danger group.

Refresh only renders when `isLive && run.port` (same condition as before).

## Button anatomy

Each action button is a flex column: icon on top, label below, centered horizontally. No explicit height — they stretch to fill the header via `align-items: stretch` on the parent.

```
┌──────────┐
│  [icon]  │  ← 16px Material Symbol
│  LABEL   │  ← 8px, uppercase, tracking-wide, font-weight 600
└──────────┘
```

Minimum width: `~52px`. Padding: `0 12px`.

Hover states:
- Default buttons: subtle `rgba(255,255,255,0.04)` background, text brightens to `#cbd5e1`
- Accent buttons (Color, Browser, Refresh): `rgba(runAccent, 0.06)` background, text brightens to `runAccent`
- Danger buttons (Stop/Resume, Delete): `rgba(accent-red, 0.08)` background, text goes to `accent-red`

## Tooltip for Refresh

```
title="Refresh — re-registers the proxy route so the browser widget can reach this session's port"
```

## Header height

The header currently uses `py-1.5` (6px top/bottom). With stacked icon+label buttons this changes to no vertical padding on the header itself — the buttons' internal centering handles spacing. Target visual height: ~48px (up from ~36px).

## What does not change

- Color palette dropdown behavior (portal, click-outside close)
- `onPointerDown/Move/Up` drag-to-move wiring
- `sessionAction` API calls
- `compact` mode (the right zone is only rendered when `!compact`)
- Error display (`actionError` banner)
- `HotgroupBadge` placement
- Browser chip remains drag-only (no click action)
