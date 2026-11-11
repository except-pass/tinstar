import { eligibleReleaseNote, type ReleaseChange, type ReleaseObject } from './releaseObjects'

export type NoteAudience = 'internal' | 'customer'

/** Reasons remain internal; the customer draft contains eligible wording only. */
export function noteExclusions(release: ReleaseObject, change: ReleaseChange, audience: NoteAudience): string[] {
  const reasons: string[] = []
  if (release.kind !== 'production') reasons.push('Planning preview only; not a production release')
  if (release.membership.status !== 'complete') reasons.push('Release membership is incomplete')
  if (!change.cardId) reasons.push('No explicitly linked work')
  if (change.delivery !== 'Deployed') reasons.push(`Deployment: ${change.delivery}`)
  if (change.acceptance !== 'Passed') reasons.push(`Acceptance: ${change.acceptance}`)
  if (!change.successCondition || !change.checkRef || !change.acceptanceEvidence) reasons.push('Feature acceptance evidence is incomplete')
  if (!change.note) reasons.push('No note wording')
  if (audience === 'customer' && change.audience !== 'customer') reasons.push('Internal-only work')
  return reasons
}

/** Shared by the visible/copyable draft and the separate publication command. */
export function draftReleaseNotes(release: ReleaseObject, changes: ReleaseChange[], audience: NoteAudience) {
  const preview = release.kind !== 'production'
  const included = changes.filter(change => (preview ? !!change.note : eligibleReleaseNote(release, change)) && (audience === 'internal' || change.audience === 'customer'))
    .map(change => ({ ...change, note: audience === 'customer' ? change.customerNote ?? change.note : change.note }))
  const groups = [...new Set(included.map(change => change.product))]
  const title = `${preview ? release.kind === 'draft' ? 'Draft ' : 'RC ' : ''}${release.version}`
  const content = [`${release.repository} · ${audience}`, '',
    ...groups.flatMap(product => [product, ...included.filter(change => change.product === product).map(change => `- ${change.note}`), '']),
    ...(!included.length ? ['No changes are currently eligible for this audience.'] : [])]
  const text = [title, preview ? 'Planning preview (not published)' : 'Draft release notes (not published)', ...content].join('\n')
  return { preview, included, groups, text, publicationBody: [title, ...content].join('\n'), excluded: changes.flatMap(change => {
    const reasons = noteExclusions(release, change, 'customer')
    return reasons.length ? [{ id: change.id, title: change.title, reasons }] : []
  }) }
}
