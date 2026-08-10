import { describe, expect, it } from 'vitest'

import {
  composeSlateFirstManagedInstructions,
  SLATE_FIRST_CONTRACT_VERSION,
  SLATE_FIRST_MANAGED_INSTRUCTIONS,
} from '../managed-contract'

describe('Slate-first managed contract', () => {
  it('is versioned and establishes the Surface-worthiness rails', () => {
    expect(SLATE_FIRST_CONTRACT_VERSION).toBe('slate-first-live-authoring/v1')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('Always create or update a Surface')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('Never create a Surface merely for a conversational turn')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('use judgment')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('Refresh recipes remain the synchronization mechanism')
  })

  it('composes a persistent persona exactly once without changing the contract', () => {
    const composed = composeSlateFirstManagedInstructions('BE THE MARSHAL')

    expect(composed.startsWith(SLATE_FIRST_MANAGED_INSTRUCTIONS)).toBe(true)
    expect(composed.match(/BE THE MARSHAL/g)).toHaveLength(1)
    expect(composeSlateFirstManagedInstructions()).toBe(SLATE_FIRST_MANAGED_INSTRUCTIONS)
  })
})
