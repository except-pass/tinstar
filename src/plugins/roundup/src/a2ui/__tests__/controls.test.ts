import { describe, it, expect } from 'vitest'
import type { A2uiContent } from '../../../../../domain/types'
import {
  parseChoice,
  hasTextInput,
  isAnswerable,
  collectChoiceOptionIds,
  collectChoiceOptionLabels,
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
