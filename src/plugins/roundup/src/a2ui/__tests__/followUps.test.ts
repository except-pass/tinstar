import { describe, it, expect } from 'vitest'
import type { A2uiContent } from '../../../../../domain/types'
import {
  UNIVERSAL_FOLLOW_UPS,
  FOLLOW_UP_COMPONENT,
  NOTICE_FOLLOWUP_TEXT_MAX,
  parseFollowUp,
  collectDeclaredFollowUps,
  followUpsFor,
  resolveFollowUp,
} from '../followUps'

function content(...components: Array<Record<string, unknown>>): A2uiContent {
  return { root: 'root', components: components as A2uiContent['components'] }
}

describe('the universal preset set', () => {
  it('includes "Simplify your explanation", whose guidance asks for de-nerding, not dumbing down', () => {
    const simplify = UNIVERSAL_FOLLOW_UPS.find(p => p.id === 'simplify')
    expect(simplify).toBeDefined()
    expect(simplify!.label).toBe('Simplify your explanation')
    // The precision requirement is the whole distinction — a "simplify" that drops
    // caveats and edge cases makes the notice useless for deciding.
    expect(simplify!.guidance).toMatch(/precision/i)
    expect(simplify!.guidance).toMatch(/jargon/i)
    expect(simplify!.guidance).toMatch(/not dumb it down/i)
  })

  it('covers the other questions that block a decision, and stays small', () => {
    const ids = UNIVERSAL_FOLLOW_UPS.map(p => p.id)
    expect(ids).toEqual(['simplify', 'why', 'do-nothing', 'background', 'show-code'])
    // A curated set, not a menu — a wall of chips is not an affordance.
    expect(ids.length).toBeLessThanOrEqual(6)
  })

  it('gives every preset a label and a non-empty question', () => {
    for (const p of UNIVERSAL_FOLLOW_UPS) {
      expect(p.label.trim()).not.toBe('')
      expect(p.question.trim()).not.toBe('')
      expect(p.question.length).toBeLessThanOrEqual(NOTICE_FOLLOWUP_TEXT_MAX)
    }
  })

  it('has unique ids', () => {
    const ids = UNIVERSAL_FOLLOW_UPS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('parseFollowUp', () => {
  const good = { id: 'rollback', component: FOLLOW_UP_COMPONENT, label: 'How long?', question: 'How long would a rollback take?' }

  it('parses a well-formed declaration', () => {
    expect(parseFollowUp(good)).toEqual({ id: 'rollback', label: 'How long?', question: 'How long would a rollback take?' })
  })

  it('returns null for a non-FollowUp component', () => {
    expect(parseFollowUp({ ...good, component: 'Text' })).toBeNull()
  })

  // Agent-authored input over a .passthrough() schema — every field is an input
  // boundary, and a malformed one must degrade rather than reach the renderer.
  it.each([
    ['missing id', { ...good, id: undefined }],
    ['empty id', { ...good, id: '' }],
    ['non-string id', { ...good, id: 7 }],
    ['missing label', { ...good, label: undefined }],
    ['empty label', { ...good, label: '' }],
    ['non-string label', { ...good, label: { a: 1 } }],
    ['missing question', { ...good, question: undefined }],
    ['empty question', { ...good, question: '' }],
    ['non-string question', { ...good, question: [] }],
  ])('returns null for %s', (_name, node) => {
    expect(parseFollowUp(node as never)).toBeNull()
  })

  it('returns null for an oversize question', () => {
    expect(parseFollowUp({ ...good, question: 'x'.repeat(NOTICE_FOLLOWUP_TEXT_MAX + 1) })).toBeNull()
  })

  // An agent must not be able to redefine what a universal preset means for its own
  // notice — "Simplify your explanation" has to mean the same thing on every card.
  it('refuses a declaration that shadows a universal preset id', () => {
    expect(parseFollowUp({ ...good, id: 'simplify' })).toBeNull()
  })
})

describe('collectDeclaredFollowUps', () => {
  it('returns declarations in order, collapsing duplicate ids (first wins)', () => {
    const c = content(
      { id: 'root', component: 'Column', children: ['a', 'b', 'c'] },
      { id: 'a', component: FOLLOW_UP_COMPONENT, label: 'A', question: 'qa' },
      { id: 'b', component: FOLLOW_UP_COMPONENT, label: 'B', question: 'qb' },
      { id: 'a', component: FOLLOW_UP_COMPONENT, label: 'A2', question: 'qa2' },
    )
    expect(collectDeclaredFollowUps(c).map(p => p.id)).toEqual(['a', 'b'])
    expect(collectDeclaredFollowUps(c)[0]!.question).toBe('qa')
  })

  it('skips malformed declarations without throwing', () => {
    const c = content(
      { id: 'ok', component: FOLLOW_UP_COMPONENT, label: 'OK', question: 'q' },
      { id: '', component: FOLLOW_UP_COMPONENT, label: 'bad', question: 'q' },
      { component: FOLLOW_UP_COMPONENT, question: 'no id or label' },
    )
    expect(collectDeclaredFollowUps(c).map(p => p.id)).toEqual(['ok'])
  })

  // The ask panel renders OUTSIDE the per-notice error boundary, so a throw here
  // would take out the whole board, not one card.
  it('survives null and non-object entries in the component list', () => {
    const c = { root: 'root', components: [null, 42, 'nope', { id: 'ok', component: FOLLOW_UP_COMPONENT, label: 'OK', question: 'q' }] } as unknown as A2uiContent
    expect(() => collectDeclaredFollowUps(c)).not.toThrow()
    expect(collectDeclaredFollowUps(c).map(p => p.id)).toEqual(['ok'])
  })

  it('is empty for absent or component-less content', () => {
    expect(collectDeclaredFollowUps(undefined)).toEqual([])
    expect(collectDeclaredFollowUps(null)).toEqual([])
    expect(collectDeclaredFollowUps({ root: 'r' } as unknown as A2uiContent)).toEqual([])
  })
})

describe('followUpsFor / resolveFollowUp', () => {
  const c = content(
    { id: 'rollback', component: FOLLOW_UP_COMPONENT, label: 'How long?', question: 'How long would a rollback take?' },
  )

  it('puts the universal set first so its chips sit in the same place on every notice', () => {
    const menu = followUpsFor(c)
    expect(menu.slice(0, UNIVERSAL_FOLLOW_UPS.length).map(p => p.id)).toEqual(UNIVERSAL_FOLLOW_UPS.map(p => p.id))
    expect(menu[menu.length - 1]!.id).toBe('rollback')
  })

  it('offers the universal set even on a notice with no content at all', () => {
    expect(followUpsFor(undefined).map(p => p.id)).toEqual(UNIVERSAL_FOLLOW_UPS.map(p => p.id))
    expect(resolveFollowUp(undefined, 'simplify')).not.toBeNull()
  })

  it('resolves a universal id and a declared id, and rejects anything else', () => {
    expect(resolveFollowUp(c, 'simplify')!.label).toBe('Simplify your explanation')
    expect(resolveFollowUp(c, 'rollback')!.question).toBe('How long would a rollback take?')
    expect(resolveFollowUp(c, 'nope')).toBeNull()
    // A declared id from a DIFFERENT notice must not resolve against this one.
    expect(resolveFollowUp(undefined, 'rollback')).toBeNull()
  })
})
