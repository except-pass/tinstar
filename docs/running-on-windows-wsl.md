# Running Tinstar on Windows (via WSL2)

Tinstar shows the workers of a [First Mate](https://github.com/kunchenguid/firstmate)
home and opens their terminals through **tmux** + **ttyd**. Both are Unix-only,
and so are First Mate's tmux-backed workers, so on a Windows machine the backend
and the First Mate home both run inside WSL2. This guide sets up the stack inside
WSL2 Ubuntu.

> If you just want the desktop app, see [desktop-app.md](desktop-app.md) — but
> note its bundled backend hits the same Windows limitation. WSL2 is the way to
> get working worker terminals on a Windows machine.

---

## Prerequisites

- **WSL2** with a Debian/Ubuntu distro (`wsl --install -d Ubuntu`). Confirm
  it's version 2: `wsl -l -v` should show `VERSION 2`.
- A **First Mate** home inside WSL, set up per First Mate's own docs. First Mate
  launches and authenticates the workers; Tinstar never does.

Everything below runs **inside WSL** unless noted. Nothing needs `sudo`.

---

## 1. Node.js 22+

Tinstar needs Node ≥ 22.12. The official tarball is the most reliable install
on WSL (the Windows Node on your `$PATH` is not usable from Linux, and `nvm`
can misdetect a WSL2 kernel as "WSL 1" and refuse to install):

```bash
FILE=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/ \
  | grep -oE 'node-v22\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz' | head -1)
curl -fSL -o /tmp/node.tar.xz "https://nodejs.org/dist/latest-v22.x/$FILE"
mkdir -p "$HOME/.local/node"
tar -xJf /tmp/node.tar.xz -C "$HOME/.local/node" --strip-components=1
echo 'export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"' >> "$HOME/.bashrc"
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
node -v && npm -v
```

(If you have passwordless `sudo`, NodeSource/apt works too — the tarball just
avoids the sudo and nvm pitfalls.)

---

## 2. ttyd (terminal server)

The worker terminals you see in the cockpit are served by `ttyd`. Install the
static binary into a directory already on your `$PATH`:

```bash
mkdir -p "$HOME/.local/bin"
curl -fSL -o "$HOME/.local/bin/ttyd" \
  https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64
chmod +x "$HOME/.local/bin/ttyd"
ttyd --version
```

`tmux` and `lsof` are also required and ship with most distros
already (`sudo apt install tmux lsof` if missing).

---

## 3. Clone and install Tinstar

Clone into the **WSL-native filesystem** (`~`), not `/mnt/c`. Running from
`/mnt/c` breaks Vite's file-watching (inotify doesn't work over DrvFs) and is
much slower:

```bash
git clone https://github.com/except-pass/tinstar.git ~/tinstar
cd ~/tinstar
npm install
```

---

## 4. Point Tinstar at your First Mate home

List the home by absolute path in `~/.config/tinstar/config.json`:

```json
{ "firstmate": { "homes": ["/home/you/firstmate"] } }
```

See [the First Mate observer doc](features/firstmate-observer.md) for the
details.

---

## 5. Run

```bash
cd ~/tinstar
export TINSTAR_TELEMETRY=0          # optional: skip the embedded Grafana/Prometheus download
npm run dev
```

| Service | URL |
|---|---|
| Frontend (UI) | http://localhost:5280 |
| Backend (API) | http://localhost:5281 |

WSL2 forwards `localhost`, so open **http://localhost:5280** in a Windows
browser. The cockpit should list the First Mate home's workers; check the
backend directly with:

```bash
curl -fsS http://localhost:5281/api/fleet
```

---

## One-click launcher scripts

Two small scripts make day-to-day use a single command. Put them on `$PATH`:

`~/.local/bin/tinstar-dev`:

```bash
#!/usr/bin/env bash
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
export TINSTAR_TELEMETRY=0
cd "$HOME/tinstar" || exit 1
exec npm run dev
```

`~/.local/bin/tinstar-stop` (kills the dev server and Tinstar's view ttyds; it
leaves tmux alone, because First Mate's workers run there):

```bash
#!/usr/bin/env bash
pkill -f "npm run dev"; pkill -f vite; pkill -f "tsx watch"
pkill -f standalone.ts; pkill -f "ttyd.*tinstar-fm-view"; exit 0
```

`chmod +x` both. Then `tinstar-dev` starts everything; close the terminal or
Ctrl-C to stop, and `tinstar-stop` force-cleans anything left over.

### Optional: a Windows desktop shortcut

Drive the WSL launcher from a Windows PowerShell wrapper and pin it to a
desktop `.lnk`. The wrapper clears stale processes, opens the browser when the
port is up, and runs the dev server in the foreground so closing the window
stops Tinstar:

```powershell
wsl.exe -d Ubuntu -- bash -lc "~/.local/bin/tinstar-stop"   # pre-clean
Start-Process "http://localhost:5280/"                       # (after the port is listening)
wsl.exe -d Ubuntu -- bash -lc "exec ~/.local/bin/tinstar-dev"
```

Point a shortcut at `powershell.exe -NoProfile -ExecutionPolicy Bypass -NoExit
-File <wrapper>.ps1` and set its icon to `src-tauri/icons/icon.ico`.

---

## Editing with hot-reload

Because the runnable copy lives at `~/tinstar` inside WSL, edit it with
**VS Code → "Connect to WSL"** (Remote-WSL extension), opening the `~/tinstar`
folder. Vite HMR then works normally. Editing the same repo from a Windows path
over `/mnt/c` will not hot-reload.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `spawn tmux ENOENT` / `spawn ttyd ENOENT` | The binary isn't on the **server process's** `$PATH`. Ensure `~/.local/bin` is exported before `npm run dev` (the `tinstar-dev` script does this). |
| Cockpit shows no workers | No `firstmate.homes` in `config.json`, or the backend is running on native Windows instead of WSL. `node bin/tinstar.js doctor` checks each home. |
| Workers listed but no terminal | `ttyd` missing from the server process's `$PATH`. |
| `localhost:5280` unreachable from Windows | Rare WSL2 localhost-forwarding drop — retry, restart WSL (`wsl --shutdown`), or use the WSL IP from the Vite "Network:" line. |
| nvm refuses with "WSL 1 is not supported" | nvm misdetects the kernel; use the Node tarball in step 1 instead. |
| First launch slow / downloading large binaries | The embedded telemetry stack (Grafana/Prometheus/Alloy). Set `TINSTAR_TELEMETRY=0` to skip it. |

---

## Why not just native Windows?

Worker terminals depend on tmux and ttyd, and First Mate's workers run in tmux.
Porting those to Windows isn't currently in scope, so WSL2 is the supported
path on Windows. The UI and HTTP/SSE layers are cross-platform.
