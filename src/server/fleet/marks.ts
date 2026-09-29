import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getConfigRoot } from '../configRoot'

export interface DirectMark {
  home: string
  id: string
}

/** The marks file could not be parsed. Callers must leave it in place. */
export class WorkerMarksUnreadable extends Error {
  constructor() {
    super('Worker marks could not be read')
    this.name = 'WorkerMarksUnreadable'
  }
}

/**
 * Direct workers, keyed by First Mate home and task id.
 * Absence means managed. One in-process queue serializes reads and writes.
 */
export class WorkerMarks {
  private readonly root: string
  private readonly path: string
  private writing: Promise<unknown> = Promise.resolve()

  constructor(root = getConfigRoot()) {
    this.root = root
    this.path = join(root, 'worker-marks.json')
  }

  queue<T>(task: () => Promise<T>): Promise<T> {
    const action = this.writing.then(task)
    this.writing = action.catch(() => undefined)
    return action
  }

  /** Listed direct workers. A missing file or a missing direct list is empty. */
  async read(): Promise<DirectMark[]> {
    return (await this.load()).entries
  }

  set(home: string, id: string, direct: boolean): Promise<boolean> {
    return this.queue(() => this.change(home, id, direct))
  }

  /** Update one mark. Caller must already hold `queue`. Returns whether the file changed. */
  async change(home: string, id: string, direct: boolean): Promise<boolean> {
    if (!home || !id) throw new Error('Worker mark needs a home and id')
    const { entries, shell } = await this.load()
    const has = entries.some(entry => entry.home === home && entry.id === id)
    if (direct === has) return false
    const next = direct
      ? [...entries.filter(entry => entry.home !== home || entry.id !== id), { home, id }]
      : entries.filter(entry => entry.home !== home || entry.id !== id)
    await mkdir(this.root, { recursive: true })
    const temp = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify({ ...shell, direct: next }), { mode: 0o600 })
    await rename(temp, this.path)
    return true
  }

  private async load(): Promise<{ entries: DirectMark[]; shell: Record<string, unknown> }> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], shell: {} }
      throw new WorkerMarksUnreadable()
    }
    let parsed: unknown
    try { parsed = JSON.parse(raw) as unknown } catch { throw new WorkerMarksUnreadable() }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new WorkerMarksUnreadable()
    const shell = parsed as Record<string, unknown>
    const direct = shell.direct
    if (!Array.isArray(direct)) return { entries: [], shell }
    const entries = direct.filter((entry): entry is DirectMark => {
      if (!entry || typeof entry !== 'object') return false
      const mark = entry as DirectMark
      return typeof mark.home === 'string' && mark.home.length > 0 && typeof mark.id === 'string' && mark.id.length > 0
    })
    return { entries, shell }
  }
}

export function directKey(home: string, id: string): string {
  return `${home}\0${id}`
}

export function directSet(entries: DirectMark[]): Set<string> {
  return new Set(entries.map(entry => directKey(entry.home, entry.id)))
}
