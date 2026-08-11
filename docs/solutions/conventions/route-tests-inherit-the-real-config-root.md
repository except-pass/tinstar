---
title: "A route-handler test with no isolation pin will rewrite your real ~/.config/tinstar"
date: 2026-08-11
category: conventions
module: testing
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - Writing or reviewing a unit test that drives a real HTTP route handler whose code path resolves config through getConfigRoot()
  - Adding a server-side test file that can reach real disk state or a real external integration
  - Auditing or changing tests/setup.ts for what environment it pins by default
tags:
  - test-isolation
  - config-root
  - reach
  - env-pinning
  - test-setup
---

# A test that drives a real handler inherits every ambient dependency that handler resolves

## Context

`src/server/api/__tests__/routes.reach.test.ts` is a route test. It stands up a throwaway `node:http` server, points it at the real router (`handleRequest`), and asserts status codes for `POST /api/reach` — 400 on a bad body, 403 on a foreign Origin, 415 on `text/plain`, 200 on the accepted shapes. Nothing in the file mentions the filesystem, a config directory, or Tailscale.

It mutated the developer's real machine anyway.

The chain is four hops, none of them visible in the test file:

1. The route handler resolves the coordinator lazily: `src/server/api/routes.ts:2651` calls `getReachCoordinator()`, then `src/server/api/routes.ts:2656` calls `coordinator.disable()` for `{"enabled":false}`.
2. `getReachCoordinator()` builds a process-wide singleton whose config root is whatever ambient resolution says it is — `configRoot: getConfigRoot()` at `src/server/reach/index.ts:51`, with the default provider `new TailscaleReachProvider()` at `src/server/reach/index.ts:48`.
3. `getConfigRoot()` (`src/server/configRoot.ts:15-23`) honors `TINSTAR_CONFIG_HOME`, then the legacy `TINSTAR_DATA_DIR`, then falls back to `join(homedir(), '.config', 'tinstar')` at `src/server/configRoot.ts:22`.
4. `ReachCoordinator.disable()` writes the operator's stored opt-in first — `writeReachPreference(this.configRoot, { enabled: false, ... })` at `src/server/reach/coordinator.ts:114` — and then calls `revokeOurMapping()` at `src/server/reach/coordinator.ts:115`.

The repo's global vitest setup (`tests/setup.ts`, wired in at `vite.config.ts:32`) pinned neither variable, so hop 3 landed on `~/.config/tinstar` — the real one. `writeReachPreference` does `mkdirSync` + write-temp-then-rename with mode `0600` (`src/server/reach/state.ts:71-76, 83-91`), so the run created the directory it needed and left a file behind.

The evidence was exactly that file. `~/.config/tinstar/reach/preference.json` existed on the dev machine containing `{"version":1,"enabled":false,"provider":"tailscale"}`, with an mtime of 09:54 — a moment when no operator had run `tinstar reach off`. The unit suite wrote it.

The write is the mild half. `revokeOurMapping()` reads the recorded mapping and returns `{ kind: 'nothing' }` when there is none (`src/server/reach/coordinator.ts:243-244`) — which is why this particular machine only lost a preference file. On a machine where reach was actually established, `mapping.json` exists, and the ownership check is `mappingIsOurs(recorded, this.instanceId)` (`src/server/reach/coordinator.ts:245`) where `instanceId` is `sha256(configRoot).slice(0,16)` (`src/server/reach/state.ts:52-54`). The test inherited the real config root, so it also inherited the real instance identity: the ownership guard would have said *yes, this mapping is yours*, and `provider.revoke(...)` at `src/server/reach/coordinator.ts:247` would have run `TailscaleReachProvider.revoke` (`src/server/reach/tailscale.ts:203-209`) → `serveRevokeArgv` → `['serve','--bg','--yes','--https=443','off']` (`src/server/reach/tailscale.ts:53-55`) executed as `sudo -n /usr/bin/tailscale …` (`src/server/reach/tailscale.ts:118-125`, `TAILSCALE_BIN` at `src/server/reach/tailscale.ts:35`).

So: on a configured machine, `npm run test:unit` (`package.json:44`) would have taken that host's live tailnet URL down, non-interactively, with no prompt and no output that looked like a failure.

Every assertion in the file passed the entire time. The defect was found by an adversarial reviewer reading the diff. No test found it, and no test could have — the assertions were about status codes, and a status code is identical whichever filesystem produced it.

## Guidance

**Treat "this test drives a real handler" as "this test inherits every ambient dependency that handler resolves at runtime."** Ambient dependency means anything the code under test looks up for itself rather than being handed: `homedir()`, `process.env`, a module-level singleton, a default constructor argument, an external binary on `PATH`. The test file named no config path; the path arrived three layers down through `getReachCoordinator()`'s default argument and `getConfigRoot()`'s fallback. Read the handler's transitive resolution, not the test's imports.

**Make isolation the default, not an opt-in.** The failure mode is *forgetting*, and a per-test opt-in only protects the tests whose authors already thought about it. The fix pins a temp root globally in `tests/setup.ts:20-22` when nothing is pinned already, and lets an explicit value win so a test can still choose a root it controls and assert against it.

There is a mechanical reason the default must be global here, not just a philosophical one. `src/server/logger.ts:5-8` resolves `getConfigRoot()` and calls `mkdirSync(LOG_DIR, …)` **at module load**, and `ReachCoordinator` imports it (`src/server/reach/coordinator.ts:2`). A `beforeEach` that sets `TINSTAR_CONFIG_HOME` runs *after* the test file's imports have already been evaluated, so it cannot redirect the logger — it is structurally too late. Vitest `setupFiles` run before the test module graph is imported, which is the only place a pin catches load-time capture.

**Do not treat green as evidence of containment.** An assertion about a response body cannot see which filesystem, config directory, daemon, or account the code reached on the way to producing it. If containment matters, assert containment directly — a positive test that the side effect landed *inside* the test's own root, which goes red the moment the pin is removed.

**Size the risk by what the handler can reach, not by what the test asserts.** Here the reachable surface included a `sudo -n` shell-out to a privileged external command. "A test wrote a file" and "a test revoked production remote access" were the same code path on two differently-configured machines.

### Diagnostic: does your suite have this?

Two commands, both concrete. Run them on a machine with a populated real config root — that is where the problem is visible.

**1. Watch the real config root across a full run.** Stop any dev server first (a running backend appends to `server.log` and would produce a false positive):

```bash
touch /tmp/suite-marker
npm run test:unit
find ~/.config/tinstar -newer /tmp/suite-marker
```

Empty output is the pass. Anything listed was written by the unit suite, and the path names the subsystem that escaped. This is exactly how the fix was confirmed: the suspect file's mtime stayed at 09:54 across a full suite run that completed at 10:16.

Strengthen it by widening the net if you suspect other roots (`~/.config`, `~/.local/state`, a cache dir):

```bash
find ~/.config ~/.local -newer /tmp/suite-marker -type f 2>/dev/null
```

**2. Measure the gap between "drives real code" and "mentions isolation."** In this repo, right now:

```bash
grep -rln "handleRequest" --include='*.test.ts' src tests | wc -l                      # 32
grep -rln "TINSTAR_CONFIG_HOME\|getConfigRoot" --include='*.test.ts' src tests | wc -l  # 7
```

Thirty-two test files drive the real router; seven mention the config root at all. That gap is not itself a bug — most of those routes touch only in-memory state — but it is the population where hop 3 can happen unnoticed, and it is why the safe default belongs in `tests/setup.ts` rather than in twenty-five individual files. For scale on the other side, both reproducible:

```bash
grep -rn 'getConfigRoot()' --include='*.ts' src/server | grep -vE '__tests__|\.test\.ts' | wc -l   # 21 grep hits, 18 real call sites
grep -rln 'node:child_process' --include='*.ts' src/server | grep -vE '__tests__|\.test\.ts' | wc -l  # 19
```

The first number needs reading with care: 21 is the raw hit count, which includes the function's own definition and two mentions inside doc comments. Eighteen are genuine call sites. That gap is the reason to show the command rather than the number.

The second command is the one to re-run after adding any new ambient root (a new env var, a new cache directory): it tells you how many tests would silently inherit it.

**Real oracle, isolated environment — two different axes.** This repo already
documents the opposite-sounding advice: `assert-against-the-real-parser-not-your-model-of-it.md`
argues that when an external tool consumes your artifact, you must invoke the real
tool, because a matcher you wrote yourself shares your blind spots. Read as a
slogan, "invoke the real thing" is exactly the license that produced this bug.

The two are not in conflict, but the distinction has to be said out loud because
nothing else in the corpus names it, though the reach-grant tests already practise it:

- **The oracle** is what you check correctness *against*. Prefer the real one —
  a hand-rolled model of `visudo` agrees with its author, not with sudoers.
- **The environment** is what the code under test is allowed to *touch* while you
  check it. Isolate it — a real config root, a real daemon, and a real `sudo`
  are side effects, not evidence.

Wanting both is coherent and usually correct: call the real handler so the test
can fail for real reasons, and sandbox every path it can mutate so "real" never
means "live". The reach-grant tests are the model — they shell out to a genuine
`visudo` for the verdict, against a rule written to a temp file that nothing else
can see.

## Why This Matters

The cost is not "a stray file in a home directory." It is three compounding properties:

- **The blast radius is set by the handler, not the test.** A route test looks cheap and self-contained. This one could reach `sudo -n /usr/bin/tailscale serve … off`. Whatever the most destructive thing on the handler's transitive call graph is, that is the worst case of the test, regardless of what it asserts.
- **The failure is invisible to the mechanism meant to catch failures.** The suite was green before and after. Status-code assertions are blind to their own side effects, so the normal feedback loop — write test, run test, trust green — reports success on a run that damaged the machine it ran on.
- **Ownership guards do not save you, because the test inherits identity too.** `ReachCoordinator` has a real, deliberate guard against clobbering another instance's mapping (`src/server/reach/coordinator.ts:245`, identity derived at `src/server/reach/state.ts:52-54`). It failed to help precisely because it derives identity *from the config root* — and the config root was the thing that leaked. A guard keyed on the same ambient value that leaked is not a second line of defense.

There is also a trust cost specific to this feature. Reach is an explicit operator opt-in (`enable()` writes the preference at `src/server/reach/coordinator.ts:95`, and the comment there says the preference persists so a transient provider outage does not discard the decision). A test suite silently rewriting that preference converts a deliberate, remembered choice into something that quietly reverts — and the operator's next restart would find reach off with no record of who asked.

Worth noting the asymmetry that let this survive: the E2E harness has isolated from the start. `docs/testing.md` documents `TINSTAR_DATA_DIR` defaulting to `/tmp/tinstar-test-<timestamp>` per Playwright run. Unit tests got no equivalent, because "unit test" carries an implicit promise of being pure that route tests do not keep.

## When to Apply

- Writing or reviewing any test that calls a real router, controller, handler, or CLI entrypoint rather than a hand-constructed unit.
- Any time production code resolves a path, root, or client through a default argument, module-level singleton, or `process.env` fallback — `getConfigRoot()` here, but the same applies to database URLs, cache directories, credential files, and API base URLs.
- Adding a new test setup file, or a new global env var that selects between a real and an isolated resource. Pin the safe value by default in `tests/setup.ts`.
- Reviewing a diff that adds a test which POSTs, PUTs, PATCHes, or DELETEs against a real handler. Trace the write to a concrete path before approving. Read paths are much lower risk; writes and shell-outs are where this bites.
- Whenever a subsystem can shell out (`node:child_process`), especially with `sudo`. Prime the singleton with an inert adapter in the test rather than trusting that the external binary is absent on every developer's machine.

## Examples

### Before — the test file that mutated the real machine

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { handleRequest, type RouteContext } from '../routes'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../originAllowlist'

afterEach(() => {
  resetOriginAllowlistForTests()
})
// …
await new Promise<void>(r => server.listen(0, r))
// …
it('admits a same-origin browser request', async () => {
  seedOriginAllowlist(5273)
  const { status } = await post('{"enabled":false}', { ...JSON_CT, Origin: 'http://localhost:5273' })
  expect(status).toBe(200)
})
```

No config root, no provider, no mention of Tailscale. `expect(status).toBe(200)` passed — and reaching that 200 required `disable()` to write to `~/.config/tinstar/reach/preference.json`. (`server.listen(0, r)` also bound the throwaway server on every interface.)

### After — the global default

`tests/setup.ts:20-22`, currently the whole of the file's own logic (line 1 is a side-effecting import that registers matchers):

```ts
if (!process.env.TINSTAR_CONFIG_HOME && !process.env.TINSTAR_DATA_DIR) {
  process.env.TINSTAR_CONFIG_HOME = mkdtempSync(`${tmpdir()}/tinstar-test-config-`)
}
```

Both variables are checked because `getConfigRoot()` honors both, in that order (`src/server/configRoot.ts:16-21`); checking only the first would let a legacy `TINSTAR_DATA_DIR` run unpinned. The condition is `if not already set` rather than an unconditional assignment, which is what preserves the per-test opt-in below and keeps CI free to point the suite wherever it likes.

### After — the per-test root and the inert provider

`src/server/api/__tests__/routes.reach.test.ts:23-35`:

```ts
beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), 'tinstar-reach-route-'))
  process.env.TINSTAR_CONFIG_HOME = configRoot
  resetReachCoordinatorForTests()
  // Prime the singleton with the adapter that never talks to a real daemon.
  getReachCoordinator(unconfiguredReachProvider)
})

afterEach(() => {
  resetOriginAllowlistForTests()
  resetReachCoordinatorForTests()
  rmSync(configRoot, { recursive: true, force: true })
})
```

Three separate mechanisms, each closing a different hole:

- **The per-test root** keeps cases independent of each other (the global pin in `tests/setup.ts` is one directory shared by the whole run).
- **`resetReachCoordinatorForTests()`** (`src/server/reach/index.ts:59-61`) is required on both sides. The coordinator is a `let coordinator: ReachCoordinator | null` at `src/server/reach/index.ts:44` that captures `configRoot` in its constructor (`src/server/reach/coordinator.ts:63`). Without the reset the first test's root would be baked into every later test in the process, outliving the `rmSync` that deleted it.
- **`getReachCoordinator(unconfiguredReachProvider)`** primes the singleton before the route can build the default one. `unconfiguredReachProvider` (`src/server/reach/index.ts:26-33`) has a `revoke` that does nothing and a `currentMappings` that returns `[]`, so no code path can reach a real daemon even if a mapping record somehow appeared.

The listen call also became `server.listen(0, '127.0.0.1', r)` (`src/server/api/__tests__/routes.reach.test.ts:45`) — a test server that accepts `POST /api/reach` should not be reachable from the LAN for the seconds it is up.

### After — the assertion that makes isolation falsifiable

`src/server/api/__tests__/routes.reach.test.ts:101-113`:

```ts
describe('the route tests do not touch the real config root', () => {
  it('writes the preference it changes into this test\'s own root', async () => {
    seedOriginAllowlist(5273)
    expect((await post('{"enabled":false}', JSON_CT)).status).toBe(200)
    expect(existsSync(join(configRoot, 'reach', 'preference.json'))).toBe(true)
    expect(process.env.TINSTAR_CONFIG_HOME).toBe(configRoot)
    expect(configRoot.startsWith(tmpdir())).toBe(true)
  })
})
```

This is the piece that turns a comment into a guard. It does not assert "nothing bad happened" — that is unprovable from inside the process. It asserts the positive: the write this route performs landed *here*, under a temp root, in this test's own directory. Delete the pin in `beforeEach` and this goes red while every status-code assertion in the file stays green — which is precisely the discrimination the original file lacked.

### Confirming it on a real machine

The independent check, run outside the suite:

```bash
$ cat ~/.config/tinstar/reach/preference.json
{"version":1,"enabled":false,"provider":"tailscale"}
$ stat -c '%y %n' ~/.config/tinstar/reach/preference.json
2026-08-11 09:54:38 … /home/…/.config/tinstar/reach/preference.json
```

That mtime was written by a test run, not an operator. After the fix, a full suite run completing at 10:16 left it at 09:54 — unchanged. The absence of a new mtime is the actual proof; the passing suite never was.

## Related

- `docs/solutions/conventions/assert-against-the-real-parser-not-your-model-of-it.md` — the
  same feature area, the opposite-seeming rule, and the reason the "Real oracle,
  isolated environment" section above exists. Invoke the real consumer for the
  verdict; do not let that become license to let the code under test reach live state.
- `docs/solutions/conventions/guest-env-boundary.md` — the nearest neighbour in the
  corpus and prior art for this exact failure genus: during that investigation a
  `kill-server` without `-L` "killed the developer's live sessions". Different
  mechanism (a child process inheriting the parent's env, versus a test inheriting a
  process-global config path), same conclusion — isolation has to be structural,
  because the failure mode is forgetting.
- `docs/solutions/conventions/verify-a-guard-by-breaking-it.md` — the same shape from the other direction. The isolation test above was written to fail when the pin is removed, which is that practice applied: if you cannot describe the edit that turns a test red, it is a description, not a guard.
- `docs/conventions.md` — "Server-side config paths go through `getConfigRoot()` — not `homedir()`." That rule is what makes a single global pin sufficient; it is also what makes the fallback at `src/server/configRoot.ts:22` a single point of leakage worth guarding centrally.
- `docs/testing.md` — the E2E isolation contract (`TINSTAR_DATA_DIR` per Playwright run). The unit suite now has the equivalent, one layer down.
- Local, unpushed on `feat/tailnet-remote-reach`: the fix commit is titled `fix(tests): stop the unit suite writing to the real ~/.config/tinstar` and touches only `tests/setup.ts` and `src/server/api/__tests__/routes.reach.test.ts`. No PR exists yet; describe the change rather than citing the SHA, which a squash-merge will rewrite.
