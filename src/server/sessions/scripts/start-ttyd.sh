#!/bin/bash
# Launch ttyd web terminal inside a container.
# Env vars set by docker exec:
#   TINSTAR_SESSION_NAME - session name for title
#   WORKSPACE_DIR - working directory
#   SESSION_ID - dictate Claude session ID on first launch (optional)
#   RESUME_SESSION_ID - resume a previous Claude session by ID (optional)
#   SKIP_PERMISSIONS - skip Claude permission prompts (optional)
#   INITIAL_PROMPT - passed as positional argument to claude on first launch (optional)

TITLE="${TINSTAR_SESSION_NAME:-Tinstar}"
TMUX_SESSION="main"

# Create tmux session if it doesn't exist
if ! tmux has-session -t $TMUX_SESSION 2>/dev/null; then
    tmux -f /dev/null new -d -s $TMUX_SESSION
    tmux set -t $TMUX_SESSION status off
    tmux set -t $TMUX_SESSION mouse on
    # Match host terminal type so C-h keybinding works consistently
    tmux set -g default-terminal screen

    # Ctrl+Backspace (xterm.js sends 0x08 / C-h) → word-erase
    tmux bind-key -n C-h send-keys C-w

    # Forward secrets into tmux environment
    for var in CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN GH_APP_ID GH_INSTALLATION_ID GH_APP_KEY; do
        [ -n "${!var}" ] && tmux set-environment -t $TMUX_SESSION "$var" "${!var}"
    done

    # Build claude command
    CLAUDE_CMD="claude"
    [ -n "$SKIP_PERMISSIONS" ] && CLAUDE_CMD="$CLAUDE_CMD --dangerously-skip-permissions"
    if [ -n "$RESUME_SESSION_ID" ]; then
        CLAUDE_CMD="$CLAUDE_CMD --resume $RESUME_SESSION_ID"
    elif [ -n "$SESSION_ID" ]; then
        CLAUDE_CMD="$CLAUDE_CMD --session-id $SESSION_ID"
    fi
    if [ -n "$INITIAL_PROMPT" ]; then
        CLAUDE_CMD="$CLAUDE_CMD -- $(printf '%q' "$INITIAL_PROMPT")"
    fi

    WORKDIR="${WORKSPACE_DIR:-$HOME}"
    tmux send-keys -t $TMUX_SESSION "eval \"\$(tmux show-environment -s)\" && cd $WORKDIR && $CLAUDE_CMD" Enter
fi

# Start ttyd
exec ttyd -W -p 7681 \
    -t titleFixed="$TITLE" \
    -t 'theme={"background":"#000000"}' \
    bash -c "tmux attach -t $TMUX_SESSION"
