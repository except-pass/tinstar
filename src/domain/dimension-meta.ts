import type { LevelLabel } from './types'

export interface DimensionMeta {
  key: string
  label: string
  icon: string
}

export const DEFAULT_LEVELS: LevelLabel[] = [
  { icon: 'folder', label: 'Project' },
  { icon: 'account_tree', label: 'Worktree' },
]

export const DIMENSION_REGISTRY: DimensionMeta[] = [
  { key: 'project', label: 'Project', icon: 'folder' },
  { key: 'worktree', label: 'Worktree', icon: 'account_tree' },
  { key: 'unscoped', label: 'Unscoped', icon: 'filter_none' },
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
