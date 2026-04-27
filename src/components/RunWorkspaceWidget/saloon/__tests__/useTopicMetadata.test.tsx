// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useTopicMetadata } from '../useTopicMetadata'
import type { TopicMetadata } from '../../../../domain/types'

vi.mock('../../../../hooks/useBackendState', () => ({
  useBackendState: () => ({
    topicMetadata: [
      { subject: 'tinstar.x', name: 'Renamed X', kind: 'broadcast', createdAt: '' } as TopicMetadata,
    ],
  }),
}))

describe('useTopicMetadata', () => {
  it('returns the metadata record for a known subject', () => {
    const { result } = renderHook(() => useTopicMetadata('tinstar.x'))
    expect(result.current?.name).toBe('Renamed X')
  })

  it('returns undefined for an unknown subject', () => {
    const { result } = renderHook(() => useTopicMetadata('tinstar.unknown'))
    expect(result.current).toBeUndefined()
  })
})
