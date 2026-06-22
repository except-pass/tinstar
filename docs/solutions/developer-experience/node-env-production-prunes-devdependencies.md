---
title: "NODE_ENV=production silently prunes devDependencies and breaks the local toolchain"
date: 2026-06-18
category: developer-experience
module: local-developer-toolchain
problem_type: developer_experience
component: development_workflow
severity: high
applies_when:
  - NODE_ENV=production is exported in the interactive shell
  - Running npm install or npm ci during an active development session
  - Invoking tsc, vitest, or vite via npx after such an install
symptoms:
  - npm install silently prunes devDependencies (typescript, vite, vitest)
  - "npx tsc resolves to a sham package printing: This is not the tsc command you are looking for"
  - "npx vitest run fails with ERR_MODULE_NOT_FOUND: Cannot find package 'vite'"
  - React component tests fail with spurious act(...) is not supported in production builds of React
root_cause: config_error
resolution_type: environment_setup
related_components:
  - tooling
  - testing_framework
tags:
  - node-env
  - npm-install
  - devdependencies
  - vitest
  - typescript
  - toolchain
  - local-dev
---

# NODE_ENV=production silently prunes devDependencies and breaks the local toolchain

## Context

On this development machine the interactive shell exports `NODE_ENV=production`. When an
agent (or a person) runs `npm install <pkg>` to add a dependency, npm treats
`NODE_ENV=production` as an implicit `--omit=dev` and **re-resolves `node_modules` without
devDependencies**, removing the ones already on disk. The trigger that surfaced this was a
plain `npm install remark-breaks` run mid-task: it exited 0, but quietly stripped
`typescript`, `vite`, and `vitest` out of `node_modules`. Every subsequent `tsc`/`vitest`
command then failed with errors that looked like broken config or a missing package — not
like an environment problem — costing real debugging time before the cause was spotted.

Prior sessions had already met the *vitest* half of this trap (the spurious "act is not
supported" failures) and institutionalized `unset NODE_ENV` for test runs, but none had
hit or documented the **devDependency-prune + sham-`tsc`** mechanism — that is what this
entry captures. (session history)

## Guidance

On this machine, **prefix every toolchain command with `env -u NODE_ENV`** so the variable
is unset for that one invocation:

```bash
env -u NODE_ENV npm install <pkg>
env -u NODE_ENV npx tsc --noEmit -p tsconfig.app.json
env -u NODE_ENV npx vitest run --exclude='e2e/**' <path>
env -u NODE_ENV npx vite build --outDir dist/client
```

**Prefer the project's npm script aliases over bare `npx`** — `npm run typecheck`,
`npm run test:unit`, `npm run build`. npm scripts put `node_modules/.bin` on `PATH`, so
they resolve the *local* `tsc`/`vitest` binaries and will never silently fetch the remote
sham `tsc` package; if devDeps are missing they fail loudly with "command not found"
instead. (You still want `env -u NODE_ENV` in front of them to avoid the vitest
production-build noise.) (session history)

**When tsc or vitest goes red unexpectedly, check the environment before the code:**

```bash
echo $NODE_ENV          # if this prints "production", suspect the env, not your change
```

**Restore after a prune** — if devDependencies have already been stripped:

```bash
env -u NODE_ENV npm install --include=dev
env -u NODE_ENV npx tsc --version   # should print "Version X.Y.Z", not the sham message
```

## Why This Matters

`npm`'s `NODE_ENV=production` → `--omit=dev` behavior is a documented footgun, but it is
especially damaging in an agentic workflow:

1. **The prune is silent.** `npm install` exits 0 with no warning that devDependencies were
   removed.
2. **The fallout mimics a code/config bug.** The sham-`tsc` message and the missing-`vite`
   error read like a broken `tsconfig` or a missing `package.json` entry, so they are easy
   to misdiagnose.
3. **Any install re-prunes.** Adding even a single production dependency re-resolves the
   whole tree without devDeps — they don't drift back in on their own; once gone they stay
   gone until explicitly restored with `--include=dev`.
4. **Tests look red when they're green.** Even with devDeps present, `NODE_ENV=production`
   makes React component tests fail with `act(...) is not supported in production builds of
   React` — a false alarm. (auto memory [claude])

## When to Apply

- Every `npm install` / `npm ci` on this machine.
- Every `npx tsc` invocation (type-checking, build verification) — or use `npm run typecheck`.
- Every `npx vitest run` invocation — or use `npm run test:unit`.
- Every `vite build` invocation.
- Any time a `tsc` or `vitest` result is red and the failure does not match the change you
  made — run `echo $NODE_ENV` before diagnosing further.

## Examples

**Failing — plain invocation under `NODE_ENV=production` (after an install pruned devDeps):**

```bash
npx tsc --noEmit -p tsconfig.app.json
# Output: "This is not the tsc command you are looking for"
# (npx fetched the unrelated sham 'tsc' package; the real TypeScript bin was pruned)

npx vitest run src/foo.test.ts
# Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite'
#   imported from .../node_modules/.vite-temp/vite.config.ts...
```

**Restore, then verify:**

```bash
env -u NODE_ENV npm install --include=dev      # devDeps reinstalled
env -u NODE_ENV npx tsc --version              # prints a real version, not the sham
```

**Working — env-prefixed (or via the script aliases):**

```bash
env -u NODE_ENV npx tsc --noEmit -p tsconfig.app.json     # exit 0
env -u NODE_ENV npx vitest run --exclude='e2e/**' src/    # tests pass, no false "act" noise
# equivalently:
env -u NODE_ENV npm run typecheck
env -u NODE_ENV npm run test:unit
```

## Related

- `docs/testing.md` — the project's testing guide; it documents the `vitest --exclude='e2e/**'`
  and `tsconfig.app.json` invocations but does **not** yet warn about the `NODE_ENV`
  trap. A one-line cross-reference there would make this fix discoverable at the point of use.
- Agent memory: `reference_vitest_node_env_production` (machine-local Myelin/auto-memory)
  captures the same trap for quick recall. (auto memory [claude])
