# Prompt Composer History — Design

**Date:** 2026-04-16
**Scope:** Add per-session recent-prompt history to the Run Workspace prompt composer.

## Problem

The prompt composer in the Run Workspace widget has no memory of previously sent prompts. Users who want to resend or slightly modify a prior prompt must retype it from scratch.

## Goal

Let users recall and reuse recently sent prompts through a small history menu, so they can rapidly resend, tweak, or reference prior prompts without retyping.

## Non-goals

- Cross-session search or global history.
- Persistence across page reloads.
- Editing or deleting individual history entries.
- Favoriting or pinning prompts.

## UX summary

In the collapsible prompt composer under each Agent Session widget:

1. Every successful send is appended to an in-memory history scoped to that session.
2. Pressing `↑` in the textarea when it is **empty** opens a popover listing recent prompts, newest first.
3. A new history icon button in the composer footer (left of Send) also opens the popover.
4. Inside the popover: arrow keys navigate, `Enter` or click selects, `Esc` or outside-click closes.
5. Selecting a prompt replaces the textarea content with it, closes the popover, and focuses the textarea with the caret at the end.

## Design decisions

| Decision | Choice |
|---|---|
| Triggers | History icon button + `↑` hotkey (empty textarea only) |
| Menu style | Popover list anchored above the textarea |
| Storage | In-memory (resets on page reload) |
| Cap | 20 prompts per session, newest first |
| Scope key | `sessionId` |
| Duplicates | Kept as separate entries |
| `↑` with non-empty textarea | Default caret movement; popover does **not** open |
| On select | Replace textarea content, close popover, focus textarea, caret at end |
| Push timing | After a successful send (not on failed or cancelled sends) |

## Data model

A module-level `Map<sessionId, string[]>` stores history arrays. Each array is ordered newest-first and capped at 20 entries. A lightweight pub/sub allows multiple composers for the same session to stay in sync.

Exposed through a new hook `usePromptHistory(sessionId)` returning:

```ts
{
  history: string[],       // newest first
  push: (text: string) => void,  // pre-trims; appends to front; caps at 20
  clear: () => void,       // not used initially, reserved for future "clear history" affordance
}
```

`push` behavior:
- Trims input; ignores empty strings.
- Does **not** collapse duplicates — identical consecutive sends result in two entries.
- Trims the array to 20 items after insert.

## Components

### `src/hooks/usePromptHistory.ts` (new)

- Owns the module-level store and subscription set.
- Uses `useSyncExternalStore` so any composer rendering for a given `sessionId` re-renders when history changes.
- Pure — no side effects outside the in-memory store.

### `src/components/RunWorkspaceWidget/PromptHistoryPopover.tsx` (new)

Props:
```ts
{
  history: string[],
  open: boolean,
  accent: string,
  onSelect: (text: string) => void,
  onClose: () => void,
  anchorRef: RefObject<HTMLElement>, // for outside-click handling
}
```

Responsibilities:
- Render the popover markup (styled to match composer chrome — see "Visual" below).
- Manage selected-index state; react to `↑`/`↓`/`Home`/`End`/`Enter`/`Esc`.
- Listen for outside-pointerdown and call `onClose`.
- Fire entry animation (~100ms fade + 4px slide-up).

### `src/components/RunWorkspaceWidget/RunSessionPanel.tsx` (modified)

Changes inside the existing `PromptComposer`:
- Call `usePromptHistory(sessionId)`.
- In `handleSend` after a successful send, call `push(text.trim())` before clearing the textarea.
- Add `historyOpen` state.
- In `handleKeyDown`, if `e.key === 'ArrowUp'` and `text.length === 0` and `history.length > 0`, prevent default and set `historyOpen = true`.
- Add a new history icon button to the left of Send, disabled when `history.length === 0`.
- Render `<PromptHistoryPopover>` when `historyOpen` is true; on select, set `text` to the chosen prompt, close the popover, and focus the textarea (caret at end via `textareaRef.current.setSelectionRange(len, len)`).

## Visual

Popover:
- Background: `bg-surface-panel`, 1px border in `hexToRgba(accent, 0.3)`.
- Anchored above the textarea, matching its width.
- Max height ~240px with `scrollbar-thin`; scroll into view on selection change.
- Entry: two lines max, `text-xs font-mono text-slate-200`, ellipsis truncation. Hover/selected row gets `bg-primary/10` plus a 2px accent-color left border. Faint row index in a `text-2xs text-slate-600` gutter.
- Header row: `RECENT PROMPTS` in `text-2xs font-mono uppercase tracking-wider text-primary/50`.
- Appearance animation: ~100ms fade-in + 4px slide-up. No exit animation (instant close).

History icon button:
- `material-symbols-outlined` `history` glyph, `text-sm`, in `hexToRgba(accent, 0.6)`, hover `hexToRgba(accent, 0.9)`.
- Same rounded chip style as Send, smaller; placed immediately left of Send with 8px gap.
- Disabled state: opacity 40, tooltip/`title="No history yet"`.

## Error handling

- No new network calls — errors are confined to client state.
- If `sessionId` is undefined, `usePromptHistory` returns an empty frozen array and a no-op `push`. Button is disabled.
- Selecting a popover item while a send is in flight is allowed (does not interfere with the in-flight request; just updates text).

## Testing

Unit tests — `src/hooks/usePromptHistory.test.ts`:
- `push` appends newest-first.
- Cap at 20: pushing a 21st drops the oldest.
- Empty and whitespace-only strings are ignored.
- Duplicates are kept as separate entries.
- Two subscribers on the same `sessionId` both re-render after `push`.

E2E test — `e2e/prompt-history.spec.ts` (runs under `TINSTAR_FAST_SIM=1`):
1. Open an agent session, expand the prompt composer.
2. Type and send prompt "one", then "two".
3. With empty textarea, press `↑`.
4. Assert popover is visible and contains both entries, "two" first.
5. Press `↓` then `Enter`; assert textarea now contains "one".
6. Press `Escape` scenario: open again, press `Escape`, assert popover closed and textarea unchanged.
7. Clear the textarea, type some text, press `↑`; assert popover does **not** open.

## Rollout

Pure additive change. Ships in `V3.7.0`. No migration or feature flag needed.
