import { useCallback, useEffect, useMemo, useState } from 'react'

export const STASH_SLOTS = 2
const STORAGE_PREFIX = 'tinstar-prompt-stash-v1:'

export type StashSlots = readonly (string | null)[]

const EMPTY: StashSlots = Object.freeze(Array(STASH_SLOTS).fill(null))

function storageKey(sessionId: string) {
  return `${STORAGE_PREFIX}${sessionId}`
}

function load(sessionId: string): StashSlots {
  try {
    const raw = localStorage.getItem(storageKey(sessionId))
    if (!raw) return EMPTY
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return EMPTY
    const normalized: (string | null)[] = Array(STASH_SLOTS).fill(null)
    for (let i = 0; i < STASH_SLOTS; i++) {
      const v = parsed[i]
      normalized[i] = typeof v === 'string' && v.length > 0 ? v : null
    }
    return normalized
  } catch {
    return EMPTY
  }
}

function save(sessionId: string, slots: StashSlots) {
  try {
    localStorage.setItem(storageKey(sessionId), JSON.stringify(slots))
  } catch {
    /* quota or disabled storage — silent */
  }
}

export interface PromptStash {
  slots: StashSlots
  setSlot: (index: number, value: string | null) => void
}

export function usePromptStash(sessionId: string | undefined): PromptStash {
  const [slots, setSlots] = useState<StashSlots>(EMPTY)

  useEffect(() => {
    setSlots(sessionId ? load(sessionId) : EMPTY)
  }, [sessionId])

  const setSlot = useCallback(
    (index: number, value: string | null) => {
      if (!sessionId) return
      if (index < 0 || index >= STASH_SLOTS) return
      setSlots(prev => {
        const next = prev.slice() as (string | null)[]
        next[index] = value && value.length > 0 ? value : null
        save(sessionId, next)
        return next
      })
    },
    [sessionId],
  )

  return useMemo(() => ({ slots, setSlot }), [slots, setSlot])
}
