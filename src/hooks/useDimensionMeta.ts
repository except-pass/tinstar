import { useMemo } from 'react'
import type { LevelLabel } from '../domain/types'
import { DEFAULT_LEVELS } from '../domain/dimension-meta'
import { useBackendState } from './useBackendState'

export interface LevelMeta {
  internalType: 'initiative' | 'epic' | 'task'
  label: string
  plural: string
  icon: string
  index: number
}

const INTERNAL_TYPES: ('initiative' | 'epic' | 'task')[] = ['initiative', 'epic', 'task']

export function autoPlural(word: string): string {
  if (!word) return ''
  if (word.match(/[sxz]$/i) || word.match(/[cs]h$/i)) return word + 'es'
  if (word.match(/[^aeiou]y$/i)) return word.slice(0, -1) + 'ies'
  return word + 's'
}

function resolveLevels(levels: LevelLabel[]): LevelMeta[] {
  // levels.length 1–3; always maps to bottom N of ['initiative','epic','task']
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
  const { spaces, activeSpaceId } = useBackendState()
  return useMemo(() => {
    const space = spaces.find(s => s.id === activeSpaceId)
    const levels = space?.labelConfig?.levels
    if (!levels || levels.length === 0) return resolveLevels(DEFAULT_LEVELS)
    return resolveLevels(levels)
  }, [spaces, activeSpaceId])
}

/** Non-hook version for components that receive LevelMeta[] as a prop */
export function resolveStaticMeta(levels?: LevelLabel[]): LevelMeta[] {
  return resolveLevels(levels && levels.length > 0 ? levels : DEFAULT_LEVELS)
}
