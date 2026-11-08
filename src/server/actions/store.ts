import { mkdir, readFile, readdir, rename, open, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { candidateSchema, type ActionCandidate, type InstalledAction, type ActionReceipt } from '../../shared/actions'
import { getConfigRoot } from '../configRoot'
import { acquireLock } from '../infra/lock'
import { sourceDigest } from './examples'

const identifier = (value: string) => { if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error('Invalid action identifier'); return value }
async function durable(path: string, data: unknown) {
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(JSON.stringify(data, null, 2) + '\n'); await file.sync() } finally { await file.close() }
}
async function atomic(path: string, data: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`
  try { await durable(temporary, data); await rename(temporary, path) } finally { await rm(temporary, { force: true }) }
}
export class ActionStore {
  constructor(readonly root = resolve(process.env.TINSTAR_ACTIONS_DIR || join(getConfigRoot(), 'actions'))) {}
  private action(id: string) { return join(this.root, identifier(id)) }
  async install(input: ActionCandidate, actor: string): Promise<InstalledAction> {
    const candidate = candidateSchema.parse(input)
    if (['runs', 'locks'].includes(candidate.manifest.id)) throw new Error('Action ID is reserved for registry storage')
    if (!actor || sourceDigest(candidate.source) !== candidate.manifest.digest) throw new Error('Reviewed source digest does not match candidate')
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const unlock = await acquireLock(join(this.root, 'registry.lock'))
    const { id, version } = candidate.manifest
    const directory = join(this.action(id), 'versions', version)
    try {
      let predecessor: string | null = null
      try { predecessor = JSON.parse(await readFile(join(this.action(id), 'active.json'), 'utf8')).version } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      await mkdir(join(this.action(id), 'versions'), { recursive: true })
      // One immutable directory prevents grants/source being overwritten under a running version.
      await mkdir(directory)
      const at = new Date().toISOString(), manifest = candidate.manifest
      const installed: InstalledAction = { ...candidate, predecessor, installedAt: at,
        grant: { actor, at, version, digest: manifest.digest, capabilities: [...manifest.capabilities], repositories: [...manifest.repositories], branches: [...manifest.branches], paths: [...manifest.paths] } }
      const file = await open(join(directory, 'implementation.mjs'), 'wx', 0o600)
      try { await file.writeFile(candidate.source); await file.sync() } finally { await file.close() }
      await durable(join(directory, 'manifest.json'), candidate.manifest)
      await durable(join(directory, 'installation.json'), installed)
      await this.event({ kind: 'installed', id, version, actor, at, predecessor })
      await atomic(join(this.action(id), 'active.json'), { version })
      return installed
    } finally { await unlock() }
  }
  async inspect(id: string, version?: string): Promise<InstalledAction> {
    const directory = this.action(id)
    const selected = identifier(version ?? JSON.parse(await readFile(join(directory, 'active.json'), 'utf8')).version)
    const installed: InstalledAction = JSON.parse(await readFile(join(directory, 'versions', selected, 'installation.json'), 'utf8'))
    const source = await readFile(join(directory, 'versions', selected, 'implementation.mjs'), 'utf8')
    const manifest = candidateSchema.shape.manifest.parse(JSON.parse(await readFile(join(directory, 'versions', selected, 'manifest.json'), 'utf8')))
    if (manifest.id !== id || manifest.version !== selected || JSON.stringify(manifest) !== JSON.stringify(installed.manifest) || source !== installed.source || sourceDigest(source) !== installed.grant.digest || installed.grant.version !== selected) throw new Error('Installed version/grant/source binding changed; reinstall an inspected version')
    return installed
  }
  async rollback(id: string, version: string, actor: string) {
    const unlock = await acquireLock(join(this.root, 'registry.lock'))
    try {
      await this.inspect(id, identifier(version))
      await this.event({ kind: 'rollback', id, version, actor, at: new Date().toISOString() })
      await atomic(join(this.action(id), 'active.json'), { version })
    } finally { await unlock() }
  }
  async versions(id: string): Promise<string[]> { return (await readdir(join(this.action(id), 'versions'))).filter(value => /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) }
  async list(): Promise<InstalledAction[]> {
    let dirs
    try { dirs = await readdir(this.root, { withFileTypes: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const result: InstalledAction[] = []
    for (const dir of dirs) if (dir.isDirectory() && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(dir.name) && !['runs', 'locks'].includes(dir.name)) {
      // Corrupt installed code is visible as an API error, never silently run.
      result.push(await this.inspect(dir.name))
    }
    return result
  }
  private async event(event: unknown) {
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const file = await open(join(this.root, 'registry-events.jsonl'), 'a', 0o600)
    try { await file.writeFile(JSON.stringify(event) + '\n'); await file.sync() } finally { await file.close() }
  }
  async append(receipt: ActionReceipt) {
    const directory = join(this.root, 'runs', identifier(receipt.runId))
    await mkdir(directory, { recursive: true, mode: 0o700 })
    // Append-only fsynced events preserve earlier per-PR results. A torn audit
    // fails reads closed rather than silently authorizing a retry.
    const file = await open(join(directory, 'events.jsonl'), 'a', 0o600)
    try { await file.writeFile(JSON.stringify(receipt) + '\n'); await file.sync() } finally { await file.close() }
  }
  async receipts(): Promise<ActionReceipt[]> {
    let runs: string[]
    try { runs = await readdir(join(this.root, 'runs')) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
    const latest = new Map<string, ActionReceipt>()
    for (const run of runs) {
      const lines = (await readFile(join(this.root, 'runs', run, 'events.jsonl'), 'utf8')).trim().split('\n')
      for (const line of lines) { const event: ActionReceipt = JSON.parse(line); latest.set(event.id, event) }
    }
    return [...latest.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt))
  }
  async reconcileInterrupted() {
    for (const receipt of await this.receipts()) if (receipt.outcome === 'intent') await this.append({ ...receipt, outcome: 'unknown', finishedAt: new Date().toISOString(), reasons: [...receipt.reasons, 'Process restarted before completion; provider reconciliation required before retry. No automatic retry.'] })
  }
}
