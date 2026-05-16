---
title: Workspaces
description: Top-level containers for tasks, sessions, and worktrees
slug: workspaces
---

# Workspaces

A workspace (also called a "space" in the API) is the top-level container for everything you do in tinstar — tasks, sessions, worktrees, and editor widgets all live inside one workspace at a time.

## When to make one

- Each major project, repo, or area of work gets its own workspace.
- Don't make workspaces per-feature — that's what tasks and epics are for.

## Commands

```
tinstar workspaces list
tinstar workspaces create "My Project"
tinstar workspaces delete <id>
```

## See also

- [tasks](tasks)
- [projects](projects)
