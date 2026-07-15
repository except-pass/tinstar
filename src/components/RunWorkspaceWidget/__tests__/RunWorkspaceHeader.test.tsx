// @vitest-environment jsdom
//
// U4 (R5, R6, R10, R11): the run-card header leads with the friendly name and
// keeps the raw id reachable — click the title to rename, click the muted id
// line to copy the id.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { RunData } from '../../../domain/types'
import { RunWorkspaceHeader } from '../RunWorkspaceHeader'
import { apiFetch } from '../../../apiClient'

// Optimistic updates land in the shared store, which re-renders the card with a
// fresh `run` prop. The harness below replays that loop so the paint-before-the-
// server-answers behaviour is actually observable in a test.
const { optimisticSink, addOptimistic } = vi.hoisted(() => {
  const sink: { apply: (run: unknown) => void } = { apply: () => {} }
  return {
    optimisticSink: sink,
    addOptimistic: vi.fn((_entity: string, data: unknown) => sink.apply(data)),
  }
})

vi.mock('../../../hooks/useBackendState', () => ({
  useBackendState: () => ({
    taxRepo: {
      getInitiativeForRun: () => null,
      getEpicForRun: () => null,
      getTaskForRun: () => null,
    },
    addOptimistic,
  }),
}))

vi.mock('../../../hotkeys/ConstellationContext', () => ({
  useConstellationContext: () => ({ slotsForNode: () => [], remove: vi.fn() }),
}))

vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../../agentIcon', () => ({
  AgentIcon: () => null,
  isIconUrl: () => false,
}))

const RUN_ID = 'vpppm-general-pourpose-2dc86'

function makeRun(overrides: Partial<RunData> = {}): RunData {
  return {
    id: RUN_ID,
    color: '#ff7700',
    status: 'idle',
    background: false,
    blocked: false,
    sessionId: 'sess-1',
    taskId: 't1',
    initiative: 'init',
    epic: 'epic',
    task: 'task',
    repo: 'repo',
    worktree: 'wt',
    touchedFiles: [],
    recapEntries: [],
    rawLogs: '',
    port: null,
    backend: null,
    ...overrides,
  }
}

/** Renders the header against a live `run` that optimistic updates feed back into. */
function Harness({ initial }: { initial: RunData }) {
  const [run, setRun] = useState(initial)
  optimisticSink.apply = (next: unknown) => setRun(next as RunData)
  return <RunWorkspaceHeader run={run} />
}

const writeText = vi.fn().mockResolvedValue(undefined)

beforeEach(() => {
  vi.mocked(apiFetch).mockClear()
  addOptimistic.mockClear()
  writeText.mockClear()
  optimisticSink.apply = () => {}
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  })
})

/** The JSON body of the most recent apiFetch call — fails loudly if there wasn't one. */
function lastPatchBody(): unknown {
  const calls = vi.mocked(apiFetch).mock.calls
  const last = calls[calls.length - 1]
  if (!last) throw new Error('expected apiFetch to have been called')
  return JSON.parse(String(last[1]?.body))
}

function title() {
  return screen.getByTestId(`run-title-${RUN_ID}`)
}

function idLine() {
  return screen.getByTestId(`run-id-copy-${RUN_ID}`)
}

describe('RunWorkspaceHeader title', () => {
  it('falls back to the run id when the run has no friendly name', () => {
    render(<RunWorkspaceHeader run={makeRun()} />)
    expect(title()).toHaveTextContent(RUN_ID)
  })

  it('renders the friendly name as the title when one is set', () => {
    render(<RunWorkspaceHeader run={makeRun({ name: 'PM Vpp project' })} />)
    expect(title()).toHaveTextContent('PM Vpp project')
    // The id is no longer the headline.
    expect(title()).not.toHaveTextContent(RUN_ID)
  })

  it('renders an empty-string name as the id, not a blank title', () => {
    render(<RunWorkspaceHeader run={makeRun({ name: '' })} />)
    expect(title()).toHaveTextContent(RUN_ID)
  })
})

describe('RunWorkspaceHeader run id line', () => {
  it('shows the raw id whether or not a friendly name is set', () => {
    const { unmount } = render(<RunWorkspaceHeader run={makeRun()} />)
    expect(idLine()).toHaveTextContent(RUN_ID)
    unmount()

    render(<RunWorkspaceHeader run={makeRun({ name: 'PM Vpp project' })} />)
    expect(idLine()).toHaveTextContent(RUN_ID)
  })

  it('copies the id — not the friendly name — to the clipboard on click', async () => {
    render(<RunWorkspaceHeader run={makeRun({ name: 'PM Vpp project' })} />)
    fireEvent.click(idLine())

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(RUN_ID))
    expect(writeText).not.toHaveBeenCalledWith('PM Vpp project')
    // Brief confirmation so the click reads as having done something.
    await screen.findByTestId(`run-id-copied-${RUN_ID}`)
  })
})

describe('RunWorkspaceHeader inline rename', () => {
  it('commits a rename on Enter: PATCHes the run, paints optimistically, leaves the id line alone', async () => {
    render(<Harness initial={makeRun()} />)

    fireEvent.click(title())
    const input = screen.getByTestId(`run-name-input-${RUN_ID}`)
    fireEvent.change(input, { target: { value: 'PM: Vpp project (Q3)' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(apiFetch).toHaveBeenCalledWith(
      `/api/runs/${RUN_ID}`,
      expect.objectContaining({ method: 'PATCH' }),
    )
    const body = lastPatchBody()
    expect(body).toEqual({ name: 'PM: Vpp project (Q3)' })

    // Optimistic — the title repaints without waiting for the SSE echo.
    expect(addOptimistic).toHaveBeenCalledWith('run', expect.objectContaining({ id: RUN_ID, name: 'PM: Vpp project (Q3)' }))
    await waitFor(() => expect(title()).toHaveTextContent('PM: Vpp project (Q3)'))

    // The id is untouched by a rename.
    expect(idLine()).toHaveTextContent(RUN_ID)
  })

  it('commits on blur', () => {
    let now = 1_000
    const nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => now)

    render(<Harness initial={makeRun()} />)

    fireEvent.click(title())
    const input = screen.getByTestId(`run-name-input-${RUN_ID}`)
    fireEvent.change(input, { target: { value: 'Reviewer — dispatch retry' } })
    now = 1_000 + 200 // past the focus-steal grace window
    fireEvent.blur(input)

    const body = lastPatchBody()
    expect(body).toEqual({ name: 'Reviewer — dispatch retry' })
    nowSpy.mockRestore()
  })

  it('submitting an empty name clears it and reverts the title to the id', async () => {
    render(<Harness initial={makeRun({ name: 'PM Vpp project' })} />)

    fireEvent.click(title())
    const input = screen.getByTestId(`run-name-input-${RUN_ID}`)
    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    const body = lastPatchBody()
    expect(body).toEqual({ name: '' })
    expect(addOptimistic).toHaveBeenCalledWith('run', expect.objectContaining({ id: RUN_ID, name: undefined }))
    await waitFor(() => expect(title()).toHaveTextContent(RUN_ID))
  })

  it('Escape cancels: no request, no optimistic update, title unchanged', () => {
    render(<Harness initial={makeRun({ name: 'PM Vpp project' })} />)

    fireEvent.click(title())
    const input = screen.getByTestId(`run-name-input-${RUN_ID}`)
    fireEvent.change(input, { target: { value: 'oops' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.blur(input)

    expect(apiFetch).not.toHaveBeenCalled()
    expect(addOptimistic).not.toHaveBeenCalled()
    expect(title()).toHaveTextContent('PM Vpp project')
  })

  it('does not PATCH when the name is unchanged', () => {
    render(<Harness initial={makeRun({ name: 'PM Vpp project' })} />)

    fireEvent.click(title())
    const input = screen.getByTestId(`run-name-input-${RUN_ID}`)
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(apiFetch).not.toHaveBeenCalled()
    expect(addOptimistic).not.toHaveBeenCalled()
  })

  it('rolls the title back to the prior name when the PATCH is rejected', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ok: false, status: 400 } as Response)
    render(<Harness initial={makeRun({ name: 'PM Vpp project' })} />)

    fireEvent.click(title())
    const input = screen.getByTestId(`run-name-input-${RUN_ID}`)
    fireEvent.change(input, { target: { value: 'Bad rename' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    // Painted optimistically first...
    await waitFor(() => expect(title()).toHaveTextContent('Bad rename'))
    // ...then reverted when the server rejects it, rather than lying.
    await waitFor(() => expect(title()).toHaveTextContent('PM Vpp project'))
  })

  it('overrides the drag-handle select-none so the input is a real text field', () => {
    render(<Harness initial={makeRun()} />)
    fireEvent.click(title())
    const input = screen.getByTestId(`run-name-input-${RUN_ID}`)
    expect(input.className).toMatch(/\bselect-text\b/)
  })

  it('survives a spurious blur right after opening (composer/terminal focus steal)', () => {
    render(<Harness initial={makeRun({ name: 'PM Vpp project' })} />)

    fireEvent.click(title())
    const input = screen.getByTestId(`run-name-input-${RUN_ID}`)
    // Same-tick blur: prompt composer / terminal iframe often steal focus a
    // frame after mount. Must not tear the editor down.
    fireEvent.blur(input)

    expect(screen.getByTestId(`run-name-input-${RUN_ID}`)).toBeInTheDocument()
    expect(apiFetch).not.toHaveBeenCalled()
  })
})
