import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AssociationStore } from '../associations'

const roots: string[] = []
async function setup() { const root = await mkdtemp(join(tmpdir(), 'release-links-')); roots.push(root); return { root, store: new AssociationStore(root) } }
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const input = () => ({ id: randomUUID(), pull: 'https://github.com/Owner/Repo/pull/1', cardId: 'a'.repeat(32), action: 'link' as const, reason: 'Reviewed required change' })
describe('local association audit', () => {
  it('serializes concurrent writes, survives reload, and retries the same request without duplicate history', async () => {
    const { root, store } = await setup(), first = input(), second = { ...input(), action: 'unlink' as const }
    await Promise.all([store.append(first, 'owner'), store.append(second, 'owner'), store.append(first, 'owner')])
    const events = await new AssociationStore(root).read()
    expect(events).toHaveLength(2)
    expect(events.map(event => event.action)).toEqual(['link', 'unlink'])
    expect(events[0]).toMatchObject({ actor: 'owner', reason: first.reason, pull: 'https://github.com/owner/repo/pull/1' })
    expect(JSON.parse(await readFile(join(root, 'releases', 'associations.json'), 'utf8')).version).toBe(1)
    await expect(store.append({ ...first, reason: 'different intent' }, 'owner')).rejects.toThrow('different content')
    expect(await store.read()).toHaveLength(2)
  })
  it('does not overwrite an unreadable or corrupt existing audit', async () => {
    const { root, store } = await setup()
    await mkdir(join(root, 'releases'))
    await writeFile(join(root, 'releases', 'associations.json'), 'broken audit')
    await expect(store.append(input(), 'owner')).rejects.toThrow()
    expect(await readFile(join(root, 'releases', 'associations.json'), 'utf8')).toBe('broken audit')
  })
})
