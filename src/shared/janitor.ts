/** Read-only proposal wire contract. Nothing in this contract authorizes a write. */
export const auditCategories = ['duplicates', 'overlaps', 'superseded', 'stale-or-no-action', 'check-in', 'ownership-or-links'] as const
export type AuditCategory = typeof auditCategories[number]
export type ProposalAction = 'exact_metadata_fix' | 'possible_duplicate' | 'overlapping_scope' | 'possible_superseded' |
  'stale_needs_owner_update' | 'suggest_summary_rewrite' | 'source_conflict'
export interface AuditContext {
  outcome: 'available' | 'partial' | 'unavailable'
  observedAt?: string
  blocks: Array<{ id: string; type: string; text: string }>
  omissions?: string
}
export interface AuditEvidence {
  pageId: string
  url: string
  field: string
  value: unknown
  observedAt: string | null
  editedAt: string
  freshness: 'fresh' | 'partial' | 'stale' | 'unknown'
  coverage: 'complete' | 'partial' | 'unknown'
  relatedPages?: Array<{ id: string; url: string; availability: 'observed' | 'unknown' }>
}
export interface AuditProposal {
  proposal_id: string
  evidenceRevision: string
  category: AuditCategory
  actionType: ProposalAction
  rule: string
  severity: 'info' | 'warning'
  pages: Array<{ id: string; url: string; title: string; role: 'operational' | 'supporting' }>
  why: string
  evidence: AuditEvidence[]
  origin: 'deterministic'
  confidence: 'high' | 'medium' | 'low'
  abstainReason: string | null
  proposedAction: string
  proposedSurvivor: null
  preview: Array<{ pageId: string; before: Record<string, unknown>; after: Record<string, unknown> }>
  impact: 'investigation-only'
  protected: string[]
  applyPreconditions: {
    authorization: 'not-authorized'
    pages: Array<{ id: string; lastEditedAt: string; sourceFingerprint: string }>
    evidenceRevision: string
    requires: string[]
  }
}
