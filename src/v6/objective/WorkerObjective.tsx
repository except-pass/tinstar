import { useEffect, useRef, useState, type FormEvent } from 'react'
import { apiFetch } from '../../apiClient'
import {
  T01_PROCESS_UNCLAIMED,
  suggestSessionName,
  type LaunchRecord,
  type WorkerObjectiveRecord,
} from './model'

export interface WorkerObjectiveProps {
  workerId?: string
  fixture?: boolean
  narrower?: boolean
  parentTaskId?: string | null
  planTaskLabel?: string | null
  planTaskSource?: 'plan-task' | null
  initialRecord?: WorkerObjectiveRecord | null
}

interface Envelope<T> {
  ok: true
  data: T
}

interface Failure {
  ok: false
  error?: { message?: string }
}

function isEnvelope<T>(value: unknown): value is Envelope<T> {
  return !!value && typeof value === 'object' && (value as { ok?: unknown }).ok === true
}

async function readJson(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>
}

export function WorkerObjective({
  workerId,
  fixture = false,
  narrower = false,
  parentTaskId = null,
  planTaskLabel = null,
  planTaskSource = null,
  initialRecord = null,
}: WorkerObjectiveProps) {
  const [record, setRecord] = useState<WorkerObjectiveRecord | null>(initialRecord)
  const [draft, setDraft] = useState(initialRecord?.current?.text ?? '')
  const [notice, setNotice] = useState('')
  const [launch, setLaunch] = useState<LaunchRecord | null>(null)
  const [project, setProject] = useState('')
  const [launchObjective, setLaunchObjective] = useState('')
  const [sessionName, setSessionName] = useState('')
  const [sessionTouched, setSessionTouched] = useState(false)
  const setAttempt = useRef<{ text: string; requestId: string } | null>(null)
  const achieveAttempt = useRef<{ revision: string; requestId: string } | null>(null)
  const launchAttempt = useRef<{ key: string; requestId: string } | null>(null)

  useEffect(() => {
    if (!workerId) return
    let cancelled = false
    void apiFetch(`/api/v6/objectives/${encodeURIComponent(workerId)}`)
      .then(readJson)
      .then(body => {
        if (cancelled || !isEnvelope<WorkerObjectiveRecord>(body)) return
        setRecord(body.data)
        setDraft(current => current || body.data.current?.text || '')
      })
      .catch(() => {
        if (!cancelled) setNotice('Objective could not be loaded.')
      })
    return () => {
      cancelled = true
    }
  }, [workerId])

  const id = workerId ?? record?.workerId
  const textFieldId = `worker-objective-text-${id ?? 'none'}`
  const projectFieldId = `launch-project-${id ?? 'none'}`
  const launchObjectiveFieldId = `launch-objective-${id ?? 'none'}`
  const sessionFieldId = `launch-session-${id ?? 'none'}`
  const current = record?.current ?? null
  const previous = record && record.history.length > 0 ? record.history[record.history.length - 1] : undefined
  const showFixture = fixture || current?.fixture === true || launch?.fixture === true
  const label = current?.planTaskLabel ?? planTaskLabel
  const source = current?.planTaskSource ?? planTaskSource
  const showPlan = source === 'plan-task' && !!label
  const showNarrower = current?.narrower === true || narrower

  async function onSet(event: FormEvent) {
    event.preventDefault()
    if (!id) {
      setNotice('Choose a worker before setting an objective.')
      return
    }
    const text = draft.trim()
    if (!text) {
      setNotice('Enter an objective.')
      return
    }
    if (!setAttempt.current || setAttempt.current.text !== text) {
      setAttempt.current = { text, requestId: crypto.randomUUID() }
    }
    setNotice('Pending')
    const response = await apiFetch(`/api/v6/objectives/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: setAttempt.current.requestId,
        revision: current?.revision ?? null,
        text,
        narrower: Boolean((current?.narrower ?? narrower) && (current?.parentTaskId ?? parentTaskId)),
        parentTaskId: current?.parentTaskId ?? parentTaskId,
        planTaskLabel: source === 'plan-task' ? label : null,
        planTaskSource: source === 'plan-task' ? 'plan-task' : null,
        fixture,
      }),
    })
    const body = await readJson(response)
    if (!isEnvelope<WorkerObjectiveRecord>(body)) {
      const message = (body as Failure).error?.message ?? 'Objective was not saved.'
      setNotice(message)
      return
    }
    setRecord(body.data)
    setDraft(body.data.current?.text ?? text)
    setNotice(body.data.current?.pending ? 'Pending' : (body.data.current?.detail ?? ''))
    if (body.data.current?.disposition !== 'failed') setAttempt.current = null
  }

  async function onAchieve() {
    if (!id || !current) return
    if (!achieveAttempt.current || achieveAttempt.current.revision !== current.revision) {
      achieveAttempt.current = { revision: current.revision, requestId: crypto.randomUUID() }
    }
    setNotice('Pending')
    const response = await apiFetch(`/api/v6/objectives/${encodeURIComponent(id)}/achieve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: achieveAttempt.current.requestId,
        revision: current.revision,
      }),
    })
    const body = await readJson(response)
    if (!isEnvelope<{ achievement: { pending: boolean; detail: string; text: string; workerId: string } }>(body)) {
      const message = (body as Failure).error?.message ?? 'Objective was not sent.'
      setNotice(message)
      return
    }
    setNotice(body.data.achievement.pending ? 'Pending' : body.data.achievement.detail)
    if (!body.data.achievement.pending && body.data.achievement.detail && !body.data.achievement.detail.toLowerCase().includes('fail')) {
      achieveAttempt.current = null
    }
  }

  async function onLaunch(event: FormEvent) {
    event.preventDefault()
    const projectName = project.trim()
    const objective = launchObjective.trim()
    if (!projectName || !objective) {
      setNotice('A launch needs a project and an objective.')
      return
    }
    const key = `${projectName}\n${objective}\n${sessionName}`
    if (!launchAttempt.current || launchAttempt.current.key !== key) {
      launchAttempt.current = { key, requestId: crypto.randomUUID() }
    }
    setNotice('Pending')
    const response = await apiFetch('/api/v6/launches', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestId: launchAttempt.current.requestId,
        project: projectName,
        objective,
        sessionName: sessionName.trim() || null,
        fixture,
      }),
    })
    const body = await readJson(response)
    if (!isEnvelope<LaunchRecord>(body)) {
      const message = (body as Failure).error?.message ?? 'Launch was not saved.'
      setNotice(message)
      return
    }
    setLaunch(body.data)
    setNotice('Pending')
  }

  return (
    <section aria-label="Worker objective" data-testid="objective-root" className="bg-surface-panel text-ink-high rounded border border-hairline p-3 space-y-3 text-sm">
      <header className="flex items-baseline justify-between gap-2">
        <h2 className="text-ink-high font-medium">Objective</h2>
        {id ? <p data-testid="objective-worker" className="text-ink-low">Worker {id}</p> : <p className="text-ink-low">No worker selected</p>}
      </header>
      {showFixture ? <p data-testid="objective-fixture" className="text-accent-amber">fixture</p> : null}
      {current ? (
        <div className="space-y-1">
          <p data-testid="objective-text" className="whitespace-pre-wrap">{current.text}</p>
          <p data-testid="objective-revision" className="text-ink-mid">Revision {current.revision}</p>
          {current.pending ? <p data-testid="objective-pending" className="text-hue-waiting">Pending</p> : null}
          {current.disposition === 'failed' ? <p data-testid="objective-failure" role="alert" className="text-hue-error">{current.detail}</p> : null}
          {current.detail && current.disposition !== 'failed' ? <p data-testid="objective-detail" className="text-ink-low">{current.detail}</p> : null}
        </div>
      ) : (
        <p data-testid="objective-empty" className="text-ink-mid">No current objective</p>
      )}
      {previous ? (
        <p data-testid="objective-previous" className="text-ink-low">
          Previous revision {previous.revision}: {previous.text}
        </p>
      ) : null}
      {showNarrower ? (
        <p data-testid="objective-narrower" className="text-ink-mid">
          Narrower than the parent task. The parent task stays open. This does not change plan progress.
        </p>
      ) : null}
      {showPlan ? (
        <p data-testid="objective-plan-task" className="text-ink-mid">
          Plan task: {label}. Source plan-task. Not acceptance criteria.
        </p>
      ) : null}

      <form onSubmit={onSet} className="space-y-2">
        <label className="block text-ink-mid" htmlFor={textFieldId}>Current objective</label>
        <textarea
          id={textFieldId}
          value={draft}
          onChange={event => setDraft(event.target.value)}
          rows={3}
          className="w-full bg-surface-base text-ink-high border border-hairline rounded px-2 py-1"
        />
        <div className="flex flex-wrap gap-2">
          <button type="submit" className="bg-surface-raised hover:bg-surface-hover border border-hairline rounded px-3 py-1">
            Set objective
          </button>
          <button
            type="button"
            data-testid="achieve-objective"
            onClick={() => { void onAchieve() }}
            disabled={!current}
            className="bg-surface-raised hover:bg-surface-hover border border-hairline rounded px-3 py-1 disabled:opacity-50"
          >
            Achieve your objective
          </button>
        </div>
      </form>

      <form onSubmit={onLaunch} aria-label="Launch a worker" className="space-y-2 border-t border-hairline pt-3">
        <h3 className="text-ink-high font-medium">Launch</h3>
        <p data-testid="launch-unclaimed" className="text-ink-low">{T01_PROCESS_UNCLAIMED}</p>
        <label className="block text-ink-mid" htmlFor={projectFieldId}>Project</label>
        <input
          id={projectFieldId}
          value={project}
          onChange={event => setProject(event.target.value)}
          onBlur={() => {
            if (!sessionTouched && project.trim()) setSessionName(suggestSessionName(project))
          }}
          className="w-full bg-surface-base text-ink-high border border-hairline rounded px-2 py-1"
        />
        <label className="block text-ink-mid" htmlFor={launchObjectiveFieldId}>Objective</label>
        <input
          id={launchObjectiveFieldId}
          value={launchObjective}
          onChange={event => setLaunchObjective(event.target.value)}
          className="w-full bg-surface-base text-ink-high border border-hairline rounded px-2 py-1"
        />
        <label className="block text-ink-mid" htmlFor={sessionFieldId}>Session name</label>
        <input
          id={sessionFieldId}
          value={sessionName}
          placeholder={project.trim() ? suggestSessionName(project) : 'optional'}
          onChange={event => {
            setSessionTouched(true)
            setSessionName(event.target.value)
          }}
          className="w-full bg-surface-base text-ink-high border border-hairline rounded px-2 py-1"
        />
        <button type="submit" className="bg-surface-raised hover:bg-surface-hover border border-hairline rounded px-3 py-1">
          Launch
        </button>
        {launch ? (
          <div data-testid="launch-result" className="space-y-1">
            <p data-testid="launch-pending" className="text-hue-waiting">Pending</p>
            <p data-testid="launch-objective-text">{launch.objective}</p>
            <p className="text-ink-low">{launch.detail}</p>
            <p className="text-ink-low">{launch.processClaim}</p>
          </div>
        ) : null}
      </form>
      {notice && notice !== 'Pending' ? <p role="status" className="text-ink-mid">{notice}</p> : null}
      {notice === 'Pending' ? <p role="status" data-testid="objective-notice-pending" className="text-hue-waiting">Pending</p> : null}
    </section>
  )
}
