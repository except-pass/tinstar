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
})
export type FleetSource = z.infer<typeof fleetSource>
const fleetSchema = z.array(fleetSource).max(32)
const notionSchema = z.object({
  dataSourceId: z.string().regex(/^[a-fA-F0-9-]{32,36}$/),
  token: z.string().min(1),
})
const jiraSchema = z.object({
  // These restrictions protect real Jira projects during the authorized pilot.
  url: z.literal('https://fortresspower-jira.atlassian.net'),
  projectId: z.literal('10638'),
  email: z.string().min(1), token: z.string().min(1),
})
export type JiraConfig = z.infer<typeof jiraSchema>
export interface ReconciliationConfig { fleet: FleetSource[]; notion?: z.infer<typeof notionSchema>; jira?: JiraConfig; warnings: string[] }

export function loadReconciliationConfig(root = getConfigRoot()): ReconciliationConfig {
  try {
    const raw = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))
    const warnings: string[] = []
    const legacyHomes = Array.isArray(raw.firstmate?.homes)
      ? raw.firstmate.homes.filter((home: unknown): home is string => typeof home === 'string' && isAbsolute(home)).map((home: string) => ({ home })) : []
    const parsedFleet = fleetSchema.safeParse(raw.reconciliation?.fleet ?? legacyHomes)
    let fleet = parsedFleet.success ? parsedFleet.data : []
    if (!parsedFleet.success) warnings.push('Invalid reconciliation fleet configuration; check absolute paths and the 32-home collection bound')
    if (new Set(fleet.map(source => source.home)).size !== fleet.length) {
      warnings.push('Configure each First Mate home once')
      fleet = []
    }
    // Independent credentials/config errors must not hide readable fleet data.
    const parsedNotion = notionSchema.optional().safeParse(raw.reconciliation?.notion)
    if (!parsedNotion.success) warnings.push('Invalid reconciliation Notion settings; configure dataSourceId and token')
    const jira = raw.reconciliation?.jira
    const parsedJira = jiraSchema.optional().safeParse(jira ? { ...jira,
      email: process.env.TINSTAR_JIRA_EMAIL ?? jira.email, token: process.env.TINSTAR_JIRA_TOKEN ?? jira.token } : undefined)
    if (!parsedJira.success) warnings.push('Invalid Jira pilot settings; configure the authorized TSSPIKE site/project and credentials')
    return { fleet, notion: parsedNotion.success ? parsedNotion.data : undefined, jira: parsedJira.success ? parsedJira.data : undefined, warnings }
  } catch (error) {
    return { fleet: [], warnings: [(error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'Tin Star config.json is absent; sources are not configured' : 'Tin Star config.json could not be read'] }
  }
}
