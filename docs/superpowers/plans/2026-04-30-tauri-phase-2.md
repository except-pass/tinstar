# Tauri Packaging Implementation Plan — Phase 2

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Tinstar V4.0 as a native desktop app (Tauri 2.x) that supports the user's primary remote-backend workflow (`infrapoc:5273`) as a first-class mode, plus local-detect and local-managed fallbacks. Unsigned binaries on macOS/Windows/Linux, GitHub-Actions release pipeline, neon splash, in-React first-run setup.

**Architecture recap (from Phase 1, do not redesign):**
- `src/apiClient.ts` reads `window.__TINSTAR_API_BASE__` at module load. Tauri injects via `Window::eval()` *before* the bundle's `<script type="module">` runs.
- `index.html` carries the `<script>window.__TINSTAR_API_BASE__ = '';</script>` placeholder.
- Backend CORS allowlist via `TINSTAR_CORS_ORIGINS`.
- `TINSTAR_CONFIG_HOME` isolates config dirs so a Tauri-spawned local backend cannot collide with the user's `:5273` instance.
- `bin/tinstar.js --no-setup` is non-interactive-safe.
- `scripts/tauri-rehearsal.sh` is the cross-origin smoke harness — Phase 2 inherits its safety patterns (`:5299`, `TINSTAR_CONFIG_HOME=/tmp/...`, literal port in pkill).

**Tauri origin:** in production the webview origin is `tauri://localhost` (macOS/Linux) or `https://tauri.localhost` (Windows). Both must be in the allowlist when `manageBackend=true` *and* whatever scheme the remote backend uses must allow `tauri://localhost` on the remote's `TINSTAR_CORS_ORIGINS` (documented, not enforced here — remote-mode is "user already configured their server").

---

## Phase decomposition

- **Phase 2a — Tauri skeleton (Tasks 0–6)** — `bin/doctor.js --tauri-dev` for build-deps check, `src-tauri/` scaffold, single window, `Window::eval()` injection, hardcoded remote URL pointed at infrapoc:5273. Proves the bundling story end-to-end before any config code exists.
- **Phase 2b — Config + first-run setup (Tasks 7–13)** — `get_config` / `save_config` IPC, `desktop.json` in `app_config_dir()`, React `<FirstRunSetup />`, routing on bootstrap.
- **Phase 2c — Splash screen (Tasks 14–16)** — `splash.html` window, Rust orchestration, dismissal on main webview ready.
- **Phase 2d — Local-mode backend manager (Tasks 17–22)** — reachability probe, `tinstar` shell-out with `TINSTAR_CONFIG_HOME` isolation, child cleanup on quit, "backend unreachable" UX with copyable command.
- **Phase 2e — Build pipeline (Tasks 23–26)** — `npm run tauri:dev` / `tauri:build`, GitHub Actions matrix, README install/run docs for unsigned binaries, V4.0 release tag.

**27 tasks total. Each task = one atomic commit.**

---

## Phase 2 File Structure

**New files:**
- `src-tauri/Cargo.toml` — Rust dependencies (tauri, tauri-build, serde, serde_json, reqwest with rustls).
- `src-tauri/build.rs` — standard tauri-build invocation.
- `src-tauri/tauri.conf.json` — window config, `frontendDist: "../dist/client"`, bundle targets.
- `src-tauri/src/main.rs` — entry point, splash + main window orchestration, command registration.
- `src-tauri/src/config.rs` — desktop.json read/write, schema struct, IPC commands (`get_config`, `save_config`).
- `src-tauri/src/backend.rs` — local-mode reachability probe, `tinstar` child spawn/kill, IPC commands (`probe_backend`, `start_local_backend`, `stop_local_backend`).
- `src-tauri/src/splash.rs` — splash window helpers.
- `src-tauri/splash.html` — neon Chakra Petch splash markup + CSS.
- `src-tauri/icons/` — placeholder icons (Tauri requires them; can be Tinstar `logo.png` resized).
- `src/desktop/firstRunSetup.tsx` — React `<FirstRunSetup />` component.
- `src/desktop/desktopBootstrap.tsx` — entry-point shim that reads config, picks setup vs main, injects `__TINSTAR_API_BASE__`.
- `src/desktop/desktopApi.ts` — typed wrappers around `invoke()` for the Tauri commands. Stubs return `null` outside Tauri so dev/browser still works.
- `src/desktop/types.ts` — `DesktopConfig` TS type, kept in sync with the Rust struct.
- `tests/desktop/desktopApi.test.ts`, `tests/desktop/firstRunSetup.test.tsx`, `tests/desktop/desktopBootstrap.test.tsx`.
- `.github/workflows/release.yml` — multi-OS Tauri build matrix on tag `v*`.
- `docs/desktop-app.md` — install/run docs for unsigned macOS/Windows/Linux binaries.

**Modified files:**
- `src/main.tsx` — delegate to `desktopBootstrap` (still renders `<App />` in browser; bootstrap is a no-op there).
- `package.json` — `tauri:dev`, `tauri:build` scripts, `@tauri-apps/cli` and `@tauri-apps/api` devDependencies.
- `index.html` — no functional changes; double-check the runtime-injection placeholder is still on a single line that Tauri can `eval` ahead of (we only *read* it; we don't rewrite the HTML at install time).
- `README.md` — pointer to `docs/desktop-app.md`.

**Phase 1 files we deliberately do NOT touch:** `src/apiClient.ts`, `src/server/api/cors.ts`, `src/server/api/routes.ts`, `src/server/api/sse.ts`, `src/server/configRoot.ts`, `bin/tinstar.js`, `scripts/tauri-rehearsal.sh`. They are the contract Phase 2 consumes.

---

## Cross-cutting safety rules

Every smoke test in this plan runs against `:5299` with `TINSTAR_CONFIG_HOME=/tmp/...`. The user runs production tinstar on `:5273`; we never start a backend that competes with it. `pkill` patterns must always include the literal `--port 5299` substring. Tauri-spawned backends in local-managed mode also use `:5299` for *all* development/test runs — the production `tauri.conf.json` defaults the local-managed port to 5273, but smoke tests override via `TINSTAR_DESKTOP_TEST_PORT`.

---

# Phase 2a — Tauri skeleton

## Task 0: Extend `tinstar doctor` with `--tauri-dev` build-deps check

End users (downloading .dmg/.msi/.deb/.AppImage) don't need any Tauri-specific libs — the OS has them, or the package manager pulls runtime deps automatically. Developers building from source DO need the `-dev` packages because cargo links against them at build time. This task extends the existing `bin/doctor.js` to surface this requirement clearly.

**Files:**
- Modify: `bin/doctor.js`

- [ ] **Step 1: Read the current doctor**

```bash
cat bin/doctor.js | head -60
```

Confirm the existing pattern: `check(label, fn)` runs `fn`, prints ✓/✗, returns boolean. The doctor already detects platform and runs platform-specific binary checks (claude, tmux, ttyd). Match this pattern.

- [ ] **Step 2: Add the `--tauri-dev` flag and check function**

In `bin/doctor.js`, after the existing checks, add:

```js
function checkTauriDev() {
  const platform = process.platform
  console.log(`\n${BOLD}Tauri build dependencies${RESET} ${DIM}(developers only)${RESET}\n`)

  if (platform === 'darwin') {
    return check('Xcode Command Line Tools', () => {
      const path = execSync('xcode-select -p', { encoding: 'utf-8' }).trim()
      if (!path) throw new Error('Run: xcode-select --install')
      return path
    })
  }

  if (platform === 'linux') {
    let allOk = true
    const debDeps = [
      ['webkit2gtk-4.1', 'libwebkit2gtk-4.1-dev'],
      ['gtk+-3.0', 'libgtk-3-dev'],
      ['ayatana-appindicator3-0.1', 'libayatana-appindicator3-dev'],
      ['librsvg-2.0', 'librsvg2-dev'],
    ]
    for (const [pkg, deb] of debDeps) {
      allOk &= check(`${pkg} (${deb})`, () => {
        execSync(`pkg-config --exists ${pkg}`, { stdio: 'pipe' })
        return null
      })
    }
    if (!allOk) {
      const missing = debDeps.map(([, d]) => d).join(' ')
      console.log(`\n${DIM}Install with:${RESET}`)
      console.log(`  sudo apt install -y ${missing} build-essential curl wget file libssl-dev`)
      console.log(`${DIM}(or your distro's equivalent for webkit2gtk-4.1, gtk+-3.0, ayatana-appindicator3, librsvg2)${RESET}`)
    }
    return !!allOk
  }

  if (platform === 'win32') {
    return check('Visual Studio Build Tools', () => {
      execSync('where cl.exe', { stdio: 'pipe' })
      return null
    })
    // If missing, doctor.js's check() already prints the error message;
    // we add a hint:
    // -> Install: https://visualstudio.microsoft.com/visual-cpp-build-tools/
    // (The user sees the error text from where cl.exe failing.)
  }

  console.log(`${DIM}Unknown platform ${platform} — no Tauri build-deps check.${RESET}`)
  return true
}
```

In the `main` function, add early-out for the new flag:

```js
if (process.argv.includes('--tauri-dev')) {
  const ok = checkTauriDev()
  process.exit(ok ? 0 : 1)
}
```

- [ ] **Step 3: Manual smoke-test on this Linux box**

Run: `node bin/doctor.js --tauri-dev`
Expected (if libs not yet installed): four ✗ lines, exit 1, install command printed.

After the user installs the libs, re-run: four ✓ lines, exit 0.

(macOS / Windows verification deferred to whoever first builds on those platforms — the logic is straightforward enough that platform-specific bugs are unlikely.)

- [ ] **Step 4: Commit**

```bash
git add bin/doctor.js
git commit -m "feat(doctor): --tauri-dev mode checks build-time deps for Tauri"
```

- [ ] **Step 5: Document the new flag**

Add a one-liner to README's "Common Commands" section if such a section exists; otherwise defer to the docs in Task 25:

```
tinstar doctor --tauri-dev   # Check Tauri build dependencies (developers building from source)
```

If README has no obvious place, skip — Task 25 puts the official version in `docs/desktop-app.md`.

---

## Task 1: Add `@tauri-apps/cli` and scaffold `src-tauri/`

**Files:**
- Modify: `package.json`
- Create: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`, `src-tauri/.gitignore`, `src-tauri/icons/*` (use existing `logo.png`).

- [ ] **Step 1: Verify Rust toolchain is available**

Run: `rustc --version && cargo --version`
Expected: rustc 1.74+ and cargo present. If absent, install via `https://rustup.rs` and re-verify.

- [ ] **Step 2: Add npm dev dependencies**

Run:
```bash
npm install --save-dev @tauri-apps/cli@^2.0.0 @tauri-apps/api@^2.0.0
```
Expected: `package.json` `devDependencies` gains both. No prod-deps changed.

- [ ] **Step 3: Add npm scripts**

Edit `package.json` `scripts`:
```jsonc
"tauri": "tauri",
"tauri:dev": "tauri dev",
"tauri:build": "tauri build",
"tauri:build:debug": "tauri build --debug"
```

- [ ] **Step 4: Hand-write `src-tauri/Cargo.toml`** (do not run `tauri init` — it overwrites things and is hard to review)

```toml
[package]
name = "tinstar-desktop"
version = "4.0.0"
description = "Tinstar — Agent Orchestrator (desktop)"
authors = ["Tinstar"]
edition = "2021"

[lib]
name = "tinstar_desktop_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2", features = [] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
reqwest = { version = "0.12", default-features = false, features = ["rustls-tls"] }
tokio = { version = "1", features = ["rt-multi-thread", "macros", "process", "time"] }
thiserror = "1"

[features]
default = ["custom-protocol"]
custom-protocol = ["tauri/custom-protocol"]
```

- [ ] **Step 5: Hand-write `src-tauri/build.rs`**

```rust
fn main() {
    tauri_build::build()
}
```

- [ ] **Step 6: Hand-write `src-tauri/tauri.conf.json`**

```jsonc
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Tinstar",
  "version": "4.0.0",
  "identifier": "io.tinstar.desktop",
  "build": {
    "beforeDevCommand": "npm run dev:frontend",
    "beforeBuildCommand": "npm run build:all",
    "devUrl": "http://localhost:5280",
    "frontendDist": "../dist/client"
  },
  "app": {
    "windows": [
      {
        "label": "main",
        "title": "Tinstar",
        "width": 1400,
        "height": 900,
        "minWidth": 900,
        "minHeight": 600,
        "visible": false,
        "decorations": true
      }
    ],
    "security": {
      "csp": null
    }
  },
  "bundle": {
    "active": true,
    "targets": ["dmg", "msi", "appimage", "deb"],
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ]
  }
}
```

`devUrl` matches Tinstar's Vite port (5280 from `vite.config.ts`); confirm by `grep -n 'port' vite.config.ts` first and adjust if it differs.

- [ ] **Step 7: Hand-write a stub `src-tauri/src/main.rs`**

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 8: Generate icons**

Run: `npx @tauri-apps/cli icon ./logo.png -o src-tauri/icons`
Expected: `src-tauri/icons/{32x32.png,128x128.png,128x128@2x.png,icon.icns,icon.ico,Square*.png}` populated.

- [ ] **Step 9: `src-tauri/.gitignore`**

```
target/
gen/
```

- [ ] **Step 10: Type-check & cargo-check**

Run: `npx tsc --noEmit`
Expected: no errors (no TS changes yet).

Run: `cd src-tauri && cargo check`
Expected: compiles clean. First run will download many crates; budget 5–10 min on a fresh box.

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json src-tauri/
git commit -m "feat(tauri): scaffold Tauri 2.x desktop shell"
```

---

## Task 2: First successful `tauri build` against the existing dist/client

**Files:** none (verification-only).

- [ ] **Step 1: Build the frontend**

Run: `npm run build:all`
Expected: `dist/client/index.html` exists and contains `__TINSTAR_API_BASE__`.

- [ ] **Step 2: Smoke-build the Tauri bundle in debug mode**

Run: `npm run tauri:build:debug`
Expected: bundle artifact under `src-tauri/target/debug/bundle/` (DMG on macOS, AppImage on Linux, MSI on Windows).

If this fails, do NOT proceed — diagnose. Common failures: missing system deps (`libwebkit2gtk-4.1-dev` on Linux), wrong `frontendDist` path.

- [ ] **Step 3: Manual launch sanity**

On macOS/Linux, run the binary directly: `./src-tauri/target/debug/tinstar` (path: `tinstar-desktop` if Cargo defaults haven't been overridden).

Expected: a window opens. It will show a blank page or the canvas with **broken API calls** (the bundle's `__TINSTAR_API_BASE__` is empty so it tries same-origin `tauri://localhost/api/...`). That's expected — Task 3 fixes it. The point of this task: prove bundling works end-to-end.

- [ ] **Step 4: Commit**

No code changes; if Task 1 commit was clean nothing to add. If you had to tweak `tauri.conf.json` paths during the smoke build:
```bash
git add src-tauri/tauri.conf.json
git commit -m "fix(tauri): correct frontendDist / devUrl after first build"
```

---

## Task 3: Inject `__TINSTAR_API_BASE__` via `Window::eval()` (hardcoded for now)

**Files:**
- Modify: `src-tauri/src/main.rs`
- Test: `src-tauri/src/main.rs` (`#[cfg(test)]` module for the URL-sanitizer helper).

The eval contract: Tauri's `WebviewWindow::eval(script)` runs synchronously after `window.create` but *before* the page's module scripts execute, **only if** we eval inside the `on_page_load` callback for `PageLoadEvent::Started`. That's the load-bearing detail.

- [ ] **Step 1: Write the failing test for the URL sanitizer**

Add to `src-tauri/src/main.rs` (or split into `lib.rs` later):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_trailing_slash() {
        assert_eq!(sanitize_api_base("http://infrapoc:5273/"), "http://infrapoc:5273");
    }
    #[test]
    fn rejects_quotes_and_newlines() {
        assert_eq!(sanitize_api_base("http://x\"; alert(1)//"), "");
        assert_eq!(sanitize_api_base("http://x\n"), "");
    }
    #[test]
    fn passes_clean_origin() {
        assert_eq!(sanitize_api_base("http://infrapoc:5273"), "http://infrapoc:5273");
    }
}
```

Run: `cd src-tauri && cargo test`
Expected: FAIL — `sanitize_api_base` undefined.

- [ ] **Step 2: Implement `sanitize_api_base`**

In `src-tauri/src/main.rs`, before `fn main`:

```rust
/// Strip trailing slashes and reject anything containing characters that would
/// let an attacker break out of the JS string literal we eval. We never accept
/// origins from untrusted sources (only desktop.json or a hardcoded constant),
/// but defense-in-depth: if the string contains anything outside a strict URL
/// charset, return empty so the frontend falls back to same-origin.
fn sanitize_api_base(raw: &str) -> String {
    let trimmed = raw.trim_end_matches('/');
    if trimmed.contains(['"', '\'', '\n', '\r', '\\', '<', '>']) {
        return String::new();
    }
    trimmed.to_string()
}
```

Run: `cargo test`
Expected: 3 tests pass.

- [ ] **Step 3: Wire `eval()` into `main`**

Replace `src-tauri/src/main.rs` `fn main` body:

```rust
const HARDCODED_BASE: &str = "http://infrapoc:5273";

fn main() {
    tauri::Builder::default()
        .on_page_load(|window, payload| {
            if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
                let base = sanitize_api_base(HARDCODED_BASE);
                let script = format!(
                    "window.__TINSTAR_API_BASE__ = {};",
                    serde_json::to_string(&base).expect("json string is always serializable")
                );
                let _ = window.eval(&script);
            }
        })
        .setup(|app| {
            let main_window = app.get_webview_window("main").expect("main window missing");
            main_window.show().expect("show main window");
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

`serde_json::to_string` produces a JS-safe quoted literal — that's the canonical way to inject string data into a JS context.

- [ ] **Step 4: cargo build + manual smoke**

Run: `npm run tauri:build:debug && ./src-tauri/target/debug/bundle/<platform>/<binary>`
Expected: window opens, canvas loads, **all `/api/*` requests in DevTools go to `http://infrapoc:5273`**, the user's existing infrapoc backend serves them. SSE works. Right-click → Inspect Element should be available in debug builds.

If infrapoc's CORS allowlist doesn't include `tauri://localhost` (on macOS/Linux) or `https://tauri.localhost` (Windows), this will fail with CORS errors. Fix: on infrapoc, restart with `TINSTAR_CORS_ORIGINS='tauri://localhost,https://tauri.localhost,http://infrapoc:5280'`. **Document this in the eventual README** but do not block the task — it's the user's existing server, they own it.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(tauri): inject __TINSTAR_API_BASE__ via Window::eval on page load"
```

---

## Task 4: Page-load timing audit (kill the FOUC-of-API)

There's a real risk that the React bundle reads `__TINSTAR_API_BASE__` *before* `eval()` runs. `apiClient.ts` reads at module init; if `eval` lands after `import` resolution, the first apiUrl call uses same-origin and 404s. We need to either (a) prove `PageLoadEvent::Started` always lands before module scripts, or (b) add a re-read.

- [ ] **Step 1: Add a forced re-read primitive to `apiClient.ts`**

Phase 1 already exposed `_resetApiBaseForTests()`. Promote a public version:

```ts
// src/apiClient.ts (additive — keep _resetApiBaseForTests for tests).
export function resetApiBaseFromGlobal(): void {
  apiBase = null
}
```

Update `tests/apiClient.test.ts` with one new test asserting `resetApiBaseFromGlobal()` re-reads `window.__TINSTAR_API_BASE__`. Run vitest: `npx vitest run tests/apiClient.test.ts`. Expected: 8 tests pass.

- [ ] **Step 2: Write the failing test for desktopBootstrap re-read behavior**

`tests/desktop/desktopBootstrap.test.tsx`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { resetApiBaseFromGlobal, apiUrl } from '../../src/apiClient'

describe('desktopBootstrap apiBase re-read', () => {
  beforeEach(() => { delete (globalThis as any).__TINSTAR_API_BASE__ })

  it('picks up __TINSTAR_API_BASE__ that was set after module init', () => {
    resetApiBaseFromGlobal()
    expect(apiUrl('/api/x')).toBe('/api/x')
    ;(globalThis as any).__TINSTAR_API_BASE__ = 'http://infrapoc:5273'
    resetApiBaseFromGlobal()
    expect(apiUrl('/api/x')).toBe('http://infrapoc:5273/api/x')
  })
})
```

Run: `npx vitest run tests/desktop/desktopBootstrap.test.tsx` → PASS once `resetApiBaseFromGlobal` is exported.

- [ ] **Step 3: Add a defensive re-read at the top of `src/main.tsx`**

```ts
import { resetApiBaseFromGlobal } from './apiClient'
resetApiBaseFromGlobal()
```

This costs one statement and removes the entire timing-class of bug.

- [ ] **Step 4: Manual verify**

Re-run the Task 3 manual smoke. DevTools console: `window.__TINSTAR_API_BASE__` should equal `http://infrapoc:5273`; first `/api/state` request should hit infrapoc.

- [ ] **Step 5: Commit**

```bash
git add src/apiClient.ts src/main.tsx tests/apiClient.test.ts tests/desktop/desktopBootstrap.test.tsx
git commit -m "feat(api-client): expose resetApiBaseFromGlobal for late injection"
```

---

## Task 5: Tauri-side smoke test for `Window::eval` injection (Rust integration test)

Tauri's testing story is awkward (no headless webview test runner in the open-source toolchain), so this task is the smallest meaningful integration test: a `cargo test` that builds the app handle without actually opening a window and asserts the eval-script string we'd send.

**Files:**
- Modify: `src-tauri/src/main.rs` (extract the script-builder into a pure function).

- [ ] **Step 1: Refactor the eval-script construction**

```rust
fn build_eval_script(base: &str) -> String {
    let sanitized = sanitize_api_base(base);
    format!(
        "window.__TINSTAR_API_BASE__ = {};",
        serde_json::to_string(&sanitized).expect("json string is always serializable")
    )
}
```

Use `build_eval_script` in the `on_page_load` callback.

- [ ] **Step 2: Tests**

```rust
#[test]
fn eval_script_quotes_string() {
    assert_eq!(build_eval_script("http://infrapoc:5273"),
               "window.__TINSTAR_API_BASE__ = \"http://infrapoc:5273\";");
}
#[test]
fn eval_script_blanks_on_unsafe_input() {
    assert_eq!(build_eval_script("http://x\"; alert(1)//"),
               "window.__TINSTAR_API_BASE__ = \"\";");
}
```

Run: `cargo test` → PASS.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "refactor(tauri): extract build_eval_script for unit testing"
```

---

## Task 6: Phase 2a end-to-end manual smoke + commit checkpoint

**Files:** none (verification).

- [ ] **Step 1: Hardcoded-remote run**

Build: `npm run tauri:build:debug`
Launch the binary. With infrapoc running on `:5273` and CORS allowlist set, expect: canvas loads, sessions panel populates, SSE works, creating a space works.

- [ ] **Step 2: Hardcoded-broken run**

Temporarily edit `HARDCODED_BASE` to `"http://localhost:9999"` (a dead port). Rebuild. Launch. Expect: canvas shell loads but `/api/*` calls fail with connection-refused. Verifies eval is happening (otherwise it'd succeed on same-origin to a 404).

Restore `HARDCODED_BASE` to infrapoc and rebuild. **Do not commit the broken value.**

- [ ] **Step 3: Phase-2a sign-off**

If both manual runs behave as described, Phase 2a is done. No commit.

---

# Phase 2b — Config + first-run setup

## Task 7: Define the desktop config schema (Rust + TS, kept in lockstep)

**Files:**
- Create: `src-tauri/src/config.rs`.
- Create: `src/desktop/types.ts`.

- [ ] **Step 1: Failing Rust test**

`src-tauri/src/config.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum BackendMode { Local, Remote }

#[derive(Debug, Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopConfig {
    pub mode: BackendMode,
    pub backend_url: String,
    pub manage_backend: bool,
    #[serde(default)]
    pub extra_hosts: Vec<String>,
    #[serde(default = "default_local_port")]
    pub local_port: u16,
}

fn default_local_port() -> u16 { 5274 }

impl Default for DesktopConfig {
    fn default() -> Self {
        Self { mode: BackendMode::Remote, backend_url: String::new(),
               manage_backend: false, extra_hosts: vec![], local_port: 5274 }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trip() {
        let c = DesktopConfig { mode: BackendMode::Local,
            backend_url: "http://localhost:5273".into(),
            manage_backend: true,
            extra_hosts: vec!["infrapoc".into()],
            local_port: 5274 };
        let json = serde_json::to_string(&c).unwrap();
        let parsed: DesktopConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(c, parsed);
    }
    #[test]
    fn camel_case_fields() {
        let c = DesktopConfig::default();
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"backendUrl\""));
        assert!(json.contains("\"manageBackend\""));
        assert!(json.contains("\"extraHosts\""));
        assert!(json.contains("\"localPort\""));
    }
}
```

Wire into `main.rs`: `mod config;`. Run `cargo test config::tests` → PASS.

- [ ] **Step 2: TS counterpart**

`src/desktop/types.ts`:

```ts
export type BackendMode = 'local' | 'remote'

export interface DesktopConfig {
  mode: BackendMode
  backendUrl: string
  manageBackend: boolean
  extraHosts: string[]
  localPort: number
}

export const DEFAULT_DESKTOP_CONFIG: DesktopConfig = {
  mode: 'remote',
  backendUrl: '',
  manageBackend: false,
  extraHosts: [],
  localPort: 5274,
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit && (cd src-tauri && cargo test)` → both clean.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/main.rs src/desktop/types.ts
git commit -m "feat(desktop): DesktopConfig schema (Rust + TS)"
```

---

## Task 8: `get_config` / `save_config` IPC commands

Backed by `app_config_dir() + "desktop.json"`. Tauri 2 path: `app.path().app_config_dir()`.

**Files:**
- Modify: `src-tauri/src/config.rs`.
- Modify: `src-tauri/src/main.rs` (register the commands).

- [ ] **Step 1: Failing test**

```rust
// in config.rs tests module
#[test]
fn read_returns_default_when_missing() {
    let tmp = tempfile::tempdir().unwrap();
    let cfg = read_config_at(tmp.path()).unwrap();
    assert_eq!(cfg, DesktopConfig::default());
}

#[test]
fn write_then_read() {
    let tmp = tempfile::tempdir().unwrap();
    let mut cfg = DesktopConfig::default();
    cfg.backend_url = "http://infrapoc:5273".into();
    write_config_at(tmp.path(), &cfg).unwrap();
    let read = read_config_at(tmp.path()).unwrap();
    assert_eq!(read.backend_url, "http://infrapoc:5273");
}
```

Add `tempfile = "3"` to `[dev-dependencies]` in `Cargo.toml`.

Run `cargo test` → fails (functions undefined).

- [ ] **Step 2: Implement file I/O**

```rust
use std::path::Path;
use std::fs;

const CONFIG_FILENAME: &str = "desktop.json";

pub fn read_config_at(dir: &Path) -> Result<DesktopConfig, std::io::Error> {
    let path = dir.join(CONFIG_FILENAME);
    if !path.exists() { return Ok(DesktopConfig::default()); }
    let raw = fs::read_to_string(&path)?;
    serde_json::from_str(&raw).map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

pub fn write_config_at(dir: &Path, cfg: &DesktopConfig) -> Result<(), std::io::Error> {
    fs::create_dir_all(dir)?;
    let path = dir.join(CONFIG_FILENAME);
    let pretty = serde_json::to_string_pretty(cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    fs::write(path, pretty)
}
```

Run `cargo test` → PASS.

- [ ] **Step 3: Wrap as IPC commands**

```rust
#[tauri::command]
pub async fn get_config(app: tauri::AppHandle) -> Result<DesktopConfig, String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    read_config_at(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn save_config(app: tauri::AppHandle, config: DesktopConfig) -> Result<(), String> {
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    write_config_at(&dir, &config).map_err(|e| e.to_string())
}
```

Register in `main.rs`:

```rust
.invoke_handler(tauri::generate_handler![
    config::get_config,
    config::save_config,
])
```

Add `use tauri::Manager;` so `app.path()` resolves.

- [ ] **Step 4: cargo check + manual round-trip**

Build & launch. In DevTools console:

```js
await window.__TAURI_INTERNALS__.invoke('save_config', { config: { mode:'remote', backendUrl:'http://infrapoc:5273', manageBackend:false, extraHosts:[], localPort:5274 } })
await window.__TAURI_INTERNALS__.invoke('get_config')
```

Expected: second call returns the saved config. Verify on disk: `cat "$HOME/Library/Application Support/io.tinstar.desktop/desktop.json"` (macOS) or `~/.config/io.tinstar.desktop/desktop.json` (Linux). **Note:** the directory uses the `identifier` (`io.tinstar.desktop`), not `tinstar` — that's correct and intentional, separate from the backend's `~/.config/tinstar/`.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/config.rs src-tauri/src/main.rs src-tauri/Cargo.toml
git commit -m "feat(tauri): get_config / save_config IPC commands"
```

---

## Task 9: TypeScript wrappers around the IPC commands

**Files:**
- Create: `src/desktop/desktopApi.ts`.
- Create: `tests/desktop/desktopApi.test.ts`.

- [ ] **Step 1: Failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('desktopApi.getConfig', () => {
  beforeEach(() => { (globalThis as any).__TAURI_INTERNALS__ = undefined })

  it('returns null outside Tauri', async () => {
    const { getConfig } = await import('../../src/desktop/desktopApi')
    expect(await getConfig()).toBeNull()
  })

  it('invokes get_config and returns the config inside Tauri', async () => {
    const invoke = vi.fn().mockResolvedValue({
      mode: 'remote', backendUrl: 'http://x', manageBackend: false, extraHosts: [], localPort: 5274,
    })
    ;(globalThis as any).__TAURI_INTERNALS__ = { invoke }
    vi.resetModules()
    const { getConfig } = await import('../../src/desktop/desktopApi')
    const cfg = await getConfig()
    expect(invoke).toHaveBeenCalledWith('get_config')
    expect(cfg?.backendUrl).toBe('http://x')
  })
})
```

Run vitest → fails (module missing).

- [ ] **Step 2: Implement**

```ts
import type { DesktopConfig } from './types'

export function isTauri(): boolean {
  return typeof globalThis !== 'undefined' &&
         typeof (globalThis as any).__TAURI_INTERNALS__ !== 'undefined'
}

async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (globalThis as any).__TAURI_INTERNALS__.invoke(cmd, args)
}

export async function getConfig(): Promise<DesktopConfig | null> {
  if (!isTauri()) return null
  return invoke<DesktopConfig>('get_config')
}

export async function saveConfig(config: DesktopConfig): Promise<void> {
  if (!isTauri()) return
  return invoke<void>('save_config', { config })
}
```

Run vitest → PASS (2 tests).

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
git add src/desktop/desktopApi.ts tests/desktop/desktopApi.test.ts
git commit -m "feat(desktop): typed IPC wrappers for get_config/save_config"
```

---

## Task 10: `<FirstRunSetup />` React component

Visual continuity: reuse Tinstar's existing Tailwind classes (`bg-surface-base`, `text-slate-100`, `font-display` = Chakra Petch). No react-bootstrap dependency — Tinstar already has its own design system.

**Files:**
- Create: `src/desktop/firstRunSetup.tsx`.
- Create: `tests/desktop/firstRunSetup.test.tsx`.

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { FirstRunSetup } from '../../src/desktop/firstRunSetup'

describe('FirstRunSetup', () => {
  it('renders mode picker', () => {
    render(<FirstRunSetup onSave={vi.fn()} />)
    expect(screen.getByText(/remote/i)).toBeTruthy()
    expect(screen.getByText(/local/i)).toBeTruthy()
  })

  it('saves remote config with backendUrl', () => {
    const onSave = vi.fn()
    render(<FirstRunSetup onSave={onSave} />)
    fireEvent.click(screen.getByLabelText(/remote/i))
    fireEvent.change(screen.getByLabelText(/backend url/i), { target: { value: 'http://infrapoc:5273' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'remote', backendUrl: 'http://infrapoc:5273',
    }))
  })

  it('exposes manageBackend checkbox only in local mode', () => {
    render(<FirstRunSetup onSave={vi.fn()} />)
    fireEvent.click(screen.getByLabelText(/local/i))
    expect(screen.getByLabelText(/manage backend/i)).toBeTruthy()
    fireEvent.click(screen.getByLabelText(/remote/i))
    expect(screen.queryByLabelText(/manage backend/i)).toBeNull()
  })

  it('rejects empty backendUrl on save', () => {
    const onSave = vi.fn()
    render(<FirstRunSetup onSave={onSave} />)
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).not.toHaveBeenCalled()
    expect(screen.getByText(/backend url is required/i)).toBeTruthy()
  })
})
```

Run vitest → fails (module missing).

- [ ] **Step 2: Implement**

```tsx
import { useState } from 'react'
import type { DesktopConfig, BackendMode } from './types'
import { DEFAULT_DESKTOP_CONFIG } from './types'

export interface FirstRunSetupProps { onSave: (config: DesktopConfig) => void }

export function FirstRunSetup({ onSave }: FirstRunSetupProps) {
  const [mode, setMode] = useState<BackendMode>(DEFAULT_DESKTOP_CONFIG.mode)
  const [backendUrl, setBackendUrl] = useState('http://infrapoc:5273')
  const [manageBackend, setManageBackend] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function submit() {
    if (!backendUrl.trim()) { setError('backend URL is required'); return }
    setError(null)
    onSave({
      mode, backendUrl: backendUrl.trim(),
      manageBackend: mode === 'local' ? manageBackend : false,
      extraHosts: [],
      localPort: 5274,
    })
  }

  return (
    <div className="min-h-screen bg-surface-base text-slate-100 font-display flex items-center justify-center p-8">
      <div className="max-w-md w-full space-y-6">
        <h1 className="text-3xl font-bold tracking-wide text-cyan-400">Tinstar — Setup</h1>
        <p className="text-slate-400">Choose how this desktop app talks to a Tinstar backend.</p>

        <fieldset className="space-y-2">
          <legend className="text-sm uppercase text-slate-400 mb-2">Backend mode</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" value="remote"
              checked={mode === 'remote'} onChange={() => setMode('remote')} />
            Remote (server on another machine)
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="mode" value="local"
              checked={mode === 'local'} onChange={() => setMode('local')} />
            Local (server on this machine)
          </label>
        </fieldset>

        <label className="block">
          <span className="text-sm uppercase text-slate-400">Backend URL</span>
          <input
            type="url"
            value={backendUrl}
            onChange={(e) => setBackendUrl(e.target.value)}
            placeholder="http://infrapoc:5273"
            className="mt-1 block w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 font-mono text-sm"
          />
        </label>

        {mode === 'local' && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={manageBackend}
                   onChange={(e) => setManageBackend(e.target.checked)} />
            Manage backend (start/stop the tinstar CLI for me)
          </label>
        )}

        {error && <p className="text-rose-400 text-sm">{error}</p>}

        <button
          onClick={submit}
          className="w-full bg-cyan-500 hover:bg-cyan-400 text-slate-900 font-bold py-2 rounded uppercase tracking-wider"
        >
          Save and connect
        </button>
      </div>
    </div>
  )
}
```

Run vitest → PASS (4 tests). If `@testing-library/react` is missing, install it (`npm install --save-dev @testing-library/react @testing-library/dom`). Tinstar likely already has it; check `package.json` first.

- [ ] **Step 3: Type-check + commit**

```bash
npx tsc --noEmit
git add src/desktop/firstRunSetup.tsx tests/desktop/firstRunSetup.test.tsx
git commit -m "feat(desktop): FirstRunSetup React component"
```

---

## Task 11: Bootstrap routing — config gates the React entry

**Files:**
- Create: `src/desktop/desktopBootstrap.tsx`.
- Modify: `src/main.tsx`.

- [ ] **Step 1: Failing test**

`tests/desktop/desktopBootstrap.test.tsx` (extend existing file):

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import * as desktopApi from '../../src/desktop/desktopApi'

describe('DesktopBootstrap', () => {
  beforeEach(() => { vi.resetModules() })

  it('renders FirstRunSetup when no config is saved', async () => {
    vi.spyOn(desktopApi, 'isTauri').mockReturnValue(true)
    vi.spyOn(desktopApi, 'getConfig').mockResolvedValue({
      mode: 'remote', backendUrl: '', manageBackend: false, extraHosts: [], localPort: 5274,
    })
    const { DesktopBootstrap } = await import('../../src/desktop/desktopBootstrap')
    render(<DesktopBootstrap><div data-testid="app">app</div></DesktopBootstrap>)
    await waitFor(() => expect(screen.getByText(/setup/i)).toBeTruthy())
  })

  it('renders children when backendUrl is set', async () => {
    vi.spyOn(desktopApi, 'isTauri').mockReturnValue(true)
    vi.spyOn(desktopApi, 'getConfig').mockResolvedValue({
      mode: 'remote', backendUrl: 'http://infrapoc:5273', manageBackend: false, extraHosts: [], localPort: 5274,
    })
    const { DesktopBootstrap } = await import('../../src/desktop/desktopBootstrap')
    render(<DesktopBootstrap><div data-testid="app">app</div></DesktopBootstrap>)
    await waitFor(() => expect(screen.getByTestId('app')).toBeTruthy())
  })

  it('renders children unconditionally outside Tauri', async () => {
    vi.spyOn(desktopApi, 'isTauri').mockReturnValue(false)
    const { DesktopBootstrap } = await import('../../src/desktop/desktopBootstrap')
    render(<DesktopBootstrap><div data-testid="app">app</div></DesktopBootstrap>)
    expect(screen.getByTestId('app')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Implement**

```tsx
import { useEffect, useState, type ReactNode } from 'react'
import { FirstRunSetup } from './firstRunSetup'
import { getConfig, saveConfig, isTauri } from './desktopApi'
import { resetApiBaseFromGlobal } from '../apiClient'
import type { DesktopConfig } from './types'

type State =
  | { status: 'loading' }
  | { status: 'setup' }
  | { status: 'ready'; config: DesktopConfig }

export function DesktopBootstrap({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(() =>
    isTauri() ? { status: 'loading' } : { status: 'ready',
      config: { mode: 'remote', backendUrl: '', manageBackend: false, extraHosts: [], localPort: 5274 } })

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    getConfig().then((cfg) => {
      if (cancelled) return
      if (!cfg || !cfg.backendUrl) setState({ status: 'setup' })
      else { applyApiBase(cfg.backendUrl); setState({ status: 'ready', config: cfg }) }
    })
    return () => { cancelled = true }
  }, [])

  if (state.status === 'loading') return null  // splash window covers this
  if (state.status === 'setup') {
    return <FirstRunSetup onSave={async (cfg) => {
      await saveConfig(cfg); applyApiBase(cfg.backendUrl)
      setState({ status: 'ready', config: cfg })
    }} />
  }
  return <>{children}</>
}

function applyApiBase(url: string) {
  ;(globalThis as any).__TINSTAR_API_BASE__ = url
  resetApiBaseFromGlobal()
}
```

Run vitest → 3 tests pass.

- [ ] **Step 3: Wire into `src/main.tsx`**

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './hotkeys/widgets'
import './widgets'
import App from './App'
import { resetApiBaseFromGlobal } from './apiClient'
import { DesktopBootstrap } from './desktop/desktopBootstrap'

resetApiBaseFromGlobal()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DesktopBootstrap><App /></DesktopBootstrap>
  </StrictMode>,
)
```

- [ ] **Step 4: Type-check + browser smoke**

`npx tsc --noEmit` clean.
`npm run dev` (browser mode) — `isTauri()` is false, app renders as before, no setup screen.

- [ ] **Step 5: Tauri smoke**

`npm run tauri:build:debug` and launch.

Sub-test 5a: with `desktop.json` absent (delete it first), expect setup screen.
Sub-test 5b: save with `http://infrapoc:5273`, expect canvas, expect API requests to infrapoc.
Sub-test 5c: relaunch the app with the saved config, expect it skips the setup screen.

- [ ] **Step 6: Commit**

```bash
git add src/main.tsx src/desktop/desktopBootstrap.tsx tests/desktop/desktopBootstrap.test.tsx
git commit -m "feat(desktop): DesktopBootstrap routes to FirstRunSetup until config saved"
```

---

## Task 12: Remove the hardcoded `HARDCODED_BASE` — config drives injection

Now that the React side reads config and reapplies `__TINSTAR_API_BASE__`, the Rust `eval` injection becomes a *fallback*: if a config exists at boot, eval the saved URL; otherwise eval empty string.

**Files:**
- Modify: `src-tauri/src/main.rs`.

- [ ] **Step 1: Read the saved config in `setup`**

```rust
.setup(|app| {
    let dir = app.path().app_config_dir().ok();
    let saved_url = dir.and_then(|d| config::read_config_at(&d).ok())
                       .map(|c| c.backend_url).unwrap_or_default();
    app.manage(SavedBase(saved_url));
    Ok(())
})
```

Add `struct SavedBase(String);`. Then in `on_page_load`:

```rust
.on_page_load(|window, payload| {
    if matches!(payload.event(), tauri::webview::PageLoadEvent::Started) {
        let base = window.app_handle().state::<SavedBase>().0.clone();
        let _ = window.eval(&build_eval_script(&base));
    }
})
```

Empty string → `__TINSTAR_API_BASE__ = ""` → `apiClient` falls back to same-origin. The first-run flow runs entirely with no apiBase (the setup screen never calls `/api/*`). After the user saves, `applyApiBase()` sets the global; the next render uses it.

- [ ] **Step 2: Test**

Same Rust unit test as before; `build_eval_script` is unchanged. cargo test → PASS.

- [ ] **Step 3: Manual smoke**

Delete `desktop.json`, launch: setup screen, save config, app loads against infrapoc. Quit and relaunch: app loads against infrapoc immediately (no setup screen, no flash).

- [ ] **Step 4: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(tauri): eval __TINSTAR_API_BASE__ from saved desktop.json"
```

---

## Task 13: Phase 2b end-to-end self-check

- [ ] Manual: delete config → setup → save remote URL → canvas works → relaunch → setup skipped.
- [ ] Manual: edit config to `mode: local, manageBackend: false, backendUrl: http://localhost:5273` → relaunch → app tries localhost. (User's `:5273` is up, this works against it; **does not** spawn anything yet.)
- [ ] Type-check clean: `npx tsc --noEmit`.
- [ ] Vitest clean: `npx vitest run tests/desktop`.
- [ ] cargo test clean.

If all green, no commit needed.

---

# Phase 2c — Splash screen

## Task 14: `splash.html` markup + CSS

**Files:**
- Create: `src-tauri/splash.html`.

The brief: ~30 lines of HTML/CSS. Chakra Petch, neon cyan, animated wordmark. No JS interactivity.

- [ ] **Step 1: Author the HTML**

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Tinstar</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@600;700&display=swap" rel="stylesheet" />
<style>
  html, body { margin: 0; height: 100%; background: #050a14; color: #67e8f9;
    font-family: 'Chakra Petch', sans-serif; overflow: hidden; }
  body { display: flex; align-items: center; justify-content: center; }
  .wm { font-size: 4rem; font-weight: 700; letter-spacing: 0.4em;
    text-shadow: 0 0 12px #06b6d4, 0 0 32px #0891b2; animation: pulse 1.4s ease-in-out infinite; }
  .wm::after { content: ""; display: block; width: 60%; height: 2px; margin: 0.6rem auto 0;
    background: linear-gradient(90deg, transparent, #67e8f9, transparent);
    animation: sweep 2s linear infinite; }
  @keyframes pulse { 0%,100% { opacity: 0.85 } 50% { opacity: 1 } }
  @keyframes sweep { 0% { transform: translateX(-50%) } 100% { transform: translateX(50%) } }
  .tag { position: absolute; bottom: 2rem; font-size: 0.75rem; letter-spacing: 0.5em;
    color: #475569; text-transform: uppercase; }
</style>
</head>
<body>
<div class="wm">TINSTAR</div>
<div class="tag">agent orchestrator</div>
</body>
</html>
```

- [ ] **Step 2: Verify it loads in a browser**

Run: `python3 -m http.server -d src-tauri 8088 &`, open `http://localhost:8088/splash.html`, confirm typography + animation. `pkill -f 'http.server -d src-tauri 8088'` to tear down.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/splash.html
git commit -m "feat(splash): neon Chakra Petch splash markup"
```

---

## Task 15: Splash window orchestration (Rust)

**Files:**
- Create: `src-tauri/src/splash.rs`.
- Modify: `src-tauri/src/main.rs`, `src-tauri/tauri.conf.json`.

Plan: define a second `splash` window in `tauri.conf.json` that is visible at boot and points at `splash.html`. Hide the main window at boot (`"visible": false` already set). When the main webview emits `PageLoadEvent::Finished`, close splash and show main.

- [ ] **Step 1: Update tauri.conf.json**

Add to `app.windows`:

```jsonc
{
  "label": "splash",
  "title": "Tinstar",
  "url": "splash.html",
  "width": 480,
  "height": 320,
  "center": true,
  "decorations": false,
  "resizable": false,
  "alwaysOnTop": true,
  "skipTaskbar": true,
  "visible": true
}
```

The main window remains `"visible": false`.

- [ ] **Step 2: Splash module**

`src-tauri/src/splash.rs`:

```rust
use tauri::{AppHandle, Manager};

pub fn dismiss(app: &AppHandle) {
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.show();
        let _ = main.set_focus();
    }
}
```

- [ ] **Step 3: Trigger dismissal on main page-load finish**

In `main.rs`:

```rust
mod splash;

// ... in on_page_load:
.on_page_load(|window, payload| {
    if window.label() == "main" {
        match payload.event() {
            tauri::webview::PageLoadEvent::Started => {
                let base = window.app_handle().state::<SavedBase>().0.clone();
                let _ = window.eval(&build_eval_script(&base));
            }
            tauri::webview::PageLoadEvent::Finished => {
                splash::dismiss(window.app_handle());
            }
            _ => {}
        }
    }
})
```

- [ ] **Step 4: Failsafe timeout**

The page-load callback might not fire if the bundle errors before first paint. Add a 5-second hard timeout in `setup`:

```rust
let app_handle = app.handle().clone();
tauri::async_runtime::spawn(async move {
    tokio::time::sleep(std::time::Duration::from_secs(5)).await;
    splash::dismiss(&app_handle);
});
```

- [ ] **Step 5: cargo check + manual smoke**

Build & launch. Expect: splash flashes briefly (typically <500ms), main window appears, splash gone. The 5s timeout is a fallback you should not see hit on a healthy build.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/src/main.rs src-tauri/src/splash.rs
git commit -m "feat(splash): show splash window during main webview load"
```

---

## Task 16: Splash polish + double-flash check

- [ ] **Step 1: Delete `desktop.json` and verify the splash → setup transition**

The setup screen is part of the React bundle, so the order is: splash → main webview loads (splash dismissed) → DesktopBootstrap renders setup screen. There should be no double-flash. If there is (because the bundle loads before render), insert one more dismissal hook tied to a custom event from React.

For now, assume the page-load-finished signal is enough. If smoke testing shows a flash gap, add this to `desktopBootstrap.tsx`:

```tsx
useEffect(() => {
  if (!isTauri()) return
  const ev = new Event('tinstar-react-ready')
  window.dispatchEvent(ev)
}, [])
```

…and listen for it in Rust via `app.listen_global("tinstar-react-ready", ...)`. **Mark TBD until smoke testing reveals whether it's needed.**

- [ ] **Step 2: No commit unless code changed**

---

# Phase 2d — Local-mode backend manager

## Task 17: Backend reachability probe (`probe_backend` IPC)

**Files:**
- Create: `src-tauri/src/backend.rs`.
- Modify: `src-tauri/src/main.rs`.

- [ ] **Step 1: Failing test**

```rust
// in backend.rs
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn probe_returns_false_for_dead_url() {
        let r = probe(&"http://127.0.0.1:1".to_string(), Duration::from_millis(500)).await;
        assert!(!r);
    }
}
```

`cargo test backend::tests` → fails (probe undefined).

- [ ] **Step 2: Implement**

```rust
use std::time::Duration;

pub async fn probe(url: &String, timeout: Duration) -> bool {
    let client = match reqwest::Client::builder().timeout(timeout).build() {
        Ok(c) => c, Err(_) => return false,
    };
    let probe_url = format!("{}/api/state", url.trim_end_matches('/'));
    matches!(client.get(&probe_url).send().await, Ok(r) if r.status().is_success())
}

#[tauri::command]
pub async fn probe_backend(url: String) -> bool {
    probe(&url, Duration::from_millis(1500)).await
}
```

Register in `main.rs` invoke handler. Run `cargo test` → PASS.

- [ ] **Step 3: TS wrapper**

In `src/desktop/desktopApi.ts`:

```ts
export async function probeBackend(url: string): Promise<boolean> {
  if (!isTauri()) return true
  return invoke<boolean>('probe_backend', { url })
}
```

- [ ] **Step 4: Smoke test**

DevTools console:
```js
await window.__TAURI_INTERNALS__.invoke('probe_backend', { url: 'http://127.0.0.1:1' }) // false
await window.__TAURI_INTERNALS__.invoke('probe_backend', { url: 'http://infrapoc:5273' }) // true
```

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/backend.rs src-tauri/src/main.rs src/desktop/desktopApi.ts
git commit -m "feat(backend): probe_backend IPC for reachability check"
```

---

## Task 18: "Backend unreachable" UX

When `mode=local, manageBackend=false` and probe fails, show a help screen with the exact `tinstar` command to run. Copyable. No retry loop — the user starts the backend manually and clicks "Try again."

**Files:**
- Create: `src/desktop/backendUnreachable.tsx`.
- Modify: `src/desktop/desktopBootstrap.tsx`.
- Test: `tests/desktop/backendUnreachable.test.tsx`.

- [ ] **Step 1: Failing test**

```tsx
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { BackendUnreachable } from '../../src/desktop/backendUnreachable'

describe('BackendUnreachable', () => {
  it('shows the URL and a copyable command', () => {
    render(<BackendUnreachable url="http://localhost:5273" onRetry={vi.fn()} onReconfigure={vi.fn()} />)
    expect(screen.getByText('http://localhost:5273')).toBeTruthy()
    expect(screen.getByText(/tinstar --port 5273/)).toBeTruthy()
  })
  it('calls onRetry when "Try again" clicked', () => {
    const onRetry = vi.fn()
    render(<BackendUnreachable url="http://localhost:5273" onRetry={onRetry} onReconfigure={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(onRetry).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Implement** — same neon styling as setup.

```tsx
export function BackendUnreachable({ url, onRetry, onReconfigure }:
  { url: string; onRetry: () => void; onReconfigure: () => void }) {
  const port = (() => { try { return new URL(url).port || '5273' } catch { return '5273' } })()
  const cmd = `tinstar --port ${port}`
  return (
    <div className="min-h-screen bg-surface-base text-slate-100 font-display flex items-center justify-center p-8">
      <div className="max-w-lg w-full space-y-4">
        <h1 className="text-2xl font-bold text-amber-400">Backend not reachable</h1>
        <p className="text-slate-400">No Tinstar backend is responding at <code className="text-cyan-400">{url}</code>.</p>
        <p className="text-slate-400">In a terminal, run:</p>
        <pre className="bg-slate-900 border border-slate-700 rounded p-3 font-mono text-sm select-all">{cmd}</pre>
        <div className="flex gap-2">
          <button onClick={onRetry} className="bg-cyan-500 text-slate-900 font-bold px-4 py-2 rounded">Try again</button>
          <button onClick={onReconfigure} className="border border-slate-700 px-4 py-2 rounded">Reconfigure</button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Wire into `DesktopBootstrap`**

Extend `State`: `| { status: 'unreachable'; config: DesktopConfig }`. After loading config, if `mode==='local' && !manageBackend`, call `probeBackend(url)`; if false, set `unreachable`. Otherwise proceed to ready. Reconfigure → `setState({ status: 'setup' })`.

For `mode==='remote'`, do *not* probe — remote mode trusts the URL and lets the user see network errors in the canvas if their server is down. (Probing remote URLs would slow the launch and offers little: if the user's remote is down, they'll see "no sessions" in the canvas, which is closer to the real failure mode anyway.)

- [ ] **Step 4: Vitest + manual smoke**

Manual: edit `desktop.json` to `mode: local, manageBackend: false, backendUrl: http://localhost:9999`. Launch. Expect "Backend not reachable" screen with `tinstar --port 9999`. `npm run tauri:build:debug && launch`.

- [ ] **Step 5: Commit**

```bash
git add src/desktop/backendUnreachable.tsx src/desktop/desktopBootstrap.tsx tests/desktop/backendUnreachable.test.tsx
git commit -m "feat(desktop): backend-unreachable screen with copyable tinstar command"
```

---

## Task 19: `start_local_backend` IPC — spawn `tinstar` with isolated config

**Files:**
- Modify: `src-tauri/src/backend.rs`, `src-tauri/src/main.rs`.

The shell-out: `tinstar --port <port> --no-open --no-setup` with `TINSTAR_CONFIG_HOME` pointing at the desktop's *own* config dir, not the user's `~/.config/tinstar`. This is the load-bearing isolation that lets a user run a separate instance via the desktop app while their existing `:5273` keeps running.

**Decision:** the desktop's local-managed backend uses port 5274 by default (via `DesktopConfig::local_port`) to avoid colliding with the user's existing :5273. User can override in setup.

- [ ] **Step 1: Failing test for spawn**

```rust
#[tokio::test]
async fn spawn_returns_handle_with_pid() {
    // Use `sleep` as a stand-in for tinstar — we're testing the spawn machinery,
    // not tinstar itself. tinstar smoke-runs in the manual step.
    let h = spawn_managed("sleep", &["1".into()], &Default::default()).unwrap();
    assert!(h.id().is_some());
    h.kill().await.ok();
}
```

- [ ] **Step 2: Implement**

```rust
use std::collections::HashMap;
use tokio::process::{Child, Command};
use std::sync::Mutex;

pub fn spawn_managed(cmd: &str, args: &[String], env: &HashMap<String, String>) -> std::io::Result<Child> {
    let mut c = Command::new(cmd);
    c.args(args).envs(env).kill_on_drop(true);
    c.stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    c.spawn()
}

pub struct ManagedBackend(pub Mutex<Option<Child>>);

#[tauri::command]
pub async fn start_local_backend(
    state: tauri::State<'_, ManagedBackend>,
    app: tauri::AppHandle,
    port: u16,
) -> Result<(), String> {
    {
        let mut g = state.0.lock().unwrap();
        if let Some(child) = g.as_mut() {
            if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                return Ok(()); // already running
            }
        }
    }
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let backend_config_home = dir.join("backend-config");
    std::fs::create_dir_all(&backend_config_home).map_err(|e| e.to_string())?;
    let mut env = HashMap::new();
    env.insert("TINSTAR_CONFIG_HOME".into(), backend_config_home.to_string_lossy().to_string());
    let args = vec![
        "--port".into(), port.to_string(),
        "--no-open".into(), "--no-setup".into(),
    ];
    let child = spawn_managed("tinstar", &args, &env).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(child);
    Ok(())
}

#[tauri::command]
pub async fn stop_local_backend(state: tauri::State<'_, ManagedBackend>) -> Result<(), String> {
    let child_opt = state.0.lock().unwrap().take();
    if let Some(mut c) = child_opt { c.kill().await.map_err(|e| e.to_string())?; }
    Ok(())
}
```

Register state and commands in `main.rs`:

```rust
.manage(backend::ManagedBackend(std::sync::Mutex::new(None)))
.invoke_handler(tauri::generate_handler![
    config::get_config, config::save_config,
    backend::probe_backend, backend::start_local_backend, backend::stop_local_backend,
])
```

`kill_on_drop(true)` is the orphan-cleanup primitive: if the Tauri process dies, tokio drops the `Child`, which sends SIGKILL on Unix. On Windows it terminates the process. **Edge case the briefing flagged:** if the OS hard-kills Tauri (force-quit, OOM), `kill_on_drop` may not fire because `Drop` doesn't run on `SIGKILL`. Document this in the README: a force-quit may leave a `tinstar --port 5274` orphan; user can `pkill -f 'tinstar --port 5274'`. Tauri does emit a `RunEvent::ExitRequested` we can hook to call `stop_local_backend` deterministically — see Task 21.

- [ ] **Step 3: cargo test + commit**

```bash
cargo test backend
git add src-tauri/src/backend.rs src-tauri/src/main.rs
git commit -m "feat(backend): start_local_backend / stop_local_backend with isolated config"
```

---

## Task 20: Wire local-managed mode through bootstrap

**Files:**
- Modify: `src/desktop/desktopApi.ts` (add wrappers), `src/desktop/desktopBootstrap.tsx`.

- [ ] **Step 1: Add wrappers**

```ts
export async function startLocalBackend(port: number): Promise<void> {
  if (!isTauri()) return
  return invoke<void>('start_local_backend', { port })
}
export async function stopLocalBackend(): Promise<void> {
  if (!isTauri()) return
  return invoke<void>('stop_local_backend')
}
```

- [ ] **Step 2: Bootstrap flow change**

In `DesktopBootstrap` `useEffect`:

```ts
const cfg = await getConfig()
if (!cfg || !cfg.backendUrl) return setState({ status: 'setup' })

if (cfg.mode === 'local' && cfg.manageBackend) {
  // Spawn first, then probe.
  await startLocalBackend(cfg.localPort)
  // Poll up to 8s for backend to come up.
  for (let i = 0; i < 16; i++) {
    if (await probeBackend(cfg.backendUrl)) break
    await new Promise(r => setTimeout(r, 500))
  }
}

if (cfg.mode === 'local' && !cfg.manageBackend) {
  if (!(await probeBackend(cfg.backendUrl))) {
    return setState({ status: 'unreachable', config: cfg })
  }
}

applyApiBase(cfg.backendUrl)
setState({ status: 'ready', config: cfg })
```

- [ ] **Step 3: Manual smoke (with safety isolation!)**

Set `desktop.json`:
```json
{ "mode": "local", "backendUrl": "http://localhost:5299", "manageBackend": true,
  "localPort": 5299, "extraHosts": [] }
```

The localPort `5299` matters — it matches the rehearsal-script port and won't collide with the user's :5273.

Launch the Tauri binary. Expect:
1. Splash flashes.
2. `start_local_backend` runs `tinstar --port 5299 --no-open --no-setup` with `TINSTAR_CONFIG_HOME=$APPCONFIG/backend-config`.
3. `probeBackend` succeeds within ~2s.
4. Canvas loads against `:5299`.
5. Quitting the app: `ps aux | grep 'tinstar --port 5299'` should show nothing within ~1s of quit (relies on Task 21's exit hook).

If you see an orphaned process, `pkill -f 'tinstar --port 5299'` and proceed to Task 21 immediately to fix.

- [ ] **Step 4: Commit**

```bash
git add src/desktop/desktopApi.ts src/desktop/desktopBootstrap.tsx
git commit -m "feat(desktop): bootstrap spawns local backend when manageBackend=true"
```

---

## Task 21: Deterministic child cleanup on app quit

`kill_on_drop` is best-effort. The reliable path is `RunEvent::ExitRequested` → call `stop_local_backend` synchronously before the process exits.

**Files:**
- Modify: `src-tauri/src/main.rs`.

- [ ] **Step 1: Hook the run event**

```rust
.build(tauri::generate_context!())
.expect("error while building tauri application")
.run(|app_handle, event| {
    if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
        let state = app_handle.state::<backend::ManagedBackend>();
        let child_opt = state.0.lock().unwrap().take();
        if let Some(mut c) = child_opt {
            // Synchronous kill on the Tokio runtime, blocking briefly.
            tauri::async_runtime::block_on(async move { let _ = c.kill().await; });
        }
    }
});
```

(Switch from `.run(...)` to `.build(...).run(closure)` so we can observe events.)

- [ ] **Step 2: Manual smoke**

Repeat Task 20 step 3. Quit the app. Within 500ms, `ps aux | grep 'tinstar --port 5299'` should return nothing. Run 3 times to confirm no flakiness.

Force-quit test (don't actually do this on the user's prod backend!): `kill -9 $(pgrep -f 'src-tauri/target/debug/tinstar')` while Tauri is running. Expect: `tinstar --port 5299` survives (this is the documented orphan case). `pkill -f 'tinstar --port 5299'` to clean up. Document in README.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/main.rs
git commit -m "feat(backend): kill spawned tinstar child on app exit"
```

---

## Task 22: Phase 2d coverage matrix self-check

For each of the four user workflows, walk through manually and assert the expected behavior. No commits unless you find bugs.

- [ ] **Remote-only (user's main case):** `desktop.json` = `{mode:remote, backendUrl:http://infrapoc:5273, manageBackend:false}`. Launch → splash → main → canvas hits infrapoc. Quit → no spawned children to clean up.
- [ ] **Local-detect (manageBackend:false):** `desktop.json` = `{mode:local, backendUrl:http://localhost:9999, manageBackend:false, localPort:9999}`. Nothing listening. Launch → splash → "Backend not reachable" with `tinstar --port 9999`. Click "Reconfigure" → setup screen. Click "Try again" → still unreachable.
- [ ] **Local-managed (manageBackend:true):** as Task 20 step 3. Launch → splash → spawns tinstar :5299 → canvas → quit cleans up.
- [ ] **First-run, no config:** delete `desktop.json`. Launch → splash → setup screen. Save remote config → canvas.

---

# Phase 2e — Build pipeline

## Task 23: Local production build artifacts

**Files:** none.

- [ ] **Step 1: Build a release**

Run: `npm run tauri:build`
Expected: `src-tauri/target/release/bundle/<format>/...` populated. macOS: DMG. Linux: AppImage + .deb. Windows: MSI.

- [ ] **Step 2: Smoke the release binary** — install the DMG/AppImage/MSI, launch. Expect identical behavior to debug builds.

- [ ] **Step 3: Note the size and any build warnings.** No commit; this is a local sanity check before CI.

---

## Task 24: GitHub Actions release workflow

**Files:** create `.github/workflows/release.yml`.

- [ ] **Step 1: Workflow file**

```yaml
name: Release Tauri Desktop
on:
  push:
    tags: ['v*']
  workflow_dispatch:

jobs:
  build:
    strategy:
      fail-fast: false
      matrix:
        include:
          - { os: macos-latest, target: '' }
          - { os: ubuntu-22.04, target: '' }
          - { os: windows-latest, target: '' }
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'npm' }
      - uses: dtolnay/rust-toolchain@stable
      - uses: swatinem/rust-cache@v2
        with: { workspaces: 'src-tauri -> target' }
      - name: Install Linux deps
        if: matrix.os == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev
      - run: npm ci
      - run: npm run build:all
      - name: Tauri build
        run: npm run tauri:build
      - name: Upload artifacts
        uses: actions/upload-artifact@v4
        with:
          name: tinstar-${{ matrix.os }}
          path: |
            src-tauri/target/release/bundle/dmg/*.dmg
            src-tauri/target/release/bundle/msi/*.msi
            src-tauri/target/release/bundle/appimage/*.AppImage
            src-tauri/target/release/bundle/deb/*.deb

  release:
    needs: build
    runs-on: ubuntu-22.04
    if: startsWith(github.ref, 'refs/tags/v')
    steps:
      - uses: actions/download-artifact@v4
        with: { path: dist }
      - uses: softprops/action-gh-release@v2
        with:
          files: dist/**/*
          generate_release_notes: true
```

- [ ] **Step 2: Trigger via `workflow_dispatch` first** to verify the matrix builds before tagging V4.0.

Run: `gh workflow run release.yml`
Watch: `gh run watch`
Expected: 3 successful builds, artifacts uploaded.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(release): GitHub Actions matrix for macOS/Windows/Linux Tauri builds"
```

---

## Task 25: Install/run docs for unsigned binaries

**Files:** create `docs/desktop-app.md`, modify `README.md`.

- [ ] **Step 1: Write `docs/desktop-app.md`**

Sections:
1. **Download** — link to GitHub release.
2. **macOS install (unsigned)** — instructions: download DMG, open, drag to Applications, *first launch must be right-click → Open* (or System Settings → Privacy & Security → "Open Anyway").
3. **Windows install (unsigned)** — SmartScreen warning; click "More info" → "Run anyway".
4. **Linux install** — `chmod +x Tinstar*.AppImage && ./Tinstar*.AppImage`, or `sudo dpkg -i tinstar*.deb`.
5. **Backend setup** — three modes (remote / local-detect / local-managed). Sample `desktop.json` for each. Where to find it: macOS `~/Library/Application Support/io.tinstar.desktop/`, Linux `~/.config/io.tinstar.desktop/`, Windows `%APPDATA%\io.tinstar.desktop\`.
6. **Remote-mode CORS** — instruct that the remote backend must allowlist the desktop origin: on the remote, run `TINSTAR_CORS_ORIGINS='tauri://localhost,https://tauri.localhost' tinstar`.
7. **Troubleshooting** — orphan child after force-quit (`pkill -f 'tinstar --port'`), config reset (`rm desktop.json`), seeing the saved config (`cat .../desktop.json`).
8. **Known limitations** — V4.0 binaries are unsigned; signing is post-V4.0.

- [ ] **Step 2: README pointer**

Add to README:
```markdown
## Desktop app

Tinstar ships as a Tauri desktop app for macOS, Windows, and Linux.
See [docs/desktop-app.md](docs/desktop-app.md) for install and config.
```

- [ ] **Step 3: Commit**

```bash
git add docs/desktop-app.md README.md
git commit -m "docs(desktop): install + configuration guide for V4.0 desktop app"
```

---

## Task 26: Tag V4.0 and verify the release fires

**Files:** none.

- [ ] **Step 1: All tests green**

```bash
npx tsc --noEmit
npx vitest run
(cd src-tauri && cargo test)
```

- [ ] **Step 2: Tag**

```bash
git tag -a v4.0.0 -m "Tinstar V4.0 — Tauri desktop app"
git push origin v4.0.0
```

- [ ] **Step 3: Watch CI**

```bash
gh run watch
```

Expected: 3 builds succeed, GitHub release created with DMG/MSI/AppImage/deb artifacts.

- [ ] **Step 4: Manual install of one artifact**

Download the release DMG (or your platform's artifact), install, launch, walk through the four user workflows from Task 22 against the production binary. Expect identical behavior.

- [ ] **Step 5: Commit (post-release fixes only, if any)**

If V4.0 ships clean: no commit. If smoke testing the release surfaces bugs, fix → patch tag (`v4.0.1`).

---

## Phase 2 — Self-Review Checklist

- [ ] **Spec coverage for the 4 user workflows.** Remote-only: Task 7, 8, 11, 12, 22. Local-detect: Task 17, 18, 22. Local-managed: Task 19–21, 22. First-run no-config: Task 11, 22.
- [ ] **Each Tauri-side decision justified.** Window count: 2 (splash + main) — splash dismissed on `PageLoadEvent::Finished`, justified in Task 15. IPC commands: 5 (`get_config`, `save_config`, `probe_backend`, `start_local_backend`, `stop_local_backend`) — minimum to support the four workflows. Build targets: DMG/MSI/AppImage/deb per the briefing.
- [ ] **No placeholders.** Every task has actual code or a precise spec. The single explicit "TBD if hits a wall": Task 16 step 1 (custom `tinstar-react-ready` event) — only added if smoke testing reveals a flash gap. Reasoning provided.
- [ ] **Type consistency across IPC.** `get_config`: Rust returns `Result<DesktopConfig, String>` ↔ TS `getConfig(): Promise<DesktopConfig | null>` (null only outside Tauri). `save_config`: Rust takes `config: DesktopConfig` ↔ TS `saveConfig(config: DesktopConfig)`. `probe_backend`: Rust `url: String` ↔ TS `url: string`. `start_local_backend`: Rust `port: u16` ↔ TS `port: number`. `DesktopConfig` Rust struct uses `#[serde(rename_all = "camelCase")]` so the wire format matches the TS interface field-for-field — Task 7 has the round-trip test asserting this.
- [ ] **Phase 1 files untouched.** `src/apiClient.ts` adds one new public export (`resetApiBaseFromGlobal`) but is otherwise unchanged; `src/server/*` and `bin/tinstar.js` and `scripts/tauri-rehearsal.sh` are unmodified by Phase 2.
- [ ] **Safety: every smoke test uses `:5299` (or `:5274` only when wired through `TINSTAR_CONFIG_HOME` isolation) and pkill patterns include the literal port.**

---

## Execution Handoff

Plan complete. Phase 2 is fully detailed (26 tasks across 5 sub-phases). Each task is one atomic commit with TDD discipline matching Phase 1.

Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task or per sub-phase. Phase 2a, 2b, 2d each have natural subagent boundaries; Phase 2c (3 tasks) and 2e (4 tasks) can each be one subagent.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch by sub-phase with checkpoints between 2a→2b, 2b→2c, 2c→2d, 2d→2e.
