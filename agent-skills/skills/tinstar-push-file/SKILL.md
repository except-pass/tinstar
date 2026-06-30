---
name: tinstar-push-file
description: Push a file you just made straight into the user's open Tinstar dashboard so their browser downloads it — no clicking, no hunting through the file tree. Use right after creating a deliverable (report, CSV, export, archive, image) the user will want to save locally.
---

# Tinstar Push File

You made a file in your session workspace. Instead of telling the user to find it
and click download, **push it** — one HTTP call and their browser saves it to
Downloads automatically, with a "⬇ Downloaded `<name>`" toast.

## How it works

`POST /api/sessions/:name/files/push-download` validates that the path is inside
your workspace, then broadcasts to every open dashboard, which auto-clicks an
invisible `<a download>`. The bytes flow over the normal download route — this
call just triggers it.

## Do it

```bash
TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"
curl -sS -X POST \
  "$TINSTAR_URL/api/sessions/${TINSTAR_SESSION_NAME}/files/push-download" \
  -H 'content-type: application/json' \
  -d '{"path":"report.csv"}'
```

- `$TINSTAR_SESSION_NAME` is injected into every Tinstar session — it's already
  your own session name, don't guess it.
- `path` is **relative to your session workspace** (the directory you're working
  in), e.g. `report.csv` or `out/build.zip`. Absolute paths and anything that
  escapes the workspace are rejected.
- `$TINSTAR_DASHBOARD_URL` is the managed-session backend URL (the dev server may
  run on 5280, or a second backend elsewhere); always use the variable, falling
  back to `http://localhost:5273`. Same convention as every other Tinstar skill.

## Report the result

The endpoint answers synchronously — relay it:

- Success → `{"ok":true,"data":{"pushed":true,"filename":"report.csv"}}`. Tell the
  user it's downloading.
- Failure → `{"ok":false,"error":{"code":"...","message":"..."}}`. Common codes:
  `SESSION_NOT_FOUND`, `INVALID_PARAMS` (path missing or not a file),
  `PATH_OUTSIDE_WORKSPACE`, `NOT_FOUND`, `BAD_REQUEST` (malformed/oversized JSON
  body). Surface the message — it tells you what to fix (usually a wrong relative
  path).

## Gotchas

- **The dashboard must be open in a browser** for the push to land. With no
  dashboard connected the call still returns `ok` but nothing downloads (it's a
  broadcast to zero clients). If the user isn't looking at Tinstar, tell them the
  file's path instead.
- **Every open dashboard tab downloads.** Fine for a single user; just know it's
  a broadcast, not targeted at one tab.
- It always **downloads** (forced attachment) — it won't open inline in the
  browser.
