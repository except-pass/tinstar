// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import type { ComponentType } from 'react'
import type { Notice } from '../../../../domain/types'
import { makeRoundupWidget, runNodeId, groupByRun } from '../RoundupWidget'

afterEach(() => vi.restoreAllMocks())

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A needs-you notice with a single-select choice + submit (answerable). */
function answerableNotice(over: Partial<Notice> = {}): Notice {
  return {
    id: 'notice-1',
    runId: 'CLD-run-1',
    kind: 'needs-you',
    headline: 'Deploy or wait?',
    content: {
      root: 'root',
      components: [
        { id: 'root', component: 'Column', children: ['choice', 'go'] },
        { id: 'choice', component: 'Choice', mode: 'single', options: [{ id: 'opt-a', label: 'Deploy now' }, { id: 'opt-b', label: 'Wait' }] },
        { id: 'go', component: 'Submit', label: 'Submit' },
      ],
    },
    createdAt: 1_700_000_000_000,
    amendedAt: 1_700_000_000_000,
    ...over,
  }
}

interface Harness {
  api: TinstarPluginAPI
  answerCalls: Array<{ id: string; body: { choices?: string[]; text?: string; dissent?: boolean } }>
  fitWidget: ReturnType<typeof vi.fn>
  setAnswerResponder(r: (id: string) => Promise<Response>): void
}

function makeApi(notices: Notice[]): Harness {
  const answerCalls: Harness['answerCalls'] = []
  const fitWidget = vi.fn()
  let answerResponder = async (_id: string): Promise<Response> => jsonResponse({ ok: true, data: { delivered: false } })

  const api = {
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    canvas: { fitWidget },
    events: { subscribe: () => ({ dispose() {} }) },
    http: {
      async fetch(path: string, init?: RequestInit): Promise<Response> {
        if (path === '/api/notices' && !init) return jsonResponse({ ok: true, data: notices })
        if (path === '/api/state') return jsonResponse({ runs: [{ id: 'CLD-run-1', name: 'My Run' }] })
        const m = path.match(/^\/api\/notices\/([^/]+)\/answer$/)
        if (m && init?.method === 'POST') {
          answerCalls.push({ id: m[1]!, body: JSON.parse(init.body as string) })
          return answerResponder(m[1]!)
        }
        return jsonResponse({ ok: false }, 404)
      },
    },
  } as unknown as TinstarPluginAPI

  return { api, answerCalls, fitWidget, setAnswerResponder: r => { answerResponder = r } }
}

function renderWidget(h: Harness) {
  const Widget = makeRoundupWidget(h.api) as ComponentType<WidgetProps>
  return render(<Widget {...({} as WidgetProps)} />)
}

describe('runNodeId (U5/R12)', () => {
  it('prefixes the run id with "run-" for the canvas node', () => {
    expect(runNodeId('CLD-run-1')).toBe('run-CLD-run-1')
  })
})

describe('groupByRun', () => {
  it('keeps needs-you ahead of fyi within a run', () => {
    const groups = groupByRun([
      answerableNotice({ id: 'a', kind: 'fyi' }),
      answerableNotice({ id: 'b', kind: 'needs-you' }),
    ])
    expect(groups[0]!.notices.map(n => n.id)).toEqual(['b', 'a'])
  })
})

describe('RoundupWidget — answering a needs-you notice (U3)', () => {
  it('submits the collected choice and shows answered optimistically', async () => {
    const h = makeApi([answerableNotice()])
    renderWidget(h)

    // Expand the notice, pick an option, submit.
    fireEvent.click(await screen.findByText('Deploy or wait?'))
    fireEvent.click(await screen.findByRole('radio', { name: 'Deploy now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    // R23: answered appears immediately; the POST carried the selected choice.
    await waitFor(() => expect(screen.getByText('✓ Answered')).toBeTruthy())
    expect(h.answerCalls).toHaveLength(1)
    expect(h.answerCalls[0]!.body.choices).toEqual(['opt-a'])
  })

  it('keeps multiple choice groups independent (a single-select in one does not wipe the other)', async () => {
    const twoGroups = answerableNotice({
      content: {
        root: 'root',
        components: [
          { id: 'root', component: 'Column', children: ['g1', 'g2', 'go'] },
          { id: 'g1', component: 'Choice', mode: 'single', options: [{ id: 'a1', label: 'A one' }, { id: 'a2', label: 'A two' }] },
          { id: 'g2', component: 'Choice', mode: 'single', options: [{ id: 'b1', label: 'B one' }, { id: 'b2', label: 'B two' }] },
          { id: 'go', component: 'Submit', label: 'Submit' },
        ],
      },
    })
    const h = makeApi([twoGroups])
    renderWidget(h)

    fireEvent.click(await screen.findByText('Deploy or wait?'))
    fireEvent.click(await screen.findByRole('radio', { name: 'A one' }))
    fireEvent.click(await screen.findByRole('radio', { name: 'B two' })) // must NOT clear group 1
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    await waitFor(() => expect(screen.getByText('✓ Answered')).toBeTruthy())
    expect([...h.answerCalls[0]!.body.choices!].sort()).toEqual(['a1', 'b2'])
  })

  it('shows the answered state before the server responds (optimistic)', async () => {
    const h = makeApi([answerableNotice()])
    let release!: (r: Response) => void
    h.setAnswerResponder(() => new Promise<Response>(res => { release = r => res(r) }))
    renderWidget(h)

    fireEvent.click(await screen.findByText('Deploy or wait?'))
    fireEvent.click(await screen.findByRole('radio', { name: 'Wait' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    // Answered shows while the answer request is still pending (not yet released).
    await waitFor(() => expect(screen.getByText('✓ Answered')).toBeTruthy())
    release(jsonResponse({ ok: true, data: { delivered: false } }))
  })

  it('reverts the optimistic answered state and surfaces an error on a failed submit', async () => {
    const h = makeApi([answerableNotice()])
    h.setAnswerResponder(async () => jsonResponse({ ok: false, error: { code: 'INTERNAL', message: 'boom' } }, 500))
    renderWidget(h)

    fireEvent.click(await screen.findByText('Deploy or wait?'))
    fireEvent.click(await screen.findByRole('radio', { name: 'Deploy now' }))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))

    // The optimistic "answered" reverts: the Submit button returns and an error shows.
    await waitFor(() => expect(screen.getByText(/Could not deliver your answer/)).toBeTruthy())
    expect(screen.queryByText('✓ Answered')).toBeNull()
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy()
  })

  it('blocks an empty submit (no choice, no text) with a hint and posts nothing', async () => {
    const h = makeApi([answerableNotice()])
    renderWidget(h)
    fireEvent.click(await screen.findByText('Deploy or wait?'))
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }))
    await waitFor(() => expect(screen.getByText(/Pick an option or add a note/)).toBeTruthy())
    expect(h.answerCalls).toHaveLength(0)
  })

  it('reflects a server-persisted answer as answered after a reload (no double-submit)', async () => {
    const h = makeApi([answerableNotice({ answer: { choices: ['opt-a'], answeredAt: 2 } })])
    renderWidget(h)
    fireEvent.click(await screen.findByText('Deploy or wait?'))
    // Already answered from the store → confirmation shown, no submit button.
    await waitFor(() => expect(screen.getByText('✓ Answered')).toBeTruthy())
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull()
  })
})

describe('RoundupWidget — FYI dissent (U4/R13, covers AE2)', () => {
  it('delivers a dissent when the user disagrees; the affordance is FYI-only', async () => {
    const fyi: Notice = {
      id: 'fyi-1', runId: 'CLD-run-1', kind: 'fyi',
      headline: 'Skipped a flaky e2e test on CI',
      createdAt: 1_700_000_000_000, amendedAt: 1_700_000_000_000,
    }
    const h = makeApi([fyi])
    renderWidget(h)

    // Headline-only FYI shows the Disagree affordance without expanding.
    fireEvent.click(await screen.findByRole('button', { name: 'Disagree' }))
    fireEvent.change(screen.getByPlaceholderText('What do you disagree with?'), {
      target: { value: 'that test caught a real bug last week' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Send objection' }))

    await waitFor(() => expect(screen.getByText('✓ Objection sent')).toBeTruthy())
    expect(h.answerCalls).toHaveLength(1)
    expect(h.answerCalls[0]!.body).toEqual({ dissent: true, text: 'that test caught a real bug last week' })
  })

  it('does nothing when the user does not dissent (silence is consent)', async () => {
    const fyi: Notice = {
      id: 'fyi-2', runId: 'CLD-run-1', kind: 'fyi', headline: 'Chose Postgres over SQLite',
      createdAt: 1_700_000_000_000, amendedAt: 1_700_000_000_000,
    }
    const h = makeApi([fyi])
    renderWidget(h)
    await screen.findByText('Chose Postgres over SQLite')
    expect(h.answerCalls).toHaveLength(0)
  })

  it('does not show a Disagree affordance on a needs-you notice', async () => {
    const h = makeApi([answerableNotice()])
    renderWidget(h)
    fireEvent.click(await screen.findByText('Deploy or wait?'))
    expect(screen.queryByRole('button', { name: 'Disagree' })).toBeNull()
  })
})

describe('RoundupWidget — viewport jump (U5/R12)', () => {
  it('pans the canvas to the run card via fitWidget("run-<runId>")', async () => {
    const h = makeApi([answerableNotice()])
    renderWidget(h)
    fireEvent.click(await screen.findByRole('button', { name: /jump/ }))
    expect(h.fitWidget).toHaveBeenCalledWith('run-CLD-run-1')
  })
})
