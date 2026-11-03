import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
export const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024

export interface FleetSnapshot {
  schema: 'fm-fleet-snapshot.v1'
  generated?: unknown
  fm_home?: unknown
  tasks: Record<string, unknown>[]
  backlog?: { present?: boolean; records?: Record<string, unknown>[] }
  [key: string]: unknown
}

/** Shared with the cockpit: only First Mate's supported read interface is run. */
export async function readFleetSnapshot(home: string, snapshotFile?: string): Promise<FleetSnapshot> {
  let text: string
  if (snapshotFile) {
    const file = await open(snapshotFile, 'r')
    try {
      // Bounded read also handles a publisher replacing/growing the file mid-read.
      const buffer = Buffer.alloc(MAX_SNAPSHOT_BYTES + 1)
      let length = 0
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
        if (!bytesRead) break
        length += bytesRead
      }
      if (length > MAX_SNAPSHOT_BYTES) throw new Error('snapshot exceeds 16 MiB')
      text = buffer.subarray(0, length).toString('utf8')
    } finally { await file.close() }
  } else {
    const result = await execFileAsync(join(home, 'bin', 'fm-fleet-snapshot.sh'), ['--json'], {
      timeout: 18_000, maxBuffer: MAX_SNAPSHOT_BYTES,
    })
    text = result.stdout
  }
  const snapshot = JSON.parse(text) as FleetSnapshot | null
  if (!snapshot || snapshot.schema !== 'fm-fleet-snapshot.v1' || !Array.isArray(snapshot.tasks) ||
      snapshot.tasks.some(task => !task || typeof task !== 'object' || Array.isArray(task))) {
    throw new Error('unexpected snapshot format')
  }
  return snapshot
}
