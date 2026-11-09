import { askFieldSchema, type AskElement, type AskElementType } from '../shared/ask'
import { fieldDrafts } from './semantic'
import type { AskSeed, AskSubject } from './semantic'

export const elementQuestions: Record<AskElementType, string> = {
  overdue: fieldDrafts.next_check_in,
  'check-in': 'What is expected at this check-in and is the date still realistic?',
  status: fieldDrafts.status,
  'waiting-for': fieldDrafts.waiting_for,
  ci: fieldDrafts.ci,
  release: fieldDrafts.deployment,
  generic: 'What does this mean and what needs attention?',
}
export const fieldLabels: Record<string, string> = {
  next_check_in: 'Next check-in', status: 'Status', waiting_for: 'Waiting For', owner: 'Owner', priority: 'Priority',
  last_edited: 'Last edited', relationship: 'Relationship', title: 'Title', ci: 'CI / checks', review: 'Review',
  changes: 'Changes', description: 'Description', deployment: 'Release state', receipt: 'Deployment receipt', worker: 'Worker',
  due_date: 'Due date', repository: 'Repository', author: 'Author', updated: 'Updated / created',
}
export function elementType(field: string): AskElementType {
  return ({ next_check_in: 'check-in', due_date: 'check-in', status: 'status', waiting_for: 'waiting-for', ci: 'ci', deployment: 'release', receipt: 'release' } as Record<string, AskElementType>)[field] ?? 'generic'
}
/** Capture what was displayed, before polling or navigation can replace it. */
export function buildElementSeed(subject: AskSubject, element: AskElement): AskSeed {
  const captured: AskElement = { ...element, field_name: element.field_name.slice(0, 128), label: element.label.slice(0, 512), value: element.value.slice(0, 4000) }
  const field = askFieldSchema.safeParse(captured.field_name)
  return { ...subject, element: captured, ...(field.success ? { field_key: field.data, field_value: captured.value } : {}), question: field.success && (captured.type === 'generic' || captured.field_name === 'receipt') ? fieldDrafts[field.data] : elementQuestions[captured.type] }
}
/** Shared data-attribute contract, including fields inside native card controls. */
export function askElement(field: string, label = fieldLabels[field] ?? field, value?: string, type = elementType(field)) {
  return { 'data-ask-field': field, 'data-ask-label': label, 'data-ask-value': value, 'data-ask-type': type, tabIndex: 0, title: `${label}${value ? `: ${value}` : ''}. Right-click or long-press to ask.` }
}
export function readAskElement(node: HTMLElement): AskElement {
  const field = node.dataset.askField ?? 'selected_text'
  return { field_name: field, label: node.dataset.askLabel ?? fieldLabels[field] ?? field, value: node.dataset.askValue ?? node.textContent?.trim() ?? '', type: node.dataset.askType as AskElementType || elementType(field) }
}
