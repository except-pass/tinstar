---
title: Sessions
description: Running CLI agents
slug: sessions
---

# Sessions

A session is a running CLI agent (claude, marshal, custom) attached to a project's working directory. Sessions are the unit of "work" in tinstar.

## Commands

```
tinstar sessions list
tinstar sessions create my-session myapp claude-multi-agent
tinstar sessions stop my-session
```

The optional final argument is the stable template ID shown by
`tinstar templates list`, not the template's renameable display name.

## See also

- [projects](projects)
- [tasks](tasks)
