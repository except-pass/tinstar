import type { Draft, OutboxMessage, SubmitResult, Worker } from '../../src/cockpit/shell/types'
import type { WorkspaceHistory } from '../../src/ask/workspaceHistory'
import { DeskWorkspace } from '../../src/ask/DeskWorkspace'
import { useState } from 'react'
import { Decisions } from '../../src/reconciliation/Decisions'
import { Overview as Section } from '../../src/reconciliation/Overview'

/** Exercise Overview in the same single-owner shell as production. */
export function Overview({ workers, messages, submit, initialCardId, views }: {
  workers: Worker[]; messages: OutboxMessage[]; submit: (draft: Draft) => Promise<SubmitResult>; initialCardId?: string; views?: WorkspaceHistory
}) {
  const [decisions, setDecisions] = useState(false)
  return <DeskWorkspace views={views} overviewActive={!decisions} decisionsActive={decisions} onOverview={() => setDecisions(false)} onDecisions={() => setDecisions(true)} workers={workers} messages={messages} submit={submit}>{decisions ? <Decisions /> : <Section workers={workers} initialCardId={initialCardId} />}</DeskWorkspace>
}
