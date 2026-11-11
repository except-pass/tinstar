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
  async revision() {
    return JSON.stringify((await this.asks.proposalRecords()).map(row => row.reply!.decision_proposal!).sort((a, b) => a.request_key < b.request_key ? -1 : a.request_key > b.request_key ? 1 : a.proposal_id < b.proposal_id ? -1 : a.proposal_id > b.proposal_id ? 1 : 0))
  }
  async forRequest(requestKey: string, cardIds: string[], histories?: Map<string, Array<Pick<WorkflowNote, 'id' | 'text'>>>) {
    const publications = (await Promise.all(cardIds.map(id => this.read(id, histories?.get(id))))).flat()
    const answers = await this.askPublications()
    return [...publications, ...answers].filter(entry => entry.value.request_key === requestKey)
  }
  private async askPublications() {
    return (await this.asks.proposalRecords()).flatMap(row => {
      const parsed = decisionProposalSchema.safeParse(row.reply?.decision_proposal)
      return parsed.success && row.context.target?.kind === 'decision' && row.context.target.id === parsed.data.request_key && parsed.data.source.kind === 'ask-reply' && parsed.data.source.id === row.request_id
        ? [{ answer_id: row.request_id, value: parsed.data, anchor: row.context.anchor.page_id }] : []
    })
  }
  async read(cardId: string, notes?: Array<Pick<WorkflowNote, 'id' | 'text'>>): Promise<ProposalPublication[]> {
    const [history, answers] = await Promise.all([notes ?? this.work(cardId), this.askPublications()])
    const work = decisionRecordRows(history, 'Tin Star request: ').flatMap(row => {
      const parsed = decisionProposalSchema.safeParse(row.proposal)
      return parsed.success && (!parsed.data.card_id || parsed.data.card_id === cardId) ? [{ answer_id: proposalAnswerId(parsed.data), value: parsed.data }] : []
    })
    const keys = new Set(work.map(entry => entry.value.request_key))
    return [...work, ...answers.filter(entry => entry.anchor === cardId || entry.value.card_id === cardId || keys.has(entry.value.request_key))]
  }
}
