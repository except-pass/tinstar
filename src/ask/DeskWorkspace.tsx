import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Draft, OutboxMessage, SubmitResult, Worker } from '../cockpit/shell/types'
import { useFloorScene } from '../reconciliation/useFloorScene'
import { useDeskQueue } from '../reconciliation/useDeskQueue'
import { usePresentation } from '../reconciliation/usePresentation'
import { QueuePanel } from '../reconciliation/QueuePanel'
import { decisionItems } from '../shared/reconciliationQueue'
import type { PresentationAction } from '../shared/reconciliationPresentation'
import { AskDesk, AskProvider, useAskControls } from './Ask'
import { deskConversations, type DeskView } from './deskInbox'
import { DeskRail } from './DeskRail'
import { useSearchSession } from '../reconciliation/useSearchSession'
import { loadOverviewDensity, type OverviewDensity } from '../reconciliation/overviewDensity'
import type { AskReturn } from '../shared/ask'
import { emptySearch } from '../shared/smartSearch'
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

export function DeskWorkspace({ views, origin, onNavigate, onClearOrigin, overviewActive, decisionsActive = false, onOverview, workers, messages, submit, children }: {
  views?: WorkspaceHistory; onClearOrigin?: () => void; origin?: AskReturn; onNavigate?: (origin: AskReturn) => void
  decisionsActive?: boolean; overviewActive: boolean; onOverview: () => void
  workers: Worker[]; messages: OutboxMessage[]; submit: (draft: Draft) => Promise<SubmitResult>; children: ReactNode
}) {
  const floor = useFloorScene(overviewActive || decisionsActive), { queue, error: queueError } = useDeskQueue()
  const presentation = usePresentation(floor.scene, queue, !!floor.error, overviewActive || decisionsActive, decisionsActive, !!queueError)
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
  const search = useSearchSession({ views, active: overviewActive, scene: floor.scene, state: presentation.state, send, canvas, root, roots: openRelationships, setRoots: setOpenRelationships, density, setDensity, details: detailedCollapsed, setDetails: setDetailedCollapsed })
  const handledOrigin = useRef<AskReturn | null>(null)
  const restoringOverview = useViewSnapshot(views, 'overview', () => ({
    query: presentation.state.search?.query ?? '', sort: presentation.state.sort ?? 'priority',
    filter: { search: presentation.state.search ?? emptySearch(), searchFocus: presentation.state.searchFocus, searchReveal: presentation.state.searchReveal, status: presentation.state.statusFilter, donut: presentation.state.donutFilter, exceptions: presentation.state.exceptionsOnly },
    group: presentation.state.organizer,
  }), saved => {
    handledOrigin.current = null
    // Workspace Back may only be dismissing a reopened search palette. Restore
    // its saved focus as well as the query; set-search intentionally clears it.
    const { selection, collapsed, navigation, exceptionsOnly, roadmapExpanded, organizer, statusFilter, donutFilter, linksVisible, arrangement, sort } = presentation.state
    presentation.send({ type: 'restore-search-view', view: { selection, collapsed, navigation, exceptionsOnly, roadmapExpanded, organizer, statusFilter, donutFilter, linksVisible, arrangement, sort,
      search: { ...saved.filter.search, query: saved.query }, searchFocus: saved.filter.searchFocus, searchReveal: saved.filter.searchReveal ?? null } })
    presentation.send({ type: 'set-sort', sort: saved.sort })
    if (saved.group) presentation.send({ type: 'set-organizer', organizer: saved.group })
    if (saved.filter.status) presentation.send({ type: 'set-status-filter', filter: saved.filter.status })
    if (saved.filter.donut) presentation.send({ type: 'set-donut-filter', filter: saved.filter.donut })
    presentation.send({ type: 'set-exceptions', enabled: saved.filter.exceptions })
  }, overviewActive && !!floor.scene)
  useLayoutEffect(() => {
    if (!origin) { handledOrigin.current = null; return }
    const target = overviewTarget(origin.target)
    if (!overviewActive || !floor.scene || origin.section !== 'overview' || !target || handledOrigin.current === origin) return
    if (restoringOverview) return
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
      <div className="desk-workspace">{children}<WorkspaceRail closeRequest={closeRequest} openRequest={openRequest} onClose={() => presentation.send({ type: 'close-queue' })} workers={workers} messages={messages} submit={submit} /></div>
    </AskProvider>
  </WorkspaceContext.Provider>
}
function WorkspaceRail({ closeRequest, openRequest, onClose, workers, messages, submit }: {
  closeRequest: number; openRequest: number; onClose: () => void
  workers: Worker[]; messages: OutboxMessage[]; submit: (draft: Draft) => Promise<SubmitResult>
}) {
  const { scene, state, send, queue, queueError, now } = useDeskWorkspace()
  const controls = useAskControls()
  const groups = deskConversations(controls?.items ?? [])
  const unread = groups.filter(group => group.unread).length
  const decisions = queue && !queueError ? decisionItems(queue, now).length : 0
  const counts = { 'needs-you': decisions + groups.filter(group => group.view === 'needs-you').length, waiting: groups.filter(group => group.view === 'waiting').length, history: groups.filter(group => group.view === 'history').length }
  const [selectedView, setSelectedView] = useState<DeskView | null>(null)
  const expandedGroup = groups.find(group => group.id === controls?.expanded)
  const previousExpanded = useRef<{ id: string; view: DeskView } | null>(null)
  // Follow an intentionally opened thread when a reply/read changes its view.
  // Resolve during render so its inline composer never unmounts between views.
  const followExpanded = expandedGroup && (expandedGroup.id !== previousExpanded.current?.id || expandedGroup.view !== previousExpanded.current.view && expandedGroup.view !== 'history')
  const view = followExpanded ? expandedGroup.view : selectedView ?? (counts['needs-you'] || !counts.waiting ? 'needs-you' : 'waiting')
  useEffect(() => {
    if (followExpanded) setSelectedView(expandedGroup.view)
    previousExpanded.current = expandedGroup ? { id: expandedGroup.id, view: expandedGroup.view } : null
  }, [expandedGroup, followExpanded])
  useEffect(() => { if (openRequest) setSelectedView('needs-you') }, [openRequest])
  const attention = decisions + groups.filter(group => group.failed && !group.unread && group.view !== 'history').length
  return <DeskRail closeRequest={closeRequest} openRequest={openRequest} unread={unread} attention={attention} onClose={onClose}>
    <nav className="desk-tabs" aria-label="Desk views">{([['needs-you', 'Needs you'], ['waiting', 'Waiting'], ['history', 'History']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => setSelectedView(key)}>{label}{' '}<span>{counts[key]}</span></button>)}</nav>
    <div hidden={view !== 'needs-you' || !(decisions || queueError || state.queueItemId || state.queueCardId)}><QueuePanel scene={scene ?? undefined} messages={messages} submit={submit} workers={workers} state={state} send={send} queue={queue} error={queueError} now={now} /></div>
    <AskDesk now={now} view={view} showEmpty={view !== 'needs-you' || !decisions} />
  </DeskRail>
}
