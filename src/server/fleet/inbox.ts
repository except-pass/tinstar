import { spawn } from 'node:child_process'
import { readFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { getConfigRoot } from '../configRoot'

export interface OutboxMessage {
  requestId: string
  anchorKey: string
  homeIndex: number
  taskId: string | null
  cardKey: string | null
  decisionKey: string | null
  kind: 'answer' | 'message'
  context: string
  text: string
}

interface Receipt {
  request_id?: string
  acknowledged?: boolean
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

/** Tin Star remembers submissions; First Mate receipts decide what was saved and read. */
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

  async get(requestId: string): Promise<OutboxMessage | undefined> {
    return (await this.load()).find(message => message.requestId === requestId)
  }

  async list(homes: string[], openCards: ReadonlySet<string>, snapshotReady = true): Promise<Array<OutboxMessage & { state: 'sending' | 'saved' | 'acknowledged' | 'done'; reply: string | null; canReceive: boolean | 'unknown' }>> {
    const messages = await this.load()
    const observations = await Promise.all(homes.map(async home => {
      try {
        const [receipts, ready] = await Promise.all([
          inbox(home, ['receipts', '--all-pending', '--all-handled']), inbox(home, ['ready']),
        ])
        if (receipts.code || ready.code) throw new Error(receipts.stderr || ready.stderr)
        const parsed = JSON.parse(receipts.stdout) as { pending?: Receipt[]; handled?: Receipt[] }
        const readiness = JSON.parse(ready.stdout) as { can_receive?: boolean | 'unknown' }
        return { receipts: [...(parsed.pending ?? []), ...(parsed.handled ?? [])], canReceive: readiness.can_receive ?? 'unknown' }
      } catch { return { receipts: [] as Receipt[], canReceive: 'unknown' as const } }
    }))
    return messages.map(message => {
      const observation = observations[message.homeIndex]
      const receipt = observation?.receipts.find(item => item.request_id === message.requestId)
      const state = receipt
        ? snapshotReady && message.kind === 'answer' && message.cardKey && !openCards.has(message.cardKey) ? 'done'
          : receipt.acknowledged ? 'acknowledged' : 'saved'
        : 'sending'
      return { ...message, state, reply: receipt?.reply?.body ?? null, canReceive: observation?.canReceive ?? 'unknown' }
    })
  }

  submit(home: string, message: OutboxMessage): Promise<{ saved: boolean; error: string | null }> {
    const action = this.writing.then(async () => {
      const messages = await this.load()
      const old = messages.find(item => item.requestId === message.requestId)
      if (old && JSON.stringify(old) !== JSON.stringify(message)) throw new Error('Request ID belongs to a different message')
      if (!old) {
        const next = [...messages, message]
        await mkdir(getConfigRoot(), { recursive: true })
        const temp = `${this.path}.${randomUUID()}.tmp`
        await writeFile(temp, JSON.stringify(next), { mode: 0o600 })
        await rename(temp, this.path)
        this.messages = next
      }
      const prefix = message.kind === 'answer'
        ? `Answer for task ${message.taskId ?? 'unknown'}, decision ${message.decisionKey ?? message.cardKey} (${message.context}):`
        : `Message about task ${message.taskId ?? 'unknown'}${message.cardKey ? `, card ${message.cardKey}` : ''} (${message.context}):`
      try {
        const result = await inbox(home, ['note', '--request-id', message.requestId, '--json', '-'], `${prefix}\n${message.text}`)
        const note = JSON.parse(result.stdout) as { saved?: boolean }
        if (note.saved) return { saved: true, error: result.code === 3 ? 'Saved, but First Mate was not woken. Retry to announce it.' : null }
        return { saved: false, error: result.stderr.trim() || 'First Mate did not save the message' }
      } catch (error) { return { saved: false, error: (error as Error).message } }
    })
    this.writing = action.catch(() => undefined)
    return action
  }
}
