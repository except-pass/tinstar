import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import type { Draft, OutboxMessage, SubmitResult, Worker } from '../cockpit/shell/types'
import { useFloorScene } from '../reconciliation/useFloorScene'
import { useDeskQueue } from '../reconciliation/useDeskQueue'
import { usePresentation } from '../reconciliation/usePresentation'
import { QueuePanel } from '../reconciliation/QueuePanel'
import { decisionItems } from '../shared/reconciliationQueue'
import type { PresentationAction } from '../shared/reconciliationPresentation'
import { AskCardAction, AskDesk, AskProvider, useAskControls } from './Ask'
import { DeskRail } from './DeskRail'

type Workspace = ReturnType<typeof useFloorScene> & ReturnType<typeof usePresentation> & {
  queue: ReturnType<typeof useDeskQueue>['queue']; queueError: string | null; openDesk: () => void
}
const WorkspaceContext = createContext<Workspace | null>(null)
export function useDeskWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('Section requires the shared Desk workspace')
  return value
}

export function DeskWorkspace({ overviewActive, onOverview, onWorkers, onReceipts, workers, messages, submit, children }: {
  overviewActive: boolean; onOverview: () => void; onWorkers?: () => void; onReceipts?: () => void
  workers: Worker[]; messages: OutboxMessage[]; submit: (draft: Draft) => Promise<SubmitResult>; children: ReactNode
}) {
  const floor = useFloorScene(), { queue, error: queueError } = useDeskQueue()
  const presentation = usePresentation(floor.scene, queue, !!floor.error, overviewActive)
  const [openRequest, setOpenRequest] = useState(0)
  const openDesk = useCallback(() => setOpenRequest(value => value + 1), [])
  const send = useCallback((action: PresentationAction) => {
    if (action.type === 'navigate-card' && !overviewActive) onOverview()
    return presentation.send(action)
  }, [presentation.send, onOverview, overviewActive])
  useEffect(() => { if (presentation.state.queueOpen) openDesk() }, [presentation.state.queueOpen, presentation.state.queueItemId, presentation.state.queueCardId, openDesk])
  const workspace = { ...floor, ...presentation, send, queue, queueError, openDesk }
  return <WorkspaceContext.Provider value={workspace}>
    <AskProvider scene={floor.scene} state={presentation.state} send={send} onReturn={() => { if (!overviewActive) onOverview() }}>
      <div className="desk-workspace">{children}<WorkspaceRail openRequest={openRequest} onClose={() => presentation.send({ type: 'close-queue' })} onWorkers={onWorkers} onReceipts={onReceipts} workers={workers} messages={messages} submit={submit} /></div>
    </AskProvider>
  </WorkspaceContext.Provider>
}
function WorkspaceRail({ openRequest, onClose, onWorkers, onReceipts, workers, messages, submit }: {
  openRequest: number; onClose: () => void; onWorkers?: () => void; onReceipts?: () => void
  workers: Worker[]; messages: OutboxMessage[]; submit: (draft: Draft) => Promise<SubmitResult>
}) {
  const { scene, state, send, queue, queueError, now } = useDeskWorkspace()
  const controls = useAskControls()
  const unread = controls?.items.filter(item => !item.dismissed_at && item.reply && !item.read_at).length ?? 0
  const failed = controls?.items.filter(item => !item.dismissed_at && item.status === 'failed').length ?? 0
  const attention = failed + (queue && !queueError ? decisionItems(queue, now).length : 0)
  return <DeskRail openRequest={openRequest} unread={unread} attention={attention} onClose={onClose} tools={closeMobile => <>
    <AskCardAction icon />
    {onWorkers && <button type="button" aria-label="Find worker" title="Find worker" onClick={() => { closeMobile(); onWorkers() }}><span className="material-symbols-outlined" aria-hidden="true">person_search</span></button>}
    {onReceipts && <button type="button" aria-label="Message receipts" title={`Message receipts · ${messages.length}`} onClick={() => { closeMobile(); onReceipts() }}><span className="material-symbols-outlined" aria-hidden="true">receipt_long</span></button>}
  </>}>
    <AskDesk now={now} /><QueuePanel scene={scene ?? undefined} messages={messages} submit={submit} workers={workers} state={state} send={send} queue={queue} error={queueError} now={now} />
  </DeskRail>
}
