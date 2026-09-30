// Per-session prompt stash. The rest of the old canvas prefs blob left with
// that UI; this is the storage the composer hook still reads.

export const familyKeys = {
  promptStash: (sessionId: string): string => `tinstar-prompt-stash-v1:${sessionId}`,
}

export function readJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJSON(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* storage disabled */ }
}
