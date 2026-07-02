// @vitest-environment jsdom
//
// U6 (R8): the BACKGROUND chip on the run-card header — subtle gray, no pulse,
// rendered whenever the run carries `background: true` (toggle-revealed and
// attention-breakthrough cards both show it).
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { RunData } from '../../domain/types'
import { RunWorkspaceHeader } from '../RunWorkspaceWidget/RunWorkspaceHeader'

vi.mock('../../hooks/useBackendState', () => ({
  useBackendState: () => ({
    taxRepo: {
      getInitiativeForRun: () => null,
      getEpicForRun: () => null,
      getTaskForRun: () => null,
    },
  }),
}))

vi.mock('../../hotkeys/ConstellationContext', () => ({
  useConstellationContext: () => ({ slotsForNode: () => [], remove: vi.fn() }),
}))

vi.mock('../../apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('../agentIcon', () => ({
  AgentIcon: () => null,
  isIconUrl: () => false,
}))

function makeRun(overrides: Partial<RunData> = {}): RunData {
  return {
    id: 'r1',
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

describe('RunWorkspaceHeader background chip', () => {
  it('renders the BACKGROUND chip for a background run', () => {
    render(<RunWorkspaceHeader run={makeRun({ background: true })} />)
    const chip = screen.getByTestId('background-chip-r1')
    expect(chip).toHaveTextContent(/background/i)
    // Subtle/gray, no pulse — unlike the status dot's animate-pulse-glow.
    expect(chip.querySelector('.animate-pulse-glow')).toBeNull()
  })

  it('renders no chip for a non-background run', () => {
    render(<RunWorkspaceHeader run={makeRun()} />)
    expect(screen.queryByTestId('background-chip-r1')).toBeNull()
  })

  it('keeps the chip alongside the normal status chip (breakthrough cards keep status styling)', () => {
    render(<RunWorkspaceHeader run={makeRun({ background: true, status: 'needs_attention' })} />)
    expect(screen.getByTestId('background-chip-r1')).toBeInTheDocument()
    expect(screen.getByText('ATTENTION')).toBeInTheDocument()
  })
})
