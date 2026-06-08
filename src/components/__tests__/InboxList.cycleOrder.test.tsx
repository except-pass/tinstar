// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import type { Run } from '../../domain/types'

// useInbox reads from useServerEvents; mock the server state so we can drive
// exactly which runs the inbox sees.
const runs: Run[] = []
vi.mock('../../hooks/useServerEvents', () => ({
  useServerEvents: () => ({
    state: { runs, pluginWidgets: [] },
    connected: true,
    loading: false,
    addOptimistic: () => {},
    disconnect: () => {},
  }),
}))

import { InboxList } from '../InboxList'
import { SelectionProvider } from '../SelectionProvider'

function run(id: string, createdAt: string): Run {
  return {
    id,
    sessionId: id,
    spaceId: 'space-1',
    status: 'idle',
    createdAt,
  } as Run
}

function renderInbox(searchQuery: string, onVisibleRunOrder: (ids: string[]) => void) {
  render(
    <SelectionProvider>
      <InboxList activeSpaceId="space-1" searchQuery={searchQuery} onVisibleRunOrder={onVisibleRunOrder} />
    </SelectionProvider>,
  )
}

describe('InboxList visible run order (cycle source)', () => {
  beforeEach(() => {
    runs.length = 0
    runs.push(run('alpha', '2026-06-01T10:00:00Z'), run('bravo', '2026-06-01T09:00:00Z'))
  })

  it('reports all run ids in inbox order when unfiltered', () => {
    const onVisibleRunOrder = vi.fn()
    renderInbox('', onVisibleRunOrder)
    // No attention → newest createdAt first.
    expect(onVisibleRunOrder).toHaveBeenLastCalledWith(['alpha', 'bravo'])
  })

  it('reports only matching run ids when a search filter is active', () => {
    const onVisibleRunOrder = vi.fn()
    renderInbox('bravo', onVisibleRunOrder)
    expect(onVisibleRunOrder).toHaveBeenLastCalledWith(['bravo'])
  })
})
