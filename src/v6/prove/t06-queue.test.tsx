import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkerDescriptor } from '../contract/descriptor'
import type { IntentEnvelope } from '../contract/intent'
import { decisionFixture } from '../needsyou/fixtures'
import { NeedsYouRail } from '../needsyou'
import { PortfolioBoard } from '../portfolio'
import { emptyPortfolio, proposalFromIntent, recordSubmission } from '../portfolio/model'
import type { Epic, PortfolioDoc } from '../portfolio/types'
import type { FmCommandRunner } from '../../server/v6/shell/fmExec'
import { submitIntent, type IntentSubmission } from '../../server/v6/shell/submitIntent'
import { V6Shell } from '../shell/V6Shell'

const LIVE_ROOTS = [
  '/Users/wtg/repo/firstmate',
  '/Users/wtg/.local/state/pm-build/tinstar-v6/firstmate-home',
]

const alpha: WorkerDescriptor = {
  source: 'fm-fleet-snapshot',
  fixture: true,
  id: 'alpha',
  spawnGen: '1',
  project: 'tinstar',
  worktree: { path: '/tmp/alpha', present: true },
  backend: 'tmux',
  endpoint: { target: 'sess:alpha', exists: true, agentAlive: 'alive', status: 'alive' },
  crewState: 'working',
  observedAt: '2026-09-24T04:00:00Z',
}

function livePath(path: string): boolean {
  return LIVE_ROOTS.some(root => path === root || path.startsWith(`${root}/`))
}

function layout(): { root: string; home: string; binDir: string; projectionFile: string; inbox: string } {
  const root = mkdtempSync(join(tmpdir(), 'tinstar-t06-ui-'))
  const home = join(root, 'fm-home')
  const binDir = join(root, 'bin')
  const inbox = join(home, 'state', 'inbox')
  mkdirSync(inbox, { recursive: true })
  mkdirSync(binDir, { recursive: true })
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(home, 'state', 'pane'), '%42\n')
  process.env.TINSTAR_CONFIG_HOME = join(root, 'config')
  return { root, home, binDir, inbox, projectionFile: join(root, 'config', 'v6', 'projection.json') }
}

function closedPrimary(home: string): FmCommandRunner {
  const inbox = join(home, 'state', 'inbox')
  return {
    exec: async (script, args, env) => {
      const fmHome = env.FM_HOME ?? ''
      if (livePath(fmHome) || livePath(script)) throw new Error(`refusing live First Mate path ${fmHome} ${script}`)
      if (args[0] === 'ask' || args.includes('ask')) throw new Error('ask is not delivery')
      if (args[0] === 'note') {
        const requestId = args[args.indexOf('--request-id') + 1] ?? 'missing'
        const body = args[args.length - 1] ?? ''
        const id = `note-${requestId}`
        writeFileSync(join(inbox, `${id}.note`), body)
        return {
          code: 0,
          stdout: JSON.stringify({
            schema: 'fm-inbox-note.v1',
            outcome: 'created',
            id,
            request_id: requestId,
            saved: true,
            announced: true,
            acknowledged: false,
            applied: true,
            delivered: true,
            processing: true,
            pane: '%42',
          }),
          stderr: '',
        }
      }
      if (args[0] === 'ready') {
        return {
          code: 0,
          stdout: JSON.stringify({
            schema: 'fm-primary-ready.v1',
            can_receive: false,
            pane: '%42',
            session: 'worker-a',
            endpoint: { exists: true, target: 'sess:alpha' },
            applied: true,
            delivered: true,
            processing: true,
          }),
          stderr: '',
        }
      }
      throw new Error(`unexpected inbox subcommand ${args[0]}`)
    },
  }
}

function claimFree(text: string): void {
  const rest = text.replaceAll('Not applied', '')
  expect(rest).not.toMatch(/delivered|processing|\bapplied\b|\bsent\b/i)
}

function noteFor(inbox: string, requestId: string): string {
  return join(inbox, `note-${requestId}.note`)
}

const roots: string[] = []
let previousConfig: string | undefined

afterEach(() => {
  vi.unstubAllGlobals()
  if (previousConfig === undefined) delete process.env.TINSTAR_CONFIG_HOME
  else process.env.TINSTAR_CONFIG_HOME = previousConfig
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('T06 primary unavailable UI', () => {
  it('does not show a shell message as delivered when the inbox file is saved and a terminal pane is open', async () => {
    previousConfig = process.env.TINSTAR_CONFIG_HOME
    const place = layout()
    roots.push(place.root)
    const seen: { submission?: IntentSubmission } = {}
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v6/workers/') && url.includes('/terminal')) {
        if (init?.method === 'DELETE') {
          return new Response(JSON.stringify({ ok: true, data: { state: 'closed' } }), { status: 200 })
        }
        return new Response(JSON.stringify({ ok: true, data: { state: 'live', pane: '%42' } }), { status: 200 })
      }
      if (url.includes('/api/v6/workers')) {
        return new Response(JSON.stringify({
          ok: true,
          data: { configured: true, workers: [alpha], identities: {}, diagnostics: [] },
        }), { status: 200 })
      }
      if (url.includes('/api/v6/identity')) {
        return new Response(JSON.stringify({ ok: true, data: { color: '#00f0ff' } }), { status: 200 })
      }
      if (url.includes('/api/v6/intents') && init?.method === 'POST') {
        const submission = await submitIntent(JSON.parse(String(init.body)) as unknown, {
          home: place.home,
          binDir: place.binDir,
          projectionFile: place.projectionFile,
          runner: closedPrimary(place.home),
        })
        seen.submission = submission
        return new Response(JSON.stringify({
          ok: true,
          data: { ...submission, pane: '%42', delivered: true, processing: true },
        }), { status: 200 })
      }
      if (url.includes('/api/v6/intents/')) {
        return new Response(JSON.stringify({
          ok: true,
          data: { applied: true, pane: '%42', reply: null, intent: { disposition: 'queued' } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({ ok: false, error: { message: 'unavailable' } }), { status: 404 })
    }))

    render(<V6Shell pollMs={60_000} />)
    await screen.findByLabelText('Message')
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))
    expect(await screen.findByTestId('terminal-alpha')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'hold this until the primary is back' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))

    await waitFor(() => {
      expect(seen.submission).toBeTruthy()
      const text = screen.getByTestId('intent-status').textContent ?? ''
      expect(text).toMatch(/Not applied/)
      const disposition = seen.submission?.disposition
      if (disposition === 'not-receivable') expect(text).toMatch(/Not receivable/)
      else if (disposition === 'queued') expect(text).toMatch(/\bQueued\b/)
      else if (disposition === 'saved-unannounced') expect(text).toMatch(/Saved, not announced/)
      else expect(text.toLowerCase()).toMatch(/fail|not saved|nothing saved|cannot receive/)
    })

    const submission = seen.submission as IntentSubmission
    expect(submission.applied).toBe(false)
    expect(submission.canReceive).not.toBe(true)
    expect(['queued', 'saved-unannounced', 'not-receivable', 'failed']).toContain(submission.disposition)
    const text = screen.getByTestId('intent-status').textContent ?? ''
    claimFree(text)
    expect(screen.queryByText(/^Applied$/)).toBeNull()
    expect(screen.queryByText(/Delivered|Processing/i)).toBeNull()
    expect(screen.getByTestId('terminal-alpha')).toBeInTheDocument()
    const notes = submission.requestId
    expect(existsSync(noteFor(place.inbox, notes))).toBe(true)
    expect(readFileSync(noteFor(place.inbox, notes), 'utf8')).toContain('hold this until the primary is back')
    expect(existsSync(join(place.home, 'state', 'pane'))).toBe(true)
  })

  it('does not show a needs-you answer as applied when the inbox file is saved and a pane exists', async () => {
    previousConfig = process.env.TINSTAR_CONFIG_HOME
    const place = layout()
    roots.push(place.root)
    const seen: { submission?: IntentSubmission } = {}
    render(
      <NeedsYouRail
        items={[decisionFixture()]}
        submitIntent={async raw => {
          const submission = await submitIntent(raw, {
            home: place.home,
            binDir: place.binDir,
            projectionFile: place.projectionFile,
            runner: closedPrimary(place.home),
          })
          seen.submission = submission
          return submission
        }}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Keep one queue' }))
    await waitFor(() => {
      expect(screen.getByTestId('needsyou-card-ny-decision').getAttribute('data-delivery')).not.toBe('pending')
    })
    const submission = seen.submission as IntentSubmission
    expect(submission.applied).toBe(false)
    expect(submission.canReceive).not.toBe(true)
    expect(submission.disposition).not.toBe('failed')
    const card = screen.getByTestId('needsyou-card-ny-decision')
    expect(card).toHaveAttribute('data-applied', 'false')
    expect(card.getAttribute('data-delivery')).not.toBe('applied')
    const status = screen.getByTestId('needsyou-status-ny-decision').textContent ?? ''
    expect(status).toMatch(/not receivable|queued|saved, not announced|failed/)
    claimFree(status)
    expect(existsSync(join(place.home, 'state', 'pane'))).toBe(true)
    const saved = readFileSync(noteFor(place.inbox, submission.requestId), 'utf8')
    expect(saved).toContain('attention.answer')
  })

  it('does not show a portfolio move as applied when the inbox file is saved and a pane exists', async () => {
    previousConfig = process.env.TINSTAR_CONFIG_HOME
    const place = layout()
    roots.push(place.root)
    const epic: Epic = {
      id: 'epic-1',
      title: 'Alpha',
      columnId: 'col-inbox',
      initiativeId: null,
      planSlug: null,
      completedAt: null,
      order: 0,
      revision: '1',
    }
    let current: PortfolioDoc = { ...emptyPortfolio(), fixture: true, epics: [epic] }
    const seen: { submission?: IntentSubmission } = {}
    render(
      <PortfolioBoard
        board={current}
        createRequestId={() => 'req-t06-move'}
        submitIntent={async (raw: IntentEnvelope) => {
          const submission = await submitIntent(raw, {
            home: place.home,
            binDir: place.binDir,
            projectionFile: place.projectionFile,
            runner: closedPrimary(place.home),
          })
          seen.submission = submission
          const proposal = proposalFromIntent(current, raw)
          if (!proposal.ok) throw new Error(proposal.diagnostic)
          current = recordSubmission(current, raw, proposal.value, submission)
          return { submission, board: current }
        }}
      />,
    )
    fireEvent.pointerDown(screen.getByTestId('epic-epic-1'))
    fireEvent.pointerUp(screen.getByTestId('drop-col-building'))
    const status = await screen.findByTestId('status-req-t06-move')
    const submission = seen.submission as IntentSubmission
    expect(submission.applied).toBe(false)
    expect(submission.canReceive).not.toBe(true)
    expect(status).toHaveAttribute('data-applied', 'false')
    expect(status).toHaveAttribute('data-disposition', 'not-receivable')
    claimFree(status.textContent ?? '')
    expect(screen.queryByText(/^Applied$/)).toBeNull()
    expect(screen.queryByText(/^Pending$/)).toBeNull()
    const card = screen.getByTestId('epic-epic-1')
    expect(card).toHaveAttribute('data-authoritative-column', 'col-inbox')
    expect(card).toHaveAttribute('data-pending', 'false')
    expect(card.closest('[data-testid="column-col-inbox"]')).toBeTruthy()
    expect(existsSync(noteFor(place.inbox, 'req-t06-move'))).toBe(true)
    expect(existsSync(join(place.home, 'state', 'pane'))).toBe(true)
  })
})
