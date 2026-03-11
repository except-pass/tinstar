#!/bin/bash
# Attach to the tmux session (called by ttyd)
TMUX_SESSION="main"

if tmux has-session -t $TMUX_SESSION 2>/dev/null; then
    exec tmux attach -t $TMUX_SESSION
else
    echo "No tmux session found. Starting bash."
    exec bash
fi
