// @vitest-environment jsdom
//
// S4 U3 — the multi-question workbench. The feature IS the isolation: N grouped
// open-points become N columns, each with its own form, its own POST, and its own
// answered-lock. The tests below are written to fail if any of that leaks — a shared
// draft, a shared submit, or a shared answered flag would all show up as "column B
// changed when I touched column A".
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import type { SlateSurface } from '../../../types'
import type { A2uiContent } from '../../../domain/types'

// apiFetch is the single HTTP seam (never bare fetch — it 404s in Tauri).
const apiFetch = vi.fn()
vi.mock('../../../apiClient', () => ({
  apiFetch: (...args: unknown[]) => apiFetch(...args),
  apiUrl: (p: string) => p,
}))

import { WorkbenchSurface, partitionWorkbenches } from '../WorkbenchSurface'

function ok(data: Record<string, unknown> = { point: {}, delivered: true }) {
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, data }) } as unknown as Response)
}

/** An answerable body: one single-select Choice, one TextInput, one Submit. Option
 *  ids are prefixed per column so a POST body identifies WHICH column submitted. */
function ask(prefix: string): A2uiContent {
  return {
    root: 'root',
    components: [
      { id: 'root', component: 'Column', children: [`${prefix}-choice`, 't', 's'] },
      {
        id: `${prefix}-choice`,
        component: 'Choice',
        mode: 'single',
        options: [
          { id: `${prefix}-yes`, label: 'Yes' },
          { id: `${prefix}-no`, label: 'No' },
        ],
      },
      { id: 't', component: 'TextInput', label: 'Notes' },
      { id: 's', component: 'Submit', label: 'Send' },
    ],
  } as unknown as A2uiContent
}

const prose: A2uiContent = {
  root: 'root',
  components: [{ id: 'root', component: 'Text', text: 'Background only, nothing to answer.' }],
} as unknown as A2uiContent

function q(id: string, extra: Partial<SlateSurface> = {}): SlateSurface {
  return {
    id,
    author: 'agent',
    kind: 'open-point',
    headline: `question ${id}`,
    status: 'open',
    group: 'launch-qs',
    body: ask(id),
    createdAt: 1,
    amendedAt: 1,
    ...extra,
  }
}

/** The answer POSTs this test run made, as [pointId, parsedBody] pairs. */
function answerCalls(): Array<[string, Record<string, unknown>]> {
  return apiFetch.mock.calls
    .filter(([url]) => String(url).endsWith('/answer'))
    .map(([url, init]) => [
      String(url).replace(/^.*\/points\/(.*)\/answer$/, '$1'),
      JSON.parse(String((init as RequestInit).body ?? '{}')) as Record<string, unknown>,
    ])
}

describe('WorkbenchSurface (S4 U3)', () => {
  beforeEach(() => {
    apiFetch.mockReset()
    apiFetch.mockImplementation(() => ok())
  })

  it('renders one column per grouped point inside a single band', () => {
    render(<WorkbenchSurface runId="run-1" group="launch-qs" points={[q('a'), q('b'), q('c')]} />)

    const band = screen.getByTestId('workbench-launch-qs')
    expect(within(band).getByTestId('workbench-column-a')).toBeTruthy()
    expect(within(band).getByTestId('workbench-column-b')).toBeTruthy()
    expect(within(band).getByTestId('workbench-column-c')).toBeTruthy()
    expect(within(band).getByText('question a')).toBeTruthy()
  })

  // #126: the Slate's scroll body is overflow-x-hidden, so a horizontal scrollbar on a
  // child of it is unreachable. The band must own its own scroll AND announce itself to
  // the canvas wheel handler, or the wheel pans the canvas instead of the columns.
  it('the band is its own data-scrollable horizontal scroller', () => {
    render(<WorkbenchSurface runId="run-1" group="launch-qs" points={[q('a'), q('b')]} />)

    const scroller = screen.getByTestId('workbench-scroller-launch-qs')
    expect(scroller.hasAttribute('data-scrollable')).toBe(true)
    expect(scroller.className).toContain('overflow-x-auto')
    // Columns hold their width and wrap long tokens internally rather than pushing the
    // panel itself sideways.
    const col = screen.getByTestId('workbench-column-a')
    expect(col.className).toContain('shrink-0')
    expect(col.className).toContain('[overflow-wrap:anywhere]')
  })

  it('submitting one column POSTs only that point — its sibling is untouched', async () => {
    render(<WorkbenchSurface runId="run-1" group="launch-qs" points={[q('a'), q('b')]} />)

    const colA = screen.getByTestId('workbench-column-a')
    fireEvent.click(within(colA).getByRole('radio', { name: 'Yes' }))
    fireEvent.change(within(colA).getByRole('textbox'), { target: { value: 'ship it' } })
    fireEvent.click(within(colA).getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(answerCalls()).toHaveLength(1))
    expect(answerCalls()[0]).toEqual(['a', { choices: ['a-yes'], text: 'ship it' }])
    expect(apiFetch).toHaveBeenCalledWith(
      '/api/runs/run-1/slate/points/a/answer',
      expect.objectContaining({ method: 'POST' }),
    )

    // Column B never fired, and its draft never picked up A's text — the surface-scoped
    // form state is what would break this, which is why each column owns its own.
    const colB = screen.getByTestId('workbench-column-b')
    expect(answerCalls().some(([id]) => id === 'b')).toBe(false)
    expect((within(colB).getByRole('textbox') as HTMLTextAreaElement).value).toBe('')
    expect((within(colB).getByRole('radio', { name: 'Yes' }) as HTMLInputElement).disabled).toBe(false)
  })

  it('an answered column locks and shows ✓ Answered while its sibling stays open', async () => {
    render(<WorkbenchSurface runId="run-1" group="launch-qs" points={[q('a'), q('b')]} />)

    const colA = screen.getByTestId('workbench-column-a')
    fireEvent.click(within(colA).getByRole('radio', { name: 'Yes' }))
    fireEvent.click(within(colA).getByRole('button', { name: 'Send' }))

    await waitFor(() => expect(within(colA).getByText(/answered/i)).toBeTruthy())
    expect(screen.getByTestId('workbench-column-a').getAttribute('data-answered')).toBe('true')
    expect((within(colA).getByRole('radio', { name: 'Yes' }) as HTMLInputElement).disabled).toBe(true)

    const colB = screen.getByTestId('workbench-column-b')
    expect(colB.getAttribute('data-answered')).toBeNull()
    expect(within(colB).getByRole('button', { name: 'Send' })).toBeTruthy()
    expect((within(colB).getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('submitting with neither a choice nor a note errors and never POSTs', async () => {
    render(<WorkbenchSurface runId="run-1" group="launch-qs" points={[q('a'), q('b')]} />)

    const colA = screen.getByTestId('workbench-column-a')
    fireEvent.click(within(colA).getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(screen.getByTestId('workbench-error-a').textContent).toMatch(/pick an option/i),
    )
    expect(answerCalls()).toHaveLength(0)
    // The guard is per-column: B has no error of its own.
    expect(screen.queryByTestId('workbench-error-b')).toBeNull()
  })

  it('the progress count reads M of N and increments as a column is answered', async () => {
    render(
      <WorkbenchSurface
        runId="run-1"
        group="launch-qs"
        // `waiting` = the thread already ends with the user's reply, i.e. durably answered.
        points={[q('a'), q('b'), q('c', { status: 'waiting' })]}
      />,
    )

    expect(screen.getByTestId('workbench-progress-launch-qs').textContent).toBe('1 of 3 answered')

    const colA = screen.getByTestId('workbench-column-a')
    fireEvent.click(within(colA).getByRole('radio', { name: 'Yes' }))
    fireEvent.click(within(colA).getByRole('button', { name: 'Send' }))

    await waitFor(() =>
      expect(screen.getByTestId('workbench-progress-launch-qs').textContent).toBe('2 of 3 answered'),
    )
  })

  it('a column with a prose-only body renders read-only — no submit', () => {
    render(
      <WorkbenchSurface runId="run-1" group="launch-qs" points={[q('a'), q('b', { body: prose })]} />,
    )

    const colB = screen.getByTestId('workbench-column-b')
    expect(within(colB).getByText(/background only/i)).toBeTruthy()
    expect(screen.getByTestId('workbench-readonly-b')).toBeTruthy()
    expect(within(colB).queryByRole('button', { name: 'Send' })).toBeNull()
    // The answerable sibling still has its controls — read-only is per column.
    expect(within(screen.getByTestId('workbench-column-a')).getByRole('button', { name: 'Send' })).toBeTruthy()
  })
})

describe('partitionWorkbenches (S4)', () => {
  const row = (id: string, extra: Partial<SlateSurface> = {}): SlateSurface => ({
    id, author: 'agent', kind: 'open-point', headline: id, status: 'open',
    createdAt: 1, amendedAt: 1, ...extra,
  })

  it('splits grouped sets out of the ungrouped rows', () => {
    const { groups, ungrouped } = partitionWorkbenches([
      row('r1'),
      row('g1', { group: 'set-a', createdAt: 2 }),
      row('r2'),
      row('g2', { group: 'set-a', createdAt: 3 }),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.group).toBe('set-a')
    expect(groups[0]!.points.map((s) => s.id)).toEqual(['g1', 'g2'])
    expect(ungrouped.map((s) => s.id)).toEqual(['r1', 'r2'])
  })

  it('a LONE grouped point stays an ordinary row, in its original position', () => {
    const { groups, ungrouped } = partitionWorkbenches([
      row('r1'),
      row('solo', { group: 'set-a' }),
      row('r2'),
    ])
    expect(groups).toHaveLength(0)
    expect(ungrouped.map((s) => s.id)).toEqual(['r1', 'solo', 'r2'])
  })

  it('orders sets by their earliest member, so a set holds its first question’s slot', () => {
    const { groups } = partitionWorkbenches([
      row('b1', { group: 'later', createdAt: 50 }),
      row('a1', { group: 'earlier', createdAt: 10 }),
      row('b2', { group: 'later', createdAt: 60 }),
      row('a2', { group: 'earlier', createdAt: 90 }),
    ])
    expect(groups.map((g) => g.group)).toEqual(['earlier', 'later'])
  })

  it('treats a whitespace-only group as ungrouped', () => {
    const { groups, ungrouped } = partitionWorkbenches([
      row('a', { group: '  ' }),
      row('b', { group: '  ' }),
    ])
    expect(groups).toHaveLength(0)
    expect(ungrouped.map((s) => s.id)).toEqual(['a', 'b'])
  })
})
