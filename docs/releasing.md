# Releasing

How a `tinstar` release is cut. The steps are gated, in order — each one has a *why* so it survives without tribal memory. The headline trap is at the bottom: **the plugin API is a separate npm package and ships on its own gate.**

A release is **cut directly from `main`**: a version-bump commit, tagged `vN.N.0`, then published to npm. `main` is the primary development branch — features land continuously as their own squashed PRs (see [contributing.md](contributing.md)), and a release bundles whatever has accumulated on `main` since the last tag. There is no longer a long-lived `V5.x` dev branch.

---

## Pre-flight (the real gate)

Run from the release branch before marking the PR ready:

```bash
npm run check:case    # case-only filename collisions — see note below
npm run typecheck     # app + e2e + test tsconfigs — must be 0 errors
npm run build:all     # vite client + esbuild server — this is what actually ships
npx vitest run --exclude='e2e/**'
```

- **`npm run check:case` — the v5.2.0 lesson.** v5.2.0 shipped `PinsBridge.tsx` next to `pinsBridge.ts` in one directory. The extensionless import resolved fine on the Linux CI runner but matched the wrong file on the macOS/Windows *release* runners, so `vite build` failed there, the release-build matrix failed, and **no GitHub Release was ever published — silently**, because Linux-only CI stayed green. This guard (now also a step in `ci.yml` on every PR, and a pre-build step in `release.yml`) fails loudly on any case-only collision before it can reach a tag. `scripts/check-case-collisions.mjs`.

- **`npm run typecheck`, not `tsc -p tsconfig.app.json`.** The script runs *three* projects (`tsconfig.app.json` + `tsconfig.e2e.json` + `tsconfig.test.json`). App-only `tsc` is green while a type error in a `*.test.tsx` file still fails CI — the test project is part of the zero baseline. *Caught a release once:* a non-null index-access error in a new test passed local app-tsc and red-lit the PR.
- `build:all` is the ship gate, not `tsc` — releases ship the `vite build` output, not `tsc` emit.
- CI (`typecheck-and-test`) re-runs all of this on the PR. Don't merge with red checks.

## Version bump

Bump every version stamp to `N.N.0` in one commit and regenerate lockfiles:

- `package.json` (the `tinstar` app)
- `packages/plugin-api/package.json` (`@tinstar/plugin-api`)
- `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`
- `npm install --package-lock-only` (root `package-lock.json`) + `cargo` regen of `Cargo.lock`

Between releases `main` sits at `N.N.0-dev.0` — the `-dev.0` suffix is deliberate: it keeps an accidental `npm publish` off the `latest` tag. The bump to plain `N.N.0` *is* the act of cutting the release. Right after tagging, bump `main` to the next `(N.N+1).0-dev.0` so it's back to a dev version.

## Release notes

Write `docs/release-notes-vN-N.md` — a pointer-map of *why* each theme exists, anchored on ADRs, matching the voice of the prior notes. Single source of truth for "what's in this release"; the PR body links it, doesn't duplicate it.

## Merge & tag

1. Land the version bump on `main` as its own small PR (`chore(release): vN.N.0`), squash-merged like any other PR. The feature PRs that make up the release already landed individually — there's no accumulating branch to preserve, so the release PR squashes like the rest.
2. Tag the resulting `main` commit and push:
   ```bash
   git fetch origin
   git tag -a vN.N.0 origin/main -m "Release vN.N.0"
   git push origin vN.N.0
   ```
   Tagging on `origin/main` lets you tag without checking out `main` — leaves a live `:5273` dev tree on its branch undisturbed. The tag triggers `release.yml` → desktop binaries + the GitHub Release.
3. **Watch the release run — do not assume it passed.** `release.yml` runs a 3-OS build matrix (macOS/Windows/Linux) and the GitHub Release is only published if *all three* pass (`release` is `needs: build`). A green `main` CI does **not** prove the macOS/Windows Tauri build passed — that asymmetry is exactly how v5.2.0 failed unnoticed. Block on it:
   ```bash
   gh run watch "$(gh run list --workflow=release.yml -L1 --json databaseId -q '.[0].databaseId')" --exit-status
   gh release view vN.N.0   # confirm it exists and has the 5 binaries attached
   ```
   If the run fails, **no release was created** — fix forward and cut the next patch (`vN.N.1`); don't leave a tag with no release behind it.

## Publish to npm — TWO packages, each gated

`npm publish` needs the publisher logged in **and an OTP** (npm 2FA). Publish from the tagged commit (`git checkout vN.N.0`).

### 1. The app — `tinstar`

```bash
npm publish --otp=NNNNNN
# EOTP? the prepublishOnly rebuild blew npm's 30s OTP window — re-run skipping it:
npm publish --ignore-scripts --otp=NNNNNN
```

Root `package.json` `files` **excludes `packages/`**, so this publish does *not* ship `@tinstar/plugin-api`. That is intentional — see the next gate.

### 2. The plugin API — `@tinstar/plugin-api` — **only if its surface changed**

`@tinstar/plugin-api` is the typed SDK plugin authors compile against. It is a **separate publish** with its own gate. Republish it **iff its shipped surface changed** since the last published version. The shipped surface is exactly `packages/plugin-api/src/index.ts` (the package's `files` is `["src/index.ts","README.md"]` — it ships raw `.ts`, no build).

**Run the gate — don't decide from memory:**

```bash
# last published version:
npm view @tinstar/plugin-api version
# diff the shipped surface against the tag that published it:
git diff vPREV vN.N.0 -- packages/plugin-api/src/index.ts
```

- **Empty diff** → skip. The already-published version still describes the API; bumping it would publish an identical surface under a new number.
- **Non-empty diff** → publish. Plugin authors on `@latest` otherwise can't compile against the new surface. *(v5.1 added the whole `PluginPrimitivesApi` — browser/terminal primitives, accessories — that the stretchplan plugin depends on; skipping it would have left every plugin author unable to use primitives.)*

```bash
cd packages/plugin-api
npm publish --otp=NNNNNN     # publishConfig.access=public — scoped packages default to restricted
```

The `tinstar` org must already exist on npm (scoped name → "Scope not found" otherwise). Do **not** migrate `tinstar` itself to a scope — it owns the bare name and can't be renamed.

---

## Checklist

```
- [ ] Pre-flight green: npm run check:case + typecheck (0) + build:all + vitest
- [ ] Versions → N.N.0 (package.json, plugin-api, tauri.conf.json, Cargo.toml) + lockfiles
- [ ] docs/release-notes-vN-N.md written
- [ ] Version-bump PR (chore(release): vN.N.0) squash-merged to main
- [ ] main bumped to next (N.N+1).0-dev.0 after tagging
- [ ] Tag vN.N.0 pushed → desktop CI + GitHub Release
- [ ] Watched release.yml to green (all 3 OS) + confirmed `gh release view vN.N.0` has 5 binaries
- [ ] npm publish tinstar@N.N.0 (OTP)
- [ ] Gate: git diff vPREV vN.N.0 -- packages/plugin-api/src/index.ts
      → non-empty? npm publish @tinstar/plugin-api@N.N.0 (OTP)   empty? skip, note why
```
