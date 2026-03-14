import { createContext, useContext, useState, type ReactNode } from 'react'

export type HotkeyScope = 'global' | 'canvas' | 'widget'

interface ActiveScopeContextValue {
  scope: HotkeyScope
  setScope: (s: HotkeyScope) => void
}

const ActiveScopeContext = createContext<ActiveScopeContextValue>({
  scope: 'global',
  setScope: () => {},
})

export function ActiveScopeProvider({ children }: { children: ReactNode }) {
  const [scope, setScope] = useState<HotkeyScope>('global')
  return (
    <ActiveScopeContext.Provider value={{ scope, setScope }}>
      {children}
    </ActiveScopeContext.Provider>
  )
}

export function useActiveScope() {
  return useContext(ActiveScopeContext)
}
