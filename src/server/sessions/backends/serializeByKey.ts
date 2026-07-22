// A tiny per-key async serializer.
//
// Some side effects must never overlap for the SAME key while staying fully
// concurrent across DIFFERENT keys. The motivating case: `tmuxBackend.sendPrompt`
// drives a session's pane in three steps (send-keys text → 300ms settle →
// send-keys Enter). Two of those racing on ONE tmux session interleave —
// text-A, text-B, Enter-A, Enter-B — and the agent receives a garbled prompt.
// Serializing per session (the key) removes the race; two DIFFERENT sessions
// still send in parallel.
//
// This is the server-side home of the ordering guarantee that used to live as a
// client-side "refresh one surface at a time" hack: with sends serialized here,
// callers (a Slate refresh-all fan-out, concurrent reply/compose/explain) can
// dispatch freely and the backend keeps each session's keystrokes intact.

/** Run `task` only after any prior task registered under the same `key` has
 *  settled (resolved OR rejected), so same-key tasks never overlap; different
 *  keys run concurrently. Returns `task`'s own result/rejection, so a caller
 *  still observes its own failure. A rejection is contained: it never poisons
 *  the next queued task for that key.
 *
 *  `chains` is the caller-owned map of in-flight tails (one entry per key). Pass
 *  a long-lived module-level Map so the ordering persists across calls. */
export function serializeByKey<T>(
  chains: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve()
  // Chain off the prior tail regardless of how it settled — `task` runs next
  // either way (both handlers are `task`).
  const result = prev.then(task, task)
  // Store a NON-rejecting tail so one task's failure can't reject the next
  // `.then` for this key. The returned `result` keeps the real rejection.
  chains.set(key, result.catch(() => {}))
  return result
}
