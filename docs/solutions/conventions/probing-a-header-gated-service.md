---
title: "A header-gated ttyd refuses in three different shapes, and Node's fetch throws on one of them"
date: 2026-08-11
category: conventions
module: server-sessions
problem_type: convention
component: test_strategy
severity: medium
applies_when:
  - Writing a test that probes a service gated by ttyd's -H / --auth-header flag
  - Asserting a specific status code from a refusal rather than asserting "not admitted"
  - Probing an HTTP endpoint with Node's global fetch and getting an unexplained TypeError
tags:
  - ttyd
  - terminal-proxy
  - test-strategy
  - http-clients
  - websocket
---

# Probing a header-gated service

## Context

Tinstar spawns every terminal with `-H X-Tinstar-Proxy`
(`src/server/sessions/backends/tmux.ts:2196`, with the constants at
`src/server/sessionProxy.ts:25` and `:28`). That flag is what makes the session
proxy the only way in: the proxy injects the header, and a direct connection to
the ttyd port does not carry it.

The open question when that landed was whether `-H` gates the **WebSocket
upgrade** or only ordinary HTTP. It matters because the terminal is the
WebSocket — a gate that let the upgrade through would protect the page and
nothing else.

It gates both. But it refuses in three different shapes, and only one of them is
the status code you would predict.

## Guidance

**Measure the refusal, don't assume it.** Against live ttyd 1.7.4:

| Request | Without the header | With it |
|---|---|---|
| `GET /` (curl) | `407` | `200` |
| WebSocket upgrade (curl) | connection torn down, empty reply (curl exit 52) | `101 Switching Protocols` |
| `GET /` (Node `fetch`) | **throws `TypeError: fetch failed`** | `200` |

The upgrade refusal is not a status code at all. ttyd closes the connection, so a
client sees an empty reply rather than a response to inspect. A test written as
`expect(res.status).toBe(407)` cannot express that case, because there is no
`res`.

**Node's global `fetch` throws on `407` specifically.** This is the part that
will waste an afternoon. It is not ttyd, and not WebSockets — it is the status
code. Isolated against a bare `node:http` server that does nothing but set a
status:

```js
401 -> fetch returned status 401
403 -> fetch returned status 403
407 -> fetch THREW: fetch failed
```

`407` is *Proxy Authentication Required*, and undici (Node's `fetch`
implementation) treats it as a protocol error when no proxy is configured, rather
than as a response to hand back. So the same probe that returns a tidy `407`
under `curl` throws under Node — and the thrown error says only `fetch failed`,
with an empty `cause`, naming nothing that would point you at the status.

**Assert the property you actually care about.** For a gate, that property is
"not admitted", which is true of all three shapes. Something like:

```js
// Admitted? Only a 2xx counts. Everything else — 407, a torn-down
// connection, a thrown TypeError — is the gate doing its job.
let admitted = false
try {
  const res = await fetch(url, { headers })
  admitted = res.ok
} catch {
  admitted = false          // tear-down and undici's 407 throw both land here
}
expect(admitted).toBe(false)
```

Then prove the assertion is not vacuous by running the same probe **with** the
header and requiring `admitted === true`. Without that second half, the negative
case passes just as well when the port is closed, the binary is missing, or the
process never started.

## Why This Matters

A gate test that asserts one refusal shape is testing your model of the refusal,
not the gate. The three shapes here differ by request type *and* by HTTP client,
so a test can be green on the developer's machine and blind on CI, or green under
`curl` and broken under the runtime it actually runs in.

The `407` behaviour is worse than a nuisance because the error is silent about
its own cause. `TypeError: fetch failed` with an empty `cause` is what you get
for a DNS failure, a refused connection, a TLS mismatch, and this — so the
natural reading is "the server isn't up", which sends you to debug the wrong
thing entirely.

## When to Apply

- Any test that probes a service to confirm it refuses something. Assert
  "not admitted", then prove the probe can succeed.
- Any time a probe against a running service throws `TypeError: fetch failed`
  with an empty `cause`. Check the status code with `curl -o /dev/null -w '%{http_code}'`
  before assuming a connection problem.
- Choosing a status code for a gate you are writing. `407` will be thrown by Node
  clients rather than returned; `401` or `403` are handled normally and say what
  you mean.

## Examples

The probe that produced the table above, reproducible in full:

```bash
ttyd -i 127.0.0.1 -p 8901 -H X-Tinstar-Proxy -W bash &

curl -s -o /dev/null -w 'http=%{http_code}\n' http://127.0.0.1:8901/
# http=407
curl -s -o /dev/null -w 'http=%{http_code}\n' \
  -H 'X-Tinstar-Proxy: tinstar-session-proxy' http://127.0.0.1:8901/
# http=200

# The upgrade, unheadered — exit 52 is "empty reply from server"
curl -s -i -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Sec-WebSocket-Protocol: tty' http://127.0.0.1:8901/ws
# (no output; exit 52)

# Same upgrade, headered
curl -s -i -H 'X-Tinstar-Proxy: tinstar-session-proxy' -H 'Connection: Upgrade' \
  -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
  -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' \
  -H 'Sec-WebSocket-Protocol: tty' http://127.0.0.1:8901/ws
# HTTP/1.1 101 Switching Protocols
```

Note the flag's shape: `-H` takes the header **name** only. Passing
`-H 'Name: value'` is a malformed argument, and the resulting behaviour looks
like the gate is broken rather than like the probe is.

## Related

- `docs/solutions/conventions/verify-a-guard-by-breaking-it.md` — the second half
  of the assertion above (prove the probe can succeed) is that practice: a
  refusal test that passes when the service is simply down is a description, not
  a guard.
- `docs/solutions/conventions/assert-against-the-real-parser-not-your-model-of-it.md`
  — the same lesson one level up. Everything in the table was measured against a
  real ttyd and a real Node runtime, because no amount of reasoning about `-H`
  would have predicted that one status code throws while its neighbours do not.
