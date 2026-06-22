# Running Tinstar on Windows (via WSL2)

Tinstar's session backend spawns one **tmux** + **ttyd** process per agent
session and coordinates them over **NATS**. All three are Unix-only — they are
explicitly disabled on native Windows, where the backend logs:

```
[observability] telemetry disabled: unsupported platform win32
[nats] disabled: unsupported platform win32
[marshal-boot] auto-start threw: spawn tmux ENOENT
```

So on Windows you can serve the **UI** natively (`npm run dev` in PowerShell
loads the canvas fine), but **spawning real agent sessions requires WSL2**.
This guide sets up the full stack inside WSL2 Ubuntu.

> If you just want the desktop app, see [desktop-app.md](desktop-app.md) — but
> note its bundled backend hits the same Windows limitation. WSL2 is the way to
> get working session terminals on a Windows machine.

---

## Prerequisites

- **WSL2** with a Debian/Ubuntu distro (`wsl --install -d Ubuntu`). Confirm
  it's version 2: `wsl -l -v` should show `VERSION 2`.
- A **Claude** subscription or API key for authenticating the agent CLI.

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

The session terminals you see in the canvas are served by `ttyd`. Install the
static binary into a directory already on your `$PATH`:

```bash
mkdir -p "$HOME/.local/bin"
curl -fSL -o "$HOME/.local/bin/ttyd" \
  https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64
chmod +x "$HOME/.local/bin/ttyd"
ttyd --version
```

`tmux` and `lsof` are also required and ship with most distros already
(`sudo apt install tmux lsof` if missing). **NATS needs no manual install** —
Tinstar downloads and manages its own `nats-server` on first launch.

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

## 4. Authenticate the agent CLI

Sessions launch an agent CLI (by default `claude`). Install and authenticate it
inside WSL:

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

For auth, either run `claude login` once, or use a subscription OAuth token.
To make the token available to every session Tinstar spawns, put it in a file
the launcher sources (keep it `600`):

```bash
umask 077
echo 'export CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-...' > ~/.tinstar-env
chmod 600 ~/.tinstar-env
```

> Prefer the subscription OAuth token over `ANTHROPIC_API_KEY` — an API key
> bills separately even if you already pay for a subscription.

---

## 5. Run

```bash
cd ~/tinstar
export TINSTAR_TELEMETRY=0          # optional: skip the embedded Grafana/Prometheus download
[ -f ~/.tinstar-env ] && . ~/.tinstar-env
npm run dev
```

| Service | URL |
|---|---|
| Frontend (UI) | http://localhost:5280 |
| Backend (API) | http://localhost:5281 |
| NATS | nats://127.0.0.1:4222 (auto-installed) |

WSL2 forwards `localhost`, so open **http://localhost:5280** in a Windows
browser. A healthy boot logs `nats-server ready`, `nats-traffic connected`, and
`marshal session ready` with **no** `ENOENT` warnings.

Verify a real session end-to-end:

```bash
curl -fsS -X POST http://localhost:5281/api/sessions \
  -H 'Content-Type: application/json' -d '{"name":"smoketest"}'
tmux ls            # -> tinstar-smoketest
pgrep -a ttyd      # -> ttyd -W -p <port> ... tmux attach -t tinstar-smoketest
curl -fsS -X DELETE http://localhost:5281/api/sessions/smoketest   # cleanup
```

---

## One-click launcher scripts

Two small scripts make day-to-day use a single command. Put them on `$PATH`:

`~/.local/bin/tinstar-dev`:

```bash
#!/usr/bin/env bash
export PATH="$HOME/.local/bin:$HOME/.local/node/bin:$PATH"
export TINSTAR_TELEMETRY=0
[ -f "$HOME/.tinstar-env" ] && . "$HOME/.tinstar-env"
cd "$HOME/tinstar" || exit 1
exec npm run dev
```

`~/.local/bin/tinstar-stop` (kills the dev server, NATS, ttyd, and agent tmux):

```bash
#!/usr/bin/env bash
pkill -f "npm run dev"; pkill -f vite; pkill -f "tsx watch"
pkill -f standalone.ts; pkill nats-server; pkill ttyd
tmux kill-server 2>/dev/null; exit 0
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
| `nats disabled: unsupported platform win32` | You're running the backend on native Windows, not WSL. |
| UI loads but sessions never get a terminal | `ttyd` missing, or the agent CLI (`claude`) isn't installed/authenticated in WSL. |
| `localhost:5280` unreachable from Windows | Rare WSL2 localhost-forwarding drop — retry, restart WSL (`wsl --shutdown`), or use the WSL IP from the Vite "Network:" line. |
| nvm refuses with "WSL 1 is not supported" | nvm misdetects the kernel; use the Node tarball in step 1 instead. |
| First launch slow / downloading large binaries | The embedded telemetry stack (Grafana/Prometheus/Alloy). Set `TINSTAR_TELEMETRY=0` to skip it. |

---

## Why not just native Windows?

The multi-agent core depends on tmux (session multiplexing), ttyd (terminal
streaming), and a Unix NATS server. Porting those to Windows isn't currently in
scope, so WSL2 is the supported path for agent sessions on Windows. The UI,
docstore, and HTTP/SSE layers are cross-platform and run fine either way.
