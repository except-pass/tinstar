// Shared project shape and picker helpers.
//
// Projects are registered in projects.json (server-side) as
// { path, starred, hidden, order } objects. The client fetches them via
// GET /api/projects as a name -> metadata map. These helpers give the pickers
// (New Session, Entity Settings) and the Settings management list a single
// source of truth for parsing, filtering, sorting, and grouping.

export interface Project {
  name: string
  path: string
  starred: boolean
  hidden: boolean
  order: number
}

type RawProjectValue = string | { path: string; starred?: boolean; hidden?: boolean; order?: number }

/**
 * Parse the GET /api/projects response map into Project objects. Tolerates the
 * legacy string-valued form (path only) so a client talking to an un-upgraded
 * backend still renders. Order falls back to map position when absent.
 */
export function parseProjects(data: Record<string, RawProjectValue> | null | undefined): Project[] {
  if (!data || typeof data !== 'object') return []
  return Object.entries(data).map(([name, value], index) => {
    if (typeof value === 'string') {
      return { name, path: value, starred: false, hidden: false, order: index }
    }
    return {
      name,
      path: value.path,
      starred: value.starred ?? false,
      hidden: value.hidden ?? false,
      order: value.order ?? index,
    }
  })
}

/** Projects sorted by order ascending (stable), regardless of starred/hidden. */
export function sortByOrder(projects: Project[]): Project[] {
  return [...projects].sort((a, b) => a.order - b.order)
}

/**
 * Compute the new name order after dropping `source` onto `target`.
 * Direction-aware: dragging downward inserts AFTER the target (so an item can
 * reach the last slot); dragging upward inserts BEFORE it. Returns the input
 * unchanged when source === target or either name is absent.
 */
export function reorderByDrop(names: string[], source: string, target: string): string[] {
  if (source === target) return names
  const from = names.indexOf(source)
  const to = names.indexOf(target)
  if (from < 0 || to < 0) return names
  const next = [...names]
  next.splice(from, 1)
  // Insert at the target's ORIGINAL index: after removing an earlier source the
  // item lands after the target (downward); for a later source, before it (up).
  next.splice(to, 0, source)
  return next
}

/**
 * Picker view: hidden projects dropped, remaining sorted by order and split
 * into a starred "Favorites" group and the rest. Used by the read-only pickers.
 */
export function groupForPicker(projects: Project[]): { favorites: Project[]; others: Project[] } {
  const visible = sortByOrder(projects.filter(p => !p.hidden))
  return {
    favorites: visible.filter(p => p.starred),
    others: visible.filter(p => !p.starred),
  }
}
