// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  _resetPromptHistoryForTests,
  pushPromptHistory,
  usePromptHistory,
} from '../usePromptHistory'

describe('usePromptHistory', () => {
  beforeEach(_resetPromptHistoryForTests)

  it('can seed a starting prompt before the composer mounts', () => {
    pushPromptHistory('new-run', '  starting prompt  ')

    const { result } = renderHook(() => usePromptHistory('new-run'))

    expect(result.current.history).toEqual(['starting prompt'])
  })

  it('notifies a mounted composer when creation seeds its history', () => {
    const { result } = renderHook(() => usePromptHistory('new-run'))

    act(() => pushPromptHistory('new-run', 'starting prompt'))

    expect(result.current.history).toEqual(['starting prompt'])
  })
})
