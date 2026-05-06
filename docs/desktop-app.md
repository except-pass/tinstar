# Tinstar Desktop App

Tinstar V4.0+ ships as a native desktop app for macOS, Windows, and Linux,
built with Tauri. Same backend, same UI, same canvas — just a window
instead of a browser tab.

Download from [GitHub Releases](https://github.com/except-pass/tinstar/releases/latest).

---

## Install

| OS | File | First-launch note |
|---|---|---|
| macOS (Apple Silicon) | `Tinstar_4.0.0_aarch64.dmg` | Right-click → **Open** the first time (unsigned binary; macOS Gatekeeper warning is expected) |
| Windows (x86_64) | `Tinstar_4.0.0_x64-setup.exe` (NSIS installer) | Click **More info → Run anyway** on the SmartScreen warning |
| Windows (x86_64, alt) | `Tinstar_4.0.0_x64_en-US.msi` | Same as above |
| Linux (Debian/Ubuntu) | `Tinstar_4.0.0_amd64.deb` | `sudo dpkg -i Tinstar_4.0.0_amd64.deb` |
| Linux (other) | `Tinstar_4.0.0_amd64.AppImage` | `chmod +x Tinstar*.AppImage && ./Tinstar*.AppImage` |

The binaries are unsigned in V4.0. Both macOS and Windows show a
"can't verify developer" warning on first launch; the workarounds
above are the standard bypass.

---

## Backend setup — REQUIRED

The desktop app is a thin webview that talks to a `tinstar` HTTP
backend. It does **not** include its own backend yet (that's coming in
V4.1). You need a `tinstar` running somewhere reachable from the
machine you installed the app on.

### Where to run the backend

Either of these works:

- **On the same machine** as the desktop app — useful for solo dev.
- **On a different machine** reachable over the network (LAN, VPN,
  Tailscale, ngrok, etc.) — useful when your Tinstar work happens on
  a beefier remote server but you want a native window on your laptop.

### What the backend needs to allow

The desktop app's webview lives at the origin **`tauri.localhost`** —
which is *not* the same origin as your backend. Cross-origin requests
between the webview and your backend require the backend to allowlist
that origin via the `TINSTAR_CORS_ORIGINS` env var.

**Required allowlist entries** (when running tinstar for desktop-app
use):

```
tauri://localhost
https://tauri.localhost
http://tauri.localhost
```

Plus whatever browser origins you also want (e.g. `http://localhost:5273`
if you also use the browser UI on the same machine).

### Single command

The minimal invocation that supports both the desktop app and a
local-browser session:

```bash
TINSTAR_CORS_ORIGINS='tauri://localhost,https://tauri.localhost,http://tauri.localhost,http://localhost:5273' \
  tinstar --port 5273 --no-open --no-setup
```

If your backend lives behind a hostname or LAN IP that the desktop
app needs to reach, append that to the allowlist too:

```bash
TINSTAR_CORS_ORIGINS='...usual,http://your-host:5273' tinstar ...
```

The `--no-setup` flag skips the interactive "add as a Tinstar project"
prompt so the backend can boot non-interactively.

---

## Pointing the desktop app at the backend

V4.0's desktop app has a **hardcoded backend URL baked in at build
time** (currently `http://infrapoc:5273` from the V4.0 build). This
is a known limitation — V4.1 ships an in-app first-run setup screen
where you'll pick local vs remote and enter the URL.

For now: if the V4.0 binary's hardcoded URL doesn't match your
backend, build your own from the V4 branch with `HARDCODED_BASE`
edited in `src-tauri/src/main.rs`. See the
[Build from source](#build-from-source) section.

---

## Build from source

### Linux (native)

```bash
# One-time system deps:
tinstar doctor --tauri-dev    # prints the missing apt packages
sudo apt install -y libwebkit2gtk-4.1-dev libgtk-3-dev \
  libayatana-appindicator3-dev librsvg2-dev build-essential

# One-time Rust target:
rustup default stable

# Build:
git checkout main           # or any V4+ branch / tag
npm ci
npm run build:all
npx tauri build
# Artifacts in src-tauri/target/release/bundle/{appimage,deb}/
```

### Windows (native)

```bash
# Requires Visual Studio Build Tools and Rust on PATH.
git checkout main
npm ci
npm run build:all
npx tauri build
# Artifacts in src-tauri/target/release/bundle/{nsis,msi}/
```

### Cross-compile Windows from Linux

Tinstar's release pipeline uses native runners per OS, but if you
need a Windows .exe from a Linux box (e.g. a remote dev server):

```bash
rustup target add x86_64-pc-windows-msvc
cargo install cargo-xwin
sudo apt install -y clang lld llvm nsis
sudo ln -sf clang-14 /usr/bin/clang-cl   # if your distro lacks it
npm ci
npm run build:all
npx tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc
# Artifact: src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*.exe
```

### macOS

Build natively on a Mac. Cross-compile from Linux is technically
possible (`osxcross` + the Apple SDK) but legally murky and brittle —
just use a Mac, GitHub's macOS Actions runner, or a cloud Mac
(MacStadium, AWS mac1.metal).

---

## Troubleshooting

**`Access to ... has been blocked by CORS policy`** —
the backend isn't allowlisting `tauri.localhost`. Restart with the
`TINSTAR_CORS_ORIGINS` env var as documented above.

**`No 'Access-Control-Allow-Origin' header is present`** specifically on
`/api/events`** — your backend predates V4.0. The Phase 1 CORS
allowlist work that honors `TINSTAR_CORS_ORIGINS` only landed in V4.0.
Upgrade tinstar to v4.0+.

**`Window appears blank, console shows nothing`** —
WebView2 (Windows) or WebKit (Linux/macOS) is up but couldn't reach
the backend. Open DevTools (F12 in V4.0+ debug builds) → check the
Network tab. If `/api/events` is failing, see CORS notes above.

**`window.__TINSTAR_API_BASE__` is empty in DevTools** —
the Tauri shell's initialization_script didn't fire (rare — would mean
a Tauri framework bug). File an issue.

**Terminals show "No session or port specified" or render the canvas
inside themselves** —
the iframe wrapper isn't picking up the API base. Verify
`window.__TINSTAR_API_BASE__` is set to your backend URL. If it is,
file an issue.

**Saloon rename doesn't save / slash commands don't show / context
window doesn't update** —
Known V4.0 bug — four endpoints used raw `fetch()` instead of the
cross-origin-aware helper. Fixed on V4.1; will be in v4.0.1 (if cut)
or v4.1.0.

**Force-quit on local-managed mode left a `tinstar` orphan** —
`pkill -f 'tinstar --port <port>'`. This is the documented orphan
case for V4.0; V4.1's local-mode helper handles it deterministically.

---

## What's coming in V4.1

See `docs/v4.1-punchlist.md`. Highlights that affect the desktop app:

- **Auto first-run setup** — pick local vs remote, enter URL, save
  config. No more hardcoded backend URL at build time.
- **Local-mode helper** — desktop app can spawn its own `tinstar`
  backend if you don't have one running.
- **Deterministic orphan cleanup** for spawned backends.
