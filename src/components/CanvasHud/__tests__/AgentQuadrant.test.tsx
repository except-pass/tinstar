// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { AgentQuadrant } from '../AgentQuadrant'
import type { Run } from '../../../domain/types'

function fakeRun(overrides: Partial<Run>): Run {
  return {
    id: 'r1',
    sessionId: 'sess-1',
    status: 'running',
    color: '#22c55e',
    agentIcon: undefined,
    taskId: 't',
    initiative: '',
    epic: '',
    task: '',
    repo: '',
    worktree: '',
    worktreeId: 'wt-1',
    touchedFiles: [],
    recapEntries: [],
    rawLogs: '',
    port: null,
    backend: null,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Run
}

describe('<AgentQuadrant>', () => {
  it('excludes stopped sessions', () => {
    const runMap = new Map([
      ['r1', fakeRun({ id: 'r1', status: 'stopped' })],
      ['r2', fakeRun({ id: 'r2', status: 'running' })],
    ])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set()} onFocusRun={() => {}} />
    )
    const avatars = container.querySelectorAll('[data-testid="agent-avatar"]')
    expect(avatars.length).toBe(1)
    expect(avatars[0]!.getAttribute('data-run-id')).toBe('r2')
  })

  it('places a BUSY + LLM run in the WORKING cell', () => {
    const runMap = new Map([['r1', fakeRun({ id: 'r1', status: 'running' })]])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set(['r1'])} onFocusRun={() => {}} />
    )
    const cell = container.querySelector('[data-testid="quadrant-cell-working"]')
    expect(cell).not.toBeNull()
    expect(cell!.querySelector('[data-run-id="r1"]')).not.toBeNull()
  })

  it('places a BUSY + quiet run in the TOOL cell', () => {
    const runMap = new Map([['r1', fakeRun({ id: 'r1', status: 'running' })]])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set()} onFocusRun={() => {}} />
    )
    expect(container.querySelector('[data-testid="quadrant-cell-tool"] [data-run-id="r1"]')).not.toBeNull()
  })

  it('places a READY + LLM run in the COOLING cell', () => {
    const runMap = new Map([['r1', fakeRun({ id: 'r1', status: 'idle' })]])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set(['r1'])} onFocusRun={() => {}} />
    )
    expect(container.querySelector('[data-testid="quadrant-cell-cooling"] [data-run-id="r1"]')).not.toBeNull()
  })

  it('places a READY + quiet run in the IDLE cell (including needs_attention and creating)', () => {
    const runMap = new Map([
      ['r1', fakeRun({ id: 'r1', status: 'idle' })],
      ['r2', fakeRun({ id: 'r2', status: 'needs_attention' })],
      ['r3', fakeRun({ id: 'r3', status: 'creating' })],
    ])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set()} onFocusRun={() => {}} />
    )
    const cell = container.querySelector('[data-testid="quadrant-cell-idle"]')
    expect(cell).not.toBeNull()
    expect(cell!.querySelectorAll('[data-testid="agent-avatar"]').length).toBe(3)
  })

  it('calls onFocusRun with the run ID when an avatar is clicked', () => {
    const runMap = new Map([['r1', fakeRun({ id: 'r1', status: 'running' })]])
    const onFocusRun = vi.fn()
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set()} onFocusRun={onFocusRun} />
    )
    const btn = container.querySelector('[data-run-id="r1"]') as HTMLElement
    fireEvent.click(btn)
    expect(onFocusRun).toHaveBeenCalledWith('r1')
  })

  it('renders nothing visible when there are zero alive sessions', () => {
    const runMap = new Map([['r1', fakeRun({ id: 'r1', status: 'stopped' })]])
    const { container } = render(
      <AgentQuadrant runMap={runMap} burningRunIds={new Set()} onFocusRun={() => {}} />
    )
    expect(container.querySelector('[data-testid="agent-quadrant"]')).toBeNull()
  })
})
