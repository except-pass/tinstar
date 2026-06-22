import { describe, it, expect } from 'vitest'

import { resolveClipboardCommand } from '../tmux'

// `exists` simulates which clipboard binaries are present on PATH.
const only = (...present: string[]) => (bin: string) => present.includes(bin)

describe('resolveClipboardCommand', () => {
  it('prefers clip.exe on WSL', () => {
    // WSL has both clip.exe and possibly Linux tools; clip.exe must win.
    expect(resolveClipboardCommand(only('clip.exe', 'xclip'))).toBe('clip.exe')
  })

  it('uses pbcopy on macOS', () => {
    expect(resolveClipboardCommand(only('pbcopy'))).toBe('pbcopy')
  })

  it('uses wl-copy on Wayland', () => {
    expect(resolveClipboardCommand(only('wl-copy'))).toBe('wl-copy')
  })

  it('uses xclip on X11 (with its selection flags)', () => {
    expect(resolveClipboardCommand(only('xclip'))).toBe('xclip -selection clipboard -in')
  })

  it('falls back to xsel when only xsel is present', () => {
    expect(resolveClipboardCommand(only('xsel'))).toBe('xsel --clipboard --input')
  })

  it('returns null when no clipboard tool is available', () => {
    expect(resolveClipboardCommand(() => false)).toBeNull()
  })
})
