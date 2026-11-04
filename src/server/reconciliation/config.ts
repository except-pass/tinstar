import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { getConfigRoot } from '../configRoot'

const absolutePath = z.string().refine(isAbsolute, 'expected an absolute path')
const fleetSource = z.object({
  home: absolutePath,
  label: z.string().optional(),
  machine: z.string().min(1).optional(),
  parentHome: absolutePath.optional(),
  snapshotFile: absolutePath.optional(),
  maxAgeSeconds: z.number().int().min(30).max(3600).optional(),
})
export type FleetSource = z.infer<typeof fleetSource>
const fleetSchema = z.array(fleetSource).max(32)
const notionSchema = z.object({
  dataSourceId: z.string().regex(/^[a-fA-F0-9-]{32,36}$/),
  token: z.string().min(1),
})
export interface ReconciliationConfig { fleet: FleetSource[]; notion?: z.infer<typeof notionSchema>; warnings: string[] }

export function loadReconciliationConfig(root = getConfigRoot()): ReconciliationConfig {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
    const warnings: string[] = []
    const legacyHomes = Array.isArray(raw.firstmate?.homes)
      ? raw.firstmate.homes.filter((home: unknown): home is string => typeof home === 'string' && isAbsolute(home)).map((home: string) => ({ home })) : []
    const parsedFleet = fleetSchema.safeParse(raw.reconciliation?.fleet ?? legacyHomes)
    let fleet = parsedFleet.success ? parsedFleet.data : []
    if (!parsedFleet.success) warnings.push('Invalid reconciliation fleet configuration; check absolute paths, the 32-home collection bound, and maxAgeSeconds (30–3600 integer seconds)')
    if (new Set(fleet.map(source => source.home)).size !== fleet.length) {
      warnings.push('Configure each First Mate home once')
      fleet = []
    }
    // Independent credentials/config errors must not hide readable fleet data.
    const parsedNotion = notionSchema.optional().safeParse(raw.reconciliation?.notion)
    if (!parsedNotion.success) warnings.push('Invalid reconciliation Notion settings; configure dataSourceId and token')
    return { fleet, notion: parsedNotion.success ? parsedNotion.data : undefined, warnings }
  } catch (error) {
    return { fleet: [], warnings: [(error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'Tin Star config.json is absent; sources are not configured' : 'Tin Star config.json could not be read'] }
  }
}
