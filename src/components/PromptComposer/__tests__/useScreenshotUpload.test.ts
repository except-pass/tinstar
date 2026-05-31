// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useScreenshotUpload } from '../useScreenshotUpload'

const ORIG_FETCH = global.fetch

beforeEach(() => {
  global.fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: { path: '/abs/path/to/file.png' } }),
  }) as Response)
  global.URL.createObjectURL = vi.fn(() => 'blob:test')
  global.URL.revokeObjectURL = vi.fn()
})
afterEach(() => {
  global.fetch = ORIG_FETCH
  vi.restoreAllMocks()
})

function fakeBlob(): File {
  return new File([new Uint8Array([0x89, 0x50])], 'paste.png', { type: 'image/png' })
}

describe('useScreenshotUpload', () => {
  it('starts with no tiles and pendingCount 0', () => {
    const { result } = renderHook(() => useScreenshotUpload())
    expect(result.current.tiles).toEqual([])
    expect(result.current.pendingCount).toBe(0)
  })

  it('adds a pending tile on startUpload and resolves to ready on success', async () => {
    const { result } = renderHook(() => useScreenshotUpload())
    let returned: { path: string; ocrText?: string } | null = null
    await act(async () => {
      const p = result.current.startUpload(fakeBlob())
      returned = await p
    })
    expect(returned).toEqual({ path: '/abs/path/to/file.png', ocrText: undefined })
    expect(result.current.tiles).toHaveLength(1)
    expect(result.current.tiles[0]!.status).toBe('ready')
    expect(result.current.tiles[0]!.path).toBe('/abs/path/to/file.png')
    expect(result.current.pendingCount).toBe(0)
  })

  it('threads ocrText through to the tile and the resolved result', async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ data: { path: '/abs/shot.png', ocrText: 'hello world' } }),
    }) as Response)
    const { result } = renderHook(() => useScreenshotUpload())
    let returned: { path: string; ocrText?: string } | null = null
    await act(async () => {
      returned = await result.current.startUpload(fakeBlob())
    })
    expect(returned).toEqual({ path: '/abs/shot.png', ocrText: 'hello world' })
    expect(result.current.tiles[0]!.ocrText).toBe('hello world')
  })

  it('marks the tile as error if fetch returns non-200', async () => {
    global.fetch = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: { code: 'INVALID_PARAMS', message: 'bad mime' } }),
    }) as Response)
    const { result } = renderHook(() => useScreenshotUpload())
    await act(async () => {
      try { await result.current.startUpload(fakeBlob()) } catch { /* swallow */ }
    })
    expect(result.current.tiles).toHaveLength(1)
    expect(result.current.tiles[0]!.status).toBe('error')
    expect(result.current.tiles[0]!.errorMessage).toBe('bad mime')
  })

  it('removeTile drops a tile by clientId', async () => {
    const { result } = renderHook(() => useScreenshotUpload())
    await act(async () => {
      await result.current.startUpload(fakeBlob())
    })
    expect(result.current.tiles).toHaveLength(1)
    const clientId = result.current.tiles[0]!.clientId
    act(() => { result.current.removeTile(clientId) })
    expect(result.current.tiles).toHaveLength(0)
  })

  it('two uploads in quick succession produce two distinct tiles', async () => {
    const { result } = renderHook(() => useScreenshotUpload())
    await act(async () => {
      await Promise.all([
        result.current.startUpload(fakeBlob()),
        result.current.startUpload(fakeBlob()),
      ])
    })
    expect(result.current.tiles).toHaveLength(2)
    expect(result.current.tiles[0]!.clientId).not.toBe(result.current.tiles[1]!.clientId)
  })

  it('clearAll empties tiles and revokes blob URLs', async () => {
    const revoke = vi.fn()
    global.URL.revokeObjectURL = revoke
    const { result } = renderHook(() => useScreenshotUpload())
    await act(async () => {
      await result.current.startUpload(fakeBlob())
      await result.current.startUpload(fakeBlob())
    })
    expect(result.current.tiles).toHaveLength(2)
    act(() => { result.current.clearAll() })
    expect(result.current.tiles).toHaveLength(0)
    expect(revoke).toHaveBeenCalledTimes(2)
  })

  it('pendingCount counts only pending tiles', async () => {
    const deferred: Array<(v: Response) => void> = []
    global.fetch = vi.fn(() => new Promise<Response>((resolve) => { deferred.push(resolve) }))
    const { result } = renderHook(() => useScreenshotUpload())
    act(() => { void result.current.startUpload(fakeBlob()) })
    await waitFor(() => expect(result.current.pendingCount).toBe(1))
    await act(async () => {
      deferred[0]!({
        ok: true, status: 200,
        json: async () => ({ data: { path: '/done.png' } }),
      } as Response)
    })
    await waitFor(() => expect(result.current.pendingCount).toBe(0))
  })
})
