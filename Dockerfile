# Tinstar-compliant container image
#
# Provides everything needed for a Tinstar Docker session:
#   bash, tmux, ttyd, curl, node, claude
#
# See docs/image-requirements.md for the full spec.
#
# Build:
#   docker build -t tinstar .
#
# You don't need to run this directly — Tinstar manages containers.
# Set "defaultImage": "tinstar" in ~/.config/tinstar/config.json (the default).

FROM ubuntu:24.04

# Avoid interactive prompts during apt
ENV DEBIAN_FRONTEND=noninteractive

# ── System packages ──────────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    tmux \
    curl \
    ca-certificates \
    git \
    && rm -rf /var/lib/apt/lists/*

# ── Node.js 22 (LTS) via NodeSource ──────────────────────────────────────────
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# ── ttyd ─────────────────────────────────────────────────────────────────────
# Web terminal emulator — must bind port 7681 inside the container.
RUN curl -sSL https://github.com/tsl0922/ttyd/releases/latest/download/ttyd.x86_64 \
    -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

# ── Claude Code CLI ───────────────────────────────────────────────────────────
RUN npm install -g @anthropic-ai/claude-code

# ── Home directory ────────────────────────────────────────────────────────────
# Tinstar runs the container as the host UID:GID (--user flag at runtime),
# which may not match any user in /etc/passwd. chmod 777 ensures the mounted
# home is writable regardless of which UID Tinstar injects.
#
# Do NOT pre-create ~/.claude/projects/ or ~/.claude/.credentials.json here —
# Tinstar volume-mounts both at runtime.
RUN mkdir -p /home/tinstar && chmod 777 /home/tinstar

ENV HOME=/home/tinstar
WORKDIR /home/tinstar

# ── Port ─────────────────────────────────────────────────────────────────────
# ttyd listens here. Tinstar maps this to a host port (8681–8780) automatically.
EXPOSE 7681

# Tinstar overrides CMD with `sleep infinity` and launches the session via
# `docker exec`. Any CMD that keeps the container alive works.
CMD ["sleep", "infinity"]
