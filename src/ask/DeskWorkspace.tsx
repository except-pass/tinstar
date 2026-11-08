import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Draft, OutboxMessage, SubmitResult, Worker } from '../cockpit/shell/types'
import { useFloorScene } from '../reconciliation/useFloorScene'
import { useDeskQueue } from '../reconciliation/useDeskQueue'
import { usePresentation } from '../reconciliation/usePresentation'
import { QueuePanel } from '../reconciliation/QueuePanel'
import { decisionItems } from '../shared/reconciliationQueue'
import type { PresentationAction } from '../shared/reconciliationPresentation'
import { AskCardAction, AskDesk, AskProvider, useAskControls } from './Ask'
import { DeskRail } from './DeskRail'
import { useSearchSession } from '../reconciliation/useSearchSession'
import { loadOverviewDensity, type OverviewDensity } from '../reconciliation/overviewDensity'
import type { AskReturn } from '../shared/ask'
import type { Target } from '../reconciliation/presentation'
import { useViewSnapshot, type WorkspaceHistory } from './workspaceHistory'

function overviewTarget(target: AskReturn['target']) {
  return target.kind === 'card' || target.kind === 'execution' || target.kind === 'claim' ? target : null
}

type Workspace = ReturnType<typeof useFloorScene> & ReturnType<typeof usePresentation> & {
  overviewSearch: { search: ReturnType<typeof useSearchSession>; canvas: React.RefObject<HTMLDivElement>; root: React.RefObject<HTMLDivElement>; density: OverviewDensity; setDensity: React.Dispatch<React.SetStateAction<OverviewDensity>>; openRelationships: Target[]; setOpenRelationships: React.Dispatch<React.SetStateAction<Target[]>>; detailedCollapsed: string[]; setDetailedCollapsed: React.Dispatch<React.SetStateAction<string[]>> }
  views?: WorkspaceHistory; origin?: AskReturn; clearOrigin?: () => void
  queue: ReturnType<typeof useDeskQueue>['queue']; queueError: string | null; openDesk: () => void
}
const WorkspaceContext = createContext<Workspace | null>(null)
export function useDeskWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('Section requires the shared Desk workspace')
  return value
}

export function DeskWorkspace({ views, origin, onNavigate, onClearOrigin, overviewActive, onOverview, onWorkers, onReceipts, workers, messages, submit, children }: {
  views?: WorkspaceHistory; onClearOrigin?: () => void; origin?: AskReturn; onNavigate?: (origin: AskReturn) => void
  overviewActive: boolean; onOverview: () => void; onWorkers?: () => void; onReceipts?: () => void
  workers: Worker[]; messages: OutboxMessage[]; submit: (draft: Draft) => Promise<SubmitResult>; children: ReactNode
}) {
  const floor = useFloorScene(), { queue, error: queueError } = useDeskQueue()
  const presentation = usePresentation(floor.scene, queue, !!floor.error, overviewActive)
  const [openRequest, setOpenRequest] = useState(0)
  const [closeRequest, setCloseRequest] = useState(0)
  const openDesk = useCallback(() => setOpenRequest(value => value + 1), [])
  const send = useCallback((action: PresentationAction) => {
    const result = presentation.send(action)
    if (result?.outcome === 'applied' && (action.type === 'navigate-card' || action.type === 'reveal-search')) {
      if (action.type === 'navigate-card') setCloseRequest(value => value + 1)
      if (!overviewActive) onOverview()
    }
    return result
  }, [presentation.send, onOverview, overviewActive])
  useEffect(() => { if (presentation.state.queueOpen) openDesk() }, [presentation.state.queueOpen, presentation.state.queueItemId, presentation.state.queueCardId, openDesk])
  const [density, setDensity] = useState<OverviewDensity>(loadOverviewDensity)
  const [openRelationships, setOpenRelationships] = useState<Target[]>([])
  const [detailedCollapsed, setDetailedCollapsed] = useState<string[]>([])
  const canvas = useRef<HTMLDivElement>(null), root = useRef<HTMLDivElement>(null)
  const search = useSearchSession({ active: overviewActive, scene: floor.scene, state: presentation.state, send, canvas, root, roots: openRelationships, setRoots: setOpenRelationships, density, setDensity, details: detailedCollapsed, setDetails: setDetailedCollapsed })
  useViewSnapshot(views, 'overview', search.captureView, search.restoreView, overviewActive && !!floor.scene)
  const handledOrigin = useRef<AskReturn | null>(null)
  useLayoutEffect(() => {
    if (!origin) { handledOrigin.current = null; return }
    const target = overviewTarget(origin.target)
    if (!overviewActive || !floor.scene || origin.section !== 'overview' || !target || handledOrigin.current === origin) return
    if (views?.restoration.snapshot?.section === 'overview') { handledOrigin.current = origin; return }
    if (!search.choose(target)) return
    handledOrigin.current = origin
    presentation.send({ type: 'flash', targets: [target] })
  })
  const overviewSearch = { search, canvas, root, density, setDensity, openRelationships, setOpenRelationships, detailedCollapsed, setDetailedCollapsed }
  const workspace = { views, origin, clearOrigin: onClearOrigin, ...floor, ...presentation, overviewSearch, send, queue, queueError, openDesk }
  return <WorkspaceContext.Provider value={workspace}>
    <AskProvider scene={floor.scene} state={presentation.state} send={send} canBack={views?.canBack} onBack={views?.back} onReturn={destination => {
      if (destination.section === 'overview') search.remember()
      if (onNavigate) onNavigate(destination)
      else if (destination.section === 'overview') {
        const target = overviewTarget(destination.target)
        if (!overviewActive) onOverview()
        if (target && search.choose(target)) presentation.send({ type: 'flash', targets: [target] })
      }
    }}>
      <div className="desk-workspace">{children}<WorkspaceRail closeRequest={closeRequest} openRequest={openRequest} onClose={() => presentation.send({ type: 'close-queue' })} onWorkers={onWorkers} onReceipts={onReceipts} workers={workers} messages={messages} submit={submit} /></div>
    </AskProvider>
  </WorkspaceContext.Provider>
}
function WorkspaceRail({ closeRequest, openRequest, onClose, onWorkers, onReceipts, workers, messages, submit }: {
  closeRequest: number; openRequest: number; onClose: () => void; onWorkers?: () => void; onReceipts?: () => void
  workers: Worker[]; messages: OutboxMessage[]; submit: (draft: Draft) => Promise<SubmitResult>
}) {
  const { scene, state, send, queue, queueError, now } = useDeskWorkspace()
  const controls = useAskControls()
  const unread = controls?.items.filter(item => !item.dismissed_at && item.reply && !item.read_at).length ?? 0
  const failed = controls?.items.filter(item => !item.dismissed_at && item.status === 'failed').length ?? 0
  const attention = failed + (queue && !queueError ? decisionItems(queue, now).length : 0)
  return <DeskRail closeRequest={closeRequest} openRequest={openRequest} unread={unread} attention={attention} onClose={onClose} tools={closeMobile => <>
    <AskCardAction icon />
    {onWorkers && <button type="button" aria-label="Find worker" title="Find worker" onClick={() => { closeMobile(); onWorkers() }}><span className="material-symbols-outlined" aria-hidden="true">person_search</span></button>}
    {onReceipts && <button type="button" aria-label="Message receipts" title={`Message receipts · ${messages.length}`} onClick={() => { closeMobile(); onReceipts() }}><span className="material-symbols-outlined" aria-hidden="true">receipt_long</span></button>}
  </>}>
    <AskDesk now={now} /><QueuePanel scene={scene ?? undefined} messages={messages} submit={submit} workers={workers} state={state} send={send} queue={queue} error={queueError} now={now} />
  </DeskRail>
}
