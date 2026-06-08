import { createContext, useContext } from 'react'
import type { BrowserHandle, TerminalHandle } from '@tinstar/plugin-api'

export const BrowserHandleContext = createContext<BrowserHandle | null>(null)
export const TerminalHandleContext = createContext<TerminalHandle | null>(null)

export function useBrowserHandle(): BrowserHandle {
  const h = useContext(BrowserHandleContext)
  if (!h) throw new Error('useBrowser() called outside a browser-primitive widget')
  return h
}

export function useTerminalHandle(): TerminalHandle {
  const h = useContext(TerminalHandleContext)
  if (!h) throw new Error('useTerminal() called outside a terminal-primitive widget')
  return h
}
