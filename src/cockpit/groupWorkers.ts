/** Overview grouping the browser can apply from fields already on each worker. */
export const groupDimensions = ['status', 'project'] as const
export type GroupDimension = (typeof groupDimensions)[number]
export const groupDimensionLabels: Record<GroupDimension, string> = {
  status: 'Status',
  project: 'Project',
}

export interface GroupChoice {
  primary: GroupDimension
  secondary: GroupDimension
}

export interface GroupableWorker {
  state: string
  project: string
}

export interface WorkerGroup<T> {
  value: string
  workers: T[]
  groups: WorkerGroup<T>[]
}

/** One browser profile remembers its own overview grouping. */
export const groupChoiceKey = 'tinstar-cockpit-group-by'

export const defaultGroupChoice: GroupChoice = { primary: 'status', secondary: 'project' }

export function isGroupDimension(value: unknown): value is GroupDimension {
  return groupDimensions.some(dimension => dimension === value)
}

export function applyGroupChoice(current: GroupChoice, which: 'primary' | 'secondary', value: GroupDimension): GroupChoice {
  if (which === 'primary') {
    return { primary: value, secondary: value === current.secondary ? current.primary : current.secondary }
  }
  return { primary: value === current.primary ? current.secondary : current.primary, secondary: value }
}

export function browserGroupStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function readGroupChoice(storage: Pick<Storage, 'getItem'> | null): GroupChoice {
  if (!storage) return defaultGroupChoice
  try {
    const parsed = JSON.parse(storage.getItem(groupChoiceKey) ?? '') as { primary?: unknown; secondary?: unknown }
    if (!isGroupDimension(parsed.primary) || !isGroupDimension(parsed.secondary) || parsed.primary === parsed.secondary) {
      return defaultGroupChoice
    }
    return { primary: parsed.primary, secondary: parsed.secondary }
  } catch {
    return defaultGroupChoice
  }
}

export function writeGroupChoice(storage: Pick<Storage, 'setItem'> | null, choice: GroupChoice): void {
  try { storage?.setItem(groupChoiceKey, JSON.stringify(choice)) } catch { /* private mode has no durable store */ }
}

function valueOf(worker: GroupableWorker, dimension: GroupDimension): string {
  return dimension === 'status' ? worker.state : worker.project
}

/** Groups in first-seen order. A repeated dimension stays one level. */
export function groupWorkers<T extends GroupableWorker>(workers: T[], primary: GroupDimension, secondary: GroupDimension): WorkerGroup<T>[] {
  const outer = new Map<string, T[]>()
  for (const worker of workers) {
    const value = valueOf(worker, primary)
    const list = outer.get(value)
    if (list) list.push(worker)
    else outer.set(value, [worker])
  }
  return [...outer].map(([value, members]) => {
    if (secondary === primary) return { value, workers: members, groups: [] }
    const inner = new Map<string, T[]>()
    for (const worker of members) {
      const innerValue = valueOf(worker, secondary)
      const list = inner.get(innerValue)
      if (list) list.push(worker)
      else inner.set(innerValue, [worker])
    }
    return {
      value,
      workers: members,
      groups: [...inner].map(([innerValue, innerMembers]) => ({ value: innerValue, workers: innerMembers, groups: [] })),
    }
  })
}
