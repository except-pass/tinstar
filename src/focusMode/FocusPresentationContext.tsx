import { createContext, useContext, type ReactNode } from 'react'

export type FocusPresentation = 'canvas' | 'focus'

const FocusPresentationContext = createContext<FocusPresentation>('canvas')

export function FocusPresentationProvider({
  value,
  children,
}: {
  value: FocusPresentation
  children: ReactNode
}) {
  return (
    <FocusPresentationContext.Provider value={value}>
      {children}
    </FocusPresentationContext.Provider>
  )
}

export function useFocusPresentation(): FocusPresentation {
  return useContext(FocusPresentationContext)
}
