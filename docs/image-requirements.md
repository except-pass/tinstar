# Docker Image Requirements

This document describes what a Docker image must provide to be compatible with Tinstar's Docker session backend.

---

## Required Binaries

The following must be installed and on `$PATH` inside the image:

| Binary | Purpose |
|--------|---------|
| `bash` | Shell used by `start-ttyd.sh` and tmux sessions |
| `tmux` | Session manager — Tinstar creates a `main` tmux session inside the container |
| `ttyd` | Web terminal emulator — must be able to bind port 7681 |
| `claude` | Claude Code CLI — the actual agent process |
| `curl` | Used by Claude Code hooks to POST state updates back to Tinstar |

---

## Home Directory

The container must have a home directory that is:

- **Writable** by the user Tinstar injects at runtime (the host user's UID:GID)
- **Not owned by root** in a way that blocks writes (since the container runs as the host user, not root)

**Default home:** `/home/tinstar`

This can be overridden per image profile in `~/.config/tinstar/config.json`:

```json
{
  "profiles": [
    { "name": "my-image", "image": "my-image:latest", "home": "/home/myuser" }
  ]
}
```

If you use a non-standard home (e.g. `/root`), you must set the profile `home` field so Tinstar mounts volumes in the right place.

---

## Port 7681

`ttyd` listens on port **7681** inside the container. Tinstar maps this to an available host port (`8681–8780`) and reverse-proxies it through Caddy.

The image must not block or occupy port 7681 before `start-ttyd.sh` runs.

---

## Entrypoint / CMD

The image must start with an entrypoint that keeps the container alive. Tinstar launches containers with:

```
docker run -d ... <image> sleep infinity
```

And then executes `start-ttyd.sh` via `docker exec`.

**You can use any entrypoint** as long as the container stays running and `docker exec` works. `sleep infinity` is the default if your image has no entrypoint or CMD, but Tinstar explicitly passes it so the image CMD is overridden.

---

## Volume Mounts (Tinstar Manages These)

Tinstar automatically mounts the following volumes — the image does not need to set them up, but **must not conflict** with these paths:

| Host Path | Container Path | Purpose |
|-----------|----------------|---------|
| `~/.config/tinstar/sessions/{name}/claude-state/` | `{home}/.claude/projects` | Claude conversation state persistence |
| `~/.claude/.credentials.json` | `{home}/.claude/.credentials.json` (read-only) | Claude OAuth credentials |
| `{workspace.path}` | Same absolute path | The workspace / git repo |
| `{basePath}/.git` | Same absolute path | Parent repo `.git` for worktrees |
| `~/.config/tinstar/start-ttyd.sh` | `{home}/start-ttyd.sh` (read-only) | Session launch script |

**Do not** bake a `~/.claude/projects/` directory into the image — it will be shadowed by the mount, wasting space and potentially hiding errors if the mount fails.

**Do not** bake a `~/.claude/.credentials.json` into the image — Tinstar mounts the host credentials file read-only.

---

## Environment Variables

Tinstar injects these at `docker exec` time. The image does not need to set them, but your startup scripts or hooks can rely on them:

| Variable | Value | Notes |
|----------|-------|-------|
| `TINSTAR_SESSION_NAME` | Session name (e.g. `my-feature`) | Identifies the session in hook callbacks |
| `TINSTAR_DASHBOARD_URL` | `http://host.docker.internal:5273` | Dashboard URL, `localhost` rewritten for container context |
| `RF_SESSION_NAME` | Same as `TINSTAR_SESSION_NAME` | Alias for images using the `RF_*` convention |
| `RF_DASHBOARD_URL` | Same as `TINSTAR_DASHBOARD_URL` | Alias for images using the `RF_*` convention |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://host.docker.internal:4318` | OTel telemetry endpoint |
| `WORKSPACE_DIR` | Absolute path to workspace | Working directory for Claude |
| `SESSION_ID` | UUID | Claude conversation ID for new sessions |
| `RESUME_SESSION_ID` | UUID | Claude conversation ID to resume (if resuming) |
| `SKIP_PERMISSIONS` | `1` or unset | If set, launches Claude with `--dangerously-skip-permissions` |

**Secrets** from `~/.config/tinstar/.secrets/` are also injected — one env var per file, named after the filename. Common ones:

| Variable | Purpose |
|----------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | Claude Code authentication |
| `GH_TOKEN` | GitHub CLI authentication |
| `GH_APP_ID` / `GH_INSTALLATION_ID` / `GH_APP_KEY` | GitHub App authentication (optional) |

---

## Docker Runtime Flags

Tinstar always adds these flags at `docker run` time:

| Flag | Value | Reason |
|------|-------|--------|
| `--user` | `{host-uid}:{host-gid}` | Run as host user so mounted files are writable |
| `--ipc=host` | — | Shared memory (needed by some Claude Code internals) |
| `--add-host` | `host.docker.internal:host-gateway` | Lets container reach host services (hooks, OTel) |
| `-p` | `127.0.0.1:{allocated-port}:7681` | Maps ttyd port to an available host port |

Your image must be compatible with running as a non-root user (the host UID). If your image uses `USER root` in the Dockerfile, that's fine — Tinstar overrides it at runtime.

---

## Claude Code Hooks

Tinstar installs Claude Code hooks into `.claude/settings.json` inside the workspace (not inside the image). The hooks call back to Tinstar via `curl`:

```
POST http://host.docker.internal:5273/api/hooks/idle    — Claude went idle
POST http://host.docker.internal:5273/api/hooks/active  — Claude is running
POST http://host.docker.internal:5273/api/hooks/file-touched  — Claude edited a file
```

**Requirements for hook scripts:**
- Use synchronous (blocking) `curl`, not backgrounded (`curl ... &`). Backgrounded curl causes Claude Code to report a hook error even if the data arrives.
- Do not suppress curl's exit code in a way that masks failures.

If your image has its own hook scripts that conflict with these, they will be de-duplicated on session create — Tinstar removes any previous hook entries containing `/api/hooks/` before adding its own.

---

## Networking

The container needs to reach `host.docker.internal` to deliver hook callbacks. This is guaranteed by `--add-host=host.docker.internal:host-gateway` which Tinstar sets automatically.

The image does not need any special network configuration.

---

## What Tinstar Does NOT Require

- A specific Linux distro or base image (Debian, Ubuntu, Alpine all work)
- A specific version of `tmux` or `ttyd`
- Root access at runtime (Tinstar runs as the host user)
- A custom `CMD` or `ENTRYPOINT` (Tinstar overrides with `sleep infinity`)
- Pre-installed project files, repos, or Claude projects (these are all volume-mounted)

---

## Minimal Compatible Dockerfile

```dockerfile
FROM ubuntu:24.04

# Install required binaries
RUN apt-get update && apt-get install -y \
    bash tmux curl \
    && rm -rf /var/lib/apt/lists/*

# Install ttyd
RUN curl -sSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 \
    -o /usr/local/bin/ttyd && chmod +x /usr/local/bin/ttyd

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Create home directory — Tinstar runs the container as host UID:GID,
# which may not match any user in /etc/passwd. The dir must be world-writable
# or owned by a UID range that includes the host user.
RUN mkdir -p /home/tinstar && chmod 777 /home/tinstar
```

> **Note:** chmod 777 on `/home/tinstar` is the safest default since Tinstar runs as the arbitrary host UID, not a user defined in the image. If your UID is predictable, use `chown` instead.

---

## Profile Configuration

To use a custom image or non-standard home directory, add a profile to `~/.config/tinstar/config.json`:

```json
{
  "container": {
    "defaultImage": "tinstar"
  },
  "profiles": [
    {
      "name": "my-custom-image",
      "image": "my-org/my-image:latest",
      "home": "/home/myuser"
    }
  ]
}
```

When creating a session, set its `profile` to `"my-org/my-image:latest"` and Tinstar will use that image with the overridden home directory.
