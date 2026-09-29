import { spawn } from 'node:child_process'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getConfigRoot } from '../configRoot'
import { log } from '../logger'
import type { AttentionType } from './attention'

export interface OutboxMessage {
  requestId: string
  home: string
  kind: 'answer' | 'message'
  taskId: string | null
  decisionKey: string | null
  holdId: string | null
  cardType: AttentionType | null
  text: string
}

export type SubmitResult = { saved: boolean; error: string | null; canReceive: boolean | 'unknown' }

export type ListedMessage = OutboxMessage & {
  state: 'unknown' | 'sending' | 'saved' | 'acknowledged' | 'done'
  announced: boolean | null
  reply: string | null
  canReceive: boolean | 'unknown'
}

interface Receipt {
  request_id?: string
  acknowledged?: boolean
  announced?: boolean | null
  reply?: { body?: string } | null
}

function inbox(home: string, args: string[], input?: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(home, 'bin', 'fm-inbox.sh'), args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    const timer = setTimeout(() => child.kill(), 15_000)
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }) })
    child.stdin.on('error', () => { /* child failure is reported by close */ })
    child.stdin.end(input)
  })
}

async function readiness(home: string): Promise<boolean | 'unknown'> {
  const ready = await inbox(home, ['ready'])
  if (ready.code) throw new Error(ready.stderr)
  return (JSON.parse(ready.stdout) as { can_receive?: boolean | 'unknown' }).can_receive ?? 'unknown'
}

async function observe(home: string): Promise<{ receipts: Receipt[]; canReceive: boolean | 'unknown' } | null> {
  try {
    const [receipts, canReceive] = await Promise.all([inbox(home, ['receipts', '--all-pending', '--all-handled']), readiness(home)])
    if (receipts.code) throw new Error(receipts.stderr)
    const parsed = JSON.parse(receipts.stdout) as { pending?: Receipt[]; handled?: Receipt[] }
    return { receipts: [...(parsed.pending ?? []), ...(parsed.handled ?? [])], canReceive }
  } catch { return null }
}

/** Tin Star remembers unfinished submissions; First Mate receipts decide what was saved and read. */
export class FleetOutbox {
  private readonly path = join(getConfigRoot(), 'fleet-outbox.json')
  private messages: OutboxMessage[] | null = null
  private writing: Promise<unknown> = Promise.resolve()

  private async load(): Promise<OutboxMessage[]> {
    if (this.messages) return this.messages
    try {
      const data = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      this.messages = Array.isArray(data) ? data as OutboxMessage[] : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.messages = []
    }
    return this.messages
  }

  private async write(messages: OutboxMessage[]): Promise<void> {
    await mkdir(getConfigRoot(), { recursive: true })
    const temp = `${this.path}.${randomUUID()}.tmp`
    await writeFile(temp, JSON.stringify(messages), { mode: 0o600 })
    await rename(temp, this.path)
  }

  private queue<T>(task: () => Promise<T>): Promise<T> {
    const action = this.writing.then(task)
    this.writing = action.catch(() => undefined)
    return action
  }

  async get(requestId: string): Promise<OutboxMessage | undefined> {
    return (await this.load()).find(message => message.requestId === requestId)
  }

  async list(homes: string[], callOpen: (message: OutboxMessage) => boolean, snapshotReady = true): Promise<ListedMessage[]> {
    const messages = await this.load()
    if (!messages.length) return []
    const wanted = [...new Set(messages.map(message => message.home))].filter(home => homes.includes(home))
    const observations = new Map(await Promise.all(wanted.map(async home => [home, await observe(home)] as const)))
    const finished = new Set<string>()
    const listed = messages.map((message): ListedMessage => {
      const observation = observations.get(message.home) ?? null
      const receipt = observation?.receipts.find(item => item.request_id === message.requestId)
      const state = !observation ? 'unknown'
        : !receipt ? 'sending'
        : snapshotReady && message.kind === 'answer' && !callOpen(message) ? 'done'
        : receipt.acknowledged ? 'acknowledged' : 'saved'
      if (state === 'done' || state === 'acknowledged') finished.add(message.requestId)
      return { ...message, state, announced: receipt?.announced ?? null, reply: receipt?.reply?.body ?? null, canReceive: observation?.canReceive ?? 'unknown' }
    })
    if (finished.size) {
      void this.queue(async () => {
        const next = (this.messages ?? []).filter(message => !finished.has(message.requestId))
        await this.write(next)
        this.messages = next
      }).catch(error => log.warn('fleet', `outbox prune failed: ${(error as Error).message}`))
    }
    return listed
  }

  submit(message: OutboxMessage, target: string): Promise<SubmitResult> {
    return this.queue(async () => {
      const messages = await this.load()
      const old = messages.find(item => item.requestId === message.requestId)
      if (old && JSON.stringify(old) !== JSON.stringify(message)) throw new Error('Request ID belongs to a different message')
      if (!old) {
        const next = [...messages, message]
        await this.write(next)
        this.messages = next
      }
      try {
        const result = await inbox(message.home, ['note', '--request-id', message.requestId, '--json', '-'], `${target}:\n${message.text}`)
        if (result.code !== 0 && result.code !== 3) return { saved: false, error: result.stderr.trim() || 'First Mate did not save the message', canReceive: 'unknown' }
        const note = JSON.parse(result.stdout) as { saved?: boolean }
        if (!note.saved) return { saved: false, error: result.stderr.trim() || 'First Mate did not save the message', canReceive: 'unknown' }
        const canReceive = await readiness(message.home).catch(() => 'unknown' as const)
        return { saved: true, error: result.code === 3 ? 'Saved, but First Mate was not woken. Use Retry under Messages to wake it.' : null, canReceive }
      } catch (error) { return { saved: false, error: (error as Error).message, canReceive: 'unknown' } }
    })
  }
}
