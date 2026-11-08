import type { AskField, AskTarget, AskView } from '../shared/ask'

export interface AskSubject { cardId?: string; target?: AskTarget; label?: string; view?: AskView }
export interface AskSeed extends AskSubject { field_key?: AskField; field_value?: string }
export const fieldDrafts: Record<AskField, string> = {
  next_check_in: 'Why is this overdue?',
  status: 'Why is this task in this status? What is happening now?',
  waiting_for: "What's preventing this from moving forward?",
  owner: 'What is this owner doing on the task?',
  priority: 'Why does this task have this priority?',
  last_edited: 'What changed in the last edit?',
  relationship: 'How are these two items related?',
  ci: 'What is happening with CI for this PR?',
  review: 'What is the current review situation for this PR?',
  changes: 'What changed in this PR?',
  description: 'Explain this PR and its current situation.',
  deployment: 'What is the deployment evidence for this release target?',
  receipt: 'What does this deployment receipt establish?',
  title: "What's the current situation with this task?",
}
