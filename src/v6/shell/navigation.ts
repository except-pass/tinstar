export type ViewId =
  | { kind: 'portfolio' }
  | { kind: 'epic'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'worker'; id: string }

export interface History {
  current: ViewId
  past: ViewId[]
}

export interface ShellNav {
  selectedWorkerId: string | null
  history: History
}

export function compareWorkerId(a: string, b: string): number {
  if (a < b) return -1
  if (a > b) return 1
  return 0
}

export function initialNav(): ShellNav {
  return {
    selectedWorkerId: null,
    history: { current: { kind: 'portfolio' }, past: [] },
  }
}

/** First sight of the worker list. A later refresh must not call this again. */
export function adoptWorkers(state: ShellNav, ids: readonly string[]): ShellNav {
  const sorted = [...ids].sort(compareWorkerId)
  if (sorted.length === 0) return state
  if (state.selectedWorkerId && sorted.includes(state.selectedWorkerId)) return state
  const id = sorted[0]!
  const untouched = state.selectedWorkerId === null
    && state.history.past.length === 0
    && state.history.current.kind === 'portfolio'
  if (untouched) {
    return { selectedWorkerId: id, history: { current: { kind: 'worker', id }, past: [] } }
  }
  return { ...state, selectedWorkerId: id }
}

export function cycleWorkerId(ids: readonly string[], currentId: string | null, dir: 1 | -1): string | null {
  const sorted = [...ids].sort(compareWorkerId)
  if (sorted.length === 0) return null
  if (!currentId || !sorted.includes(currentId)) {
    return dir === 1 ? sorted[0]! : sorted[sorted.length - 1]!
  }
  const index = sorted.indexOf(currentId)
  return sorted[(index + dir + sorted.length) % sorted.length]!
}

export function selectWorker(state: ShellNav, id: string): ShellNav {
  if (state.history.current.kind === 'worker') {
    return { selectedWorkerId: id, history: { ...state.history, current: { kind: 'worker', id } } }
  }
  return {
    selectedWorkerId: id,
    history: {
      current: { kind: 'worker', id },
      past: [...state.history.past, state.history.current],
    },
  }
}

export function cycleSelection(state: ShellNav, ids: readonly string[], dir: 1 | -1): ShellNav {
  const nextId = cycleWorkerId(ids, state.selectedWorkerId, dir)
  if (!nextId || nextId === state.selectedWorkerId && state.history.current.kind === 'worker') {
    if (!nextId) return state
    if (state.history.current.kind === 'worker' && state.history.current.id === nextId) return state
  }
  if (!nextId) return state
  if (state.history.current.kind === 'worker') {
    return {
      selectedWorkerId: nextId,
      history: { ...state.history, current: { kind: 'worker', id: nextId } },
    }
  }
  return {
    selectedWorkerId: nextId,
    history: {
      current: { kind: 'worker', id: nextId },
      past: [...state.history.past, state.history.current],
    },
  }
}

/** One step from whatever is showing to the portfolio. Does not visit task or epic. */
export function jumpBoard(state: ShellNav): ShellNav {
  if (state.history.current.kind === 'portfolio') return state
  return {
    ...state,
    history: {
      current: { kind: 'portfolio' },
      past: [...state.history.past, state.history.current],
    },
  }
}

export function goBack(state: ShellNav): ShellNav {
  const past = state.history.past
  if (past.length === 0) return state
  const current = past[past.length - 1]!
  return {
    selectedWorkerId: current.kind === 'worker' ? current.id : state.selectedWorkerId,
    history: { current, past: past.slice(0, -1) },
  }
}
