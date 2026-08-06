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
- **ttyd 1.7.4 or newer is now required.** Both containment flags (`-i`, `-H`) are silently ignored by older builds rather than rejected, so a terminal spawn is refused below that floor instead of quietly serving a world-reachable shell. `tinstar doctor` reports the installed version against it.

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

This widens the bind, which is exactly what the containment work narrowed — the whole address is reachable to anything that can route to it, with no authentication in front. Prefer tailnet reach below, which keeps the bind on loopback.

### Preferred: tailnet reach

Reach fronts the loopback bind with `tailscale serve` instead of widening it. Tailnet membership is the authorization; Tinstar ships no credential of its own, and the listener stays on `127.0.0.1`.

```bash
tinstar reach on       # prints the privilege grant, installs it, then enables
tinstar reach status   # where you are reachable, or why not
tinstar reach off      # revokes the mapping and removes the grant
```

The opt-in is persisted, so a restart or reboot brings the same URL back with no second decision — a clean shutdown takes the mapping down but never the preference. `GET /api/reach` returns the same state, so an agent can ask whether it is reachable remotely.

Preconditions, each refused by name rather than generically if unmet:

- **Tailscale 1.98.9 or newer.** Refused below that, not warned. Bulletins TS-2026-005, TS-2026-007 and TS-2026-008 are fixed in 1.98.9, and TS-2026-008 is an unauthenticated denial of service against the exact serve path this turns on, reachable from any tailnet peer.
- **MagicDNS and HTTPS certificates enabled for the tailnet.** Both are admin-console settings, not device settings.
- **The privilege grant installed.** `tinstar reach on` writes a sudoers drop-in at `/etc/sudoers.d/tinstar-reach` permitting exactly the two `tailscale serve` invocations Tinstar issues and nothing else — no other subcommand, no wildcard. It prints the rule before writing it and validates it with `visudo -c` before anything reaches `/etc/sudoers.d`. The grant is installed only when you ask for reach, never by `install-service`; `tinstar reach off` removes it, and you can remove it yourself at any time with `sudo rm /etc/sudoers.d/tinstar-reach`. Tailscale's own `--operator` grant is deliberately *not* used: it confers control of the whole daemon and is the pivot in one of the advisories above.

Run `tinstar doctor` to see the observed bind of every listener, both external version floors, and the current reach state.

**The tailnet is assumed to be single-user** — every member one of your own devices. Default Tailscale ACLs let any member reach any peer, so on a shared tailnet this relocates the exposure rather than closing it. Nothing enforces this; it is a precondition.

### If you installed the systemd unit before v5.4

Regenerate it: `tinstar install-service --port <port>`. The old unit resolved a tailnet IP into `--host` at every start, which re-opens the bind this release closed, and it froze a CORS allowlist at install time that the server now seeds itself. Tinstar warns about a stale unit on every service command rather than only at install.

### Why a runtime notice as well as this note

Tinstar is published to npm and its documented onboarding is `npx tinstar`, so an operator can upgrade without ever seeing a release note — and the symptom (a URL that stopped answering) looks like a crash rather than a decision. The server therefore prints this change **once**, on the first start after upgrading an existing install. A brand-new install stays quiet: it never had the old behaviour.

Code: `src/server/bind.ts` (the bind resolver and the one loopback literal), `src/server/bindNotice.ts` (the one-time notice), `src/server/standalone.ts` (listener wiring), `src/server/sessions/backends/tmux.ts` (terminal bind, incumbent bind matching, the readiness probe's header), `src/server/sessionProxy.ts` (the terminal auth header, origin refusal, identity-header stripping).
