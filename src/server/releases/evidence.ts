import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import type { DeploymentReceipt, RequiredTarget } from '../../shared/releaseReconciliation'
import { releasePull } from '../../shared/releases'
import { cmsandboxReceipts } from './cmsandbox'
import { readCoordinatorBundle } from './coordinatorStore'

const stamp = z.string().datetime({ offset: true })
const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
const https = z.string().url().refine(value => new URL(value).protocol === 'https:', 'Expected HTTPS evidence link')
const target = z.object({ target: z.string().min(1), component: z.string().min(1) })
const receipt = target.extend({
  id: z.string().min(1), repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).transform(value => value.toLowerCase()), environment: z.string(),
  deployedSha: sha.nullable(), artifactDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/).nullable(), version: z.string().nullable(),
  deployedAt: stamp, workflowUrl: https, receiptUrl: https,
  outcome: z.enum(['succeeded', 'failed', 'partial', 'skipped', 'rollback']), exceptions: z.array(z.string()).default([]),
})
const settingsSchema = z.object({
  version: z.literal(1),
  repositories: z.array(z.object({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/).transform(value => value.toLowerCase()), checkout: z.string().refine(value => value === 'github' || isAbsolute(value)) })).default([]),
  requirements: z.array(z.object({ pull: z.string().refine(value => !!releasePull(value)), targets: z.array(target).min(1), exceptions: z.array(z.string()).default([]) })).default([]),
  receiptFiles: z.array(z.string().refine(isAbsolute)).default([]),
  // Explicit historical review sources cannot authorize automatic writes.
  coordinatorSnapshots: z.array(z.object({ directory: z.string().refine(isAbsolute), collectedAt: stamp })).default([]),
  // A stale current-state snapshot cannot certify PROD after a later unobserved deployment.
  maxSnapshotAgeSeconds: z.number().positive().default(300),
})
export interface EvidenceRead {
  coordinatorSources?: Array<{ bundle: Awaited<ReturnType<typeof readCoordinatorBundle>>; asOf: string; historical: boolean }>
  status: 'fresh' | 'snapshot' | 'stale' | 'unconfigured' | 'error'
  collectedAt: string | null
  warnings: string[]
  receipts: DeploymentReceipt[]
  repositories: Map<string, string>
  requirements: Map<string, { targets: RequiredTarget[]; exceptions: string[] }>
}
async function readJson(path: string) {
  // Bound local export reads so a growing coordinator journal cannot exhaust the HTTP worker.
  if ((await stat(path)).size > 8 * 1024 * 1024) throw new Error('Receipt export exceeds 8 MiB; supply a bounded export')
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
export class ReleaseEvidenceReader {
  constructor(private root: string, private now = Date.now) {}
  async get(): Promise<EvidenceRead> {
    const result: EvidenceRead = { status: 'unconfigured', collectedAt: null, warnings: [], receipts: [], repositories: new Map(), requirements: new Map() }
    let raw: unknown
    try { raw = await readJson(join(this.root, 'releases', 'reconciliation.json')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') { result.warnings.push('Deployment evidence is not configured; no receipt can prove shipment'); return result }
      return { ...result, status: 'error', warnings: ['Release reconciliation configuration could not be read'] }
    }
    const parsed = settingsSchema.safeParse(raw)
    if (!parsed.success) return { ...result, status: 'error', warnings: ['Release reconciliation settings are invalid; check repository, target and receipt-file mappings'] }
    const settings = parsed.data
    for (const repo of settings.repositories) {
      if (result.repositories.has(repo.repository)) return { ...result, status: 'error', warnings: ['Repository checkout mapping is duplicated'] }
      result.repositories.set(repo.repository, repo.checkout)
    }
    for (const requirement of settings.requirements) {
      const identity = releasePull(requirement.pull)!
      if (result.requirements.has(identity.id)) return { ...result, status: 'error', warnings: [`Required-target mapping conflicts for ${identity.url}`] }
      result.requirements.set(identity.id, { targets: [...new Map(requirement.targets.map(target => [`${target.target}:${target.component}`, target])).values()], exceptions: requirement.exceptions })
    }
    if (!settings.receiptFiles.length && !settings.coordinatorSnapshots.length) { result.warnings.push('No production receipt files configured'); return result }
    result.status = 'fresh'
    const times: string[] = [], identities = new Map<string, string>()
    for (const file of settings.receiptFiles) {
      try {
        const raw = await readJson(file) as { schema?: unknown; collectedAt?: unknown }
        const collectedAt = stamp.parse(raw.collectedAt), time = Date.parse(collectedAt)
        times.push(collectedAt)
        if (time > this.now() + 60_000 || this.now() - time > settings.maxSnapshotAgeSeconds * 1000) {
          result.status = 'stale'; result.warnings.push('Production snapshot is stale or future-dated; refresh the current-state export')
        }
        const rows = raw.schema === 'tinstar.cmsandbox-production-export.v1' ? cmsandboxReceipts(raw)
          : z.object({ schema: z.literal('tinstar.deployment-receipts.v1'), receipts: z.array(receipt) }).parse(raw).receipts
        if (raw.schema === 'tinstar.cmsandbox-production-export.v1') (result.coordinatorSources ??= []).push({ bundle: raw as Awaited<ReturnType<typeof readCoordinatorBundle>>, asOf: collectedAt, historical: result.status !== 'fresh' })
        for (const row of rows) {
          const checked = receipt.parse(row), signature = JSON.stringify(checked), previous = identities.get(checked.id)
          if (previous && previous !== signature) throw new Error('Conflicting receipt identity')
          if (!previous) { identities.set(checked.id, signature); result.receipts.push(checked) }
        }
      } catch {
        result.status = 'error'; result.warnings.push('Production receipt export is unreadable, unsupported or conflicting; no shipment is certified')
      }
    }
    for (const snapshot of settings.coordinatorSnapshots) {
      try {
        const bundle = await readCoordinatorBundle(snapshot.directory)
        const rows = cmsandboxReceipts(bundle)
        ;(result.coordinatorSources ??= []).push({ bundle, asOf: snapshot.collectedAt, historical: true })
        times.push(snapshot.collectedAt)
        for (const row of rows) {
          const checked = receipt.parse(row), signature = JSON.stringify(checked), previous = identities.get(checked.id)
          if (previous && previous !== signature) throw new Error('Conflicting receipt identity')
          if (!previous) { identities.set(checked.id, signature); result.receipts.push(checked) }
        }
        if (result.status === 'fresh') result.status = 'snapshot'
        result.warnings.push(`Historical coordinator snapshot as of ${snapshot.collectedAt}; review only. It cannot certify current PROD or authorize automatic transitions.`)
      } catch { result.status = 'error'; result.warnings.push('Coordinator directory is unreadable or incomplete; no shipment is certified') }
    }
    result.collectedAt = times.sort((a, b) => Date.parse(a) - Date.parse(b))[0] ?? null
    return result
  }
}
