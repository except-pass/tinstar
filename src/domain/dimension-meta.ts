export interface DimensionMeta {
  key: string
  label: string
  icon: string
}

export const DIMENSION_REGISTRY: DimensionMeta[] = [
  { key: 'initiative', label: 'Initiative', icon: '🚀' },
  { key: 'epic', label: 'Epic', icon: '🏔️' },
  { key: 'task', label: 'Task', icon: '🗂️' },
  { key: 'worktree', label: 'Worktree', icon: '🌿' },
  { key: 'run', label: 'Run', icon: '▶' },
]

const registry = new Map(DIMENSION_REGISTRY.map(d => [d.key, d]))

export function getDimensionMeta(key: string): DimensionMeta | undefined {
  return registry.get(key)
}

export function getDimensionLabel(key: string): string {
  return registry.get(key)?.label ?? key
}

export function getDimensionIcon(key: string): string {
  return registry.get(key)?.icon ?? ''
}
