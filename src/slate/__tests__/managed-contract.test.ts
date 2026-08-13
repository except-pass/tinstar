import { describe, expect, it } from 'vitest'

import {
  composeSlateFirstManagedInstructions,
  SLATE_FIRST_CONTRACT_VERSION,
  SLATE_FIRST_MANAGED_INSTRUCTIONS,
} from '../managed-contract'

describe('Slate-first managed contract', () => {
  it('is versioned and establishes the Surface-worthiness rails', () => {
    expect(SLATE_FIRST_CONTRACT_VERSION).toBe('slate-first-live-authoring/v1')
    for (const alwaysIn of [
      'explicitly asks for one',
      'must act or choose',
      'primary result needed to judge the Objective',
      'blocker that needs human intervention',
    ]) expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain(alwaysIn)
    for (const alwaysOut of [
      'conversational turn',
      'raw tool or terminal output',
      'transient working update',
      'private reasoning',
      'content already owned by another Surface',
    ]) expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain(alwaysOut)
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('use judgment')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('work objects, not turns')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('inspect the run\'s Slate authoring context')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('Amend the Surface that already owns the subject')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('Reserve a new Surface only for a genuinely distinct work object')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('amend that same Surface')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('one Surface per decision')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('unrelated monitoring signals must not')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('status/FYI, not an approval request')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('verified facts')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('label hypotheses')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('comment open for valid outcomes')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('unanswered Decision must not have a refresh recipe')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('Refresh recipes remain the synchronization mechanism')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('reading or selecting a Surface never authorizes agent work')
    expect(SLATE_FIRST_MANAGED_INSTRUCTIONS).toContain('Do not spawn ambient refresh workers')
  })

  it('composes a persistent persona exactly once without changing the contract', () => {
    const composed = composeSlateFirstManagedInstructions('BE THE MARSHAL')

    expect(composed.startsWith(SLATE_FIRST_MANAGED_INSTRUCTIONS)).toBe(true)
    expect(composed.match(/BE THE MARSHAL/g)).toHaveLength(1)
    expect(composeSlateFirstManagedInstructions()).toBe(SLATE_FIRST_MANAGED_INSTRUCTIONS)
  })
})
