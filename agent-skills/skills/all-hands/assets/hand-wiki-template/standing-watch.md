# <hand-name> — standing watch

When the implementer posts a `committed:` line in the room, I wake up if any of the following match. Otherwise I stay silent.

## Triggers

1. **<trigger name>** — wake on: <concrete pattern, e.g. file path glob, dependency change, keyword in commit subject>
   - Why: <one-line reason this matters in my lane>
   - When woken, I will: <one-line action — usually "ask a clarifying question" or "post a concrete concern with file:line">

2. **<trigger name>** — wake on: <pattern>
   - Why: <reason>
   - When woken, I will: <action>

(1 or 2 triggers max. More than that and I am not "lurking" — I am noisy.)
