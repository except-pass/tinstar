import { describe, expect, it } from 'vitest'
import { notesFixture } from '../../../test-fixtures/releases/notes'
import { releaseChanges } from '../../shared/releaseChanges'
import { cardAcceptanceContract } from '../../shared/releaseAcceptance'
import { draftReleaseNotes } from '../../shared/releaseNotes'

describe('release-scoped editorial drafts', () => {
  it('includes only accepted deployed work, using separate Internal and Customer wording', () => {
    const { release, data, scene } = notesFixture()
    const changes = releaseChanges(release, data, scene)
    const internal = draftReleaseNotes(release, changes, 'internal')
    expect(internal.included.map(change => change.cardId)).toEqual(['notes-card-0', 'notes-card-1'])
    expect(internal.text).toContain('- Internal: Bound query load.')
    const customer = draftReleaseNotes(release, changes, 'customer')
    expect(customer.included.map(change => change.cardId)).toEqual(['notes-card-1'])
    expect(customer.text).toContain('- Customer: Hide absent generator frequency.')
    expect(customer.text).not.toMatch(/Bound query|enum|controller|permissions|expired|Internal:/)
    expect(internal.excluded.find(item => item.id === 'card:notes-card-0')?.reasons).toContain('Internal-only work')
    expect(internal.excluded.find(item => item.id === 'card:notes-card-2')?.reasons).toContain('Acceptance: Failed')
    expect(internal.excluded.find(item => item.id === 'card:notes-card-5')?.reasons).toContain('Deployment: Not deployed')
  })
  it('defaults old contracts to Internal titles and preserves acceptance when editorial wording changes', () => {
    const f = notesFixture(), card = f.scene.cards[1]!
    const original = releaseChanges(f.release, f.data, f.scene)[1]!
    const parsed = cardAcceptanceContract(card.source.properties.Evidence!.value).contract!
    delete parsed.notes
    card.source.properties.Evidence!.value = '```production-acceptance\n' + JSON.stringify(parsed) + '\n```'
    const updated = releaseChanges(f.release, f.data, f.scene)[1]!
    expect(updated).toMatchObject({ audience: 'internal', note: 'Hide absent generator frequency', acceptance: 'Passed' })
    expect(updated.checks![0]!.key).toBe(original.checks![0]!.key)
    expect(draftReleaseNotes(f.release, releaseChanges(f.release, f.data, f.scene), 'customer').included).toHaveLength(0)
  })
  it('holds incomplete membership, missing associations and changed targets', () => {
    const f = notesFixture()
    f.release.membership.status = 'partial'
    expect(draftReleaseNotes(f.release, releaseChanges(f.release, f.data, f.scene), 'internal').included).toHaveLength(0)
    f.release.membership.status = 'complete'; f.data.associationsComplete = false
    expect(draftReleaseNotes(f.release, releaseChanges(f.release, f.data, f.scene), 'internal').included).toHaveLength(0)
    f.data.associationsComplete = true
    f.release.targets[0]!.receipt!.id = 'different-attempt'
    expect(draftReleaseNotes(f.release, releaseChanges(f.release, f.data, f.scene), 'internal').included).toHaveLength(0)
  })
  it('keeps candidates a planning preview, deduplicates cards and isolates another release', () => {
    const f = notesFixture(), candidate = f.data.releases!.find(item => item.kind === 'candidate')!
    const draft = draftReleaseNotes(candidate, releaseChanges(candidate, f.data, f.scene), 'customer')
    expect(draft.preview).toBe(true); expect(draft.text).toContain('Planning preview (not published)')
    expect(draft.included).toHaveLength(5)
    const older = f.data.releases!.at(-1)!
    expect(draftReleaseNotes(older, releaseChanges(older, f.data, f.scene), 'internal').included).toHaveLength(0)
    // A second member PR for the same accepted card remains one note.
    const extra = structuredClone(f.release.pulls[1]!); extra.url += '0'; extra.id += '0'
    f.data.pulls.push(extra); f.release.pulls.push(extra)
    const changes = releaseChanges(f.release, f.data, f.scene)
    expect(changes.filter(change => change.cardId === 'notes-card-1')).toHaveLength(1)
    expect(changes.find(change => change.cardId === 'notes-card-1')!.acceptance).toBe('Human review')
  })
})
