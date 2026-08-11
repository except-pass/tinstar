---
title: "localhost is a name, not an address — bind the loopback pair or the server looks down"
date: 2026-08-11
category: conventions
module: server-config
problem_type: convention
component: server_bootstrap
severity: medium
applies_when:
  - Binding a listener to loopback rather than every interface
  - A server that starts cleanly but is unreachable at http://localhost:PORT
  - Writing a health check or probe that connects to localhost by name
tags:
  - networking
  - loopback
  - ipv6
  - bind
  - dns
---

# localhost is a name, not an address

## Context

Replacing an all-interfaces `listen(port)` with a loopback bind raises a question
that looks trivial and is not: *which* loopback address?

`127.0.0.1` and `::1` are two different addresses. `localhost` is a name that
resolves to some host-dependent subset of them, in a host-dependent order. Bind
one, and a client that resolves `localhost` to the other finds nothing listening
— the server is up, the port is open, and the browser says the connection was
refused.

The tempting move is to determine the order once and bind whichever wins. That
does not survive contact with other machines. Measured on the box this was
written on:

```
$ grep localhost /etc/hosts
127.0.0.1 localhost
::1     ip6-localhost ip6-loopback

$ node -e "require('node:dns').lookup('localhost',{all:true},(e,a)=>console.log(a))"
[ { address: '127.0.0.1', family: 4 } ]
```

Here `localhost` is v4-only, and `::1` is not called `localhost` at all. On a host
whose `/etc/hosts` maps `::1 localhost` — extremely common, and the configuration
that motivated this work — the same lookup returns `::1`, and Node hands it to the
connection first.

Two things make the order genuinely unpredictable rather than merely varied. Node
17 changed the default DNS result order to `verbatim`, so it no longer reorders
IPv4 ahead of IPv6 the way older versions did (`dns.getDefaultResultOrder()`
returns `verbatim` on Node 22). And the mapping itself is per-host
configuration — `/etc/hosts`, `nsswitch.conf`, and the resolver stack can each
change the answer.

## Guidance

**Bind the pair. Do not pick a winner.** `resolveBindTargets` in
`src/server/bind.ts` returns both addresses for the no-host case
(`src/server/bind.ts:73-80`): `127.0.0.1` as `required: true`, `::1` as
`required: false`. Whatever `localhost` resolves to on the operator's machine,
something is listening.

**Make the second address best-effort, not mandatory.** An IPv6-disabled host
must still start. `openListeners` skips a non-required target when the failure
says the address family or address is unavailable — `EAFNOSUPPORT`,
`EADDRNOTAVAIL`, `EPROTONOSUPPORT`, `EINVAL` (`src/server/bind.ts:104-109`).

**`EADDRINUSE` must stay fatal, and that exclusion is load-bearing.** It is the
one error that looks like "this address didn't work" but means something else
entirely: the port is taken. Tolerating it would let the server come up on fewer
addresses than it reported, silently, instead of falling back to the next port.
The comment at `src/server/bind.ts:98-103` says so explicitly, because the
tolerant list is exactly where someone would add it while tidying.

**Roll back a partial bind.** If a required listener fails after an optional one
succeeded, close everything. A half-bound server is worse than one that did not
start: it answers on one address and refuses on another, which reads to the
operator as an intermittent fault rather than a configuration error.

**Report the name, record the address.** The two are for different consumers.
`preferredHost` is `'localhost'` — what a human should type, and what works
regardless of which family won. `hostFileValue` is the `127.0.0.1` literal,
because the file is read by hooks and scripts that need an address they can use
without bracketing rules or a resolver.

## Why This Matters

The symptom points away from the cause. "Server started, listening on port 5273"
followed by a browser that cannot connect reads as a firewall problem, a port
conflict, or a crashed process — every hypothesis except *the name resolved to an
address I am not listening on*. Nothing in the logs mentions address families.

It is also invisible on the machine of whoever writes the code, roughly half the
time. A single-address bind works perfectly on a host whose resolver agrees with
the choice, and fails completely on the next one. That is the worst kind of
defect: not flaky, but deterministic per-machine, so each person is certain about
a different answer.

## When to Apply

- Any change from all-interfaces to loopback binding, in a server, a test
  harness, or a dev proxy.
- Writing a probe or health check that connects to `localhost` by name. It may
  reach either address; if only one is bound, the probe reports the service down.
- Reviewing a list of tolerated network error codes. Check specifically whether
  `EADDRINUSE` is in it, and treat its presence as a defect rather than
  thoroughness.
- Any place a bind address is written to a file, a log line, or a URL shown to a
  person. Decide deliberately whether that consumer needs the name or the
  literal.

## Examples

The default, from `src/server/bind.ts`:

```ts
if (explicit.length === 0) {
  return {
    targets: [
      { host: LOOPBACK_BIND_ADDRESS, required: true },
      { host: LOOPBACK_BIND_ADDRESS_V6, required: false },
    ],
    preferredHost: 'localhost',
    hostFileValue: LOOPBACK_BIND_ADDRESS,
  }
}
```

And the tolerance list, with the deliberate omission:

```ts
function isAddressUnavailable(err: NodeJS.ErrnoException): boolean {
  return err.code === 'EAFNOSUPPORT'
    || err.code === 'EADDRNOTAVAIL'
    || err.code === 'EPROTONOSUPPORT'
    || err.code === 'EINVAL'
}
```

A one-line diagnostic when a service is reportedly up but unreachable — compare
what the name resolves to against what is actually bound:

```bash
node -e "require('node:dns').lookup('localhost',{all:true},(e,a)=>console.log(a))"
ss -tlnp | grep ':5273'
```

If the first prints an address the second does not list, that is the whole bug.

## Related

- `docs/solutions/conventions/an-empty-cors-allowlist-is-a-live-wildcard.md` — the
  seeded browser-origin list carries all three loopback spellings
  (`localhost`, `127.0.0.1`, `[::1]`) for the same reason this doc binds two
  addresses: a browser sends the origin the user typed, and those are three
  different strings for one machine.
