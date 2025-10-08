---
allowed-tools: Bash(pnpm lint:*), Bash(pnpm typecheck:*), Bash(pnpm build:*)
description: Prep
---

Perform the following, in order.  Debug each step until it successfully passes.
`pnpm lint`
`pnpm typecheck`
`timeout 240 pnpm build`