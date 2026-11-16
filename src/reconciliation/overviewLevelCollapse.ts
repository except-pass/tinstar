import type { FloorGroup, Organizer } from '../shared/floorOrganization'
import { semanticId } from './presentation'

/** One bulk control. Ids are the semantic group ids for that level only. */
export interface LevelControl {
  ids: string[]
  action: 'collapse' | 'expand'
  disabled: boolean
  name: string
}

const groupKey = (id: string) => semanticId({ kind: 'group', id })

/**
 * Initiative and epic bulk toggles for the groups currently on the Overview tree.
 * Collapsing a level only adds that level's ids, so a parent's children keep the
 * expansion they had before the parent was closed.
 */
export function overviewLevelControls(groups: readonly FloorGroup[], collapsed: readonly string[], organizer?: Organizer): { initiatives: LevelControl; epics: LevelControl } {
  const nested = !!organizer && organizer.inner !== 'none'
  const initiativeIds = organizer?.outer === 'initiative' ? [...new Set(groups.map(group => nested ? group.outerId : group.id))].map(groupKey) : []
  const epicIds = organizer?.inner === 'epic' && nested
    ? [...new Set(groups.filter(group => !collapsed.includes(groupKey(group.outerId))).map(group => group.id))].map(groupKey)
    : []
  const parentsCollapsed = organizer?.outer === 'initiative' && organizer.inner === 'epic' && nested && groups.length > 0 && groups.every(group => collapsed.includes(groupKey(group.outerId)))
  return {
    initiatives: control('Initiatives', initiativeIds, collapsed),
    epics: control('Epics', epicIds, collapsed, parentsCollapsed ? 'Epics — no visible groups. Expand an initiative first.' : undefined),
  }
}

function control(level: string, ids: string[], collapsed: readonly string[], disabledName?: string): LevelControl {
  const anyExpanded = ids.some(id => !collapsed.includes(id))
  const disabled = ids.length === 0
  const action = anyExpanded ? 'collapse' : 'expand'
  return { ids, action, disabled, name: disabled ? disabledName ?? `${level} — no visible groups` : `${level} — ${action} all` }
}

/** Same collapsed-set result as one set-expanded per id. Other ids stay put. */
export function nextLevelCollapsed(collapsed: readonly string[], ids: readonly string[], action: 'collapse' | 'expand'): string[] {
  if (action === 'expand') {
    const drop = new Set(ids)
    return collapsed.filter(id => !drop.has(id))
  }
  return [...new Set([...collapsed, ...ids])]
}
