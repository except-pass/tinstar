# Contributing

How work flows through this repo. The short version: **`main` is the primary
development branch, every feature lands as its own small PR, and production
releases are tags cut from `main`.**

This replaces the old "one accumulating `V5.x` dev branch that merges to `main`
at release" model. There are no long-lived dev branches anymore — `main` is
where development happens, and it stays releasable.

## The flow at a glance

```
main ──●────●────●────●────●────●──────●─────►   (always releasable)
        \        \        \             │
   feat/x PR  fix/y PR  feat/z PR      tag vN.N.0  ──► npm + desktop release
   (squash)   (squash)  (squash)
```

1. Branch off `main`.
2. Build one feature (or one fix). Keep it small and self-contained.
3. Open a PR targeting `main`.
4. Pass the gate (typecheck + build + tests), get it green in CI.
5. **Squash-merge** into `main`.
6. Releases are cut from `main` on their own cadence — see [releasing.md](releasing.md).

## Branches

- Branch off the latest `main`.
- Name branches `<type>/<short-description>`, where `<type>` matches the
  Conventional-Commit types below: `feat/widgets-resize`,
  `fix/telemetry-wal-replay`, `docs/git-flow`, `chore/bump-deps`.
- **One feature or fix per branch.** If you find yourself writing "and also" in
  the PR title, it's probably two PRs. Small PRs review faster, revert cleanly,
  and keep `main`'s history legible.
- Don't accumulate unrelated work on a long-lived branch — that's the monster-PR
  habit this flow exists to kill.

## Pull requests

- **Target `main`.** Never `master` (we don't use it), never a release branch
  (there are none).
- **Title is a Conventional Commit** — `type(scope): summary`. On squash-merge
  this title *becomes* the commit message on `main`, so write it for the person
  reading `git log` in six months. Types: `feat`, `fix`, `docs`, `refactor`,
  `test`, `chore`, `perf`, `build`, `harden`.
- **Body**: what changed and why, plus how you verified it. Link any issue or
  roborev finding it closes.
- **Keep it green before asking for review.** Run the gate locally (below); CI
  (`typecheck-and-test`) re-runs it on the PR and a red check blocks merge.
- Address review feedback on the branch; force-push is fine on your own feature
  branch (no one else builds on it).

## The pre-merge gate

Run before marking a PR ready — this is exactly what CI enforces:

```bash
npm run typecheck                      # app + e2e + test tsconfigs — must be 0 errors
npm run build:all                      # vite client + esbuild server — what actually ships
npx vitest run --exclude='e2e/**'      # unit/integration tests
```

Two traps worth restating (both have bitten releases):

- **`npm run typecheck`, not `tsc -p tsconfig.app.json`.** The script checks
  *three* projects (`tsconfig.app.json` + `tsconfig.e2e.json` +
  `tsconfig.test.json`). App-only `tsc` stays green while a type error in a
  `*.test.tsx` red-lights CI. The whole baseline is zero errors.
- **`build:all` is the ship gate, not `tsc`** — releases ship the `vite build` /
  `esbuild` output, not `tsc` emit. If you touched server code, a stale
  `dist/server` won't reflect it until you rebuild (see
  [conventions.md](conventions.md) on the rebuild-required traps).

If your change is environment-sensitive, prefix tooling with `env -u NODE_ENV`
(`NODE_ENV=production` in the shell breaks vitest and prunes devDeps).

## Squash-merge

Feature PRs merge with **squash** (`gh pr merge <N> --squash`):

- One commit per feature on `main` → linear, scannable history; trivial to
  `git revert` a single feature.
- The PR title is the squashed commit subject — so it must stand alone.
- Co-author trailers (e.g. `Co-Authored-By:`) are preserved by GitHub's squash.

> Note: the *release* merge in the old flow used `--merge` to preserve an
> accumulating branch's history. That branch no longer exists, so that exception
> is gone — feature PRs always squash.

## Versioning between releases

`main` sits at the **next** version with a `-dev.N` suffix (e.g. `5.3.0-dev.0`)
between releases. The suffix is deliberate: it keeps an accidental `npm publish`
off the `latest` tag. **Feature PRs do not touch the version** — the version
only changes when a release is cut (the bump to plain `N.N.0` *is* the release,
after which `main` is bumped to the next `-dev.0`). Full mechanics live in
[releasing.md](releasing.md).

## Releases

Production releases still work the way they always have — tagged `vN.N.0`,
published to npm, desktop binaries built by CI — they're just **cut directly
from `main`** now instead of from an accumulating dev branch. One release can
bundle many feature PRs; the release notes are the map of what shipped. See
**[releasing.md](releasing.md)** for the gated, step-by-step process (including
the trap that `@tinstar/plugin-api` is a separate, conditionally-published npm
package).
