import { decisionProposalSchema } from '../../shared/decisionProposal'
import { decisionRecordRows } from '../../shared/workflowRequests'
import type { AskStore } from '../ask/store'
import { proposalAnswerId } from '../ask/decision'
import type { WorkflowNote } from './workflowContent'

export interface ProposalPublication {
  answer_id: string
  value: import('../../shared/decisionProposal').DecisionProposal
}
export class ProposalSource {
  constructor(private asks: AskStore, private work: (cardId: string) => Promise<WorkflowNote[]>) {}
  async read(cardId: string, notes?: Array<Pick<WorkflowNote, 'id' | 'text'>>): Promise<ProposalPublication[]> {
    const [history, answers] = await Promise.all([notes ?? this.work(cardId), this.asks.proposalRecords()])
    const work = decisionRecordRows(history, 'Tin Star request: ').flatMap(row => {
      const parsed = decisionProposalSchema.safeParse(row.proposal)
      return parsed.success && (!parsed.data.card_id || parsed.data.card_id === cardId) ? [{ answer_id: proposalAnswerId(parsed.data), value: parsed.data }] : []
    })
    return [...work, ...answers.flatMap(row => {
      const parsed = decisionProposalSchema.safeParse(row.reply?.decision_proposal)
      return parsed.success && row.context.anchor.page_id === cardId && row.context.target?.kind === 'decision' && row.context.target.id === parsed.data.request_key && parsed.data.source.kind === 'ask-reply' && parsed.data.source.id === row.request_id
        ? [{ answer_id: row.request_id, value: parsed.data }] : []
    })]
  }
}
