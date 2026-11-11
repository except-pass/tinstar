import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'
import { releaseChanges } from '../../shared/releaseChanges'
import { draftReleaseNotes, type NoteAudience } from '../../shared/releaseNotes'
import type { ReleasesRead } from '../../shared/releases'
import type { FloorScene } from '../../shared/reconciliationPresentation'
import { CreationReceipts } from '../reconciliation/workflowReceipts'

const settingsSchema = z.object({ version: z.literal(1), enabled: z.boolean().default(false) }).strict()
export async function readPublicationSettings(root: string) {
  try { return settingsSchema.parse(JSON.parse(await readFile(join(root, 'releases', 'publication.json'), 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 as const, enabled: false }
    throw new Error('Correct releases/publication.json or remove it to restore the OFF default.')
  }
}
interface PublishedRelease { url: string; isDraft: boolean; description: string | null }
// Provider newline normalization is cosmetic; compare the authored note content.
const sameNotes = (actual: string | null, expected: string) => (actual ?? '').replace(/\r\n/g, '\n').trim() === expected.replace(/\r\n/g, '\n').trim()
export interface PublicationGithub {
  inspect(repository: string, tag: string): Promise<{ tagSha: string | null; release: PublishedRelease | null }>
  create(repository: string, tag: string, title: string, body: string): Promise<void>
}
const exec = promisify(execFile)
async function query(query: string, variables: Record<string, string>) {
  const { stdout } = await exec('gh-axi', ['api', 'POST', 'graphql', '--field', `query=${query}`,
    ...Object.entries(variables).flatMap(([key, value]) => ['--field', `${key}=${value}`]), '--jq', '{payload: (.|tojson)}', '--full'], { timeout: 20_000, maxBuffer: 1024 * 1024 })
  const raw = JSON.parse(stdout.trim().replace(/^payload: /, ''))
  const result = typeof raw === 'string' ? JSON.parse(raw) : raw
  if (result.errors?.length || !result.data?.repository) throw new Error('GitHub release/tag inspection unavailable; no publication attempted.')
  return result.data.repository
}
/** --verify-tag is mandatory: GitHub's create API alone can implicitly create
 * a missing tag. No --target, generated notes, deployment or tag mutation path.
 * https://cli.github.com/manual/gh_release_create */
export const publicationGithub: PublicationGithub = {
  async inspect(repository, tag) {
    const [owner, name] = repository.split('/')
    const result = await query(`query($owner:String!,$name:String!,$tag:String!,$ref:String!){repository(owner:$owner,name:$name){release(tagName:$tag){url isDraft description} ref(qualifiedName:$ref){target{oid __typename}}}}`, { owner: owner!, name: name!, tag, ref: `refs/tags/${tag}` })
    let target = result.ref?.target
    // Peel annotated tags as well as lightweight tags; only an exact commit binds notes.
    while (target?.__typename === 'Tag') {
      const peeled = await query(`query($owner:String!,$name:String!,$oid:GitObjectID!){repository(owner:$owner,name:$name){object(oid:$oid){... on Tag{target{oid __typename}}}}}`, { owner: owner!, name: name!, oid: target.oid })
      target = peeled.object?.target
    }
    return { tagSha: target?.__typename === 'Commit' ? target.oid : null, release: result.release ?? null }
  },
  async create(repository, tag, title, body) {
    const temporary = await mkdtemp(join(tmpdir(), 'tinstar-notes-'))
    try {
      const file = join(temporary, 'notes.md')
      await writeFile(file, body, { mode: 0o600 })
      await exec('gh-axi', ['release', 'create', tag, '--repo', repository, '--verify-tag', '--latest=false', '--title', title, '--notes-file', file], { timeout: 30_000, maxBuffer: 256 * 1024 })
    } finally { await rm(temporary, { recursive: true, force: true }) }
  },
}

/** An explicit operator invocation only. Page reads cannot publish. GitHub owns
 * release uniqueness; existing releases are inspected, never silently edited. */
export class ReleaseNotesPublisher {
  constructor(private root: string, private read: () => Promise<{ data: ReleasesRead; scene: FloorScene }>, private github: PublicationGithub = publicationGithub) {}
  async plan(releaseId: string, audience: NoteAudience) {
    const [{ data, scene }, settings] = await Promise.all([this.read(), readPublicationSettings(this.root)])
    const release = data.releases?.find(release => release.id === releaseId)
    if (!release) throw new Error('Select an exact release ID from the Releases read model.')
    const draft = draftReleaseNotes(release, releaseChanges(release, data, scene), audience)
    const holds = [
      ...(!settings.enabled ? ['Publication is OFF in releases/publication.json.'] : []),
      ...(release.kind !== 'production' ? ['Planning previews cannot be published.'] : []),
      ...(release.membership.status !== 'complete' || !data.associationsComplete ? ['Complete release membership and explicit work associations are required.'] : []),
      ...(!release.sourceSha ? ['An exact release tag/source binding is required.'] : []),
      ...(!draft.included.length ? ['No deployed, accepted changes are eligible for this audience.'] : []),
    ]
    return { zeroWrites: true, enabled: settings.enabled, releaseId, audience, repository: release.repository, tag: release.version,
      sourceSha: release.sourceSha, title: release.version, body: draft.publicationBody, included: draft.included.map(change => change.id), holds,
      command: ['gh-axi', 'release', 'create', release.version, '--repo', release.repository, '--verify-tag', '--latest=false', '--title', release.version, '--notes-file', '<reviewed-draft-file>'],
      preflight: 'Inspect the existing tag commit and existing GitHub Release; review release:published listeners before owner activation.' }
  }
  async publish(releaseId: string, audience: NoteAudience, actor: string, reason: string) {
    if (!actor.trim() || !reason.trim()) throw new Error('Publication requires an actor and an authorization reason.')
    const plan = await this.plan(releaseId, audience)
    if (plan.holds.length) throw new Error(plan.holds.join(' '))
    if (!/^[\w.-]+\/[\w.-]+$/.test(plan.repository) || !plan.tag || plan.tag.startsWith('-')) throw new Error('Invalid repository/tag identity')
    const existing = await this.github.inspect(plan.repository, plan.tag)
    if (existing.tagSha !== plan.sourceSha) throw new Error('Existing tag is missing or differs from the selected release source. No tag will be created.')
    const audit = new CreationReceipts(this.root), key = `release-notes:${randomUUID()}`
    const entry = { at: new Date().toISOString(), actor, reason, releaseId, audience, repository: plan.repository, tag: plan.tag, body: plan.body, status: 'intent', url: null as string | null }
    const save = async (status: string, url: string | null = null) => { await audit.put(key, JSON.stringify({ ...entry, status, url })); return { key, status, url } }
    if (existing.release) {
      // A replay or a lost create response is recovered by reading GitHub itself.
      return save(existing.release.isDraft ? 'existing-draft; review in GitHub' : sameNotes(existing.release.description, plan.body) ? 'already-published' : 'existing-release; review in GitHub', existing.release.url)
    }
    await save('intent')
    try {
      await this.github.create(plan.repository, plan.tag, plan.title, plan.body)
      const confirmed = await this.github.inspect(plan.repository, plan.tag)
      if (confirmed.tagSha !== plan.sourceSha || !confirmed.release || confirmed.release.isDraft || !sameNotes(confirmed.release.description, plan.body)) throw new Error('Publication readback is not confirmed')
      return await save('published', confirmed.release.url)
    } catch {
      await save('inconclusive')
      throw new Error('Publication outcome unknown. Inspect GitHub, then rerun this command with a reason; existing releases are never overwritten or automatically retried.')
    }
  }
}
