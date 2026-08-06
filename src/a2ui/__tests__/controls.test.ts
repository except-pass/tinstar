import { describe, it, expect } from 'vitest'
import type { A2uiContent } from '../../domain/types'
import {
  parseChoice,
  hasTextInput,
  isAnswerable,
  collectChoiceOptionIds,
  collectChoiceOptionLabels,
  parseDecision,
  MAX_DECISION_OPTIONS,
  MAX_DECISION_RISKS,
} from '../controls'

describe('parseChoice', () => {
  it('parses a single-select Choice with valid options', () => {
    const parsed = parseChoice({ component: 'Choice', id: 'c', mode: 'single', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })
    expect(parsed).toEqual({ mode: 'single', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })
  })

  it('defaults mode to single and honors multi', () => {
    expect(parseChoice({ component: 'Choice', options: [{ id: 'a', label: 'A' }] })!.mode).toBe('single')
    expect(parseChoice({ component: 'Choice', mode: 'multi', options: [{ id: 'a', label: 'A' }] })!.mode).toBe('multi')
  })

  it('returns null for a non-Choice node', () => {
    expect(parseChoice({ component: 'Text', text: 'x' })).toBeNull()
  })

  it('degrades (null) a Choice with no options / no valid options', () => {
    expect(parseChoice({ component: 'Choice' })).toBeNull()
    expect(parseChoice({ component: 'Choice', options: [] })).toBeNull()
    // options present but each malformed (missing id/label) → dropped → null
    expect(parseChoice({ component: 'Choice', options: [{ label: 'no id' }, { id: '', label: 'blank id' }] })).toBeNull()
  })

  it('drops individual malformed options but keeps the valid ones', () => {
    const parsed = parseChoice({ component: 'Choice', options: [{ id: 'ok', label: 'Fine' }, { id: 42, label: 'bad id' }, 'nope'] as unknown as [] })
    expect(parsed!.options).toEqual([{ id: 'ok', label: 'Fine' }])
  })
})

describe('choice collection (server validation source of truth)', () => {
  const content: A2uiContent = {
    root: 'root',
    components: [
      { id: 'root', component: 'Column', children: ['c1', 'c2', 't'] },
      { id: 'c1', component: 'Choice', mode: 'single', options: [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Bravo' }] },
      { id: 'c2', component: 'Choice', mode: 'multi', options: [{ id: 'c', label: 'Charlie' }] },
      { id: 't', component: 'TextInput', label: 'Notes' },
    ],
  }

  it('collectChoiceOptionIds returns every declared option id across all choices', () => {
    expect(collectChoiceOptionIds(content)).toEqual(new Set(['a', 'b', 'c']))
  })

  it('collectChoiceOptionLabels maps id → label', () => {
    const labels = collectChoiceOptionLabels(content)
    expect(labels.get('a')).toBe('Alpha')
    expect(labels.get('c')).toBe('Charlie')
  })

  it('hasTextInput / isAnswerable reflect the declared controls', () => {
    expect(hasTextInput(content)).toBe(true)
    expect(isAnswerable(content)).toBe(true)
  })

  it('a prose-only notice is not answerable and declares no choices', () => {
    const prose: A2uiContent = { root: 'root', components: [{ id: 'root', component: 'Text', text: 'just words' }] }
    expect(collectChoiceOptionIds(prose).size).toBe(0)
    expect(hasTextInput(prose)).toBe(false)
    expect(isAnswerable(prose)).toBe(false)
  })

  it('handles nullish/empty content without throwing', () => {
    expect(collectChoiceOptionIds(undefined).size).toBe(0)
    expect(collectChoiceOptionLabels(null).size).toBe(0)
    expect(isAnswerable(null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Decision (the Decision card, docs/brainstorms/2026-08-06-decision-card-requirements.md)
// ---------------------------------------------------------------------------

/** A minimal well-formed Decision node — two options is the floor (R9). */
function decisionNode(overrides: Record<string, unknown> = {}) {
  return {
    component: 'Decision',
    id: 'd',
    options: [
      { id: 'worktree', label: 'Isolated worktree', gain: 'No stomping.', cost: '~400ms each.', wrongIf: 'Hands mostly read.' },
      { id: 'locks', label: 'Advisory locks', gain: 'Zero setup.', cost: 'Stale locks.', wrongIf: 'Two hands write one file.' },
    ],
    ...overrides,
  }
}

describe('parseDecision', () => {
  it('parses options into id/label/gain/cost/wrongIf', () => {
    const d = parseDecision(decisionNode())!
    expect(d.options).toHaveLength(2)
    expect(d.options[0]).toEqual({
      id: 'worktree', label: 'Isolated worktree',
      gain: 'No stomping.', cost: '~400ms each.', wrongIf: 'Hands mostly read.',
    })
  })

  it('returns null for a non-Decision node', () => {
    expect(parseDecision({ component: 'Choice', options: [{ id: 'a', label: 'A' }] })).toBeNull()
  })

  it('degrades whole (null) below two usable options — one option is not a decision', () => {
    expect(parseDecision({ component: 'Decision' })).toBeNull()
    expect(parseDecision({ component: 'Decision', options: [] })).toBeNull()
    expect(parseDecision({ component: 'Decision', options: [{ id: 'a', label: 'A' }] })).toBeNull()
    // Two entries but one has no usable id → one survivor → still not a decision.
    expect(parseDecision({ component: 'Decision', options: [{ id: 'a', label: 'A' }, { label: 'no id' }] })).toBeNull()
  })

  it('defaults missing option prose to empty strings rather than dropping the option', () => {
    const d = parseDecision({ component: 'Decision', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] })!
    expect(d.options[0]).toEqual({ id: 'a', label: 'A', gain: '', cost: '', wrongIf: '' })
  })

  it('caps options at MAX_DECISION_OPTIONS', () => {
    const many = Array.from({ length: MAX_DECISION_OPTIONS + 5 }, (_, i) => ({ id: `o${i}`, label: `O${i}` }))
    expect(parseDecision({ component: 'Decision', options: many })!.options).toHaveLength(MAX_DECISION_OPTIONS)
  })

  it('rates a three-value scale onto the 0/2/3 ramp so its top step is fully hot', () => {
    const d = parseDecision(decisionNode({
      risks: [
        { label: 'r0', severity: 'annoying', likelihood: 'unlikely', discoverability: 'obvious' },
        { label: 'r1', severity: 'costly', likelihood: 'possible', discoverability: 'subtle' },
        { label: 'r2', severity: 'severe', likelihood: 'likely', discoverability: 'silent' },
      ],
    }))!
    expect(d.risks.map(r => r.severity!.heat)).toEqual([0, 2, 3])
    expect(d.risks.map(r => r.likelihood!.heat)).toEqual([0, 2, 3])
    expect(d.risks.map(r => r.discoverability!.heat)).toEqual([0, 2, 3])
  })

  it('rates a four-value scale straight through 0..3', () => {
    const actions = ['trivial', 'cheap', 'costly', 'one-way']
    const heats = actions.map(a => parseDecision(decisionNode({ reversal: { action: a, damage: 'days' } }))!.reversal!.action!.heat)
    expect(heats).toEqual([0, 1, 2, 3])
    const damages = ['minutes', 'hours', 'days', 'weeks+']
    const dh = damages.map(x => parseDecision(decisionNode({ reversal: { action: 'cheap', damage: x } }))!.reversal!.damage!.heat)
    expect(dh).toEqual([0, 1, 2, 3])
    const spans = ['until-next-commit', 'until-this-ships', 'while-the-code-lives', 'permanent']
    const sh = spans.map(s => parseDecision(decisionNode({ horizon: { span: s, until: 'x' } }))!.horizon!.span!.heat)
    expect(sh).toEqual([0, 1, 2, 3])
  })

  it('keeps an unrecognised rating verbatim with heat null — never coerced up or down (R8)', () => {
    const d = parseDecision(decisionNode({ risks: [{ label: 'r', severity: 'catastrophic' }] }))!
    expect(d.risks[0]!.severity).toEqual({ value: 'catastrophic', heat: null })
  })

  it('distinguishes an absent rating (null) from an unrecognised one', () => {
    const d = parseDecision(decisionNode({ risks: [{ label: 'r', severity: 'severe' }] }))!
    expect(d.risks[0]!.severity).toEqual({ value: 'severe', heat: 3 })
    expect(d.risks[0]!.likelihood).toBeNull()
    expect(d.risks[0]!.discoverability).toBeNull()
  })

  it('drops risks with no label and flags risksMalformed only when nothing survives', () => {
    const some = parseDecision(decisionNode({ risks: [{ label: 'keep' }, { note: 'no label' }] }))!
    expect(some.risks).toHaveLength(1)
    expect(some.risksMalformed).toBe(false)
    const none = parseDecision(decisionNode({ risks: 'not an array' }))!
    expect(none.risks).toEqual([])
    expect(none.risksMalformed).toBe(true)
  })

  it('does not flag risksMalformed when risks is simply absent', () => {
    expect(parseDecision(decisionNode())!.risksMalformed).toBe(false)
  })

  it('caps risks at MAX_DECISION_RISKS', () => {
    const many = Array.from({ length: MAX_DECISION_RISKS + 5 }, (_, i) => ({ label: `r${i}` }))
    expect(parseDecision(decisionNode({ risks: many }))!.risks).toHaveLength(MAX_DECISION_RISKS)
  })

  it('requires `until` whenever a horizon span is present (R4)', () => {
    const ok = parseDecision(decisionNode({ horizon: { span: 'permanent', until: 'the migration wrote rows' } }))!
    expect(ok.horizon).toEqual({ span: { value: 'permanent', heat: 3 }, until: 'the migration wrote rows' })
    expect(ok.horizonMalformed).toBe(false)
    const noUntil = parseDecision(decisionNode({ horizon: { span: 'permanent' } }))!
    expect(noUntil.horizon).toBeNull()
    expect(noUntil.horizonMalformed).toBe(true)
  })

  it('flags reversalMalformed when reversal carries neither rating', () => {
    const bad = parseDecision(decisionNode({ reversal: { note: 'only a note' } }))!
    expect(bad.reversal).toBeNull()
    expect(bad.reversalMalformed).toBe(true)
    const ok = parseDecision(decisionNode({ reversal: { action: 'cheap' } }))!
    expect(ok.reversal).toEqual({ action: { value: 'cheap', heat: 1 }, damage: null, note: '' })
  })

  it('a malformed block never takes the options down with it (R9)', () => {
    const d = parseDecision(decisionNode({ risks: 'garbage', reversal: 42, horizon: null }))!
    expect(d.options).toHaveLength(2)
    expect(d.risksMalformed).toBe(true)
    expect(d.reversalMalformed).toBe(true)
  })

  it('defaults the comment field label and honors an author override (R7)', () => {
    expect(parseDecision(decisionNode())!.comment).toEqual({ label: 'Anything else?', placeholder: '' })
    const custom = parseDecision(decisionNode({ comment: { label: 'Constraints?', placeholder: 'e.g. deadline' } }))!
    expect(custom.comment).toEqual({ label: 'Constraints?', placeholder: 'e.g. deadline' })
  })
})

describe('Decision is a control component', () => {
  const content: A2uiContent = { root: 'd', components: [decisionNode()] }

  it('makes a surface answerable (R1)', () => {
    expect(isAnswerable(content)).toBe(true)
  })

  it('contributes its option ids to the endpoint validator (R1)', () => {
    expect(collectChoiceOptionIds(content)).toEqual(new Set(['worktree', 'locks']))
  })

  it('contributes its option labels so a delivered prompt names the choice in words', () => {
    expect(collectChoiceOptionLabels(content).get('worktree')).toBe('Isolated worktree')
  })

  it('a Decision below the two-option floor contributes no ids', () => {
    const thin: A2uiContent = { root: 'd', components: [{ component: 'Decision', id: 'd', options: [{ id: 'a', label: 'A' }] }] }
    expect(collectChoiceOptionIds(thin).size).toBe(0)
  })

  it('coexists with a Choice without either clobbering the other', () => {
    const both: A2uiContent = {
      root: 'r',
      components: [decisionNode(), { component: 'Choice', id: 'c', options: [{ id: 'yes', label: 'Yes' }] }],
    }
    expect(collectChoiceOptionIds(both)).toEqual(new Set(['worktree', 'locks', 'yes']))
  })
})
