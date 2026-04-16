# H3 — Stale sockets in `/tmp` came from a previous in-repo channel-server impl

**Status:** **inconclusive**
**Bug:** `breakout-room-no-delivery`
**Casefile:** [../00-casefile.md](../00-casefile.md)
**Index:** [../01-hypothesis-index.md](../01-hypothesis-index.md)
**Owner/agent:** quickfixes
**Opened:** 2026-04-09

---

## Statement

The three stale Unix sockets in `/tmp` (`tinstar-nats-mcp-agent.sock`, `tinstar-nats-nats-worker.sock`, `tinstar-nats-ui-agent.sock`, dated 2026-03-28 and 2026-03-29) were created by an earlier implementation of the channel server — one that lived inside the tinstar repo under `nats-poc/` and then `nats-channel-mcp/` — before the code was extracted to the external `github:except-pass/nats-channel-mcp` package. That earlier implementation did honor the `/tmp/tinstar-nats-<name>.sock` convention (and the tinstar-side `sendNatsSocketCommand` client was written against it). The extraction dropped the socket server; nobody noticed because tinstar's HTTP handler silently catches the ENOENT and returns `ok: true` (casefile F4).

---

## Why pursue H3 when H1 already explains the symptom?

H1 proves the current channel-server does not implement the socket. It does not prove this is a regression versus an original design. H3 differentiates between:
- **(a) regression:** an earlier impl did it, someone dropped it → fix is to port the socket server back into `nats-channel-mcp` (or a successor).
- **(b) never existed:** the feature was written on the tinstar side first and the channel-server side was never built → fix is to design and build the missing counterpart from scratch.

The fix-path choice matters for follow-up work, so H3 is worth an explicit resolution even though it doesn't change the observed failure mode today.

H3 also directly answers casefile `U1` (when did the convention stop being honored) and casefile `U2` (who was supposed to create the socket).

---

## Map to Casefile Facts

| Casefile fact | Relevance to H3 |
|---|---|
| **F6** — 3 stale sockets dated 2026-03-28/29 | The direct evidence H3 is trying to explain. |
| Temporal context §5 | Git log shows the `nats-poc` → `nats-channel-mcp` rename (`e28908e`, 2026-03-28 17:30) and a later decoupling (`efeed76 chore: remove all Tinstar references from nats-channel-mcp`) and deletion of the in-repo tree (`946cb41 feat(patterns): add k8s-style multi-agent orchestration` shows `nats-channel-mcp/*` among its deleted paths). H3 proposes these commits are the point the socket was dropped. |

---

## Timeline of Test Steps

### Step 1 — 2026-04-09 ~17:35 — Stat stale sockets

**Command:**
```
$ stat /tmp/tinstar-nats-mcp-agent.sock /tmp/tinstar-nats-nats-worker.sock /tmp/tinstar-nats-ui-agent.sock
```

**Output (relevant lines):**
```
File: /tmp/tinstar-nats-mcp-agent.sock
Modify: 2026-03-29 14:47:08.041607404 -0400

File: /tmp/tinstar-nats-nats-worker.sock
Modify: 2026-03-28 17:26:56.103461545 -0400

File: /tmp/tinstar-nats-ui-agent.sock
Modify: 2026-03-28 18:06:10.896810373 -0400
```

**Interpretation:** earliest socket mtime is 2026-03-28 17:26:56. Ties to casefile F6.

### Step 2 — 2026-04-09 ~17:43 — Search git log for channel-server related commits

**Command:**
```
$ git log --all --oneline --grep='nats-channel\|channel-server'
```

**Output (relevant):**
```
946cb41 feat(patterns): add k8s-style multi-agent orchestration
ad8fdba docs: add review-critique pattern design spec
7fa1304 feat(nats-channel-mcp): publish traffic events for monitoring #nats-monitor
2696098 docs: multi-agent patterns guide for Tinstar + nats-channel-mcp
e28908e chore: rename nats-poc dir to nats-channel-mcp, update hardcoded path in tmux.ts
9c38fa7 feat: NATS agent channels integration for Tinstar sessions
efeed76 chore: remove all Tinstar references from nats-channel-mcp
17c25cf chore: rename to nats-channel-mcp, CHANNEL_KEY coupling fix, auth note
ea1c6ff feat: --topics-file + repeatable --subscribe, Topics section in README
04ef437 docs: production-quality README + --instructions-file support
2e6ba8b feat: claude-nats-channel PoC — MCP bridge for NATS→Claude agent communication
```

**Interpretation:** a clear evolution: `2e6ba8b` (original PoC) → `17c25cf` (rename + auth decoupling) → `efeed76` (tinstar references removed) → `e28908e` (in-repo dir rename to nats-channel-mcp) → eventual deletion in some later commit. The commit `9c38fa7 feat: NATS agent channels integration for Tinstar sessions` is a key candidate for when tinstar's `sendNatsSocketCommand` client was added.

### Step 3 — 2026-04-09 ~17:43 — Stat the e28908e rename commit

**Command:**
```
$ git show --stat e28908e | head -20
```

**Output:**
```
commit e28908e61375aa9fe1450389e4245cbf757e423f
Author: Claude <claude@anthropic.com>
Date:   Sat Mar 28 17:30:35 2026 -0400

    chore: rename nats-poc dir to nats-channel-mcp, update hardcoded path in tmux.ts

 {nats-poc => nats-channel-mcp}/.gitignore          |  1 +
 {nats-poc => nats-channel-mcp}/README.md           |  0
 {nats-poc => nats-channel-mcp}/channel-server.ts   |  0
 ... (more file renames)
```

**Interpretation:** commit e28908e is dated 2026-03-28 17:30:35, just **4 minutes after** the earliest stale socket's mtime (2026-03-28 17:26:56). That is consistent with: (a) the `nats-worker` session was running at 17:26 using `nats-poc/channel-server.ts` and had already created its socket, (b) the commit 4 minutes later was a pure directory rename (not a content change — every file is listed with `|  0` indicating identical bytes), and (c) the `nats-poc/channel-server.ts` content *at that time* either did or did not contain the socket server — Step 4 is needed to determine which.

### Step 4 — NOT YET EXECUTED — Check the in-repo `nats-poc/channel-server.ts` content

**Command (pending):**
```
$ git show 2e6ba8b -- 'nats-poc/channel-server.ts' | head -60
$ git show 2e6ba8b:nats-poc/channel-server.ts | grep -nE '\.sock|createServer|net\.|listen'
$ git show efeed76 -- 'nats-channel-mcp/channel-server.ts'
$ git show 946cb41 --stat | grep nats-channel-mcp
$ git show 946cb41 -- 'nats-channel-mcp/channel-server.ts' | grep -nE '\.sock|createServer|net\.'
```

**Expected outputs:** each `git show` either prints content or empty. A non-empty match for `\.sock` or `createServer` in any historical version of `channel-server.ts` at `2e6ba8b`, `efeed76`, or just-prior-to-delete would raise H3 from **inconclusive** to **supported**. An empty match at every historical version would raise H3 to **falsified** (option b: "never existed" from §"Why pursue H3").

**Not executed in this run** because: (a) the primary symptom is already explained by H1 (supported), (b) resolving H3 is nice-to-have for the fix-design stage, not for the problem statement, and (c) casefile §7 Constraints directs investigation toward read-only non-destructive operations, not extensive git archaeology, at this phase. Planned for the fix-design phase if owners decide to port a socket server back.

### Step 5 — 2026-04-09 ~17:43 — Cross-check: confirm `sendNatsSocketCommand` existed at the time of the stale sockets

**Command:**
```
$ git log --all --oneline -S 'sendNatsSocketCommand' -- 'src/'
```

**Output:**
```
3e06504 feat(hands): add hand support to session creation with --append-system-prompt
9c38fa7 feat: NATS agent channels integration for Tinstar sessions
```

**Interpretation:** `sendNatsSocketCommand` was introduced in commit `9c38fa7 feat: NATS agent channels integration for Tinstar sessions` — the original tinstar-side NATS integration. The commit date of `9c38fa7` was not captured in this step and should be gathered before proceeding further. If `9c38fa7` predates 2026-03-28 17:26 (the earliest stale socket mtime), then the client was already in place when the stale sockets were created, which is necessary (though not sufficient) for H3. If `9c38fa7` is after 2026-03-28 17:26, the sockets must have been created by something other than the tinstar client flow, which would falsify H3.

**Next action for H3 resolution:** `git show --format='%ci' -s 9c38fa7` and `git show --format='%ci' -s 2e6ba8b` + the Step 4 archaeology.

---

## Current Verdict

**Inconclusive.** The git log evidence is *consistent with* H3's story (rename → decouple → strip tinstar references → delete in-repo tree), but the decisive test (inspect the historical content of `channel-server.ts` for socket code) was not run. Nothing falsifies H3 either.

**Weight of evidence:** leans supportive.
- For H3: stale sockets predate the current external package version (`2026-03-30 15:11` file mtime on the package), the commit history shows multiple rename/decouple events, `sendNatsSocketCommand` is a cross-process client that requires *some* server implementation to have ever existed for the code to make sense.
- Against H3: none directly; only the absence of confirmed historical content.

**Does NOT falsify H1.** H3 is complementary to H1, not a competitor. Even if H3 is eventually supported, H1 remains the correct description of the *current* state.

---

## Open Questions Carried Forward

- Exact commit date of `9c38fa7` and of `2e6ba8b` — ordering is load-bearing.
- Historical content of `nats-poc/channel-server.ts` at `2e6ba8b`, `nats-channel-mcp/channel-server.ts` at `efeed76` and at its deletion commit (likely `946cb41` or a later one).
- If the historical content did have a socket server: what was its exact protocol? tinstar's client sends `{action, subject}` JSON lines — did the old server speak the same dialect?
- Was there a commit message or PR description that explicitly said "socket server removed" or "will be re-added later"?
