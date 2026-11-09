import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { fixtureScene } from '../../../test-fixtures/reconciliation/scenes'
import { OpenInChatGPT } from '../OpenInChatGPT'

const opened = vi.fn(), expanded = vi.fn(), key = vi.fn()
beforeEach(() => {
  vi.stubGlobal('open', opened)
  vi.stubGlobal('PointerEvent', MouseEvent)
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', '') }
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); opened.mockReset(); expanded.mockReset(); key.mockReset() })
function mount() {
  const scene = fixtureScene()
  return render(<div onClick={expanded} onKeyDown={key}><OpenInChatGPT target={{ kind: 'work', scene, card: scene.cards[0]! }} /></div>)
}
it('opens a new isolated tab and keeps an editable-before-send copy fallback without expanding the row', async () => {
  const clipboard = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText: clipboard } })
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Open in ChatGPT' }))
  expect(opened).toHaveBeenCalledWith(expect.stringContaining('https://chatgpt.com/?prompt='), '_blank', 'noopener,noreferrer')
  expect(expanded).not.toHaveBeenCalled()
  const prompt = screen.getByRole('textbox', { name: 'Prompt to copy' }) as HTMLTextAreaElement
  expect(prompt.value).toBe(new URL(opened.mock.calls[0]![0]).searchParams.get('prompt'))
  fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
  expect(clipboard).toHaveBeenCalledWith(prompt.value)
  expect(await screen.findByText(/Prompt copied/)).toBeTruthy()
  expect(expanded).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  expect(screen.queryByRole('dialog')).toBeNull()
})
it('preserves keyboard activation and isolates Enter/Space from row expansion', () => {
  mount()
  const action = screen.getByRole('button', { name: 'Open in ChatGPT' })
  for (const value of ['Enter', ' ']) {
    fireEvent.keyDown(action, { key: value })
    expect(key).not.toHaveBeenCalled()
    // Native button keyboard activation produces a click with detail 0.
    fireEvent.click(action, { detail: 0 })
    expect(screen.getByRole('dialog')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
  }
  expect(opened).toHaveBeenCalledTimes(2)
})
it('allows a stationary touch and rejects swipes/cancelled gestures without row expansion', () => {
  mount()
  const action = screen.getByRole('button', { name: 'Open in ChatGPT' })
  fireEvent.pointerDown(action, { clientX: 100, clientY: 100 })
  fireEvent.pointerMove(action, { clientX: 50, clientY: 100 })
  fireEvent.pointerUp(action, { clientX: 100, clientY: 100 })
  fireEvent.click(action, { detail: 1 })
  expect(opened).not.toHaveBeenCalled()
  fireEvent.pointerDown(action, { clientX: 100, clientY: 100 })
  fireEvent.pointerCancel(action)
  fireEvent.click(action, { detail: 1 })
  expect(opened).not.toHaveBeenCalled()
  fireEvent.pointerDown(action, { clientX: 100, clientY: 100 })
  fireEvent.pointerUp(action, { clientX: 102, clientY: 100 })
  fireEvent.click(action, { detail: 1 })
  expect(opened).toHaveBeenCalledTimes(1)
  expect(expanded).not.toHaveBeenCalled()
})
it('selects the visible prompt when clipboard access is unavailable, even when popup opening fails', async () => {
  vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('denied')) } })
  opened.mockReturnValue(null)
  mount()
  fireEvent.click(screen.getByRole('button', { name: 'Open in ChatGPT' }))
  fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }))
  expect(await screen.findByText(/Clipboard unavailable/)).toBeTruthy()
  const prompt = screen.getByRole('textbox') as HTMLTextAreaElement
  expect(prompt.selectionStart).toBe(0)
  expect(prompt.selectionEnd).toBe(prompt.value.length)
  expect(screen.getByRole('link', { name: 'Open ChatGPT again ↗' })).toHaveAttribute('target', '_blank')
})
