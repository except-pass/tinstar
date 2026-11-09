import { describe, expect, it } from 'vitest'
import { askContextSchema, askCreateSchema } from '../../shared/ask'
import { buildElementSeed, elementQuestions, readAskElement } from '../element'
import { fieldDrafts } from '../semantic'

const subject = { cardId: 'a'.repeat(32) }
describe('element context and deterministic drafts', () => {
  it('captures the displayed badge, exact field value and existing item origin', () => {
    const seed = buildElementSeed(subject, { field_name: 'next_check_in', label: 'Overdue 3d · Next check-in Nov 6, 10:00 AM ET', value: '2026-11-06T15:00:00Z', type: 'overdue' })
    expect(seed).toMatchObject({ ...subject, field_key: 'next_check_in', field_value: '2026-11-06T15:00:00Z', question: fieldDrafts.next_check_in })
    const context = askContextSchema.parse({ anchor: { kind: 'work', page_id: subject.cardId, label: 'PR Operations', url: null, observed_at: null }, view: { scene: 'overview' }, element: seed.element, field_key: seed.field_key, field_value: seed.field_value })
    expect(context.element).toEqual(seed.element)
    expect(askCreateSchema.parse({ client_key: crypto.randomUUID(), card_id: seed.cardId, element: seed.element, field_key: seed.field_key, field_value: seed.field_value, question: seed.question, view: context.view }).element).toEqual(context.element)
  })
  it.each(Object.entries(elementQuestions))('has a stable %s question without a model call', (type, question) => {
    expect(buildElementSeed(subject, { field_name: 'field', label: 'Field', value: 'Value', type: type as keyof typeof elementQuestions }).question).toBe(question)
  })
  it('reuses all existing field templates and carries generic fields as structured context', () => {
    for (const [field_name, question] of Object.entries(fieldDrafts)) expect(buildElementSeed(subject, { field_name, label: field_name, value: 'Observed', type: 'generic' }).question).toBe(question)
    expect(buildElementSeed(subject, { field_name: 'author', label: 'Author', value: 'Octocat', type: 'generic' })).toMatchObject({ element: { field_name: 'author', value: 'Octocat' }, question: elementQuestions.generic })
  })
  it('reads existing data-ask-field markup and bounds captured text to the wire limits', () => {
    const node = document.createElement('span'); node.dataset.askField = 'ci'; node.textContent = 'Checks failing'
    expect(readAskElement(node)).toEqual({ field_name: 'ci', label: 'CI / checks', value: 'Checks failing', type: 'ci' })
    const seed = buildElementSeed(subject, { field_name: 'description', label: 'L'.repeat(600), value: 'x'.repeat(5000), type: 'generic' })
    expect(seed.element!.label).toHaveLength(512); expect(seed.element!.value).toHaveLength(4000)
  })
})
