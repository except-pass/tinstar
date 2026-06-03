import { describe, it, expect, vi, beforeEach } from 'vitest'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../../../apiClient', () => ({ apiFetch, apiUrl: (p: string) => p }))

import { makeTerminalHandle } from '../terminalHandle'

function okResponse(data: unknown) {
  return { ok: true, json: async () => ({ ok: true, data }) } as unknown as Response
}
beforeEach(() => { apiFetch.mockReset(); apiFetch.mockResolvedValue(okResponse(null)) })

describe('makeTerminalHandle', () => {
  it('sendKeys POSTs /send-keys with the keys', async () => {
    await makeTerminalHandle('sess-1').sendKeys(['Up', 'Enter'])
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/sess-1/send-keys', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse((apiFetch.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ keys: ['Up', 'Enter'] })
  })
  it('sendText with enter uses /enter-prompt', async () => {
    await makeTerminalHandle('sess-1').sendText('hello')
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/sess-1/enter-prompt', expect.objectContaining({ method: 'POST' }))
    expect(JSON.parse((apiFetch.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ prompt: 'hello' })
  })
  it('sendText without enter uses /send-keys with [text]', async () => {
    await makeTerminalHandle('sess-1').sendText('hi', { enter: false })
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/sess-1/send-keys', expect.anything())
    expect(JSON.parse((apiFetch.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ keys: ['hi'] })
  })
  it('readScreen GETs /screen and returns data.screen', async () => {
    apiFetch.mockResolvedValue(okResponse({ screen: 'BUF' }))
    expect(await makeTerminalHandle('sess-1').readScreen()).toBe('BUF')
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/sess-1/screen', expect.objectContaining({ method: 'GET' }))
  })
  it('readScreen passes scrollback as a query param', async () => {
    apiFetch.mockResolvedValue(okResponse({ screen: 'B' }))
    await makeTerminalHandle('s').readScreen({ scrollback: 120 })
    expect(apiFetch).toHaveBeenCalledWith('/api/sessions/s/screen?scrollback=120', expect.anything())
  })
  it('exec POSTs /exec and returns the structured result', async () => {
    apiFetch.mockResolvedValue(okResponse({ stdout: 'O', stderr: '', code: 0 }))
    expect(await makeTerminalHandle('sess-1').exec(['roborev', 'list', '--json'])).toEqual({ stdout: 'O', stderr: '', code: 0 })
    expect(JSON.parse((apiFetch.mock.calls[0]![1] as RequestInit).body as string)).toEqual({ argv: ['roborev', 'list', '--json'] })
  })
  it('throws when the envelope is not ok', async () => {
    apiFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: false, error: { message: 'nope' } }) } as unknown as Response)
    await expect(makeTerminalHandle('s').exec(['x'])).rejects.toThrow(/nope/)
  })
})
