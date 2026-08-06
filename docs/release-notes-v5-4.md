# Tinstar v5.4 — feature reference

Single-source reference for what shipped in v5.4. Organized by subsystem. Points at the relevant code and existing timeless docs.

---

## ⚠️ Breaking change — Tinstar no longer answers on your LAN by default

**Read this one before upgrading.**

Every previous release called `listen(port)` with no address, which binds the unspecified address: one listener on **every interface**. Combined with no authentication layer and per-session `ttyd` processes that each bound every interface too, a Tinstar host with no firewall served an unauthenticated, writable shell — with the operator's git credentials and agent tokens in reach — to anything that could route to it. Nothing in the product said so.

As of v5.4:

- The server binds **`127.0.0.1` and `::1`** and nothing else, unless you name an address.
- Every agent terminal binds `127.0.0.1` only, and additionally requires a header that only Tinstar's own session proxy sends. A terminal port is no longer independently usable, even from the same machine.
- A terminal left running by an older Tinstar is **replaced rather than reused**, because its bind does not match. Existing sessions restart their terminal once on the first start after upgrade. The tmux session behind it — and therefore the agent — is untouched.

### What still works, unchanged

`http://localhost:<port>` on the host machine. Every host-local caller keeps working with no configuration: the `cc-quota` statusline shim, project `.claude/settings.json` hooks, `tinstar doctor`, `tinstar status`, agent skills, the built-in hand prompt, and `bin/apiBase.js`. `server.host` still records an IPv4 address that those callers can put in a URL.

### If you were reaching Tinstar from another device

Name the address explicitly:

```bash
tinstar --host 100.x.y.z          # e.g. a tailnet address
tinstar --host 192.168.1.50       # a LAN address
tinstar --host a.b.c.d,e.f.g.h    # or repeat --host
```

`127.0.0.1` is force-added to whatever you name, so host-local callers keep working. `TINSTAR_HOST` takes the same value.

This is the **interim** path. It widens the bind, which is exactly what the containment work narrowed — the whole address is reachable to anything that can route to it, with no authentication in front. A tailnet-fronted path that keeps the bind on loopback is the intended replacement.

### Why a runtime notice as well as this note

Tinstar is published to npm and its documented onboarding is `npx tinstar`, so an operator can upgrade without ever seeing a release note — and the symptom (a URL that stopped answering) looks like a crash rather than a decision. The server therefore prints this change **once**, on the first start after upgrading an existing install. A brand-new install stays quiet: it never had the old behaviour.

Code: `src/server/bind.ts` (the bind resolver and the one loopback literal), `src/server/bindNotice.ts` (the one-time notice), `src/server/standalone.ts` (listener wiring), `src/server/sessions/backends/tmux.ts` (terminal bind, incumbent bind matching, the readiness probe's header), `src/server/sessionProxy.ts` (the terminal auth header, origin refusal, identity-header stripping).
