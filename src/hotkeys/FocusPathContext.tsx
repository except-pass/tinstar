import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'

export interface FocusNode {
  id: string
  type: string
  label: string
}

interface FocusPathValue {
  path: FocusNode[]
  pushFocus: (node: FocusNode) => void
  popFocus: () => void
}

const FocusPathContext = createContext<FocusPathValue>({
  path: [],
  pushFocus: () => {},
  popFocus: () => {},
})

export function FocusPathProvider({ children }: { children: ReactNode }) {
  const [path, setPath] = useState<FocusNode[]>([])
  const pushFocus = useCallback((node: FocusNode) => {
    setPath(prev => [...prev, node])
  }, [])
  const popFocus = useCallback(() => {
    setPath(prev => prev.slice(0, -1))
  }, [])
  return (
    <FocusPathContext.Provider value={{ path, pushFocus, popFocus }}>
      {children}
    </FocusPathContext.Provider>
  )
}

export function useFocusPath() {
  return useContext(FocusPathContext)
}
