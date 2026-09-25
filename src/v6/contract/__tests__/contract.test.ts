import { describe, expect, it } from 'vitest'
import {
  NEEDS_YOU_TYPES,
  parseAppliedReceipt,
  parseDecisionPayload,
  parseIntentEnvelope,
  parseNeedsYouItem,
  parseWorkerDescriptor,
  rateScaleWord,
  SEVERITY_SCALE,
} from '../index'

const task = {
  id: 'alpha',
  fixture: true,
  project: 'tinstar',
  spawn_gen: '4',
  backend: 'tmux',
  paths: { worktree: { path: '/tmp/alpha', present: true } },
  endpoint: { target: 'sess:alpha', exists: true, agent_alive: 'alive', status: 'alive' },
  current_state: { state: 'working', observed_at: '2026-09-24T04:00:00Z' },
  actions: { steer: "bin/fm-send.sh fm-alpha '<instruction>'", watch: 'bin/fm-peek.sh fm-alpha' },
  hints: { last_event_text: 'raw status line' },
}

describe('v6 contract', () => {
  it('names the six Needs You types and the decision scales', () => {
    expect([...NEEDS_YOU_TYPES]).toEqual([
      'decision', 'blocked', 'failure', 'schedule-drift', 'contradiction', 'review-ready',
    ])
    expect([...SEVERITY_SCALE]).toEqual(['annoying', 'costly', 'severe'])
  })

  it('parses an intent and a receipt and rejects an unknown kind', () => {
    const intent = parseIntentEnvelope({
      schema: 'tinstar.v6.intent/1',
      kind: 'thread.message',
      requestId: 'req-1',
      revision: null,
      anchor: { type: 'worker', ids: ['alpha'] },
      body: { text: 'hello' },
      extra: true,
    })
    expect(intent.ok && intent.value.kind).toBe('thread.message')
    expect(parseIntentEnvelope({ ...intent.ok && intent.value, kind: 'shell.run' }).ok).toBe(false)
    const receipt = parseAppliedReceipt(JSON.stringify({
      schema: 'tinstar.v6.receipt/1',
      requestId: 'req-1',
      outcome: 'applied',
      detail: 'done',
    }))
    expect(receipt.ok && receipt.value.outcome).toBe('applied')
    expect(parseAppliedReceipt('captain says hi').ok).toBe(false)
  })

  it('strips actions and steer text and keeps an unknown risk word unknown', () => {
    const parsed = parseWorkerDescriptor(task)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.value.fixture).toBe(true)
    expect(parsed.value.crewState).toBe('working')
    expect(JSON.stringify(parsed.value)).not.toContain('fm-send')
    expect(JSON.stringify(parsed.value)).not.toContain('actions')
    expect(JSON.stringify(parsed.value)).not.toContain('raw status')
    expect(parseWorkerDescriptor({ ...task, current_state: { state: 'busy', observed_at: 't' } }).ok).toBe(false)
    const word = rateScaleWord('catastrophic', SEVERITY_SCALE)
    expect(word.ok && word.value).toEqual({ value: 'catastrophic', known: false })
  })

  it('fails a decision closed when an option is missing and does not coerce a review link', () => {
    expect(parseDecisionPayload({
      options: [{ id: 'a', label: 'A', gain: 'g', cost: 'c', wrongIf: 'w' }],
    }).ok).toBe(false)
    const item = parseNeedsYouItem({
      id: 'ny-1',
      type: 'review-ready',
      headline: 'PR',
      state: 'answered',
      provenance: { workerId: 'alpha', epicId: '' },
      createdAt: 't',
      updatedAt: 't',
      revision: '1',
      executionImpact: 'continues',
      payload: {
        kind: 'pr',
        summary: 'ready',
        target: 'main',
        pr: { repo: 'except-pass/tinstar', number: 1, url: 'http://example.com/pr/1' },
      },
      response: null,
    })
    expect(item.ok).toBe(false)
  })
})
