import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Draft, OutboxMessage, SubmitResult, Worker } from '../cockpit/shell/types'
import { useFloorScene } from '../reconciliation/useFloorScene'
import { useDeskQueue } from '../reconciliation/useDeskQueue'
import { usePresentation } from '../reconciliation/usePresentation'
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
  queue: ReturnType<typeof useDeskQueue>['queue']; queueError: string | null; openDesk: () => void; workers: Worker[]; messages: OutboxMessage[]; submit: (draft: Draft) => Promise<SubmitResult>
}
const WorkspaceContext = createContext<Workspace | null>(null)
export function useDeskWorkspace() {
  const value = useContext(WorkspaceContext)
  if (!value) throw new Error('Section requires the shared Desk workspace')
  return value
}

export function DeskWorkspace({ views, origin, onNavigate, onClearOrigin, overviewActive, decisionsActive = false, onOverview, onDecisions, workers, messages, submit, children }: {
  views?: WorkspaceHistory; onClearOrigin?: () => void; origin?: AskReturn; onNavigate?: (origin: AskReturn) => void
  decisionsActive?: boolean; overviewActive: boolean; onOverview: () => void; onDecisions?: () => void
  workers: Worker[]; messages: OutboxMessage[]; submit: (draft: Draft) => Promise<SubmitResult>; children: ReactNode
}) {
  const [history, setHistory] = useState(false)
  const [openRequest, setOpenRequest] = useState(0)
  const [closeRequest, setCloseRequest] = useState(0)
  const floor = useFloorScene(overviewActive || decisionsActive, history), { queue, error: queueError } = useDeskQueue()
  const presentation = usePresentation(floor.scene, queue, !!floor.error, overviewActive || decisionsActive, decisionsActive, !!queueError, action => {
    if (action.type === 'open-queue' || action.type === 'navigate-queue') {
      if (!decisionsActive) onDecisions?.()
      return
    }
    if (action.origin !== 'assistant') {
      if (action.type === 'navigate-card') setCloseRequest(value => value + 1)
      if (!overviewActive) onOverview()
      return
    }
    const targets = action.type === 'navigate-card' ? [{ kind: 'card', id: action.cardId }] : action.type === 'reveal-search' || action.type === 'focus' ? [action.target] : action.type === 'flash' ? action.targets : []
    if (!targets.length) return
    setCloseRequest(value => value + 1)
    const inDecisions = targets.every(target => target.kind === 'card' && (queue?.needsWill ?? queue?.items ?? []).some(item => item.cardIds.includes(target.id)))
    if (action.type === 'navigate-card' && inDecisions && onDecisions) { if (!decisionsActive) onDecisions() }
    else if (!overviewActive && !inDecisions) onOverview()
  })
  // All/custom are explicit requests for records outside the operational scope.
  // MCP work queries choose their own scope and never inherit this UI state.
  useEffect(() => { setHistory(presentation.state.statusFilter?.preset === 'all' || presentation.state.statusFilter?.preset === 'custom') }, [presentation.state.statusFilter?.preset])
  const openDesk = useCallback(() => setOpenRequest(value => value + 1), [])
  const send = presentation.send
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
  const workspace = { views, origin, clearOrigin: onClearOrigin, ...floor, ...presentation, overviewSearch, send, queue, queueError, openDesk, workers, messages, submit }
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
      <div className="desk-workspace">{children}<WorkspaceRail closeRequest={closeRequest} openRequest={openRequest} /></div>
    </AskProvider>
  </WorkspaceContext.Provider>
}
function WorkspaceRail({ closeRequest, openRequest }: {
  closeRequest: number; openRequest: number
}) {
  const { now } = useDeskWorkspace()
  const controls = useAskControls()
  const groups = deskConversations(controls?.items ?? [])
  const unread = groups.filter(group => group.unread).length
  const counts = { 'needs-you': groups.filter(group => group.attention).length, waiting: groups.filter(group => group.view === 'waiting').length, history: groups.filter(group => group.view === 'history').length }
  const [selectedView, setSelectedView] = useState<DeskView | null>(null)
  const expandedGroup = groups.find(group => group.id === controls?.expanded)
  const previousExpanded = useRef<{ id: string; view: DeskView } | null>(null)
  // Follow an intentionally opened thread when a reply/read changes its view.
  // Resolve during render so its inline composer never unmounts between views.
  const followExpanded = expandedGroup && (expandedGroup.id !== previousExpanded.current?.id || expandedGroup.view !== previousExpanded.current.view && !expandedGroup.turns.every(turn => !!turn.dismissed_at))
  const view = followExpanded ? expandedGroup.view : selectedView ?? (groups.some(group => group.view === 'needs-you') || !counts.waiting ? 'needs-you' : 'waiting')
  useEffect(() => {
    if (followExpanded) setSelectedView(expandedGroup.view)
    previousExpanded.current = expandedGroup ? { id: expandedGroup.id, view: expandedGroup.view } : null
  }, [expandedGroup, followExpanded])
  useEffect(() => { if (openRequest) setSelectedView('needs-you') }, [openRequest])
  const attention = groups.filter(group => group.attention && !group.unread).length
  return <DeskRail closeRequest={closeRequest} openRequest={openRequest} unread={unread} attention={attention}>
    <nav className="desk-tabs" aria-label="Discuss views">{([['needs-you', 'Needs you'], ['waiting', 'Waiting'], ['history', 'History']] as const).map(([key, label]) => <button type="button" key={key} aria-pressed={view === key} onClick={() => setSelectedView(key)}>{label}{' '}<span>{counts[key]}</span></button>)}</nav>
    <AskDesk now={now} view={view} />
  </DeskRail>
}
