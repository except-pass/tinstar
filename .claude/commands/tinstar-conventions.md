---
name: tinstar-conventions
description: Tinstar-specific file/directory conventions and component topology. Consult before implementing any feature that touches sessions or sidebars.
---

Key conventions in the Tinstar codebase:

## Sidebars

- `HierarchySidebar.tsx` is the sidebar rendered in the main app layout
- `HotkeysSidebar.tsx` also exists but is secondary — changes to hotkey display often need both
- Shared hotkey constants/components live in `HotkeyBindingRow.tsx`

## Sessions

- `sessionId` in the frontend == session `name` in API URLs (`/api/sessions/{name}/...`)
- `send-keys` sends text without Enter; `enter-prompt` sends and submits

## Dev Server

- Backend changes require a server restart to take effect (tsx watch handles most, but standalone.ts changes need manual restart)
- Skill cache TTL is 7 seconds — bust with `bustSkillCache()` or wait it out
- PID file at `~/.config/tinstar/server.pid` — stale servers are auto-killed on restart

## Quick Draw (Hotgroups)

- User-facing branding is "Quick Draw", internal code uses "hotgroup"
- All work widgets (RunWorkspace, BrowserWidget, FileEditorWidget, ImageViewerWidget) support Quick Draw assignment
- Node IDs: `run-{id}`, `editor-{id}`, `browser-{id}`, `image-{id}`
- `useHotgroups.ts` stores assignments in localStorage keyed by space ID
