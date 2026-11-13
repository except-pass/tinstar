import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CardLeases, CardLeaseError, leaseCaller, leaseDuration, withLeaseCaller } from '../cardLeases'
import { WorkflowOperations } from '../workflow'
import { WorkflowContent } from '../workflowContent'
import { WorkReader } from '../workReader'
import { NotionApi } from '../notionApi'

const roots: string[] = []
const root = () => { const path = mkdtempSync(join(tmpdir(), 'tinstar-card-leases-')); roots.push(path); return path }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const caller = leaseCaller('ChatGPT', { authorization: 'install', 'x-tinstar-caller-authorization': 'caller' })
const card = 'a'.repeat(32), other = 'b'.repeat(32)
async function claimed(service: CardLeases, id = card, operation = 'first') {
  const result = await service.claim([id], caller, 'ChatGPT', operation)
  expect(result).toMatchObject({ outcome: 'claimed' })
  if (!('lease_token' in result) || !result.lease_token || !('lease' in result) || !result.lease) throw new Error('Missing lease')
  return { token: result.lease_token, lease: result.lease }
}

it('claims durably, replays ambiguous claims, binds credentials and keeps tokens out of stored records', async () => {
  const directory = root(), service = new CardLeases(directory), first = await claimed(service)
  const restarted = new CardLeases(directory)
  expect(restarted.status(card)).toEqual(first.lease)
  expect(await restarted.claim([card], caller, 'ChatGPT', 'first')).toMatchObject({ lease_token: first.token, lease: first.lease })
  expect(await restarted.claim([other], caller, 'ChatGPT', 'repeat', first.token)).toMatchObject({ outcome: 'held', lease: { card_id: card } })
  expect(await restarted.claim([other], caller, 'ChatGPT', 'exact', first.token, true)).toMatchObject({ outcome: 'already-holding', lease: { card_id: card } })
  expect(await restarted.claim([other], caller, 'ChatGPT', 'first', undefined, true)).toMatchObject({ outcome: 'operation-conflict' })
  await expect(restarted.release('different-caller', first.token, 'abandoned')).rejects.toBeInstanceOf(CardLeaseError)
  await expect(restarted.claim([card], leaseCaller('ChatGPT', { authorization: 'rotated' }), 'ChatGPT', 'rotate', first.token)).rejects.toBeInstanceOf(CardLeaseError)
  for (const file of readdirSync(directory)) {
    expect(readFileSync(join(directory, file)).includes(Buffer.from(first.token))).toBe(false)
    expect(statSync(join(directory, file)).mode & 0o077).toBe(0)
  }
})

it.each([false, true])('replays only current claims with refreshed metadata (exact=%s)', async exact => {
  let now = 1_000
  const directory = root(), service = new CardLeases(directory, () => now)
  const claim = (operation: string) => service.claim([card], caller, 'ChatGPT', operation, undefined, exact)
  const first = await claim('first')
  if (!('lease_token' in first) || !first.lease_token || !first.lease) throw new Error('Missing lease')
  now += leaseDuration / 2
  await withLeaseCaller(caller, first.lease_token, () => service.mutate(card, async () => undefined))
  expect(await new CardLeases(directory, () => now).claim([card], caller, 'ChatGPT', 'first', undefined, exact)).toMatchObject({ outcome: 'claimed', lease_token: first.lease_token, lease: service.status(card) })
  now += leaseDuration
  await expect(claim('first')).rejects.toThrow('Claim lost')
  const second = await claim('second')
  if (!('lease_token' in second) || !second.lease_token || !second.lease) throw new Error('Missing lease')
  await expect(claim('first')).rejects.toThrow('Claim lost')
  await service.release(caller, second.lease_token, 'Finished')
  await expect(claim('second')).rejects.toThrow('Claim lost')
  const third = await claim('third')
  if (!('lease' in third) || !third.lease) throw new Error('Missing lease')
  await service.ownerRelease(card, third.lease.generation, 'Owner release')
  await expect(claim('third')).rejects.toThrow('Claim lost')
  await claim('fourth')
  await expect(claim('third')).rejects.toThrow('Claim lost')
})

it('serializes simultaneous claim selection across independent service instances in original order', async () => {
  const directory = root(), first = new CardLeases(directory), second = new CardLeases(directory)
  const results = await Promise.all([first.claim([card, other], caller, 'ChatGPT', 'chat-1'), second.claim([card, other], caller, 'ChatGPT', 'chat-2')])
  expect(results.map(row => 'lease' in row ? row.lease?.card_id : null)).toEqual([card, other])
  expect(await first.claim([card, other], caller, 'ChatGPT', 'chat-3')).toMatchObject({ outcome: 'no-unclaimed-card' })
})

it('refuses all other sessions and ordinary writers, renews only holder changes, and fences stale tokens', async () => {
  let now = Date.parse('2026-11-13T13:00:00Z')
  const service = new CardLeases(root(), () => now), first = await claimed(service), write = vi.fn(async () => 'changed')
  now += leaseDuration / 2
  expect(service.status(card)?.expires_at).toBe(first.lease.expires_at)
  await expect(service.mutate(card, write)).rejects.toThrow(`held by ${first.lease.holder} until ${first.lease.expires_at}`)
  await expect(withLeaseCaller(caller, 'another-chat-token', () => service.mutate(card, write))).rejects.toBeInstanceOf(CardLeaseError)
  expect(write).not.toHaveBeenCalled()
  await expect(withLeaseCaller(caller, first.token, () => service.mutate(card, async () => { throw new Error('Provider failed') }))).rejects.toThrow('Provider failed')
  expect(service.status(card)?.expires_at).toBe(first.lease.expires_at)
  await withLeaseCaller(caller, first.token, () => service.mutate(card, write))
  expect(service.status(card)?.expires_at).toBe(new Date(now + leaseDuration).toISOString())
  now += leaseDuration
  expect(service.status(card)).toBeNull()
  await expect(withLeaseCaller(caller, first.token, () => service.mutate(card, write))).rejects.toThrow('Claim lost')
  const second = await claimed(service, card, 'second')
  expect(second.lease.generation).toBeGreaterThan(first.lease.generation)
  await expect(withLeaseCaller(caller, first.token, () => service.mutate(card, write))).rejects.toThrow('held by')
  await expect(service.release(caller, first.token, 'old release')).rejects.toBeInstanceOf(CardLeaseError)
  expect(service.status(card)).toEqual(second.lease)
  expect(await service.ownerRelease(card, first.lease.generation, 'stale UI')).toMatchObject({ outcome: 'claim-changed' })
  await service.release(caller, second.token, 'explicit abandoned')
  expect(service.status(card)).toBeNull()
  await expect(withLeaseCaller(caller, second.token, () => service.mutate(card, write))).rejects.toThrow('Claim lost')
  await service.mutate(card, write)
  const third = await claimed(service, card, 'third')
  expect(third.lease.generation).toBeGreaterThan(second.lease.generation)
  await service.ownerRelease(card, third.lease.generation, 'Owner release')
  expect(service.status(card)).toBeNull()
})

it('does not grant a new generation during an in-flight older holder write, even past expiry', async () => {
  let now = 1_000, finish!: () => void, started!: () => void
  const directory = root(), service = new CardLeases(directory, () => now), competitor = new CardLeases(directory, () => now)
  const first = await claimed(service), writing = new Promise<void>(resolve => { started = resolve }), blocked = new Promise<void>(resolve => { finish = resolve })
  const change = withLeaseCaller(caller, first.token, () => service.mutate(card, async () => { started(); await blocked }))
  await writing
  now += leaseDuration + 1
  let claimedNew = false
  const next = competitor.claim([card], caller, 'Other chat', 'new-generation').then(result => { claimedNew = true; return result })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(claimedNew).toBe(false)
  finish(); await change
  expect(await next).toMatchObject({ outcome: 'no-unclaimed-card' })
})

it('guards workflow and low-level content writes for Firstmate, mate and Clawson', async () => {
  const directory = root(), transport = vi.fn(async () => new Response('{}'))
  const reader = new WorkReader({ token: 'fixture-only', dataSourceId: other }, new NotionApi(transport, 0))
  const workflow = new WorkflowOperations(reader, async () => [], directory)
  const first = await claimed(reader.leases!)
  for (const actor of ['Firstmate', 'mate', 'Clawson', 'Tin Star UI']) {
    expect(await workflow.update({ card_id: card, operation_id: actor, kind: 'edit', note: 'A conflicting change' }, actor)).toMatchObject({ outcome: 'not-saved', code: 'card-held', message: `held by ${first.lease.holder} until ${first.lease.expires_at}` })
  }
  const content = new WorkflowContent(reader)
  await expect(content.patchProperties(card, { Name: {} })).rejects.toBeInstanceOf(CardLeaseError)
  await expect(content.note(card, 'Conflicting note', 'fixture')).rejects.toBeInstanceOf(CardLeaseError)
  await expect(content.section(card, 'brief', 'Conflicting brief')).rejects.toBeInstanceOf(CardLeaseError)
  await expect(content.appendBlocks(card, [])).rejects.toBeInstanceOf(CardLeaseError)
  expect(transport).not.toHaveBeenCalled()
})


it('selects distinct cards across concurrent backend processes using the same durable store', async () => {
  const module = pathToFileURL(resolve('src/server/reconciliation/cardLeases.ts')).href
  // Reopening after the last connection closes exercises WAL recovery as well
  // as the writer race; a single open can miss SQLite's BUSY_RECOVERY result.
  for (let round = 0; round < 5; round++) {
    const directory = root()
    const run = (operation: string) => promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `import { CardLeases } from ${JSON.stringify(module)}; const service = new CardLeases(${JSON.stringify(directory)}); const result = await service.claim(${JSON.stringify([card, other])}, 'fixture-caller', 'Fixture chat', ${JSON.stringify(operation)}); process.stdout.write(JSON.stringify({card: result.lease?.card_id}));`])
    const results = await Promise.all([run('process-a'), run('process-b')])
    expect(new Set(results.map(result => JSON.parse(result.stdout).card))).toEqual(new Set([card, other]))
    const service = new CardLeases(directory)
    expect(service.status(card)).toBeTruthy()
    expect(new CardLeases(directory).status(other)).toBeTruthy()
    const replay = await service.claim([card, other], 'fixture-caller', 'Fixture chat', 'process-a')
    if (!('lease_token' in replay) || !replay.lease_token || !replay.lease) throw new Error('Missing replay')
    await withLeaseCaller('fixture-caller', replay.lease_token, () => service.mutate(replay.lease!.card_id, async () => undefined))
  }
}, 20_000)
