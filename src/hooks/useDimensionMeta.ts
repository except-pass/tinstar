import type { LevelLabel } from '../domain/types'
import { DEFAULT_LEVELS } from '../domain/dimension-meta'

export interface LevelMeta {
  internalType: 'project' | 'worktree'
  label: string
  plural: string
  icon: string
  index: number
}

const INTERNAL_TYPES: ('project' | 'worktree')[] = ['project', 'worktree']

export function autoPlural(word: string): string {
  if (!word) return ''
  if (word.match(/[sxz]$/i) || word.match(/[cs]h$/i)) return word + 'es'
  if (word.match(/[^aeiou]y$/i)) return word.slice(0, -1) + 'ies'
  return word + 's'
}

function resolveLevels(levels: LevelLabel[]): LevelMeta[] {
  // Organizational scope has one fixed hierarchy in v1.
  const offset = INTERNAL_TYPES.length - levels.length
  return levels.map((lvl, i) => ({
    internalType: INTERNAL_TYPES[offset + i]!,
    label: lvl.label,
    plural: lvl.plural?.trim() || autoPlural(lvl.label),
    icon: lvl.icon,
    index: i,
  }))
}

export function useDimensionMeta(): LevelMeta[] {
  return resolveLevels(DEFAULT_LEVELS)
}

/** Non-hook version for components that receive LevelMeta[] as a prop */
export function resolveStaticMeta(levels?: LevelLabel[]): LevelMeta[] {
  return resolveLevels(levels && levels.length > 0 ? levels : DEFAULT_LEVELS)
}
