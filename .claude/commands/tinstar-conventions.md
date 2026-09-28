---
name: tinstar-conventions
description: Tinstar-specific file/directory conventions and component topology. Consult before implementing any feature that touches sessions.
---

Key conventions in the Tinstar codebase:

## Sessions

- `sessionId` in the frontend == session `name` in API URLs (`/api/sessions/{name}/...`)
- `send-keys` sends text without Enter; `enter-prompt` sends and submits

## Dev Server

- Backend changes require a server restart to take effect (tsx watch handles most, but standalone.ts changes need manual restart)
- Skill cache TTL is 7 seconds — bust with `bustSkillCache()` or wait it out
- PID file at `~/.config/tinstar/server.pid` — stale servers are auto-killed on restart
