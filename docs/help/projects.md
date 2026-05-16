---
title: Projects
description: Git repos tinstar can spawn sessions inside
slug: projects
---

# Projects

A project is a registered name → path mapping for a git repo. Sessions reference projects by name when they start.

## When to register one

- Any time you want to spawn sessions inside a new repo.
- Projects are global — once registered, any workspace can use them.

## Commands

```
tinstar projects list
tinstar projects register myapp /home/me/repo/myapp
tinstar projects unregister myapp
```

## See also

- [sessions](sessions)
- [onboarding](onboarding)
