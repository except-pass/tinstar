import type { AnchorType } from '../contract/intent'

/** Transport state of one user turn. A prose reply is not an approval. */
export const TURN_DISPOSITIONS = [
  'queued',
  'saved-unannounced',
  'not-receivable',
  'failed',
  'replied',
] as const

export type TurnDisposition = (typeof TURN_DISPOSITIONS)[number]

export interface TextSelection {
  text: string
  field?: string
}

export interface ThreadAnchorView {
  type: AnchorType
  /** Semantic ids, stored in the order the user selected. */
  ids: string[]
  textSelection: TextSelection | null
  revision: string | null
  /** Short labels for the selected objects. Never a portfolio dump. */
  labels: string[]
}

export interface ThreadDisplayView {
  status: 'current' | 'changed'
  /** Set when the target was archived or the pixels now hold something else. */
  changedLine: string | null
  position: { columnId: string | null; index: number | null } | null
}

export interface ThreadMessageView {
  id: string
  role: 'user' | 'firstmate'
  text: string
  disposition: TurnDisposition
  noteId: string | null
  requestId: string | null
  previousNoteId: string | null
  pending: boolean
  detail: string
}

export interface ThreadView {
  id: string
  anchor: ThreadAnchorView
  fixture: boolean
  display: ThreadDisplayView
  messages: ThreadMessageView[]
}

export interface ThreadAnchorInput {
  type: AnchorType
  ids: string[]
  textSelection?: TextSelection | null
  labels?: string[]
  revision?: string | null
}

export interface ThreadPlacement {
  archived?: boolean
  /** Ids of whatever currently occupies the anchor's pixels. Not identity. */
  occupantIds?: string[]
  position?: { columnId?: string | null; index?: number | null }
}

export function dispositionLabel(disposition: TurnDisposition): string | null {
  switch (disposition) {
    case 'queued':
      return 'queued'
    case 'saved-unannounced':
      return 'saved, not announced'
    case 'not-receivable':
      return 'not receivable'
    case 'failed':
      return 'failed'
    case 'replied':
      return null
  }
}
