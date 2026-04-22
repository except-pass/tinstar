# 01 — Hypothesis Index

**Bug:** `breakout-room-no-delivery`
**Casefile:** [00-casefile.md](00-casefile.md)
**Opened:** 2026-04-09
**Owner/agent:** quickfixes

All hypotheses answer the central question: **Why is there no Unix socket at `/tmp/tinstar-nats-<name>.sock` for any currently-running NATS-enabled session, causing `sendNatsSocketCommand` to ENOENT every hot-subscribe?** (casefile facts `F3`, `F5`, `F6`.)

| ID | Statement | Status | Run log |
|----|-----------|--------|---------|
| H1 | The `nats-channel-mcp` package (github:except-pass/nats-channel-mcp) does not create the control Unix socket that tinstar's `sendNatsSocketCommand` client expects. The socket was never implemented on the server side. | **supported** | [runs/H1-nats-channel-mcp-no-control-socket.md](runs/H1-nats-channel-mcp-no-control-socket.md) |
| H2 | Claude Code's `--dangerously-load-development-channels server:nats` flag spawns a different channel-server implementation than `nats-channel-mcp`, and the socket responsibility lives there. | open | — (not tested; H1 already explains the observed symptom) |
| H3 | The 3 stale sockets in `/tmp` (dated 2026-03-28/29) were created by an earlier in-repo channel-server implementation that was lost when the package was extracted from the tinstar repo. | **inconclusive** | [runs/H3-stale-sockets-previous-impl.md](runs/H3-stale-sockets-previous-impl.md) |
| H4 | The socket is being created at a different path than `/tmp/tinstar-nats-<name>.sock` (path mismatch). | **falsified** | — (see below) |
| H5 | Tinstar or nats-channel-mcp removes the socket file after creation (cleanup / housekeeping). | **falsified** | — (see below) |

---

## Evidence Summary per Hypothesis

### H1 — supported (plus post-fix corroboration)

The current channel-server source (`channel-server.ts`, originally 181 lines, located at `/tmp/bunx-1000-nats-channel-mcp@github@10077192783352013657/node_modules/nats-channel-mcp/channel-server.ts`) contains no Unix-socket server code whatsoever.

**Post-fix experiment (2026-04-09 ~14:03):** the cached file was patched in-place as a quick standalone retest — valuable as diagnosis corroboration, discarded as a durability path.

**Durable integration (2026-04-09 ~14:10–14:25):**
- Upstream: opt-in `--control-socket <path>` flag merged in `except-pass/nats-channel-mcp#1` (commit `7025420` on main), with a new `test/e2e/control-socket.sh` covering create → hot-sub → delivery → hot-unsub → malformed-JSON → graceful-shutdown-unlink.
- Tinstar: commit `3ccd9f8` on branch `V3.7.0` (local only, not pushed) adds a shared `natsControlSocketPath` helper, wires `--control-socket` into `generateNatsMcpConfig`, and switches `sendNatsSocketCommand` to use the helper so both sides can't drift.
- End-to-end retest against the merged upstream code + tinstar-generator-style args: socket created at the exact path `sendNatsSocketCommand` expects, JSON protocol match, NATS message delivered, graceful shutdown unlinks the socket. See H1 run log's "Durability path taken" section.

**Still open and tracked in H1 run log as follow-ups:**
- The 9 live NATS sessions from F7 still need a restart to pick up the new wiring (out of scope per casefile §7 Constraints).
- The silent-failure pattern at `routes.ts:2572-2578` (+3 sibling sites) still demotes socket errors to warn — should surface them now that the happy path works. Grep for `\.sock|createServer|net\.|Unix|listen` against the file returns matches only to NATS operations (`nc.subscribe`, `sub.unsubscribe`, etc.). The only process interface is `StdioServerTransport` (line 163) for MCP and the `nats` TCP client (line 92). There is a Map `activeSubs` (line 96) with the comment *"Track active subscriptions so we can hot-manage them later"* — the data structure is present, the external entrypoint to use it is not. This explains casefile facts F3, F5, F6, F7 in a single stroke: tinstar's client sends to a socket server that was never written.

Cohort alignment: explains the failing cohort (every session of the multi-agent CLI template — they all run this same package, F7) and the non-repro cohort (spawn-time `--subscribe` args; these are handled in the initial loop at `channel-server.ts:166-168`, which *does* exist — F9).

### H2 — open, not pursued

Not tested because H1 is supported and alone accounts for all observed facts. Would become relevant only if H1 were disproven, e.g. if a future test showed a socket being created transiently during spawn, at which point H2 would ask "by whom?". Reopen if:
- New evidence surfaces of a socket being created for any current session.
- The `--dangerously-load-development-channels server:nats` path is found to spawn a different process from the one seen in `pgrep -af nats-channel-mcp` (casefile F7).

### H3 — inconclusive

Supporting: the stale sockets (`mcp-agent`, `nats-worker`, `ui-agent`, dated 2026-03-28/29) correspond to session names not present in `/api/state`; git log shows the channel server was renamed from `nats-poc/` to `nats-channel-mcp/` in commit `e28908e` on 2026-03-28 17:30 and was removed from the tinstar repo at some point after that (git log `--diff-filter=D` shows commit `946cb41 feat(patterns): add k8s-style multi-agent orchestration` deleted the in-repo `nats-channel-mcp/` directory). Commit `efeed76 chore: remove all Tinstar references from nats-channel-mcp` strongly suggests a decoupling event where tinstar-specific code paths (potentially including the control socket) were stripped.

Not supporting: I did not inspect the pre-extraction `nats-poc/channel-server.ts` or `nats-channel-mcp/channel-server.ts` content at the in-repo commits to confirm whether socket code ever existed in the Tinstar-owned copy. The commit `efeed76`'s diff was not examined. Without that, H3 is a plausible story but not proven.

Concrete next step to resolve: `git show efeed76 -- 'nats-channel-mcp/channel-server.ts' 'nats-poc/channel-server.ts'`, then `git show 946cb41 -- 'nats-channel-mcp/**'` — look for any `.sock`, `net.createServer`, or `createConnection` references in the deleted / decoupled content.

### H4 — falsified

Full listing of every Unix socket in `/tmp` (depth 2):

```
/tmp/cursor-askpass-12df5bff-3.sock   (cursor editor, unrelated)
/tmp/cursor-askpass-2dcdf1e7-f.sock   (cursor editor, unrelated)
/tmp/cursor-askpass-6281b28a-4.sock   (cursor editor, unrelated)
/tmp/cursor-askpass-c13fddc2-0.sock   (cursor editor, unrelated)
/tmp/tinstar-nats-mcp-agent.sock      (stale, F6)
/tmp/tinstar-nats-nats-worker.sock    (stale, F6)
/tmp/tinstar-nats-ui-agent.sock       (stale, F6)
```

There is no Unix socket for any currently running multi-agent session under any name. The 7 sockets present are accounted for (4 cursor, 3 stale tinstar). H4 falsified: there is no alternative location.

### H5 — falsified

`Grep -n 'unlink.*nats|tinstar-nats.*unlink|\.sock.*unlink' src/` in `/home/ubuntu/repo/tinstar/src/` returned **zero matches**. Tinstar source does not unlink any `.sock` file. nats-channel-mcp source (H1 inspection) also contains no `unlink`/`rm` calls. H5 falsified: no code path removes these sockets. (Consistent with H1: you cannot delete a file that was never created.)

---

## Open Questions Still Mapped to Casefile Known Unknowns

- Casefile `U1` *(when did the convention stop being honored)* is now partially resolved: the honoring process stopped existing no later than the Apr 8 spawn of `e2e`. The upper bound is still open — needs H3 resolution.
- Casefile `U2` *(who is supposed to create the socket)* is strongly narrowed by H1: **no one currently does**, and the only plausible owner is `nats-channel-mcp` itself (or a tinstar-owned sidecar that doesn't exist). The "supposed to" part remains an intent question answered only by whoever wrote commit `9c38fa7 feat: NATS agent channels integration for Tinstar sessions` and the original `sendNatsSocketCommand` client.
- Casefile `U3–U7` untouched by this hypothesis round.

---

## Completion Criteria Check

- [x] Casefile loaded and referenced (every hypothesis maps to at least one F-number).
- [x] Hypotheses tracked in index (H1–H5 with status).
- [x] Each active hypothesis has a detailed run log (H1 supported: `runs/H1-*`; H3 inconclusive: `runs/H3-*`). H4 and H5 are falsified by trivial single-step evidence and are noted inline above rather than in separate run logs.
- [x] Findings explain both failing cohort (F1, F2, F3, F7) and counter-examples (F9, F10, F11) — see H1 "Cohort alignment".
- [x] No "fixed" claims.
