---
name: tinstar-hand
description: Spawn, steer, and tear down a Tinstar hand — a specialized collaborator agent that inherits your worktree/task/NATS and talks over NATS. Use when you want help from a reviewer/tester/bugsearcher/docs/security/skeptic/rubberduck/etc. Skip for one-off lookups (subagent is lighter).
---

# Tinstar Hand

A **hand** is a Tinstar session spawned as your child. It inherits your worktree, your task, and your NATS subscriptions, and talks back to you over NATS — not the prompt API. You spawn one when you want a persistent, conversational collaborator you can hand work to, probe, push back on, and reassign.

## When *not* to use a hand

Don't spawn a hand for a one-shot lookup. Subagents are lighter.

| Situation | Use |
|---|---|
| "Search the repo for X" / single question | **subagent** |
| "Read this file and summarize" | **subagent** |
| "Review this diff — I want to probe what you checked, push back if you disagree, hand you follow-ups" | **hand** (`reviewer`) |
| "Keep a line of investigation going while I work on the fix" | **hand** (`bugsearcher`) |
| "Audit / critique / challenge — back-and-forth" | **hand** (`skeptic`, `reviewer`, `rubberduck`) |
| "Parallel tasks that need their own context window" | **hands** (spawn several) |

Rule of thumb: if the interaction is one round-trip, use a subagent. If you'll come back to them, use a hand.

## 1 — Confirm you can spawn

```bash
TINSTAR_URL="${TINSTAR_DASHBOARD_URL:-http://localhost:5273}"
curl -sf "$TINSTAR_URL/api/state" > /dev/null || { echo "Tinstar not reachable"; exit 1; }
SESSION=$(tmux display-message -p '#S' 2>/dev/null)
[ -z "$SESSION" ] && { echo "Not inside a Tinstar tmux session — can't spawn a hand"; exit 1; }

# Confirm your own session has NATS enabled — required to talk to the hand
curl -s "$TINSTAR_URL/api/state" \
  | jq --arg n "$SESSION" '.sessions[] | select(.name==$n) | {name, nats: .nats.enabled}'
```

If `nats: false`, your session was started with a non-multi-agent template. Fix your parent session first (restart with `Claude (multi-agent)`) — spawning will succeed but you won't be able to talk to the hand.

## 2 — Pick a hand

```bash
curl -s "$TINSTAR_URL/api/hands" | jq -r '.data[] | "\(.name) — \(.description)"'
```

Typical choices:

| Hand | Use when |
|---|---|
| `general-purpose` | Implementation, research, broad search |
| `reviewer` | Audit a diff or chunk of work for quality |
| `skeptic` | Challenge assumptions, find edge cases |
| `rubberduck` | Think a design out loud before committing |
| `tester` | Expand test coverage |
| `bugsearcher` | Root-cause a bug systematically |
| `fixer` | Keep the build / type-check green |
| `cleanup` | Enforce consistency, reduce duplication |
| `docs` | READMEs, changelog, comments |
| `security-scanner` | Security review of a diff |
| `pr-responder` | Answer PR review comments |

If none fit, `general-purpose` with a sharp prompt is always valid.

## 3 — Spawn (same worktree — the default)

**Always use `POST /api/sessions/<your-session>/spawn`.** This endpoint inherits your worktree, task, epic, initiative, and NATS subscriptions, and wires up a parent↔child NATS link so the hand can reach you directly.

**Never use `POST /api/sessions`** for a child. It creates an orphan with no task context and no NATS link — the hand cannot talk to you.

```bash
HAND="reviewer"
PROMPT="Review the last 3 commits on this branch. Focus on auth edge cases. Report findings."

curl -s -X POST "$TINSTAR_URL/api/sessions/$SESSION/spawn" \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg hand "$HAND" --arg prompt "$PROMPT" '{hand: $hand, prompt: $prompt}')" \
  | jq '{name, state}'
```

Spawned names look like `<parent>-<hand>-<uuid8>` (e.g. `my-task-reviewer-a1b2c3d4`). Remember it — you'll use it for follow-ups and teardown.

## 3b — Spawn in a *different* worktree

Sometimes you want a hand working off a different checkout — auditing `main` while you're on a feature branch, or poking at a sister repo. Pass `worktreePath` (and optionally `repo`):

```bash
curl -s -X POST "$TINSTAR_URL/api/sessions/$SESSION/spawn" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
        --arg hand "$HAND" \
        --arg prompt "$PROMPT" \
        --arg wt "/home/ubuntu/repo/other-worktree" \
        '{hand: $hand, prompt: $prompt, worktreePath: $wt}')"
```

- The path must already exist — `worktreePath` does **not** create a worktree.
- You keep the parent↔child NATS link; the hand is still your child, just working elsewhere on disk.
- If you need a fresh worktree, create it first (`git worktree add …`) and pass the path.

Spawning a disconnected session via `POST /api/sessions` is almost never right. Use `spawn` even when the worktree differs.

## 4 — Wait for the intro, then ack

The hand's first action is to introduce itself to you over NATS. Within ~5–15s you should see a message arrive with a `<channel source="nats" subject="…">` wrapper:

```
<channel source="nats" subject="...">reviewer online. I audit diffs for quality and correctness. Ready.</channel>
```

**Ack immediately** using the `reply` MCP tool with the subject from the tag:

```
reply(to="<subject-from-channel-tag>", text="Welcome reviewer. Task: <restate the work>. Reply here when done, and flag anything you skipped.")
```

If no intro within ~15s, check state:

```bash
curl -s "$TINSTAR_URL/api/state" \
  | jq --arg n "<spawned-name>" '.sessions[] | select(.name==$n) | {state, nats: .nats}'
```

- `state: "starting"` — still booting, wait
- `state: "running"` + no intro — `tmux capture-pane -t tinstar-<spawned-name> -p | tail -30` to see if the hand is stuck on a prompt (rare)

## 5 — Steer the hand (this is the whole game)

Hands are conversational. **Treat them like a teammate, not a one-shot function call.** Agents under-talk to hands by default — push against that.

- **Be verbose.** Explain what you want, what you've tried, what's ambiguous. Over-explain. They don't charge for tokens.
- **Probe on "done".** When a hand reports complete, don't just accept it. Ask: *"What did you check? What did you skip? What surprised you? Were any of these judgment calls?"*
- **Push back.** Thin or wrong answer? Say so and ask them to dig deeper. They're not fragile.
- **Parallelize.** If two lines of investigation are independent, don't serialize — spawn a second hand. Hands can spawn their own children.
- **Close the loop explicitly.** Tell them when they're done (see teardown below) so the tree doesn't orphan.

Follow-ups use the same `reply` tool:

```
reply(to="<hand-subject>", text="One more thing — did you look at the token-refresh path in auth.ts:140?")
```

**Broadcast to every agent on your task:**

```
reply(to="tinstar.<space>.<init>.<epic>.<task>.*", text="Status check")
```

**Don't use `POST /api/sessions/:id/prompt`** for hands — that's the non-NATS path and bypasses the parent-child channel. **Don't use `tmux send-keys`** — same reason. Always `reply()`.

## 6 — Tear down cleanly

When the hand's work is done:

1. **Tell them you're wrapping up.** No surprise kills.
   ```
   reply(to="<hand-subject>", text="Thanks, that's everything. You can wrap up — I've got what I need.")
   ```

2. **Confirm work product landed.** If the hand was writing code, ask them to commit before you dismiss — session work dies with the session unless it's on disk.

3. **Stop or delete via the API:**
   ```bash
   # Stop (session record remains, can restart)
   curl -s -X POST "$TINSTAR_URL/api/sessions/<spawned-name>/stop"

   # Delete (removes session record entirely)
   curl -s -X DELETE "$TINSTAR_URL/api/sessions/<spawned-name>"
   ```

**Never `kill -9` the tmux pane or `tmux kill-session`.** The session record drifts out of sync with reality. Always go through the API.

## Gotchas

- **Session names must not contain dots.** tmux reads `.` as a pane separator. Spawned names are auto-generated so this usually doesn't bite you, but if you name anything manually, stick to `[a-z0-9-]`.
- **Parent must have NATS.** Without `Claude (multi-agent)` on your own session, spawning succeeds but the hand can't hear you. Step 1 catches this.
- **Intros go point-to-point, not broadcast.** Don't look for the intro on the task `*` subject.
- **A live hand roster is `GET /api/hands`.** The table above drifts — trust the API for what's actually installed.
- **Defining new hands:** drop a `<name>.md` with the right frontmatter into `~/.config/tinstar/hands/`. See `~/.config/tinstar/hands/HAND-PROTOCOL.md` for the contract and any existing file in that directory as a template.

## See also

- `tinstar` skill — broader API (patterns, editor widgets, breakout rooms, state queries) for when hands aren't what you need
- `tinstar-tmux` skill — why raw tmux commands against Tinstar sessions are an antipattern
