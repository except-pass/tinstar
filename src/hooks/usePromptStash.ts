import { useCallback, useEffect, useMemo, useState } from 'react'
import { familyKeys, readJSON, writeJSON } from '../lib/uiPrefs'

export const STASH_SLOTS = 2

export type StashSlots = readonly (string | null)[]

const EMPTY: StashSlots = Object.freeze(Array(STASH_SLOTS).fill(null))

function load(sessionId: string): StashSlots {
  const parsed = readJSON<unknown>(familyKeys.promptStash(sessionId), null)
  if (!Array.isArray(parsed)) return EMPTY
  const normalized: (string | null)[] = Array(STASH_SLOTS).fill(null)
  for (let i = 0; i < STASH_SLOTS; i++) {
    const v = parsed[i]
    normalized[i] = typeof v === 'string' && v.length > 0 ? v : null
  }
  return normalized
}

function save(sessionId: string, slots: StashSlots) {
  writeJSON(familyKeys.promptStash(sessionId), slots)
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
