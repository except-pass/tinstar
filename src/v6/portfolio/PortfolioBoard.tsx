import { useEffect, useRef, useState } from 'react'
import type { IntentEnvelope } from '../contract/intent'
import {
  completeEnvelope,
  createEpicEnvelope,
  dependencyEnvelope,
  displayColumnId,
  initiativeEnvelope,
  launchEnvelope,
  moveEnvelope,
  pendingLabel,
  renameEnvelope,
  sortedColumns,
  taskEnvelope,
} from './model'
import { isClickablePlanHref } from './plan'
import { getPortfolio, getPortfolioPlan, postPortfolioIntent, postPortfolioReconcile, type PortfolioSubmitResult } from './client'
import type { Column, Epic, PlanView, PortfolioDoc } from './types'

export interface PortfolioBoardProps {
  board?: PortfolioDoc
  plan?: PlanView | null
  submitIntent?: (envelope: IntentEnvelope) => Promise<PortfolioSubmitResult>
  onReconcile?: (requestId: string) => Promise<PortfolioDoc>
  onOpenPlan?: (slug: string) => Promise<PlanView>
  createRequestId?: () => string
  clock?: () => string
}

function Field({ label, testId, defaultValue }: { label: string; testId: string; defaultValue?: string }) {
  return (
    <label className="block text-2xs text-ink-low">
      {label}
      <input
        aria-label={label}
        data-testid={testId}
        defaultValue={defaultValue}
        className="mt-0.5 block w-full bg-surface-base border border-white/10 px-1 py-0.5 text-xs text-ink-high"
      />
    </label>
  )
}

function inputValue(root: ParentNode | null, testId: string): string {
  const node = root?.querySelector(`[data-testid="${testId}"]`)
  return node instanceof HTMLInputElement ? node.value.trim() : ''
}

export function PortfolioBoard({
  board: boardProp,
  plan: planProp = null,
  submitIntent,
  onReconcile,
  onOpenPlan,
  createRequestId,
  clock,
}: PortfolioBoardProps) {
  const [doc, setDoc] = useState<PortfolioDoc | null>(boardProp ?? null)
  const [plan, setPlan] = useState<PlanView | null>(planProp)
  const [error, setError] = useState<string | null>(null)
  const armed = useRef<string | null>(null)
  const ids = useRef(0)
  const nextId = createRequestId ?? (() => `port-${ids.current += 1}`)
  const now = clock ?? (() => new Date().toISOString())

  useEffect(() => {
    if (boardProp) {
      setDoc(boardProp)
      return undefined
    }
    let cancelled = false
    void getPortfolio().then(board => {
      if (!cancelled) setDoc(board)
    }).catch(() => {
      if (!cancelled) setError('Portfolio unavailable')
    })
    return () => {
      cancelled = true
    }
  }, [boardProp])

  useEffect(() => {
    setPlan(planProp)
  }, [planProp])

  async function send(envelope: IntentEnvelope) {
    try {
      const result = await (submitIntent ?? postPortfolioIntent)(envelope)
      setDoc(result.board)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Not applied')
    }
  }

  async function dropOn(columnId: string) {
    const epicId = armed.current
    armed.current = null
    if (!epicId || !doc) return
    const epic = doc.epics.find(item => item.id === epicId)
    if (!epic) return
    const order = doc.epics.filter(item => displayColumnId(doc, item.id) === columnId).length
    await send(moveEnvelope(epic, columnId, nextId(), order))
  }

  async function rename(column: Column, root: ParentNode | null) {
    const name = inputValue(root, `name-${column.id}`) || column.name
    const description = inputValue(root, `description-${column.id}`) || column.description
    await send(renameEnvelope(column, name, description, nextId()))
  }

  async function openPlan(slug: string) {
    try {
      const view = onOpenPlan ? await onOpenPlan(slug) : await getPortfolioPlan(slug)
      setPlan(view)
      setError(null)
    } catch (err) {
      setPlan({ available: false, fixture: false, slug, href: null, tasks: [], detail: 'Stretch Plan unavailable' })
      setError(err instanceof Error ? err.message : 'Stretch Plan unavailable')
    }
  }

  if (!doc) {
    return <p data-testid="portfolio-loading" className="p-3 text-xs text-ink-mid">Loading portfolio</p>
  }

  const columns = sortedColumns(doc)

  return (
    <section data-testid="portfolio-board" className="bg-surface-base text-ink-high p-2 font-mono">
      <header className="mb-2 flex items-baseline gap-2">
        <h1 className="text-sm text-ink-high">Portfolio</h1>
        {doc.fixture ? <span data-testid="fixture-board" className="text-2xs text-hue-waiting">Fixture</span> : null}
      </header>
      {error ? <p role="alert" className="mb-2 text-xs text-hue-error">{error}</p> : null}
      <ul data-testid="explanations" className="mb-2 space-y-1">
        {doc.pending.filter(item => !item.applied).map(item => (
          <li
            key={item.requestId}
            data-testid={`status-${item.requestId}`}
            data-applied="false"
            data-disposition={item.disposition}
            data-exit={item.exitCode ?? ''}
            className="flex items-center gap-2 text-2xs text-hue-discussing"
          >
            <span>{pendingLabel(item)}</span>
            <button
              type="button"
              className="border border-white/10 px-1 text-ink-mid"
              onPointerUp={() => {
                void (onReconcile ?? postPortfolioReconcile)(item.requestId).then(setDoc).catch(err => {
                  setError(err instanceof Error ? err.message : 'Not applied')
                })
              }}
            >
              Check receipt
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2 overflow-x-auto">
        {columns.map(column => {
          const cards = doc.epics
            .filter(epic => displayColumnId(doc, epic.id) === column.id)
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
          return (
            <div key={column.id} data-testid={`column-${column.id}`} className="w-56 shrink-0 bg-surface-panel border border-white/10 p-2">
              <h2 className="text-xs text-ink-high" data-testid={`column-name-${column.id}`}>{column.name}</h2>
              <p className="text-2xs text-ink-low" data-testid={`column-description-${column.id}`}>{column.description}</p>
              <div className="my-1 space-y-1">
                <Field label={`Name ${column.name}`} testId={`name-${column.id}`} defaultValue={column.name} />
                <Field label={`Description ${column.name}`} testId={`description-${column.id}`} defaultValue={column.description} />
                <button
                  type="button"
                  className="text-2xs border border-white/10 px-1 text-ink-mid"
                  onPointerUp={event => {
                    void rename(column, event.currentTarget.parentElement)
                  }}
                >
                  Rename
                </button>
              </div>
              {cards.map(epic => (
                <EpicCard
                  key={epic.id}
                  doc={doc}
                  epic={epic}
                  onArm={() => { armed.current = epic.id }}
                  onComplete={() => { void send(completeEnvelope(epic, now(), nextId())) }}
                  onReopen={() => { void send(completeEnvelope(epic, null, nextId())) }}
                  onPlan={epic.planSlug ? () => { void openPlan(epic.planSlug as string) } : undefined}
                />
              ))}
              <button
                type="button"
                data-testid={`drop-${column.id}`}
                className="mt-2 w-full border border-white/10 px-1 py-0.5 text-2xs text-ink-mid"
                onPointerUp={() => { void dropOn(column.id) }}
              >
                Move here
              </button>
            </div>
          )
        })}
      </div>
      <Associations doc={doc} send={send} nextId={nextId} />
      <PlanPanel plan={plan} />
    </section>
  )
}

function EpicCard({
  doc,
  epic,
  onArm,
  onComplete,
  onReopen,
  onPlan,
}: {
  doc: PortfolioDoc
  epic: Epic
  onArm: () => void
  onComplete: () => void
  onReopen: () => void
  onPlan?: () => void
}) {
  const initiative = doc.initiatives.find(item => item.id === epic.initiativeId)
  const pending = doc.pending.some(item => !item.applied && item.disposition === 'queued' && item.proposal.op === 'move' && item.proposal.epicId === epic.id)
  return (
    <article
      data-testid={`epic-${epic.id}`}
      data-authoritative-column={epic.columnId}
      data-pending={pending ? 'true' : 'false'}
      onPointerDown={onArm}
      className="mb-2 bg-surface-raised border border-white/10 p-2"
    >
      <h3 className="text-xs text-ink-high">{epic.title}</h3>
      <p className="text-2xs text-ink-mid" data-testid={`initiative-${epic.id}`}>
        {initiative ? initiative.name : 'No initiative'}
      </p>
      {epic.completedAt ? (
        <time data-testid={`completed-${epic.id}`} className="block text-2xs text-ink-low">{epic.completedAt}</time>
      ) : null}
      {pending ? <span className="text-2xs text-hue-discussing">Pending</span> : null}
      <div className="mt-1 flex flex-wrap gap-1">
        <button type="button" className="text-2xs border border-white/10 px-1" onPointerUp={onComplete}>Mark completed</button>
        <button type="button" className="text-2xs border border-white/10 px-1" onPointerUp={onReopen}>Reopen</button>
        {onPlan ? (
          <button type="button" data-testid={`open-plan-${epic.id}`} className="text-2xs border border-white/10 px-1" onPointerUp={onPlan}>
            Show plan
          </button>
        ) : null}
      </div>
    </article>
  )
}

function Associations({
  doc,
  send,
  nextId,
}: {
  doc: PortfolioDoc
  send: (envelope: IntentEnvelope) => Promise<void>
  nextId: () => string
}) {
  const root = useRef<HTMLDivElement>(null)
  return (
    <div ref={root} className="mt-3 grid gap-3 md:grid-cols-2">
      <div>
        <h2 className="text-xs text-ink-mid">Initiatives</h2>
        <ul>
          {doc.initiatives.map(item => (
            <li key={item.id} data-testid={`initiative-row-${item.id}`} className="text-2xs text-ink-mid">
              {item.name}: {item.epicIds.join(', ') || 'no epics'} / {item.projectIds.join(', ') || 'no projects'}
            </li>
          ))}
        </ul>
        <div className="mt-1 space-y-1">
          <Field label="Initiative name" testId="new-initiative-name" />
          <Field label="Initiative projects" testId="new-initiative-projects" />
          <button
            type="button"
            className="text-2xs border border-white/10 px-1"
            onPointerUp={() => {
              const name = inputValue(root.current, 'new-initiative-name')
              if (!name) return
              const projectIds = inputValue(root.current, 'new-initiative-projects').split(/\s+/).filter(Boolean)
              const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'initiative'
              void send(initiativeEnvelope({
                id,
                name,
                epicIds: [],
                projectIds,
              }, nextId(), null))
            }}
          >
            Save initiative
          </button>
        </div>
      </div>
      <div>
        <h2 className="text-xs text-ink-mid">Tasks</h2>
        <ul>
          {doc.tasks.map(task => (
            <li key={task.id} data-testid={`task-${task.id}`} className="text-2xs text-ink-mid">
              {task.id} · Project {task.project}
              <button
                type="button"
                data-testid={`launch-${task.id}`}
                className="ml-1 border border-white/10 px-1"
                onPointerUp={() => { void send(launchEnvelope({
                  taskId: task.id,
                  project: task.project,
                  requestId: nextId(),
                  revision: task.revision,
                })) }}
              >
                Launch
              </button>
            </li>
          ))}
        </ul>
        <div className="mt-1 space-y-1">
          <Field label="Task id" testId="new-task-id" />
          <Field label="Task project" testId="new-task-project" />
          <button
            type="button"
            className="text-2xs border border-white/10 px-1"
            onPointerUp={() => {
              const id = inputValue(root.current, 'new-task-id')
              const project = inputValue(root.current, 'new-task-project')
              if (!id || !project) return
              void send(taskEnvelope({ id, project, requestId: nextId(), revision: null }))
            }}
          >
            Save task
          </button>
          <Field label="Epic title" testId="new-epic-title" />
          <button
            type="button"
            data-testid="add-epic"
            className="text-2xs border border-white/10 px-1"
            onPointerUp={() => {
              const title = inputValue(root.current, 'new-epic-title')
              const column = sortedColumns(doc)[0]
              if (!title || !column) return
              const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'epic'
              void send(createEpicEnvelope({ id, title, columnId: column.id, requestId: nextId() }))
            }}
          >
            Add epic
          </button>
          <Field label="Dependency id" testId="new-dependency-id" />
          <Field label="Dependency from" testId="new-dependency-from" />
          <Field label="Dependency to" testId="new-dependency-to" />
          <button
            type="button"
            className="text-2xs border border-white/10 px-1"
            onPointerUp={() => {
              const id = inputValue(root.current, 'new-dependency-id')
              const fromId = inputValue(root.current, 'new-dependency-from')
              const toId = inputValue(root.current, 'new-dependency-to')
              if (!id || !fromId || !toId) return
              void send(dependencyEnvelope({ id, fromId, toId }, nextId()))
            }}
          >
            Add dependency
          </button>
        </div>
        <ul className="mt-1">
          {doc.dependencies.map(item => (
            <li key={item.id} data-testid={`dependency-${item.id}`} className="text-2xs text-ink-mid">
              Depends on {item.fromId} → {item.toId}
            </li>
          ))}
        </ul>
        <ul>
          {doc.launches.map(item => (
            <li key={item.requestId} data-testid={`launch-record-${item.requestId}`} className="text-2xs text-ink-low">
              {item.taskId} · {item.project} · {item.initiativeId ?? 'no-initiative'}
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

function PlanPanel({ plan }: { plan: PlanView | null }) {
  if (!plan) return null
  return (
    <aside data-testid="plan-panel" className="mt-3 border border-white/10 bg-surface-panel p-2">
      <h2 className="text-xs text-ink-high">Stretch Plan</h2>
      {plan.fixture ? <p data-testid="fixture-plan" className="text-2xs text-hue-waiting">Fixture</p> : null}
      {!plan.available ? <p data-testid="plan-unavailable" className="text-xs text-hue-error">Stretch Plan unavailable</p> : null}
      {plan.available && plan.href && isClickablePlanHref(plan.href) ? (
        <a data-testid="plan-link" className="text-xs text-primary" href={plan.href}>Open plan</a>
      ) : null}
      {plan.available ? (
        <ul data-testid="plan-tasks" className="mt-1">
          {plan.tasks.map(task => (
            <li key={task.id} data-testid={`plan-task-${task.id}`} className="text-2xs text-ink-mid">
              {task.label || task.id}
            </li>
          ))}
        </ul>
      ) : null}
    </aside>
  )
}
