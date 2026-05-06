# Standing Watch — Format Guide

A standing watch is the 1–2 triggers that should pull you out of "lurking" during implementation. The implementer posts a `committed:` line after each commit; you read the line and your `standing-watch.md`, and self-decide whether to wake.

## Format

Each trigger has three parts:

1. **Pattern** — the concrete signal that fires the trigger
2. **Why** — one sentence on why this matters in your lane (so future-you can judge edge cases)
3. **Action** — one sentence on what you do when woken

## Good examples

````
1. **Auth surface change** — wake on: any commit touching `src/auth/` or adding/removing env vars matching `*_TOKEN`, `*_SECRET`, `*_KEY`
   - Why: token handling is where most security incidents land
   - When woken, I will: post a concrete question about token lifecycle (rotation, expiry, storage) with file:line
````

````
1. **New external call** — wake on: commit subject mentioning `fetch`, `http`, `axios`, or any file diff adding a new URL
   - Why: every new outbound call is a new trust boundary
   - When woken, I will: ask whether the response is validated and what happens on timeout/non-2xx
````

````
1. **Dependency added** — wake on: changes to `package.json`, `package-lock.json`, `requirements.txt`, `Cargo.toml`, etc.
   - Why: supply chain is a security and perf vector
   - When woken, I will: name the dep and ask why it's needed and whether it has a license/maintenance flag
````

## Bad examples (and why)

````
1. **Anything important** — wake on: anything that looks risky
````
Bad: "important" and "risky" are not patterns. You'll wake on everything or nothing.

````
1. **All commits** — wake on: every commit
   - When woken, I will: think about whether security applies
````
Bad: this isn't lurking. You'll dominate the room and burn tokens. Pick a real signal.

````
1. **Style** — wake on: commits with linter changes
````
Bad: scope is too narrow to justify a hand's existence. If this is your only watch, you probably shouldn't be in the roster.

## Rule of thumb

If your watch fires on more than ~30% of commits, it's too broad. If it fires on <5%, it might be too narrow — consider whether you should be in the roster at all.
