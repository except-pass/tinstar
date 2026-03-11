#!/bin/bash
# Launch ttyd web terminal inside a container.
# Env vars set by docker exec:
#   TINSTAR_SESSION_NAME - session name for title
#   WORKSPACE_DIR - working directory
#   RESUME_CONVERSATION_ID - conversation to resume (optional)
#   SKIP_PERMISSIONS - skip Claude permission prompts (optional)

TITLE="${TINSTAR_SESSION_NAME:-Tinstar}"
TMUX_SESSION="main"

# Create tmux session if it doesn't exist
if ! tmux has-session -t $TMUX_SESSION 2>/dev/null; then
    tmux -f /dev/null new -d -s $TMUX_SESSION
    tmux set -t $TMUX_SESSION status off
    tmux set -t $TMUX_SESSION mouse on

    # Forward secrets into tmux environment
    for var in CLAUDE_CODE_OAUTH_TOKEN GH_TOKEN GH_APP_ID GH_INSTALLATION_ID GH_APP_KEY; do
        [ -n "${!var}" ] && tmux set-environment -t $TMUX_SESSION "$var" "${!var}"
    done

    # Build claude command
    CLAUDE_CMD="claude"
    [ -n "$SKIP_PERMISSIONS" ] && CLAUDE_CMD="$CLAUDE_CMD --dangerously-skip-permissions"
    if [ -n "$RESUME_CONVERSATION_ID" ]; then
        CLAUDE_CMD="$CLAUDE_CMD --resume $RESUME_CONVERSATION_ID"
    fi

    WORKDIR="${WORKSPACE_DIR:-$HOME}"
    tmux send-keys -t $TMUX_SESSION "eval \"\$(tmux show-environment -s)\" && cd $WORKDIR && $CLAUDE_CMD" Enter
fi

# Start ttyd
exec ttyd -W -p 7681 \
    -t titleFixed="$TITLE" \
    -t 'theme={"background":"#000000"}' \
    bash -c "tmux attach -t $TMUX_SESSION"
