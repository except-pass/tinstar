import type { ActionSnapshot } from '../../shared/actions'

/** Only a selected PR's exact base ref + base SHA can establish a dependency.
 * Shared paths and model prose do not establish order; those targets serialize. */
export function coordinateTargets(targets: ActionSnapshot[]) {
  const dependencies = new Map(targets.map(target => [target.id, targets.filter(parent => parent.id !== target.id && parent.repository === target.repository && parent.headRepository === target.repository && parent.headRef === target.base && parent.head === target.baseHead)]))
  if ([...dependencies.values()].some(parents => parents.length > 1)) return { targets, plan: ['Ambiguous selected base/head identities; preserve selection order and serialize with fresh per-PR validation.'] }
  const ordered: ActionSnapshot[] = [], remaining = new Set(targets)
  const plan: string[] = []
  while (remaining.size) {
    const ready = [...remaining].find(target => dependencies.get(target.id)!.every(parent => ordered.includes(parent)))
    if (!ready) return { targets, plan: ['Dependency evidence is cyclic or ambiguous; preserve selection order and serialize with fresh per-PR validation.'] }
    remaining.delete(ready); ordered.push(ready)
    const parents = dependencies.get(ready.id)!
    plan.push(`${ready.url}: ${parents.length === 1 ? `after ${parents[0]!.url}; exact base-ref/base-SHA evidence` : 'dependency order unknown; serialized with fresh per-PR validation'}`)
  }
  return { targets: ordered, plan }
}
