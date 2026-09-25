// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NeedsYouRail, type NeedsYouHttp, type RailSubmitIntent } from '../NeedsYouRail'
import {
  blockedFixture,
  contradictionFixture,
  decisionFixture,
  driftFixture,
  failureFixture,
  needsYouFixtures,
  reviewFixture,
} from '../fixtures'
import type { InboxSubmission } from '../model'
import { registerNeedsYouRoutes } from '../../../server/v6/needsyou/routes'

function queued(over: Partial<InboxSubmission> = {}): InboxSubmission {
  return {
    requestId: 'req-1',
    noteId: 'note-1',
    disposition: 'queued',
    applied: false,
    detail: 'queued',
    ...over,
  }
}

function regions(id: string): string[] {
  const card = document.querySelector(`[data-testid="needsyou-card-${id}"]`)
  if (!card) return []
  return [...card.querySelectorAll('[data-region]')].map(node => node.getAttribute('data-region') ?? '')
}

describe('NeedsYouRail fixtures', () => {
  it('renders six labeled types in one queue, matching within a type', () => {
    const second = decisionFixture({
      id: 'ny-decision-b',
      headline: 'Second decision, same shape',
      revision: 'rev-decision-b',
      payload: {
        ...(decisionFixture().payload as Record<string, unknown>),
        options: [
          { id: 'ship', label: 'Ship it', gain: 'Done', cost: 'A follow-up', wrongIf: 'The diff is wrong' },
          { id: 'hold', label: 'Hold', gain: 'Another read', cost: 'The slot slips', wrongIf: 'Waiting was the drift' },
        ],
      },
    })
    render(<NeedsYouRail items={[...needsYouFixtures(), second]} />)

    expect(screen.getAllByTestId('needsyou-rail')).toHaveLength(1)
    const rail = screen.getByTestId('needsyou-rail')
    for (const fixture of needsYouFixtures()) {
      const id = String(fixture.id)
      const card = screen.getByTestId(`needsyou-card-${id}`)
      expect(rail.contains(card)).toBe(true)
      expect(card.getAttribute('data-fixture')).toBe('true')
      expect(within(card).getByTestId('needsyou-fixture')).toHaveTextContent('fixture')
      expect(card.getAttribute('data-layout')).toBe(fixture.type)
      expect(card.getAttribute('data-icon')).toBe(fixture.type)
    }

    const icons = needsYouFixtures().map(fixture => (
      screen.getByTestId(`needsyou-card-${String(fixture.id)}`).getAttribute('data-icon')
    ))
    expect(new Set(icons).size).toBe(6)
    const components = needsYouFixtures().map(fixture => (
      screen.getByTestId(`needsyou-card-${String(fixture.id)}`).getAttribute('data-component')
    ))
    expect(components).toEqual([
      'DecisionCard',
      'BlockedCard',
      'FailureCard',
      'ScheduleDriftCard',
      'ContradictionCard',
      'ReviewReadyCard',
    ])
    expect(regions('ny-decision')).toEqual(regions('ny-decision-b'))
    expect(regions('ny-decision')).not.toEqual(regions('ny-blocked'))
    expect(regions('ny-blocked')).not.toEqual(regions('ny-failure'))
    expect(regions('ny-failure')).not.toEqual(regions('ny-drift'))
    expect(regions('ny-drift')).not.toEqual(regions('ny-contradiction'))
    expect(regions('ny-contradiction')).not.toEqual(regions('ny-review'))

    const decision = screen.getByTestId('needsyou-card-ny-decision')
    expect(within(decision).getByRole('button', { name: 'Keep one queue' })).toBeTruthy()
    expect(within(decision).getByRole('button', { name: 'Split reviews out' })).toBeTruthy()
    expect(within(decision).getByRole('button', { name: 'Defer the call' })).toBeTruthy()
    expect(within(screen.getByTestId('needsyou-card-ny-blocked')).getByRole('button', { name: 'Supply' })).toBeTruthy()
    expect(within(screen.getByTestId('needsyou-card-ny-failure')).getByRole('button', { name: 'Retry' })).toBeTruthy()
    expect(within(screen.getByTestId('needsyou-card-ny-drift')).getByRole('button', { name: 'Acknowledge' })).toBeTruthy()
    expect(within(screen.getByTestId('needsyou-card-ny-contradiction')).getByRole('button', { name: 'Compare' })).toBeTruthy()
    expect(within(screen.getByTestId('needsyou-card-ny-review')).getByRole('link', { name: 'Open pull request' })).toBeTruthy()
    expect(screen.getByTestId('needsyou-origin-ny-blocked').textContent).not.toMatch(/initiative/)
  })

  it('expands a decision without hiding unknown risk words', () => {
    render(<NeedsYouRail items={[decisionFixture()]} />)
    expect(screen.queryByTestId('risk-ny-decision-0-severity')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))

    expect(screen.getByTestId('option-ny-decision-keep-gain')).toHaveTextContent('gain: One place to look')
    expect(screen.getByTestId('option-ny-decision-keep-cost')).toHaveTextContent('cost: The rail gets taller')
    expect(screen.getByTestId('option-ny-decision-keep-wrongIf')).toHaveTextContent('wrongIf: Review volume drowns blockers')
    const unknown = screen.getByTestId('risk-ny-decision-0-severity')
    expect(unknown).toHaveTextContent('severity: catastrophic (unknown)')
    expect(unknown).toHaveAttribute('data-known', 'false')
    expect(unknown.className).not.toMatch(/green/)
    expect(screen.getByTestId('risk-ny-decision-0-likelihood')).toHaveTextContent('likelihood: possible')
    expect(screen.getByTestId('risk-ny-decision-0-discoverability')).toHaveTextContent('discoverability: subtle')
    expect(screen.getByTestId('risk-ny-decision-1-severity')).toHaveAttribute('data-known', 'true')
    expect(screen.getByTestId('risk-ny-decision-1-likelihood')).toHaveTextContent('likelihood: likely')
    expect(screen.getByTestId('risk-ny-decision-1-discoverability')).toHaveTextContent('discoverability: silent')
    expect(screen.getByTestId('reversal-action-ny-decision')).toHaveTextContent('reversal action: cheap')
    expect(screen.getByTestId('reversal-damage-ny-decision')).toHaveTextContent('reversal damage: weeks+')
    expect(screen.getByTestId('horizon-span-ny-decision')).toHaveTextContent('horizon span: until-this-ships')
    expect(screen.getByTestId('horizon-until-ny-decision')).toHaveTextContent('until: the v6 account wire-up lands')
    expect(screen.getByTestId('decision-comment-ny-decision')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders fewer than two options as a diagnostic', () => {
    const payload = decisionFixture().payload as { options: unknown[] }
    render(<NeedsYouRail items={[decisionFixture({
      id: 'ny-short',
      payload: { ...payload, options: [{ id: 'only', label: 'Only choice', gain: 'g', cost: 'c', wrongIf: 'w' }] },
    })]} />)
    expect(screen.getByTestId('needsyou-diagnostic-ny-short')).toHaveTextContent('at least two options')
    expect(screen.queryByRole('button', { name: 'Only choice' })).toBeNull()
    expect(screen.queryByTestId('needsyou-card-ny-short')).toBeNull()
  })

  it('keeps open, answered, and resolved distinct from queued', () => {
    const answered = {
      fixture: true,
      delivery: 'queued',
      answerRequestId: 'req-queued',
      spentRequestIds: [],
      lastError: null,
      receiptDetail: null,
      acknowledgement: null,
      item: {
        ...decisionFixture({ id: 'ny-queued', headline: 'Queued decision' }),
        state: 'answered',
        response: { revision: 'rev-decision', at: '2026-09-25T00:00:00.000Z', body: { optionId: 'keep' } },
      },
    }
    render(<NeedsYouRail items={[
      decisionFixture({ id: 'ny-open', headline: 'Open decision' }),
      answered,
      decisionFixture({ id: 'ny-resolved', headline: 'Resolved decision', state: 'resolved' }),
    ]} />)
    expect(screen.getByTestId('needsyou-state-ny-open')).toHaveTextContent('state open')
    expect(screen.getByTestId('needsyou-status-ny-open')).toHaveTextContent('unanswered')
    expect(screen.getByTestId('needsyou-status-ny-open').textContent).not.toMatch(/resolved/)
    expect(screen.getByTestId('needsyou-state-ny-queued')).toHaveTextContent('state answered')
    expect(screen.getByTestId('needsyou-status-ny-queued')).toHaveTextContent('queued')
    expect(screen.getByTestId('needsyou-status-ny-queued').textContent).not.toMatch(/resolved/)
    expect(screen.getByTestId('needsyou-state-ny-resolved')).toHaveTextContent('state resolved')
    expect(screen.getByTestId('needsyou-status-ny-resolved')).toHaveTextContent('resolved')
  })
})

describe('NeedsYouRail actions', () => {
  it('sends attention.answer for the revision on screen and stays unapplied', async () => {
    const submit = vi.fn<RailSubmitIntent>(async () => queued())
    render(<NeedsYouRail items={[decisionFixture()]} submitIntent={submit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep one queue' }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const envelope = submit.mock.calls[0]?.[0] as {
      kind: string
      revision: string
      anchor: { type: string; ids: string[] }
      body: Record<string, unknown>
    }
    expect(envelope.kind).toBe('attention.answer')
    expect(envelope.revision).toBe('rev-decision')
    expect(envelope.anchor).toEqual({ type: 'needsyou', ids: ['ny-decision'] })
    expect(envelope.body).toEqual({ optionId: 'keep', comment: 'fixture comment' })
    expect(envelope.body.command).toBeUndefined()
    const card = screen.getByTestId('needsyou-card-ny-decision')
    expect(card).toHaveAttribute('data-state', 'answered')
    expect(card).toHaveAttribute('data-applied', 'false')
    expect(screen.getByTestId('needsyou-status-ny-decision')).toHaveTextContent('queued')
    expect(screen.getByTestId('needsyou-status-ny-decision').textContent).not.toMatch(/resolved/)
  })

  it('keeps a failed answer on screen and does not mark it applied', async () => {
    const submit = vi.fn<RailSubmitIntent>(async () => queued({
      noteId: null,
      disposition: 'failed',
      detail: 'nothing saved',
    }))
    render(<NeedsYouRail items={[decisionFixture()]} submitIntent={submit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep one queue' }))
    await waitFor(() => expect(screen.getByTestId('needsyou-error-ny-decision')).toHaveTextContent('nothing saved'))
    expect(screen.getByTestId('needsyou-card-ny-decision')).toHaveAttribute('data-state', 'open')
    expect(screen.getByTestId('needsyou-card-ny-decision')).toHaveAttribute('data-applied', 'false')
  })

  it('shows saved-unannounced and not-receivable without calling them applied', async () => {
    const saved = vi.fn<RailSubmitIntent>(async () => queued({
      disposition: 'saved-unannounced',
      detail: 'saved, not announced',
    }))
    const { rerender } = render(<NeedsYouRail items={[decisionFixture()]} submitIntent={saved} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep one queue' }))
    await waitFor(() => expect(screen.getByTestId('needsyou-status-ny-decision')).toHaveTextContent('saved, not announced'))
    expect(screen.getByTestId('needsyou-card-ny-decision')).toHaveAttribute('data-applied', 'false')

    const blocked = vi.fn<RailSubmitIntent>(async () => queued({
      disposition: 'not-receivable',
      detail: 'not receivable',
    }))
    rerender(<NeedsYouRail items={[decisionFixture({ id: 'ny-decision-2', headline: 'Second' })]} submitIntent={blocked} />)
    fireEvent.click(screen.getByRole('button', { name: 'Keep one queue' }))
    await waitFor(() => expect(screen.getByTestId('needsyou-status-ny-decision-2')).toHaveTextContent('not receivable'))
    expect(screen.getByTestId('needsyou-card-ny-decision-2')).toHaveAttribute('data-applied', 'false')
  })

  it('retries a failure as an inbox intent', async () => {
    const submit = vi.fn<RailSubmitIntent>(async () => queued())
    render(<NeedsYouRail items={[failureFixture()]} submitIntent={submit} />)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const envelope = submit.mock.calls[0]?.[0] as { kind: string; body: Record<string, unknown> }
    expect(envelope.kind).toBe('attention.answer')
    expect(envelope.body).toEqual({
      action: 'retry',
      operation: 'publish the needs-you projection',
      proposedNextAction: 'retry the projection write',
    })
    expect(JSON.stringify(envelope)).not.toMatch(/command|shell|tmux/)
  })

  it('acknowledges drift without rewriting the baseline and shows continues', async () => {
    const submit = vi.fn<RailSubmitIntent>(async () => queued())
    render(<NeedsYouRail items={[driftFixture()]} submitIntent={submit} />)
    const clock = document.querySelector('[data-region="clock"]')
    expect(clock).toHaveAttribute('data-planned-ms', '7200000')
    expect(clock).toHaveAttribute('data-continues', 'true')
    expect(screen.getByText('Work continues')).toBeTruthy()
    expect(screen.getByText('last progress unknown')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge' }))
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    const envelope = submit.mock.calls[0]?.[0] as { kind: string; body: Record<string, unknown> }
    expect(envelope.kind).toBe('schedule.acknowledge')
    expect(envelope.body).toEqual({ acknowledge: true })
    expect(document.querySelector('[data-region="clock"]')).toHaveAttribute('data-planned-ms', '7200000')
    expect(screen.getByTestId('needsyou-card-ny-drift')).toHaveAttribute('data-state', 'open')
    expect(screen.getByTestId('needsyou-ack-ny-drift')).toHaveTextContent('acknowledged queued')
  })

  it('compares a contradiction in place and does not hard-code blocking', () => {
    render(<NeedsYouRail items={[contradictionFixture(), contradictionFixture({
      id: 'ny-contradiction-block',
      headline: 'Blocking disagreement',
      payload: {
        ...(contradictionFixture().payload as Record<string, unknown>),
        blocking: true,
      },
    })]} />)
    expect(screen.queryByTestId('contradiction-evidence-ny-contradiction')).toBeNull()
    fireEvent.click(screen.getAllByRole('button', { name: 'Compare' })[0]!)
    expect(screen.getByTestId('contradiction-evidence-ny-contradiction')).toHaveTextContent('Evidence A: rail length 0')
    expect(screen.getByTestId('contradiction-evidence-ny-contradiction')).toHaveTextContent('Source B: projection file')
    expect(within(screen.getByTestId('needsyou-card-ny-contradiction')).getByText('not blocking')).toBeTruthy()
    expect(within(screen.getByTestId('needsyou-card-ny-contradiction-block')).getByText('blocking')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('opens a pull request link without answering, resolving, or a modal', () => {
    const submit = vi.fn<RailSubmitIntent>(async () => queued())
    render(<NeedsYouRail items={[reviewFixture()]} submitIntent={submit} />)
    expect(screen.getByRole('heading', { name: 'Review the Needs You rail' })).toBeTruthy()
    expect(screen.getByTestId('review-repo-ny-review')).toHaveTextContent('except-pass/tinstar')
    expect(screen.getByTestId('review-number-ny-review')).toHaveTextContent('#1206')
    const link = screen.getByTestId('review-link-ny-review')
    expect(link.getAttribute('href')).toBe('https://github.com/except-pass/tinstar/pull/1206')
    const ci = screen.getByTestId('review-ci-ny-review')
    expect(ci).toHaveTextContent('CI unknown')
    expect(ci).toHaveAttribute('data-ci', 'unknown')
    expect(ci.className).not.toMatch(/green/)
    fireEvent.click(link)
    expect(submit).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('needsyou-card-ny-review')).toHaveAttribute('data-state', 'open')
    expect(screen.getByTestId('needsyou-status-ny-review')).toHaveTextContent('unanswered')
  })

  it('does not paint a known-success CI treatment on an unrecognized status', () => {
    render(<NeedsYouRail items={[reviewFixture({ ci: 'weird', payload: { ...(reviewFixture().payload as object), ci: 'weird' } })]} />)
    const ci = screen.getByTestId('review-ci-ny-review')
    expect(ci).toHaveAttribute('data-ci', 'unknown')
    expect(ci.className).not.toMatch(/green/)
  })

  it('supplies a blocker in place', () => {
    render(<NeedsYouRail items={[blockedFixture()]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Supply' }))
    expect(screen.getByTestId('blocked-supply-ny-blocked')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('NeedsYouRail revision check through its routes', () => {
  const servers: Server[] = []
  const dirs: string[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a choice against an older revision and does not apply it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'needsyou-ui-'))
    dirs.push(dir)
    const submit = vi.fn(async () => queued())
    const handle = registerNeedsYouRoutes({ dir, submitIntent: submit, now: () => '2026-09-25T03:00:00.000Z' })
    const server = createServer((req, res) => {
      void handle(req, res).then(handled => {
        if (!handled && !res.headersSent) {
          res.statusCode = 404
          res.end()
        }
      })
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

    async function call(path: string, body?: unknown) {
      return fetch(`${base}${path}`, body === undefined ? undefined : {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
    }

    const seeded = await call('/api/v6/needsyou/items', decisionFixture())
    expect(seeded.status).toBe(200)
    const http: NeedsYouHttp = {
      list: async () => (await fetch(`${base}/api/v6/needsyou`)).json(),
      answer: async (id, body) => (await call(`/api/v6/needsyou/${id}/answer`, body)).json(),
    }
    render(<NeedsYouRail http={http} />)
    await screen.findByRole('button', { name: 'Keep one queue' })
    expect(screen.getByTestId('needsyou-card-ny-decision')).toHaveAttribute('data-state', 'open')

    const revised = await call('/api/v6/needsyou/items', decisionFixture({ revision: 'rev-decision-2', headline: 'The decision changed' }))
    expect(revised.status).toBe(200)

    fireEvent.click(screen.getByRole('button', { name: 'Keep one queue' }))
    await waitFor(() => expect(screen.getByTestId('needsyou-error-ny-decision')).toHaveTextContent(/revision mismatch/))
    expect(submit).not.toHaveBeenCalled()
    expect(screen.getByTestId('needsyou-card-ny-decision')).toHaveAttribute('data-state', 'open')
    expect(screen.getByTestId('needsyou-card-ny-decision')).toHaveAttribute('data-applied', 'false')
    expect(screen.queryByRole('dialog')).toBeNull()

    const listed = await (await fetch(`${base}/api/v6/needsyou`)).json() as {
      data: { items: Array<{ item: { revision: string; state: string; response: unknown } }> }
    }
    expect(listed.data.items).toHaveLength(1)
    expect(listed.data.items[0]?.item.revision).toBe('rev-decision-2')
    expect(listed.data.items[0]?.item.state).toBe('open')
    expect(listed.data.items[0]?.item.response).toBeNull()
  })

  it('shows the rail name, face, and color on attention provenance', () => {
    const identity = { name: 'Ace', color: '#123456', project: 'tinstar', worktree: '/tmp/alpha' }
    const { rerender } = render(<NeedsYouRail
      items={[blockedFixture({ id: 'ny-alpha', provenance: { workerId: 'alpha', taskId: 'task-1' } })]}
      identities={{ alpha: identity }}
    />)
    const mark = screen.getByTestId('needsyou-provenance-ny-alpha')
    expect(mark).toHaveAttribute('data-name', 'Ace')
    expect(mark).toHaveAttribute('data-color', '#123456')
    expect(mark).toHaveTextContent('Ace')
    expect(mark.querySelector('[data-face="alpha"]')).toBeTruthy()
    rerender(<NeedsYouRail
      items={[blockedFixture({ id: 'ny-alpha', provenance: { workerId: 'alpha', taskId: 'task-1' } })]}
      identities={{ alpha: { ...identity } }}
    />)
    const again = screen.getByTestId('needsyou-provenance-ny-alpha')
    expect(again).toHaveAttribute('data-name', 'Ace')
    expect(again).toHaveAttribute('data-color', '#123456')
    expect(again).toHaveTextContent('Ace')
    expect(again.querySelector('[data-face="alpha"]')).toBeTruthy()
  })
})
