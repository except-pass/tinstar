import { createContext, useContext, useReducer, useCallback, type ReactNode } from 'react'
import type { GroupingDimension, SelectionState } from '../domain/types'

// --- Actions ---

type SelectionAction =
  | { type: 'select'; id: string; entityType: GroupingDimension | 'run' }
  | { type: 'deselect' }
  | { type: 'hover'; id: string | null }
  | { type: 'toggleExpand'; id: string }
  | { type: 'expandAll'; ids: string[] }
  | { type: 'collapseAll' }

// --- Reducer ---

function selectionReducer(state: SelectionState, action: SelectionAction): SelectionState {
  switch (action.type) {
    case 'select':
      return {
        ...state,
        selectedId: action.id,
        selectedType: action.entityType,
      }
    case 'deselect':
      return {
        ...state,
        selectedId: null,
        selectedType: null,
      }
    case 'hover':
      return {
        ...state,
        hoveredId: action.id,
      }
    case 'toggleExpand': {
      const next = new Set(state.expandedIds)
      if (next.has(action.id)) {
        next.delete(action.id)
      } else {
        next.add(action.id)
      }
      return { ...state, expandedIds: next }
    }
    case 'expandAll': {
      const next = new Set(state.expandedIds)
      for (const id of action.ids) {
        next.add(id)
      }
      return { ...state, expandedIds: next }
    }
    case 'collapseAll':
      return { ...state, expandedIds: new Set() }
    default:
      return state
  }
}

// --- Context shape ---

interface SelectionContextValue {
  state: SelectionState
  select: (id: string, type: GroupingDimension | 'run') => void
  deselect: () => void
  hover: (id: string | null) => void
  toggleExpand: (id: string) => void
  expandAll: (ids: string[]) => void
  collapseAll: () => void
  isSelected: (id: string) => boolean
  isExpanded: (id: string) => boolean
  isHovered: (id: string) => boolean
}

const initialState: SelectionState = {
  selectedId: null,
  selectedType: null,
  expandedIds: new Set(),
  hoveredId: null,
}

export const SelectionContext = createContext<SelectionContextValue | null>(null)

// --- Provider ---

export function SelectionProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(selectionReducer, initialState)

  const select = useCallback(
    (id: string, type: GroupingDimension | 'run') =>
      dispatch({ type: 'select', id, entityType: type }),
    [],
  )

  const deselect = useCallback(() => dispatch({ type: 'deselect' }), [])

  const hover = useCallback(
    (id: string | null) => dispatch({ type: 'hover', id }),
    [],
  )

  const toggleExpand = useCallback(
    (id: string) => dispatch({ type: 'toggleExpand', id }),
    [],
  )

  const expandAll = useCallback(
    (ids: string[]) => dispatch({ type: 'expandAll', ids }),
    [],
  )

  const collapseAll = useCallback(() => dispatch({ type: 'collapseAll' }), [])

  const isSelected = useCallback(
    (id: string) => state.selectedId === id,
    [state.selectedId],
  )

  const isExpanded = useCallback(
    (id: string) => state.expandedIds.has(id),
    [state.expandedIds],
  )

  const isHovered = useCallback(
    (id: string) => state.hoveredId === id,
    [state.hoveredId],
  )

  const value: SelectionContextValue = {
    state,
    select,
    deselect,
    hover,
    toggleExpand,
    expandAll,
    collapseAll,
    isSelected,
    isExpanded,
    isHovered,
  }

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  )
}

// --- Hook ---

export function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext)
  if (!ctx) {
    throw new Error('useSelection must be used within a SelectionProvider')
  }
  return ctx
}
