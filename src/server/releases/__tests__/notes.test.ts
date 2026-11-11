import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { notesFixture } from '../../../../test-fixtures/releases/notes'
import { ReleaseNotesPublisher, publicationGithub, readPublicationSettings } from '../notes'
import { CreationReceipts } from '../../reconciliation/workflowReceipts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); vi.unstubAllEnvs() })
async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tinstar-notes-test-')); roots.push(root)
  const f = notesFixture()
  const inspect = vi.fn().mockResolvedValue({ tagSha: f.release.sourceSha, release: null })
  const create = vi.fn().mockImplementation(async (_repository, _tag, _title, body) => {
    inspect.mockResolvedValue({ tagSha: f.release.sourceSha, release: { url: 'https://github.com/fortresspower/cmsandbox/releases/tag/v1.24.0', isDraft: false, description: body } })
  })
  const publisher = new ReleaseNotesPublisher(root, async () => ({ data: f.data, scene: f.scene }), { inspect, create })
  const enable = async () => { await mkdir(join(root, 'releases'), { recursive: true }); await writeFile(join(root, 'releases/publication.json'), JSON.stringify({ version: 1, enabled: true })) }
  return { ...f, root, publisher, inspect, create, enable }
}

describe('separate default-OFF GitHub publication', () => {
  it('produces a complete zero-write dry run without contacting GitHub; OFF also blocks execute', async () => {
    const f = await setup()
    const plan = await f.publisher.plan(f.release.id, 'customer')
    expect(plan).toMatchObject({ zeroWrites: true, enabled: false, tag: f.release.version, included: ['card:notes-card-1'] })
    expect(plan.command).toContain('--verify-tag')
    expect(plan.body).toContain('Customer: Hide absent generator frequency.')
    expect(plan.body).not.toMatch(/Draft release notes|Internal:|enum|expired/)
    await expect(f.publisher.publish(f.release.id, 'customer', 'owner', 'Approved')).rejects.toThrow('Publication is OFF')
    expect(f.inspect).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled()
    expect(await new CreationReceipts(f.root).entries('release-notes:')).toHaveLength(0)
  })
  it('publishes reviewed accepted copy to an existing matching tag, audits and handles replay', async () => {
    const f = await setup(); await f.enable()
    const result = await f.publisher.publish(f.release.id, 'customer', 'owner', 'Reviewed release:published listeners; authorized notes')
    expect(result.status).toBe('published')
    expect(f.create).toHaveBeenCalledWith(f.release.repository, f.release.version, f.release.version, expect.stringContaining('Customer: Hide absent generator frequency.'))
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.inspect).toHaveBeenCalledTimes(2)
    const entry = JSON.parse((await new CreationReceipts(f.root).get(result.key))!.input)
    expect(entry).toMatchObject({ status: 'published', actor: 'owner', reason: 'Reviewed release:published listeners; authorized notes', releaseId: f.release.id })
    expect((await f.publisher.publish(f.release.id, 'customer', 'owner', 'Inspect replay')).status).toBe('already-published')
    expect(f.create).toHaveBeenCalledTimes(1)
  })
  it.each([null, 'wrong-sha'])('never creates a missing/mismatched tag (%s)', async tagSha => {
    const f = await setup(); await f.enable(); f.inspect.mockResolvedValue({ tagSha, release: null })
    await expect(f.publisher.publish(f.release.id, 'customer', 'owner', 'Approved')).rejects.toThrow('No tag will be created')
    expect(f.create).not.toHaveBeenCalled()
  })
  it('supports an accepted component release without inventing a coordinator candidate', async () => {
    const f = await setup(); await f.enable(); f.release.candidateId = null; f.release.planId = null
    expect((await f.publisher.publish(f.release.id, 'customer', 'owner', 'Approved exact component release')).status).toBe('published')
    expect(f.create).toHaveBeenCalledTimes(1)
  })
  it.each([true, false])('leaves an existing draft/published record untouched (%s)', async isDraft => {
    const f = await setup(); await f.enable()
    f.inspect.mockResolvedValue({ tagSha: f.release.sourceSha, release: { url: 'https://example.com/existing', isDraft, description: 'Manually authored existing notes' } })
    const result = await f.publisher.publish(f.release.id, 'customer', 'owner', 'Inspect existing')
    expect(result.status).toBe(isDraft ? 'existing-draft; review in GitHub' : 'existing-release; review in GitHub')
    expect(f.create).not.toHaveBeenCalled()
  })
  it('records an ambiguous create response and recovers by inspecting GitHub before any repeat', async () => {
    const f = await setup(); await f.enable()
    f.create.mockRejectedValueOnce(new Error('Lost response'))
    await expect(f.publisher.publish(f.release.id, 'customer', 'owner', 'Approved')).rejects.toThrow('Publication outcome unknown')
    const entries = await new CreationReceipts(f.root).entries('release-notes:')
    expect(JSON.parse(entries[0]![1].input).status).toBe('inconclusive')
    const plan = await f.publisher.plan(f.release.id, 'customer')
    f.inspect.mockResolvedValue({ tagSha: f.release.sourceSha, release: { url: 'https://example.com/recovered', isDraft: false, description: plan.body } })
    expect((await f.publisher.publish(f.release.id, 'customer', 'owner', 'Inspected the lost response')).status).toBe('already-published')
    expect(f.create).toHaveBeenCalledTimes(1)
  })
  it('holds previews, incomplete membership/associations, no accepted work and missing authorization', async () => {
    const f = await setup(); await f.enable()
    await expect(f.publisher.publish(f.release.id, 'customer', '', 'reason')).rejects.toThrow('actor')
    await expect(f.publisher.publish(f.release.id, 'customer', 'owner', '')).rejects.toThrow('reason')
    const candidate = f.data.releases!.find(item => item.kind === 'candidate')!
    await expect(f.publisher.publish(candidate.id, 'customer', 'owner', 'reason')).rejects.toThrow('Planning previews')
    f.data.associationsComplete = false
    await expect(f.publisher.publish(f.release.id, 'customer', 'owner', 'reason')).rejects.toThrow('Complete release membership')
    f.data.associationsComplete = true; f.release.membership.status = 'partial'
    await expect(f.publisher.publish(f.release.id, 'customer', 'owner', 'reason')).rejects.toThrow('Complete release membership')
    f.release.membership.status = 'complete'; f.data.acceptanceRecords = []
    await expect(f.publisher.publish(f.release.id, 'customer', 'owner', 'reason')).rejects.toThrow('No deployed, accepted changes')
    expect(f.create).not.toHaveBeenCalled()
  })
  it('rejects malformed publication configuration and restores OFF by removal', async () => {
    const f = await setup(); await f.enable()
    await writeFile(join(f.root, 'releases/publication.json'), '{')
    await expect(readPublicationSettings(f.root)).rejects.toThrow('restore the OFF default')
    await rm(join(f.root, 'releases/publication.json'))
    expect(await readPublicationSettings(f.root)).toMatchObject({ enabled: false })
  })
  it('executes the real gh-axi adapter against a fake binary, peeling tags and enforcing --verify-tag', async () => {
    const f = await setup()
    const log = join(f.root, 'calls.jsonl'), binary = join(f.root, 'gh-axi')
    await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, body: args.includes('--notes-file') ? fs.readFileSync(args[args.indexOf('--notes-file')+1], 'utf8') : null })+'\\n');
if (args[0] === 'api') {
 const peeling = args.some(arg => arg.startsWith('oid='));
 const repository = peeling ? {object:{target:{oid:${JSON.stringify(f.release.sourceSha)},__typename:'Commit'}}} : {ref:{target:{oid:'annotated-tag-object',__typename:'Tag'}},release:null};
 console.log('payload: '+JSON.stringify(JSON.stringify({data:{repository}})));
} else if (args[0] !== 'release' || args[1] !== 'create' || !args.includes('--verify-tag') || args.includes('--target')) process.exit(8);
`, { mode: 0o755 })
    await chmod(binary, 0o755); vi.stubEnv('PATH', `${f.root}:${process.env.PATH}`)
    expect(await publicationGithub.inspect(f.release.repository, f.release.version)).toEqual({ tagSha: f.release.sourceSha, release: null })
    const body = 'Literal notes with `backticks`, $(shell text), and\na new line.'
    await publicationGithub.create(f.release.repository, f.release.version, f.release.version, body)
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(calls).toHaveLength(3)
    expect(calls[2]).toMatchObject({ args: ['release', 'create', f.release.version, '--repo', f.release.repository, '--verify-tag', '--latest=false', '--title', f.release.version, '--notes-file', expect.any(String)], body })
    await expect(readFile(calls[2].args.at(-1))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
