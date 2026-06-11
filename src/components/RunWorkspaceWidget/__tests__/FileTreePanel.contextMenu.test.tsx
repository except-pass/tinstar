// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, fireEvent, screen, waitFor } from '@testing-library/react'

const apiFetch = vi.hoisted(() => vi.fn())
vi.mock('../../../apiClient', () => ({ apiFetch }))
vi.mock('../../../context/ConfigContext', () => ({ useConfig: () => ({ uploadMaxBytes: 1024 }) }))
vi.mock('../useFileUpload', () => ({ useFileUpload: () => ({ start: vi.fn() }) }))

import { FileTreePanel } from '../FileTreePanel'

function jsonRes(data: unknown, ok = true) {
  return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok, data }) })
}

beforeEach(() => {
  apiFetch.mockReset()
  // Root listing: one file.
  apiFetch.mockImplementation((url: string) => {
    if (url.includes('/files?path=')) return jsonRes([{ name: 'readme.md', path: 'readme.md', isDir: false }])
    return jsonRes({})
  })
})

describe('<FileTreePanel> right-click context menu', () => {
  it('opens a context menu with Open/Download/Rename on a file', async () => {
    render(<FileTreePanel sessionId="sess-a" />)
    const row = await screen.findByText('readme.md')
    fireEvent.contextMenu(row)
    const menu = screen.getByTestId('file-context-menu')
    expect(menu.textContent).toContain('Open')
    expect(menu.textContent).toContain('Download')
    expect(menu.textContent).toContain('Rename')
  })

  it('Rename shows an inline input; Enter posts to the rename endpoint', async () => {
    render(<FileTreePanel sessionId="sess-a" />)
    const row = await screen.findByText('readme.md')
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText('Rename'))

    const input = await screen.findByDisplayValue('readme.md')
    fireEvent.change(input, { target: { value: 'README.md' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        '/api/sessions/sess-a/files/rename',
        expect.objectContaining({ method: 'POST' }),
      )
    })
    const renameCall = apiFetch.mock.calls.find((c: unknown[]) => String(c[0]).endsWith('/files/rename'))!
    expect(JSON.parse((renameCall[1] as { body: string }).body)).toEqual({ from: 'readme.md', to: 'README.md' })
  })

  it('Download fetches the download endpoint', async () => {
    // jsdom lacks URL.createObjectURL / anchor click side effects — stub them.
    Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:x', configurable: true })
    Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, configurable: true })
    apiFetch.mockImplementation((url: string) => {
      if (url.includes('/files/download')) {
        return Promise.resolve({ ok: true, blob: () => Promise.resolve(new Blob(['hi'])) })
      }
      if (url.includes('/files?path=')) return jsonRes([{ name: 'readme.md', path: 'readme.md', isDir: false }])
      return jsonRes({})
    })

    render(<FileTreePanel sessionId="sess-a" />)
    const row = await screen.findByText('readme.md')
    fireEvent.contextMenu(row)
    fireEvent.click(screen.getByText('Download'))

    await waitFor(() => {
      expect(apiFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/sessions/sess-a/files/download?path=readme.md'),
      )
    })
  })
})
