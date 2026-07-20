// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
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
  dismissCalls: Array<{ id: string; method: string }>
  fitWidget: ReturnType<typeof vi.fn>
  setAnswerResponder(r: (id: string) => Promise<Response>): void
  /** Hold the dismiss response open, to exercise the in-flight guard. */
  setDismissGate(gate: Promise<void>): void
  /** Make the dismiss write succeed but the reload return the PRE-write snapshot,
   *  simulating a reload that raced an in-flight delta. */
  freezeSnapshot(): void
}

function makeApi(notices: Notice[]): Harness {
  const answerCalls: Harness['answerCalls'] = []
  const dismissCalls: Harness['dismissCalls'] = []
  let dismissGate: Promise<void> | null = null
  let frozen = false
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
        // Dismiss / undo: mutate the backing array so the widget's reload after
        // onChanged() reflects the server's new truth, like the real backend.
        const d = path.match(/^\/api\/notices\/([^/]+)\/dismiss$/)
        if (d && (init?.method === 'POST' || init?.method === 'DELETE')) {
          dismissCalls.push({ id: d[1]!, method: init.method })
          if (dismissGate) await dismissGate
          const idx = frozen ? -1 : notices.findIndex(n => n.id === d[1])
          if (idx >= 0) {
            notices[idx] = init.method === 'POST'
              ? { ...notices[idx]!, dismissedAt: 1_700_000_500_000 }
              : { ...notices[idx]!, dismissedAt: undefined }
          }
          return jsonResponse({ ok: true, data: notices[idx] ?? null })
        }
        return jsonResponse({ ok: false }, 404)
      },
    },
  } as unknown as TinstarPluginAPI

  return {
    api, answerCalls, dismissCalls, fitWidget,
    setAnswerResponder: r => { answerResponder = r },
    setDismissGate: g => { dismissGate = g },
    freezeSnapshot: () => { frozen = true },
  }
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

describe('groupByRun — dismissed sinks below live (R24)', () => {
  it('sorts every dismissed notice below every live one, even a dismissed needs-you', () => {
    const groups = groupByRun([
      // A dismissed needs-you would otherwise sort FIRST (needs-you outranks fyi).
      answerableNotice({ id: 'dismissed-needs-you', kind: 'needs-you', dismissedAt: 1_700_000_500_000 }),
      answerableNotice({ id: 'live-fyi', kind: 'fyi' }),
      answerableNotice({ id: 'live-needs-you', kind: 'needs-you' }),
      answerableNotice({ id: 'dismissed-fyi', kind: 'fyi', dismissedAt: 1_700_000_500_000 }),
    ])
    expect(groups[0]!.notices.map(n => n.id)).toEqual([
      'live-needs-you', 'live-fyi', 'dismissed-needs-you', 'dismissed-fyi',
    ])
  })

  it('still orders live notices needs-you-first, newest-amended-first', () => {
    const groups = groupByRun([
      answerableNotice({ id: 'old', kind: 'needs-you', amendedAt: 1 }),
      answerableNotice({ id: 'fyi', kind: 'fyi', amendedAt: 9 }),
      answerableNotice({ id: 'new', kind: 'needs-you', amendedAt: 5 }),
    ])
    expect(groups[0]!.notices.map(n => n.id)).toEqual(['new', 'old', 'fyi'])
  })
})

describe('RoundupWidget — dismissing a notice (R24)', () => {
  it('dismisses via POST, collapses the body, and keeps the card with an undo', async () => {
    const h = makeApi([answerableNotice()])
    const { container } = renderWidget(h)

    // Expand it first so we can prove the body is hidden after dismissing.
    fireEvent.click(await screen.findByText('Deploy or wait?'))
    expect(await screen.findByRole('radio', { name: 'Deploy now' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy())
    expect(h.dismissCalls).toEqual([{ id: 'notice-1', method: 'POST' }])
    // Non-destructive: the card is still on the board, just dimmed + collapsed.
    expect(screen.getByText('Deploy or wait?')).toBeTruthy()
    expect(container.querySelector('[data-testid="notice-notice-1"][data-dismissed="true"]')).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'Deploy now' })).toBeNull()
  })

  it('dismissing does NOT answer the notice (no prompt is delivered to the agent)', async () => {
    const h = makeApi([answerableNotice()])
    renderWidget(h)
    fireEvent.click(await screen.findByRole('button', { name: /Dismiss/ }))
    await waitFor(() => expect(h.dismissCalls).toHaveLength(1))
    expect(h.answerCalls).toHaveLength(0)
  })

  it('undoes a dismissal via DELETE and brings the card back to life', async () => {
    const h = makeApi([answerableNotice({ dismissedAt: 1_700_000_500_000 })])
    const { container } = renderWidget(h)

    fireEvent.click(await screen.findByRole('button', { name: /Undo/ }))

    await waitFor(() => expect(screen.getByRole('button', { name: /Dismiss/ })).toBeTruthy())
    expect(h.dismissCalls).toEqual([{ id: 'notice-1', method: 'DELETE' }])
    expect(container.querySelector('[data-dismissed="true"]')).toBeNull()
  })

  it('renders a dismissed FYI without its Disagree affordance', async () => {
    const fyi: Notice = {
      id: 'fyi-3', runId: 'CLD-run-1', kind: 'fyi', headline: 'Skipped a flaky test',
      createdAt: 1_700_000_000_000, amendedAt: 1_700_000_000_000, dismissedAt: 1_700_000_500_000,
    }
    const h = makeApi([fyi])
    renderWidget(h)
    await screen.findByText('Skipped a flaky test')
    expect(screen.queryByRole('button', { name: 'Disagree' })).toBeNull()
  })

  it('renders dismissed cards after live ones in the DOM', async () => {
    const h = makeApi([
      answerableNotice({ id: 'gone', headline: 'Already handled', dismissedAt: 1_700_000_500_000 }),
      answerableNotice({ id: 'here', headline: 'Still needs you' }),
    ])
    const { container } = renderWidget(h)
    await screen.findByText('Still needs you')
    const ids = [...container.querySelectorAll('[data-testid^="notice-"]')].map(el => el.getAttribute('data-testid'))
    expect(ids).toEqual(['notice-here', 'notice-gone'])
  })

  it('marks a notice untended for over a day as stale, and a fresh one not', async () => {
    const now = Date.now()
    const h = makeApi([
      answerableNotice({ id: 'old', headline: 'Old ask', amendedAt: now - 3 * 24 * 60 * 60 * 1000 }),
      answerableNotice({ id: 'fresh', headline: 'Fresh ask', amendedAt: now - 60_000 }),
    ])
    const { container } = renderWidget(h)
    await screen.findByText('Old ask')
    expect(container.querySelector('[data-testid="notice-old"][data-stale="true"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="notice-fresh"][data-stale="true"]')).toBeNull()
    // The derived age is shown on the card, so old cards read as old.
    expect(screen.getByText('3d ago')).toBeTruthy()
  })
})

describe('RoundupWidget — dismiss hardening', () => {
  it('ignores a second click while a dismiss request is in flight', async () => {
    const h = makeApi([answerableNotice()])
    let release!: () => void
    h.setDismissGate(new Promise<void>(r => { release = r }))
    renderWidget(h)

    const btn = await screen.findByRole('button', { name: /Dismiss/ })
    fireEvent.click(btn)
    // Still pending — a rapid second click must not fire POST-then-DELETE, whose
    // responses could land out of order and leave the stored bit inconsistent.
    fireEvent.click(btn)
    fireEvent.click(btn)
    expect(h.dismissCalls).toHaveLength(1)
    expect((btn as HTMLButtonElement).disabled).toBe(true)

    await act(async () => { release(); await Promise.resolve() })
    await waitFor(() => expect(screen.getByRole('button', { name: /Undo/ })).toBeTruthy())
    expect(h.dismissCalls).toHaveLength(1)
  })

  it('re-enables the control after the request settles, so the next click works', async () => {
    const h = makeApi([answerableNotice()])
    renderWidget(h)

    fireEvent.click(await screen.findByRole('button', { name: /Dismiss/ }))
    const undo = await screen.findByRole('button', { name: /Undo/ })
    await waitFor(() => expect((undo as HTMLButtonElement).disabled).toBe(false))

    fireEvent.click(undo)
    await waitFor(() => expect(screen.getByRole('button', { name: /Dismiss/ })).toBeTruthy())
    expect(h.dismissCalls.map(c => c.method)).toEqual(['POST', 'DELETE'])
  })

  it('does not get stuck optimistic when the reload returns the pre-write snapshot', async () => {
    const h = makeApi([answerableNotice()])
    h.freezeSnapshot() // the write succeeds, but the reload still shows it undismissed
    const { container } = renderWidget(h)

    fireEvent.click(await screen.findByRole('button', { name: /Dismiss/ }))
    await waitFor(() => expect(h.dismissCalls).toHaveLength(1))

    // The override must be released once the reload lands, so the card follows
    // the server's truth. Keyed to `notice.dismissedAt` instead, it would never
    // clear here (that value never changed) and the card would sit dimmed forever.
    await waitFor(() => expect(container.querySelector('[data-dismissed="true"]')).toBeNull())
    expect(await screen.findByRole('button', { name: /Dismiss/ })).toBeTruthy()
  })

  it('emits exactly one opacity class on a card that is both dismissed and old', async () => {
    const h = makeApi([answerableNotice({
      dismissedAt: 1_700_000_500_000,
      amendedAt: Date.now() - 5 * 24 * 60 * 60 * 1000,
    })])
    const { container } = renderWidget(h)
    await screen.findByText('Deploy or wait?')

    const card = container.querySelector('[data-testid="notice-notice-1"]')!
    const opacities = [...card.classList].filter(c => c.startsWith('opacity-'))
    expect(opacities).toEqual(['opacity-50'])
  })

  it('says "nothing needs you" rather than "0 notices" when every card is dismissed', async () => {
    const h = makeApi([answerableNotice({ dismissedAt: 1_700_000_500_000 })])
    renderWidget(h)
    await screen.findByText('Deploy or wait?')
    expect(screen.getByText('nothing needs you · 1 dismissed')).toBeTruthy()
    expect(screen.queryByText(/^0 notices/)).toBeNull()
  })
})

describe('RoundupWidget — staleness ticks on its own', () => {
  it('dims a card that crosses the threshold while the board sits open, with no delta', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const DAY = 24 * 60 * 60 * 1000
      const h = makeApi([answerableNotice({
        id: 'aging', headline: 'Aging ask',
        amendedAt: Date.now() - (DAY - 30_000), // 30s short of stale
      })])
      const { container } = renderWidget(h)
      await screen.findByText('Aging ask')
      expect(container.querySelector('[data-testid="notice-aging"][data-stale="true"]')).toBeNull()

      // Nothing arrives from the server — only time passes.
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000) })

      expect(container.querySelector('[data-testid="notice-aging"][data-stale="true"]')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('clears its tick on unmount', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')
    const h = makeApi([answerableNotice()])
    const { unmount } = renderWidget(h)
    await screen.findByText('Deploy or wait?')
    unmount()
    expect(clearSpy).toHaveBeenCalled()
  })
})
