# Slash Command Autocomplete — Prompt Composer

**Date:** 2026-05-05
**Status:** Design approved, awaiting implementation plan
**Scope:** Add inline slash-command autocompletion to the prompt composer in `RunSessionPanel.tsx`, with filesystem-based discovery, local usage tracking, and OTLP telemetry.

## Goal

When the user types `/` in the prompt composer, surface the most relevant slash commands and skills they can invoke. Tab completes the top match. The status bar shows other top contenders. Tab pressed again cycles through them. The whole interaction must feel snappy and immediate — no spinners, no network round-trip in the typing path.

## Trigger rules

A `/` enters slash mode when:

- It is the first character of the textarea, OR
- The character immediately before it is whitespace.

`path/to/foo` does NOT trigger. `please /foo` does.

The "slash token" is the contiguous non-whitespace run starting at the `/`. Detection runs on every text change against the current cursor position:

```
function findSlashToken(text, cursor):
  let i = cursor - 1
  while i >= 0 and text[i] is not whitespace: i--
  // i points at last whitespace (or -1)
  if text[i+1] != '/': return null
  return { start: i+1, partial: text.slice(i+2, cursor) }
```

Slash mode exits when:

- The cursor moves outside the token range.
- A whitespace char is inserted into the token (commit).
- The token is deleted entirely.

## Discovery

Backend scans the same directories claude-code reads. Sources (in priority order for tie-break):

1. `<cwd>/.claude/commands/*.md` — project commands
2. `<cwd>/.claude/skills/*/SKILL.md` — project skills
3. `~/.claude/commands/*.md` — user commands
4. `~/.claude/skills/*/SKILL.md` — user skills
5. `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/commands/**/*.md`
6. `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/skills/*/SKILL.md`

Plugin entries are namespaced: `<plugin>:<name>` (matches what claude-code shows in the skill list — e.g. `superpowers:brainstorming`). User and project commands keep their bare name.

Each entry returns:

```ts
type SlashCommand = {
  name: string            // "full-review", "superpowers:brainstorming"
  description: string     // from frontmatter `description:` field
  source: 'project' | 'user' | 'plugin' | 'project-skill' | 'user-skill' | 'plugin-skill'
  argumentHint?: string   // optional, from frontmatter
}
```

We do NOT attempt to discover claude-code's built-in commands (`/help`, `/clear`, etc.) — those have no on-disk representation. Pragmatically, the autocompletion-list-as-suggestion pattern means typing `/cle` and getting nothing falls through harmlessly to claude-code's own handler when sent.

### Out of scope for v1

- **Docker sessions with non-default `~/.claude` mounts.** We surface what's on the host. If a Docker session mounts a different `~/.claude`, the menu may include commands not available there, or miss ones that are. Acceptable: the menu is a hint; the underlying claude-code is the truth.
- **Per-session command lists.** The discovery is shared across all composers.

## Caching

### Server-side

`slashCommandRegistry` (singleton):

- On first request, walks the directories and builds the list.
- Caches the list keyed on a hash of `(directory mtimes)`.
- `fs.watch` registered on each source directory at first build. Any event invalidates the cache.
- Re-scans lazily on next request after invalidation. (No background scanning.)

### Client-side

`useSlashCommands()` hook:

- Module-scoped in-memory cache (shared across composers).
- Fetches once on first composer mount.
- Refetches on each composer expand (cheap — server cache returns immediately if unchanged).
- Returns `{ commands, loading }`. `loading` is true only on the very first fetch — never blocks rendering of suggestions; if cache is empty, no suggestions are shown.

The matcher always reads from the latest in-memory list. Network never gates a keystroke.

## Matching

Pure function `matchSlashCommands(commands, partial, usage)` returns commands sorted by score, top N (5) only.

```
score = matchScore + recencyBoost + frequencyBoost

matchScore (against `name` and `description`):
  exact name match              1000
  prefix name match              900 - (name.length - partial.length)
  substring name match           700
  subsequence (fuzzy) name       500
  description substring          200
  no match                         0

recencyBoost (uses lastUsedAt):
  within 24h                     100
  within 7d                       30
  else                             0

frequencyBoost (uses count):
  min(60, 10 * log2(1 + count))
```

When `partial` is empty (just typed `/`), `matchScore` is `0` for everything — so the ranking is recency + frequency. This produces "your most-used commands first" on bare `/`, the discoverability sweet spot.

## Tab cycle

State: `cycleState: { candidates: SlashCommand[]; index: number } | null`.

```
On first Tab in slash mode:
  candidates = top 5 matches
  replace token with `/${candidates[0].name}`   // no trailing space
  cursor at end of inserted name
  cycleState = { candidates, index: 0 }

On subsequent Tab while cycleState != null:
  index = (index + 1) % candidates.length
  replace token with `/${candidates[index].name}`

On any other keystroke (Space, Enter, Backspace, arrows, character keys):
  cycleState = null  // the keystroke itself is handled normally; only the cycle state is dropped
```

Once cycleState is cleared, the next Tab starts a fresh cycle from the current partial. Frozen candidate list while cycling means the order doesn't shift under the user.

## UI presentation

### Inline ghost text

While in slash mode with a non-empty partial AND a top match, render a positioned span over the textarea showing the suffix of the top match's name. E.g. user typed `/full`, ghost shows `-review` after the cursor. Implemented via a sibling overlay `<div>` that mirrors textarea layout (standard textarea overlay technique).

When in cycle mode, the ghost text reflects the currently-selected candidate — but since the visible text is already replaced with the full name, ghost text is hidden.

### Status bar chip strip

Replaces the existing "Ready / Wait for idle..." line at `RunSessionPanel.tsx:330` when slash mode is active.

Layout:

```
[Ready]   tab: /full-review · /flourish-test · /file-search   [⏱] [▶]
```

- Status label shrinks left.
- Up to 5 chips fill the middle. First chip styled as the tab-target (accent border + background); others dim.
- During cycle mode, the chip at `cycleState.index` is the highlighted one; brief flash on Tab press (matches existing `feedback_flourish_on_sidebar.md` pattern).
- Click a chip to insert that command (same as Tab to that index).

When NOT in slash mode, the row renders exactly as today.

## Usage tracking

### Local file: `~/.config/tinstar/slash-usage.json`

```json
{
  "full-review": { "count": 12, "lastUsedAt": "2026-05-05T10:23:00Z" },
  "superpowers:brainstorming": { "count": 3, "lastUsedAt": "2026-05-04T14:00:00Z" }
}
```

- Increment on each `POST /api/sessions/:id/prompt` whose text matches the slash-token pattern at start.
- LRU-cap at 1000 entries. Eviction by `lastUsedAt` ascending.
- Loaded into memory at server start; written on increment (debounced 5s).

### OTLP counter

Same hook emits a counter through `OtlpExporter`:

```
metric: tinstar_slash_use_total
type:   counter
labels: { name: "<command-name>" }
```

Exposed via the embedded Alloy → Prometheus stack — usable in Grafana for "most-used skills, last 7d" panels. Non-blocking; failures don't affect prompt sending.

### Caveat

The server only sees prompts sent through the composer. Direct terminal input or `send-keys` does not count. Acceptable: the ranking is a sort hint, not a source of truth.

## API

### `GET /api/slash-commands`

Response:

```json
{
  "commands": [
    {
      "name": "full-review",
      "description": "Run the complete feature review pipeline",
      "source": "user",
      "argumentHint": null,
      "useCount": 12,
      "lastUsedAt": "2026-05-05T10:23:00Z"
    },
    ...
  ]
}
```

Returns the merged discovery + usage data. Server-side cached by mtime of source dirs.

### `POST /api/sessions/:id/prompt` (existing)

Hook added: parse text for leading slash token, increment usage counter, emit OTLP counter. No change to the response or other behavior.

## Files

New:

1. `src/server/sessions/slashCommandRegistry.ts` — discovery, mtime cache, fs.watch
2. `src/server/sessions/slashUsage.ts` — local usage file load/save/increment
3. `src/lib/slashMatching.ts` — pure token detection + scoring (unit-testable)
4. `src/hooks/useSlashCommands.ts` — client cache + SWR fetch
5. `src/components/RunWorkspaceWidget/SlashChips.tsx` — chip strip for status bar

Edited:

6. `src/components/RunWorkspaceWidget/RunSessionPanel.tsx` — wire detection, cycle state, ghost text overlay, replace status row in `PromptComposer`
7. `src/server/api/routes.ts` — at the existing `POST /api/sessions/:id/prompt` handler (around `routes.ts:3269`), call `slashUsage.increment` and `otlpExporter.counter` after the text is accepted. Register `GET /api/slash-commands` in the same file.

## Testing

- **Unit tests** for `slashMatching.ts`: token detection edge cases (start of string, after newline, after space, mid-word `/`, deleted partial), scoring ladder, ranking blend.
- **Unit tests** for `slashCommandRegistry.ts`: discovers each source, namespaces plugins correctly, applies mtime cache, handles missing dirs gracefully.
- **Unit tests** for `slashUsage.ts`: increment, LRU eviction, persistence round-trip.
- **Playwright e2e**: type `/`, see chips. Tab inserts top. Tab again cycles. Type a char, Tab again starts a fresh cycle. Space commits and exits slash mode.
- **Manual**: ghost text alignment under different font sizes / line wraps.

## Open questions resolved during brainstorming

- ✅ Discovery from filesystem (option A) with mtime-keyed cache + fs.watch
- ✅ Skills included alongside commands; plugin skills namespaced as `plugin:skill`
- ✅ Tab cycles top-N, frozen candidate list, reset on any non-Tab keystroke
- ✅ Bare `/` shows top contenders ranked by recency+frequency
- ✅ Usage tracked locally for ranking, also emitted via OTLP for Grafana
