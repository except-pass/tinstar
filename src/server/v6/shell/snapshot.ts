import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parseWorkerDescriptor, snapshotTaskObjects, type WorkerDescriptor } from '../../../v6/contract/descriptor'
import {
  defaultFmRunner,
  fmChildEnv,
  snapshotScript,
  type FmCommandRunner,
} from './fmExec'

export interface WorkerList {
  configured: boolean
  workers: WorkerDescriptor[]
  diagnostics: string[]
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
}): Promise<{ descriptor: WorkerDescriptor | null; diagnostic: string | null; taskSupported: boolean }> {
  if (!/^[A-Za-z0-9._-]+$/.test(input.id)) {
    return { descriptor: null, diagnostic: 'bad worker id', taskSupported: true }
  }
  const runner = input.runner ?? defaultFmRunner
  const result = await execSnapshot(runner, input.binDir, input.home, ['--task', input.id, '--json'])
  const unsupported = result.code === 2 && /usage: fm-fleet-snapshot/.test(`${result.stderr}\n${result.stdout}`)
  if (unsupported) {
    return { descriptor: null, diagnostic: 'snapshot --task is not available', taskSupported: false }
  }
  if (result.code !== 0) {
    return { descriptor: null, diagnostic: result.stderr.trim() || `snapshot --task exited ${result.code}`, taskSupported: true }
  }
  try {
    const parsed = parseWorkerDescriptor(JSON.parse(result.stdout) as unknown)
    if (!parsed.ok) return { descriptor: null, diagnostic: parsed.diagnostic, taskSupported: true }
    if (parsed.value.id !== input.id) {
      return { descriptor: null, diagnostic: 'snapshot --task returned a different worker', taskSupported: true }
    }
    return { descriptor: stampFixture(parsed.value, input.fixture === true), diagnostic: null, taskSupported: true }
  } catch {
    return { descriptor: null, diagnostic: 'snapshot --task was not JSON', taskSupported: true }
  }
}

/**
 * List workers from `--task` when the binary supports it. Otherwise filter the
 * fleet document. Neither path is used when the home is unconfigured.
 */
export async function listWorkerDescriptors(input: {
  home: string
  configured: boolean
  binDir: string | null
  runner?: FmCommandRunner
  fixture?: boolean
}): Promise<WorkerList> {
  if (!input.configured || !input.binDir) {
    return { configured: false, workers: [], diagnostics: [] }
  }
  const runner = input.runner ?? defaultFmRunner
  const fixture = input.fixture === true || process.env.TINSTAR_V6_FIXTURE === '1'
  const diagnostics: string[] = []
  const ids = metaIds(input.home)
  if (ids.length === 0) {
    return { configured: true, workers: [], diagnostics }
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
      diagnostics.push(fleet.stderr.trim() || 'fleet snapshot failed')
      return { configured: true, workers: [], diagnostics }
    }
    try {
      const workers = parseTasks(JSON.parse(fleet.stdout) as unknown, fixture, diagnostics)
        .filter(worker => ids.includes(worker.id))
      return { configured: true, workers, diagnostics }
    } catch {
      diagnostics.push('fleet snapshot was not JSON')
      return { configured: true, workers: [], diagnostics }
    }
  }
  const workers: WorkerDescriptor[] = []
  if (probe.descriptor) workers.push(probe.descriptor)
  else if (probe.diagnostic) diagnostics.push(probe.diagnostic)
  for (const id of ids.slice(1)) {
    const read = await readTaskDescriptor({ home: input.home, binDir: input.binDir, id, runner, fixture })
    if (read.descriptor) workers.push(read.descriptor)
    else if (read.diagnostic) diagnostics.push(`${id}: ${read.diagnostic}`)
  }
  workers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { configured: true, workers, diagnostics }
}
