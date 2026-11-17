import { floorFields, type FloorField, type FloorGroup, type Organizer } from '../shared/floorOrganization'
import { semanticId } from './presentation'

/** One bulk control. Ids are the semantic group ids for that depth only. */
export interface LevelControl {
  ids: string[]
  action: 'collapse' | 'expand'
  disabled: boolean
  name: string
}

const groupKey = (id: string) => semanticId({ kind: 'group', id })

const levelTitles = {
  manager: 'Managers',
  machine: 'Machines',
  workerStatus: 'Worker statuses',
  activity: 'Last activity',
  initiative: 'Initiatives',
  epic: 'Epics',
  status: 'Task statuses',
  owner: 'Task owners',
  priority: 'Priorities',
  checkIn: 'Next check-ins',
  due: 'Due dates',
  edited: 'Last edited',
  area: 'Areas',
  subArea: 'Sub-areas',
  none: 'Groups',
} as const satisfies Record<FloorField | 'none', string>

function levelTitle(id: FloorField | 'none' | undefined): string {
  return id ? levelTitles[id] : 'Groups'
}

/** Sentence noun for "expand a machine first" style prompts. */
function levelNoun(id: FloorField | 'none' | undefined): string {
  if (!id || id === 'none') return 'group'
  return floorFields.find(field => field.id === id)?.label.toLowerCase() ?? 'group'
}

/**
 * Outer and inner bulk toggles for the groups currently on the Overview tree.
 * Depth follows the current organizer: level one is every top-level group,
 * level two is every second-level group inside an expanded parent.
 * Collapsing a level only adds that level's ids, so a parent's children keep the
 * expansion they had before the parent was closed.
 */
export function overviewLevelControls(groups: readonly FloorGroup[], collapsed: readonly string[], organizer?: Organizer): { outer: LevelControl; inner: LevelControl } {
  const nested = !!organizer && organizer.inner !== 'none'
  const outerTitle = levelTitle(organizer?.outer)
  const innerTitle = levelTitle(organizer?.inner)
  const outerIds = organizer
    ? [...new Set(groups.map(group => nested ? group.outerId : group.id))].map(groupKey)
    : []
  const innerIds = nested
    ? [...new Set(groups.filter(group => !collapsed.includes(groupKey(group.outerId))).map(group => group.id))].map(groupKey)
    : []
  const parentsCollapsed = nested && groups.length > 0 && groups.every(group => collapsed.includes(groupKey(group.outerId)))
  const noun = levelNoun(organizer?.outer)
  const article = /^[aeiou]/i.test(noun) ? 'an' : 'a'
  return {
    outer: control(outerTitle, outerIds, collapsed),
    inner: control(innerTitle, innerIds, collapsed, !nested
      ? 'No second level in this organizer'
      : parentsCollapsed ? `${innerTitle} — no visible groups. Expand ${article} ${noun} first.` : undefined),
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
