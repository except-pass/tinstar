// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import type { TinstarPluginAPI, WidgetProps } from '@tinstar/plugin-api'
import type { ComponentType } from 'react'
import type { Notice } from '../../../../domain/types'
import { makeRoundupWidget, runNodeId, groupByRun, askThread, isAwaitingReply, SHIMMER_MAX_MS } from '../RoundupWidget'
import { UNIVERSAL_FOLLOW_UPS } from '../a2ui/followUps'

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
  repliesCalls: Array<{ id: string; body: { presetId?: string; text?: string; author?: string } }>
  fitWidget: ReturnType<typeof vi.fn>
  setAnswerResponder(r: (id: string) => Promise<Response>): void
  setRepliesResponder(r: () => Promise<Response>): void
  /** Hold the dismiss response open, to exercise the in-flight guard. */
  setDismissGate(gate: Promise<void>): void
  /** Make the dismiss write succeed but the reload return the PRE-write snapshot,
   *  simulating a reload that raced an in-flight delta. */
  freezeSnapshot(): void
}

function makeApi(notices: Notice[]): Harness {
  const answerCalls: Harness['answerCalls'] = []
  const dismissCalls: Harness['dismissCalls'] = []
  const repliesCalls: Harness['repliesCalls'] = []
  let dismissGate: Promise<void> | null = null
  let frozen = false
  const fitWidget = vi.fn()
  let answerResponder = async (_id: string): Promise<Response> => jsonResponse({ ok: true, data: { delivered: false } })
  let repliesResponder: (() => Promise<Response>) | null = null

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
        // Follow-up thread: append to the backing notice so the widget's reload
        // after onChanged() sees the server's new truth, like the real backend.
        const r = path.match(/^\/api\/notices\/([^/]+)\/replies$/)
        if (r && init?.method === 'POST') {
          const body = JSON.parse(init.body as string)
          repliesCalls.push({ id: r[1]!, body })
          if (repliesResponder) return repliesResponder()
          const idx = notices.findIndex(n => n.id === r[1])
          if (idx >= 0) {
            const text = body.presetId
              ? (UNIVERSAL_FOLLOW_UPS.find(p => p.id === body.presetId)?.question ?? body.presetId)
              : body.text
            notices[idx] = {
              ...notices[idx]!,
              followUps: [...(notices[idx]!.followUps ?? []),
                { id: `fu-${repliesCalls.length}`, author: 'user', text, createdAt: Date.now() }],
            }
          }
          return jsonResponse({ ok: true, data: { notice: notices[idx] ?? null, delivered: true } })
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
    api, answerCalls, dismissCalls, repliesCalls, fitWidget,
    setAnswerResponder: r => { answerResponder = r },
    setRepliesResponder: r => { repliesResponder = r },
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

describe('askThread / isAwaitingReply', () => {
  it('appends optimistic questions after the persisted thread', () => {
    const n = answerableNotice({ followUps: [{ id: 'a', author: 'agent', text: 'hi', createdAt: 1 }] })
    const out = askThread(n, [{ id: 'p', author: 'user', text: 'why?', createdAt: 2 }])
    expect(out.map(m => m.text)).toEqual(['hi', 'why?'])
  })

  it('shimmers only while the last word is the user\'s', () => {
    expect(isAwaitingReply([])).toBe(false)
    expect(isAwaitingReply([{ id: 'a', author: 'user', text: 'q', createdAt: 1 }])).toBe(true)
    expect(isAwaitingReply([
      { id: 'a', author: 'user', text: 'q', createdAt: 1 },
      { id: 'b', author: 'agent', text: 'a', createdAt: 2 },
    ])).toBe(false)
  })
})

// The ask panel (U6). Its placement is the point: a compact secondary surface, not
// part of the notice body, so a long thread never grows the card.
describe('RoundupWidget — asking a follow-up (U6)', () => {
  it('offers the ask panel on every notice, collapsed, without expanding the body', async () => {
    const h = makeApi([answerableNotice()])
    renderWidget(h)
    // Present before anything is expanded, and it is NOT inside the body — the
    // body's controls stay hidden until the card is expanded.
    expect(await screen.findByTestId('ask-toggle-notice-1')).toBeTruthy()
    expect(screen.queryByRole('radio', { name: 'Deploy now' })).toBeNull()
    // Collapsed: no chips, no input.
    expect(screen.queryByTestId('followup-chip-simplify')).toBeNull()
    expect(screen.queryByTestId('ask-input-notice-1')).toBeNull()
  })

  it('shows the universal presets — including "Simplify your explanation" — on a notice that declared none', async () => {
    const h = makeApi([answerableNotice()])
    renderWidget(h)
    fireEvent.click(await screen.findByTestId('ask-toggle-notice-1'))

    for (const p of UNIVERSAL_FOLLOW_UPS) {
      expect(screen.getByTestId(`followup-chip-${p.id}`)).toBeTruthy()
    }
    expect(screen.getByText('Simplify your explanation')).toBeTruthy()
  })

  it('also shows the agent-declared follow-ups, after the universal set', async () => {
    const notice = answerableNotice({
      content: {
        root: 'root',
        components: [
          { id: 'root', component: 'Column', children: ['t', 'fu'] },
          { id: 't', component: 'Text', text: 'body' },
          { id: 'fu', component: 'FollowUp', label: 'How long is the rollback?', question: 'How long would a rollback take?' },
        ],
      },
    })
    const h = makeApi([notice])
    renderWidget(h)
    fireEvent.click(await screen.findByTestId('ask-toggle-notice-1'))
    expect(screen.getByTestId('followup-chip-fu')).toBeTruthy()
    expect(screen.getByText('How long is the rollback?')).toBeTruthy()
  })

  it('a FollowUp declaration renders nothing in the notice body — it belongs to the panel', async () => {
    const notice = answerableNotice({
      content: {
        root: 'root',
        components: [
          { id: 'root', component: 'Column', children: ['t', 'fu'] },
          { id: 't', component: 'Text', text: 'the body prose' },
          { id: 'fu', component: 'FollowUp', label: 'Declared chip', question: 'q?' },
        ],
      },
    })
    const h = makeApi([notice])
    renderWidget(h)
    fireEvent.click(await screen.findByText('Deploy or wait?')) // expand the body
    await screen.findByText('the body prose')
    // The declaration is known to the catalog, so it draws neither a chip nor an
    // "unsupported component" warning inline.
    expect(screen.queryByText('Declared chip')).toBeNull()
    expect(screen.queryByText(/unsupported/i)).toBeNull()
  })

  it('posts a preset question as the user and shows it on the thread immediately', async () => {
    const h = makeApi([answerableNotice()])
    renderWidget(h)
    fireEvent.click(await screen.findByTestId('ask-toggle-notice-1'))
    fireEvent.click(screen.getByTestId('followup-chip-simplify'))

    const simplify = UNIVERSAL_FOLLOW_UPS.find(p => p.id === 'simplify')!
    // Optimistic: the question is on the thread before the round trip settles.
    await waitFor(() => expect(screen.getByText(simplify.question)).toBeTruthy())
    await waitFor(() => expect(h.repliesCalls).toHaveLength(1))
    expect(h.repliesCalls[0]).toEqual({ id: 'notice-1', body: { presetId: 'simplify', author: 'user' } })
  })

  it('posts freeform text and clears the input on success', async () => {
    const h = makeApi([answerableNotice()])
    renderWidget(h)
    fireEvent.click(await screen.findByTestId('ask-toggle-notice-1'))

    const input = screen.getByTestId('ask-input-notice-1') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'what does flaky mean here?' } })
    fireEvent.click(screen.getByRole('button', { name: 'Ask' }))

    await waitFor(() => expect(h.repliesCalls).toHaveLength(1))
    expect(h.repliesCalls[0]!.body).toEqual({ text: 'what does flaky mean here?', author: 'user' })
    await waitFor(() => expect((screen.getByTestId('ask-input-notice-1') as HTMLInputElement).value).toBe(''))
  })

  it('shimmers "agent is replying…" while the last message is the user\'s', async () => {
    const h = makeApi([answerableNotice()])
    renderWidget(h)
    fireEvent.click(await screen.findByTestId('ask-toggle-notice-1'))
    fireEvent.click(screen.getByTestId('followup-chip-why'))

    await waitFor(() => expect(screen.getByTestId('ask-awaiting-open-notice-1')).toBeTruthy())
  })

  it('shows the shimmer while collapsed too, so a pending answer is visible at a glance', async () => {
    const h = makeApi([answerableNotice({
      followUps: [{ id: 'fu-1', author: 'user', text: 'why?', createdAt: Date.now() }],
    })])
    renderWidget(h)
    expect(await screen.findByTestId('ask-awaiting-notice-1')).toBeTruthy()
  })

  it('stops shimmering once the agent has replied', async () => {
    const h = makeApi([answerableNotice({
      followUps: [
        { id: 'fu-1', author: 'user', text: 'why?', createdAt: 1 },
        { id: 'fu-2', author: 'agent', text: 'because CI is blocked', createdAt: 2 },
      ],
    })])
    renderWidget(h)
    await screen.findByTestId('ask-toggle-notice-1')
    expect(screen.queryByTestId('ask-awaiting-notice-1')).toBeNull()
  })

  it('reverts the optimistic question and surfaces an error when the ask fails', async () => {
    const h = makeApi([answerableNotice()])
    h.setRepliesResponder(async () => jsonResponse({ ok: false, error: { message: 'nope' } }, 500))
    renderWidget(h)
    fireEvent.click(await screen.findByTestId('ask-toggle-notice-1'))
    fireEvent.click(screen.getByTestId('followup-chip-why'))

    const why = UNIVERSAL_FOLLOW_UPS.find(p => p.id === 'why')!
    await waitFor(() => expect(screen.getByText('Could not send your question. Try again.')).toBeTruthy())
    // Cleanly reverted: no ghost message, and no shimmer for a reply that isn't coming.
    expect(screen.queryByText(why.question)).toBeNull()
    expect(screen.queryByTestId('ask-awaiting-open-notice-1')).toBeNull()
  })

  it('says so when the question persisted but the session was unreachable', async () => {
    const h = makeApi([answerableNotice()])
    h.setRepliesResponder(async () => jsonResponse({ ok: true, data: { delivered: false } }))
    renderWidget(h)
    fireEvent.click(await screen.findByTestId('ask-toggle-notice-1'))
    fireEvent.click(screen.getByTestId('followup-chip-why'))

    await waitFor(() => expect(screen.getByText(/isn't reachable right now/)).toBeTruthy())
  })

  it('renders a persisted thread with both authors', async () => {
    const h = makeApi([answerableNotice({
      followUps: [
        { id: 'fu-1', author: 'user', text: 'explain plainly?', createdAt: 1 },
        { id: 'fu-2', author: 'agent', text: 'in plain words: …', createdAt: 2 },
      ],
    })])
    renderWidget(h)
    fireEvent.click(await screen.findByTestId('ask-toggle-notice-1'))
    expect(screen.getByText('explain plainly?')).toBeTruthy()
    expect(screen.getByText('in plain words: …')).toBeTruthy()
  })

  it('hides the ask panel on a dismissed notice — it is off the plate', async () => {
    const h = makeApi([answerableNotice({ dismissedAt: 1_700_000_500_000 })])
    renderWidget(h)
    await screen.findByText('Deploy or wait?')
    expect(screen.queryByTestId('ask-toggle-notice-1')).toBeNull()
  })
})

// A shimmer claims an answer is ON ITS WAY. These are the two cases where that
// claim is false, and rendering it anyway is a lie the user is meant to trust.
describe('RoundupWidget — the shimmer never promises a reply that is not coming', () => {
  it('suppresses the shimmer when the question persisted but reached nobody', async () => {
    const h = makeApi([answerableNotice()])
    h.setRepliesResponder(async () => jsonResponse({ ok: true, data: { delivered: false } }))
    renderWidget(h)
    fireEvent.click(await screen.findByTestId('ask-toggle-notice-1'))
    fireEvent.click(screen.getByTestId('followup-chip-why'))

    // The "not reachable" note appears...
    await waitFor(() => expect(screen.getByText(/isn't reachable right now/)).toBeTruthy())
    // ...and the contradictory "agent is replying…" does NOT, in either position.
    expect(screen.queryByTestId('ask-awaiting-open-notice-1')).toBeNull()
    fireEvent.click(screen.getByTestId('ask-toggle-notice-1')) // collapse
    expect(screen.queryByTestId('ask-awaiting-notice-1')).toBeNull()
  })

  it('clears the undelivered state on the next ask, so a retry shimmers again', async () => {
    const h = makeApi([answerableNotice()])
    h.setRepliesResponder(async () => jsonResponse({ ok: true, data: { delivered: false } }))
    renderWidget(h)
    fireEvent.click(await screen.findByTestId('ask-toggle-notice-1'))
    fireEvent.click(screen.getByTestId('followup-chip-why'))
    await waitFor(() => expect(screen.getByText(/isn't reachable right now/)).toBeTruthy())

    // Session is back; asking again must be optimistic once more.
    h.setRepliesResponder(async () => jsonResponse({ ok: true, data: { delivered: true } }))
    fireEvent.click(screen.getByTestId('followup-chip-background'))
    await waitFor(() => expect(screen.getByTestId('ask-awaiting-open-notice-1')).toBeTruthy())
  })

  it('stops shimmering for a question the agent simply never answered', async () => {
    // Delivered fine, but it has been outstanding well past the give-up window —
    // an unbounded shimmer would still be pulsing here, forever.
    const h = makeApi([answerableNotice({
      followUps: [{ id: 'fu-1', author: 'user', text: 'why?', createdAt: Date.now() - (SHIMMER_MAX_MS + 60_000) }],
    })])
    renderWidget(h)
    await screen.findByTestId('ask-toggle-notice-1')
    expect(screen.queryByTestId('ask-awaiting-notice-1')).toBeNull()
    // The question itself is still there — that is the honest rendering.
    fireEvent.click(screen.getByTestId('ask-toggle-notice-1'))
    expect(screen.getByText('why?')).toBeTruthy()
  })

  it('isAwaitingReply times out on its own once `now` is supplied', () => {
    const t = 1_700_000_000_000
    const thread = [{ id: 'a', author: 'user' as const, text: 'q', createdAt: t }]
    expect(isAwaitingReply(thread, t + 1_000)).toBe(true)
    expect(isAwaitingReply(thread, t + SHIMMER_MAX_MS)).toBe(true)
    expect(isAwaitingReply(thread, t + SHIMMER_MAX_MS + 1)).toBe(false)
    // Omitting `now` keeps the pure last-author reading.
    expect(isAwaitingReply(thread)).toBe(true)
  })
})
