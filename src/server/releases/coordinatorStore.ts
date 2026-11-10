import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { cmsandboxReceipts, receiptHash } from './cmsandbox'

/** Read an exported coordinator directory, never AWS or the deployment control
 * plane. Exporters preserve S3 LastModified as file mtime. Only committed journal
 * and referenced frozen objects are loaded; unrelated exports are ignored. */
export async function readCoordinatorBundle(directory: string) {
  let bytes = 0
  const read = async (path: string) => {
    const metadata = await stat(path)
    bytes += metadata.size
    // Protect the HTTP process from accidentally reading an unbounded journal.
    if (metadata.size > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024) throw new Error('Coordinator export exceeds bounded snapshot size')
    return { value: JSON.parse(await readFile(path, 'utf8')), at: metadata.mtime.toISOString() }
  }
  const control = (await read(join(directory, 'control.json'))).value
  const journal: Record<string, any> = {}, journalMetadata: Record<string, { lastModified: string }> = {}, objects: Record<string, any> = {}
  const digest = (id: unknown): string => {
    if (typeof id !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('Invalid coordinator object reference')
    return id.slice(7)
  }
  let next = control.head
  while (next) {
    const name = digest(next)
    if (journal[next] || Object.keys(journal).length >= 1000) throw new Error('Invalid coordinator journal chain')
    const row = await read(join(directory, 'journal', `${name}.json`))
    if (receiptHash(row.value) !== next) throw new Error('Corrupted coordinator journal')
    journal[next] = row.value; journalMetadata[next] = { lastModified: row.at }; next = row.value.previous
  }
  const load = async (id: string) => {
    if (objects[id]) return objects[id]
    const value = (await read(join(directory, 'objects', `${digest(id)}.json`))).value
    if (receiptHash(value) !== id) throw new Error('Corrupted frozen coordinator object')
    objects[id] = value; return value
  }
  for (const event of Object.values(journal)) {
    if (!event.state?.releases?.[event.binding?.release_id]?.binding && event.result?.status === 'superseded') continue
    const plan = await load(event.binding.plan)
    const candidate = await load(event.binding.manifest)
    const inputs = await load(plan.inputs)
    // Build records are normally embedded in frozen inputs. The native adapter
    // resolves that provenance without requiring duplicate separate objects.
    for (const selected of Object.values(candidate.desired ?? {}) as Array<{ build_record?: string }>) {
      if (selected.build_record && !(inputs.builds ?? []).some((build: unknown) => receiptHash(build) === selected.build_record)) await load(selected.build_record)
    }
  }
  const bundle = { schema: 'tinstar.cmsandbox-production-export.v1', repository: 'fortresspower/cmsandbox', bucket: 'fortresspower-cmsandbox-release-prod-298117917676', control, journal, journalMetadata, objects }
  return bundle
}

export async function readCoordinatorStore(directory: string) {
  return cmsandboxReceipts(await readCoordinatorBundle(directory))
}
