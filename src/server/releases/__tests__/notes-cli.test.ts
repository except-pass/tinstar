import { afterEach, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { notesFixture } from '../../../../test-fixtures/releases/notes'
import { releaseChanges } from '../../../shared/releaseChanges'

const roots: string[] = []
const argv = process.argv
afterEach(async () => {
  process.argv = argv
  vi.restoreAllMocks()
  vi.doUnmock('../../reconciliation')
  vi.doUnmock('../../reconciliation/config')
  vi.doUnmock('../routes')
  vi.resetModules()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

it.each(['internal', 'customer'] as const)('retains Done and active accepted work in %s CLI preview and publication', async audience => {
  vi.resetModules()
  const root = await mkdtemp(join(process.cwd(), '.notes-cli-test-'))
  roots.push(root)
  const f = notesFixture()
  f.scene.cards[1]!.source.properties.Status!.value = 'Done'
  f.scene.cards[0]!.source.properties.Evidence!.value = String(f.scene.cards[0]!.source.properties.Evidence!.value).replace('"audience":"internal"', '"audience":"customer"')
  for (const change of releaseChanges(f.release, f.data, f.scene)) {
    const record = f.data.acceptanceRecords!.find(record => record.changeId === change.id)
    if (record) record.key = change.checks![0]!.key
  }
  vi.doMock('../../reconciliation', () => ({ ReconciliationSources: class {
    async scene(_force = false, scope: { history?: boolean } = {}) {
      return { ...f.scene, cards: f.scene.cards.filter(card => scope.history || card.source.properties.Status!.value !== 'Done') }
    }
  } }))
  vi.doMock('../../reconciliation/config', () => ({ loadReconciliationConfig: () => ({}) }))
  vi.doMock('../routes', () => ({ ReleasesApi: class { async read() { return f.data } } }))
  const { publicationGithub } = await import('../notes')
  const inspect = vi.spyOn(publicationGithub, 'inspect').mockResolvedValue({ tagSha: f.release.sourceSha, release: null })
  const create = vi.spyOn(publicationGithub, 'create').mockImplementation(async (_repository, _tag, _title, body) => {
    inspect.mockResolvedValue({ tagSha: f.release.sourceSha, release: { url: 'https://example.com/fake-release', isDraft: false, description: body } })
  })
  const inspectMock = publicationGithub.inspect
  const createMock = publicationGithub.create
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const args = ['node', 'scripts/releases-notes.ts', '--config-root', root, '--release-id', f.release.id, '--audience', audience]
  process.argv = args
  await import('../../../../scripts/releases-notes')
  const preview = JSON.parse(log.mock.calls.at(-1)![0])
  expect(preview).toMatchObject({ enabled: false, zeroWrites: true, included: ['card:notes-card-0', 'card:notes-card-1'] })
  const prefix = audience === 'customer' ? 'Customer' : 'Internal'
  expect(preview.body).toContain(`${prefix}: Bound query load.`)
  expect(preview.body).toContain(`${prefix}: Hide absent generator frequency.`)
  expect(inspect).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  vi.resetModules()
  process.argv = [...args, '--execute', '--actor', 'Synthetic owner', '--reason', 'Synthetic approval']
  await expect(import('../../../../scripts/releases-notes')).rejects.toThrow('Publication is OFF')
  expect(inspect).not.toHaveBeenCalled()
  expect(create).not.toHaveBeenCalled()
  await mkdir(join(root, 'releases'), { recursive: true })
  await writeFile(join(root, 'releases/publication.json'), JSON.stringify({ version: 1, enabled: true }))
  vi.resetModules()
  const enabledNotes = await import('../notes')
  vi.spyOn(enabledNotes.publicationGithub, 'inspect').mockImplementation(inspectMock)
  vi.spyOn(enabledNotes.publicationGithub, 'create').mockImplementation(createMock)
  await import('../../../../scripts/releases-notes')
  expect(JSON.parse(log.mock.calls.at(-1)![0]).status).toBe('published')
  expect(create).toHaveBeenCalledTimes(1)
  expect(create).toHaveBeenCalledWith(f.release.repository, f.release.version, f.release.version, preview.body)
})
