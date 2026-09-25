import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseWorkerDescriptor, snapshotTaskObjects, type WorkerDescriptor } from '../../../v6/contract/descriptor'
import {
  defaultFmRunner,
  fmChildEnv,
  snapshotScript,
  type FmCommandRunner,
} from './fmExec'
import { absentObservation, observeLedgerFile, type LedgerObservation } from './ledger'

export interface UnobservedWorker {
  id: string
  health: 'unknown'
  completion: 'unknown'
  reason: string
}

export interface WorkerList {
  configured: boolean
  workers: WorkerDescriptor[]
  diagnostics: string[]
  /** Ledger fold. It does not add workers and does not set health or completion. */
  observation: LedgerObservation
  /** Meta ids whose snapshot read failed. Not marked done or alive. */
  unobserved: UnobservedWorker[]
}

function stampFixture(worker: WorkerDescriptor, fixture: boolean): WorkerDescriptor {
  if (!fixture || worker.fixture) return worker
  return { ...worker, fixture: true }
}

/** Ids from meta filenames. The files themselves are not opened. */
export function metaIds(home: string): string[] {
  let names: string[]
  try {
    names = readdirSync(join(home, 'state'))
  } catch {
    return []
  }
  return names
    .filter(name => name.endsWith('.meta') && !name.startsWith('.'))
    .map(name => name.slice(0, -'.meta'.length))
    .filter(id => /^[A-Za-z0-9._-]+$/.test(id))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
}

function parseTasks(raw: unknown, fixture: boolean, diagnostics: string[]): WorkerDescriptor[] {
  const workers: WorkerDescriptor[] = []
  for (const task of snapshotTaskObjects(raw)) {
    const parsed = parseWorkerDescriptor(task)
    if (!parsed.ok) {
      diagnostics.push(parsed.diagnostic)
      continue
    }
    workers.push(stampFixture(parsed.value, fixture))
  }
  workers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return workers
}

async function execSnapshot(
  runner: FmCommandRunner,
  binDir: string,
  home: string,
  args: string[],
) {
  return runner.exec(snapshotScript(binDir), args, fmChildEnv(home))
}

export async function readTaskDescriptor(input: {
  home: string
  binDir: string
  id: string
  runner?: FmCommandRunner
  fixture?: boolean
}): Promise<{ descriptor: WorkerDescriptor | null; diagnostic: string | null; taskSupported: boolean; notFound: boolean }> {
  if (!/^[A-Za-z0-9._-]+$/.test(input.id)) {
    return { descriptor: null, diagnostic: 'bad worker id', taskSupported: true, notFound: true }
  }
  const runner = input.runner ?? defaultFmRunner
  const result = await execSnapshot(runner, input.binDir, input.home, ['--task', input.id, '--json'])
  const unsupported = result.code === 2 && /usage: fm-fleet-snapshot/.test(`${result.stderr}\n${result.stdout}`)
  if (unsupported) {
    return { descriptor: null, diagnostic: 'snapshot --task is not available', taskSupported: false, notFound: false }
  }
  if (result.code !== 0) {
    const notFound = /"found"\s*:\s*false/.test(result.stdout) || /"reason"\s*:\s*"not-found"/.test(result.stdout)
    return {
      descriptor: null,
      diagnostic: result.stderr.trim() || `snapshot --task exited ${result.code}`,
      taskSupported: true,
      notFound,
    }
  }
  try {
    const parsed = parseWorkerDescriptor(JSON.parse(result.stdout) as unknown)
    if (!parsed.ok) return { descriptor: null, diagnostic: parsed.diagnostic, taskSupported: true, notFound: false }
    if (parsed.value.id !== input.id) {
      return { descriptor: null, diagnostic: 'snapshot --task returned a different worker', taskSupported: true, notFound: false }
    }
    return { descriptor: stampFixture(parsed.value, input.fixture === true), diagnostic: null, taskSupported: true, notFound: false }
  } catch {
    return { descriptor: null, diagnostic: 'snapshot --task was not JSON', taskSupported: true, notFound: false }
  }
}

function readingsAgree(a: WorkerDescriptor, b: WorkerDescriptor): boolean {
  return a.crewState === b.crewState
    && a.spawnGen === b.spawnGen
    && a.endpoint.agentAlive === b.endpoint.agentAlive
    && a.endpoint.status === b.endpoint.status
    && a.endpoint.target === b.endpoint.target
    && a.endpoint.exists === b.endpoint.exists
}

/** Two records for one id disagree. Keep one row, and do not pick done or alive. */
function withholdDisagreement(current: WorkerDescriptor): WorkerDescriptor {
  return {
    ...current,
    crewState: 'unknown',
    endpoint: { target: null, exists: null, agentAlive: 'unknown', status: 'unknown' },
  }
}

function dedupeWorkers(workers: WorkerDescriptor[], diagnostics: string[]): WorkerDescriptor[] {
  const byId = new Map<string, WorkerDescriptor>()
  for (const worker of workers) {
    const prior = byId.get(worker.id)
    if (!prior) {
      byId.set(worker.id, worker)
      continue
    }
    diagnostics.push(`${worker.id}: duplicate record kept once`)
    if (!readingsAgree(prior, worker)) byId.set(worker.id, withholdDisagreement(prior))
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function unknownWorker(id: string, fixture: boolean): WorkerDescriptor {
  return {
    source: 'fm-fleet-snapshot',
    fixture,
    id,
    spawnGen: null,
    project: '',
    worktree: { path: null, present: false },
    backend: 'unknown',
    endpoint: { target: null, exists: null, agentAlive: 'unknown', status: 'unknown' },
    crewState: 'unknown',
    observedAt: new Date(0).toISOString(),
  }
}

function missed(id: string, reason: string): UnobservedWorker {
  return { id, health: 'unknown', completion: 'unknown', reason }
}

function finish(
  configured: boolean,
  home: string | null,
  knownIds: string[],
  workers: WorkerDescriptor[],
  diagnostics: string[],
  unobserved: UnobservedWorker[],
): WorkerList {
  const observation = home
    ? observeLedgerFile(join(home, 'state', 'fleet-ledger.jsonl'), knownIds)
    : absentObservation()
  return {
    configured,
    workers: dedupeWorkers(workers, diagnostics),
    diagnostics,
    observation,
    unobserved,
  }
}

/**
 * List workers from `--task` when the binary supports it. Otherwise filter the
 * fleet document to meta ids. Ledger lines are folded beside that list and
 * never add, complete, or mark a worker healthy. An unconfigured home is not read.
 */
export async function listWorkerDescriptors(input: {
  home: string
  configured: boolean
  binDir: string | null
  runner?: FmCommandRunner
  fixture?: boolean
}): Promise<WorkerList> {
  if (!input.configured || !input.binDir) {
    return finish(false, null, [], [], [], [])
  }
  const runner = input.runner ?? defaultFmRunner
  const fixture = input.fixture === true || process.env.TINSTAR_V6_FIXTURE === '1'
  const diagnostics: string[] = []
  const unobserved: UnobservedWorker[] = []
  const ids = metaIds(input.home)
  if (ids.length === 0) {
    return finish(true, input.home, [], [], diagnostics, unobserved)
  }

  const accept = (id: string, read: Awaited<ReturnType<typeof readTaskDescriptor>>, workers: WorkerDescriptor[]) => {
    if (read.descriptor) {
      workers.push(read.descriptor)
      return
    }
    const reason = read.diagnostic ?? 'observation failed'
    if (!read.notFound) {
      workers.push(unknownWorker(id, fixture))
      unobserved.push(missed(id, reason))
    }
    diagnostics.push(`${id}: ${reason}`)
  }

  const probe = await readTaskDescriptor({
    home: input.home,
    binDir: input.binDir,
    id: ids[0]!,
    runner,
    fixture,
  })
  if (!probe.taskSupported) {
    diagnostics.push('listed from the fleet snapshot because --task is not available')
    const fleet = await execSnapshot(runner, input.binDir, input.home, ['--json'])
    if (fleet.code !== 0) {
      const reason = fleet.stderr.trim() || 'fleet snapshot failed'
      diagnostics.push(reason)
      for (const id of ids) unobserved.push(missed(id, reason))
      const workers = ids.map(id => unknownWorker(id, fixture))
      return finish(true, input.home, ids, workers, diagnostics, unobserved)
    }
    try {
      const workers = parseTasks(JSON.parse(fleet.stdout) as unknown, fixture, diagnostics)
        .filter(worker => ids.includes(worker.id))
      const present = new Set(workers.map(worker => worker.id))
      for (const id of ids) {
        if (!present.has(id)) {
          const reason = 'fleet snapshot did not return this worker'
          diagnostics.push(`${id}: ${reason}`)
          unobserved.push(missed(id, reason))
          workers.push(unknownWorker(id, fixture))
        }
      }
      return finish(true, input.home, ids, workers, diagnostics, unobserved)
    } catch {
      diagnostics.push('fleet snapshot was not JSON')
      for (const id of ids) unobserved.push(missed(id, 'fleet snapshot was not JSON'))
      return finish(true, input.home, ids, ids.map(id => unknownWorker(id, fixture)), diagnostics, unobserved)
    }
  }

  const workers: WorkerDescriptor[] = []
  accept(ids[0]!, probe, workers)
  for (const id of ids.slice(1)) {
    const read = await readTaskDescriptor({ home: input.home, binDir: input.binDir, id, runner, fixture })
    accept(id, read, workers)
  }
  return finish(true, input.home, ids, workers, diagnostics, unobserved)
}
