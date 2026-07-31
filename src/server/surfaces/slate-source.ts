// The `slate-file` source binding — one canonical Surface per authored entry in
// `<worktree>/.tinstar/slate/*.json` (plan U2, KTD4).
//
// Two directions cross this module, and they have to agree on one locator and one
// watermark or reconciliation oscillates:
//
//   · INGRESS (file → canonical). `SlateWatcher` reads and validates the directory,
//     this module turns each surviving entry into a binding address plus a content
//     hash, and the reconciler proposes it through the mutation service.
//   · EGRESS (canonical → file). A direct API content edit to a Surface whose
//     authority IS its source binding may not simply overwrite the record — the next
//     epoch would revert it. {@link SlateFileAdapter} is the `SurfaceSourceAdapter`
//     U3 left a seam for: it carries the edit back into the same entry of the same
//     file, and only the watermark it returns is persisted.
//
// IDENTITY DOES NOT LIVE HERE, and that is the point of the split. A Surface's id
// comes from the run INCARNATION plus the entry's LOCAL id
// (`deriveLegacySurfaceId`) — the same derivation the legacy migration uses, which
// is what lets a file-authored entry land on the Surface migration already adopted
// from the matching legacy point, thread and lifecycle intact. The filename is
// carried in the locator as ADDRESSING only, so moving an entry between files
// rebinds the same Surface instead of minting a second one.
//
// Server-only (rides the server esbuild bundle) and React-free.

import { createHash } from 'node:crypto'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join, sep } from 'node:path'
import type {
  A2uiContent, PointAuthor, SurfaceClaim, SurfaceContent, SurfaceProposal, SurfaceRefreshDeclaration,
} from '../../domain/types'
import {
  parseProposal, parseRefreshDeclaration, parseSurfaceClaim, parseSurfaceClaims,
} from './surface-trigger-matcher'
import type { SurfaceSourceAdapter } from './surface-service'

/** The adapter name stamped on a Surface reconciled from a Slate source file. */
export const SLATE_FILE_ADAPTER = 'slate-file'

/** The directory, relative to a worktree, that the watcher reads and this adapter
 *  writes. Kept here so ingress and egress cannot drift apart. */
export const SLATE_DIR_PARTS = ['.tinstar', 'slate'] as const

/** One authored entry as the source presents it. The subset of a validated file
 *  entry that a canonical Surface has a home for — `anchor` and `group` are
 *  deliberately absent (the canonical model has no card-vs-row distinction and
 *  models grouping as a container Surface, not a field). */
export interface SlateSourceEntry {
  /** The entry's run-local id: explicit `id`, or the synthesized content hash the
   *  legacy projection assigns an id-less entry. Identity follows THIS. */
  localId: string
  /** Basename of the file it was read from — addressing, not identity. */
  file: string
  content: SurfaceContent
  author: PointAuthor
  /** File-seeded creation stamp, when the entry carries one. */
  createdAt?: number
  /** Content hash of the authored fields. See {@link slateEntryWatermark}. */
  watermark: string
  /** Claims this entry declared that the host would not accept, one sentence each
   *  (R3, plan U6). HOST KNOWLEDGE riding alongside the author's content, and
   *  deliberately NOT part of {@link watermark} — the refusal is the host's verdict
   *  on the declaration, not part of it, and a verdict inside the watermark basis
   *  would advance the generation every time the host re-read the same file.
   *
   *  Absent when nothing was refused. The entry is present either way: a refused
   *  claim costs that claim and never the Surface (KTD5), so the card renders its
   *  NEW content with the bad claim gone — which is a different case from the
   *  watcher's `unreadable` path, where an entry it could not parse at all keeps
   *  its LAST-VALID projection. */
  claimRefusals?: string[]
}

/** Build a `slate-file` locator. Two halves because a file holds many entries and
 *  the binding addresses ONE of them: a file-level change must be attributable to
 *  the entries inside it, or "one source file cannot retract a Surface owned by
 *  another file" would have nothing to compare. */
export function slateFileLocator(file: string, localId: string): string {
  return `file:${file}#${localId}`
}

/** The inverse. `null` for a locator this adapter does not own — which includes
 *  every `legacy-slate-point` locator (`run:<id>/point:<id>`), whose address is a
 *  position in the legacy bridge and resolves to no file at all. */
export function parseSlateFileLocator(locator: string): { file: string; localId: string } | null {
  if (!locator.startsWith('file:')) return null
  const hash = locator.indexOf('#')
  if (hash < 0) return null
  const file = locator.slice('file:'.length, hash)
  const localId = locator.slice(hash + 1)
  if (!file || !localId) return null
  // Addressing only, but it still reaches the filesystem on egress: a name with a
  // separator in it is not a direct child of the slate dir and is refused here
  // rather than at the write, so a malformed locator cannot be constructed at all.
  if (basename(file) !== file || !file.endsWith('.json')) return null
  return { file, localId }
}

/**
 * The observation evidence for one entry: a hash of the AUTHORED fields only.
 *
 * Normalized rather than taken over the raw file bytes, deliberately. The
 * watermark's job is to answer "did the author change this surface", and hashing
 * bytes would answer "did anything in the file move" — reformatting the JSON,
 * reordering keys, or touching a sibling entry would all advance the generation and
 * burn a revision on a Surface nobody edited.
 *
 * KTD10 is explicit that this is EVIDENCE, compared for equality only, and never
 * ordered as time. The monotonic ordering lives in the binding's `generation`.
 */
export function slateEntryWatermark(fields: {
  headline: string
  body?: A2uiContent
  recipe?: string
  refreshPolicy?: SurfaceRefreshDeclaration
  claims?: SurfaceClaim[]
  proposal?: SurfaceProposal
  author: PointAuthor
}): string {
  const basis = JSON.stringify({
    headline: fields.headline,
    body: fields.body ?? null,
    recipe: fields.recipe ?? null,
    // U6's declaration is part of the basis: it decides WHEN the host rebuilds this
    // surface, so an author who edits only the policy has genuinely changed the
    // entry. Leaving it out would mean the reconciler saw an unchanged watermark,
    // committed nothing, and quietly kept enforcing the old triggers.
    refreshPolicy: fields.refreshPolicy ?? null,
    // U1's claims are in the basis for the same reason: a claim DECLARATION is
    // author meaning — it says what would prove this surface wrong — so editing one
    // is genuinely editing the entry, and an unchanged watermark would leave the
    // host checking the old statement forever.
    //
    // ONLY THE DECLARATION. What a witness observed is host-owned and lives on
    // `freshness` (KTD2), deliberately outside this basis: a host-written value in
    // here would move the watermark every time the host looked, which is a revision
    // and a rebuild per surface per sweep, forever. `?? null` keeps absent and `[]`
    // apart — they serialize differently, which is the whole three-state contract.
    claims: fields.claims ?? null,
    // The author's CLAIM is part of the basis, but only its meaning — `state` and
    // `detail`. `at` is host-stamped on every read, so hashing it would move the
    // watermark on every epoch forever and burn a revision per surface per tick.
    proposal: fields.proposal ? { state: fields.proposal.state, detail: fields.proposal.detail ?? null } : null,
    author: fields.author,
  })
  return 'sha256:' + createHash('sha256').update(basis).digest('hex').slice(0, 32)
}

/** The absolute path a `slate-file` binding resolves to, or `null` when it cannot
 *  be resolved safely. Containment is re-asserted here because this is the path the
 *  EGRESS adapter writes through — the watcher's own containment check protects
 *  reads and says nothing about a locator that arrived on a persisted record. */
export function slateFilePath(worktree: string, file: string): string | null {
  if (!worktree) return null
  const dir = join(worktree, ...SLATE_DIR_PARTS)
  const path = join(dir, file)
  return path.startsWith(dir + sep) ? path : null
}

/** Filesystem seam for the egress adapter — injectable so tests need no temp dir. */
export interface SlateSourceFs {
  readFile(path: string): Promise<string> | string
  writeFile(path: string, data: string): Promise<void> | void
  rename(from: string, to: string): Promise<void> | void
}

const DEFAULT_FS: SlateSourceFs = {
  readFile: p => readFile(p, 'utf8'),
  writeFile: (p, d) => writeFile(p, d, 'utf8'),
  rename: (a, b) => rename(a, b),
}

/** The authored fields of one raw file entry, or `null` when it does not look like
 *  an entry at all. Used by the egress adapter to compute the CURRENT watermark of
 *  the entry it is about to replace — the ingress side computes the same value from
 *  the same fields through {@link slateEntryWatermark}. */
function authoredFieldsOf(raw: unknown): {
  headline: string; body?: A2uiContent; recipe?: string
  refreshPolicy?: SurfaceRefreshDeclaration; claims?: SurfaceClaim[]
  proposal?: SurfaceProposal; author: PointAuthor
} | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (typeof r.headline !== 'string' || !r.headline) return null
  const author: PointAuthor = r.author === 'user' || r.author === 'process' ? r.author : 'agent'
  const declaration = parseRefreshDeclaration(r.refreshPolicy)
  // The REFUSALS half is deliberately dropped here. This function exists to
  // reproduce the watermark of an entry the ingress side already read, and a refusal
  // is host knowledge that is not in the watermark basis — reading it on this side
  // would be reading it in the one place that cannot report it.
  const { claims } = parseSurfaceClaims(r.claims)
  // Host-stamped `at`, exactly as ingress stamps it. The value never survives into
  // the watermark (see `slateEntryWatermark`), so a constant here would be equally
  // correct and a wrong-looking one would be harder to read.
  const proposal = parseProposal(r.proposal, Date.now())
  return {
    headline: r.headline,
    ...(r.content !== undefined ? { body: r.content as A2uiContent } : {}),
    ...(typeof r.refresh === 'string' && r.refresh ? { recipe: r.refresh } : {}),
    // Parsed rather than passed through, so the watermark this computes matches the
    // one INGRESS computes from the same file. Hashing the raw declaration would let
    // a field the parser drops move the watermark on every epoch, forever.
    ...(declaration ? { refreshPolicy: declaration } : {}),
    // Parsed for the same reason, and carried with `!== undefined` because `[]` is a
    // declaration rather than an empty one: collapsing it here would make the
    // egress side hash something the ingress side does not, and every write-back
    // would look to the next epoch like an author edit.
    ...(claims !== undefined ? { claims } : {}),
    ...(proposal ? { proposal } : {}),
    author,
  }
}

/** The raw claim entries of one file entry that {@link parseSurfaceClaim} would not
 *  accept — the author's own words, kept verbatim through a write-back. Read off the
 *  RAW entry rather than reconstructed, because the whole point is to preserve a
 *  shape the parser could not turn into a `SurfaceClaim` at all.
 *
 *  Only per-claim refusals. A list refused WHOLE (over the cap) leaves every claim
 *  individually valid, so nothing here matches it and the pre-existing whole-list
 *  behaviour is unchanged. */
function refusedRawClaims(rawEntry: unknown): Record<string, unknown>[] {
  if (!rawEntry || typeof rawEntry !== 'object') return []
  const claims = (rawEntry as Record<string, unknown>).claims
  if (!Array.isArray(claims)) return []
  return claims.filter(c => typeof parseSurfaceClaim(c) === 'string') as Record<string, unknown>[]
}

/** The adapter registry every `SurfaceService` in the process is built with. One
 *  factory so the HTTP service and the watcher's service cannot end up with
 *  different adapters registered — which would make a source-bound content edit
 *  succeed or be refused depending on which entry point it arrived through. */
export function slateSourceAdapters(): Record<string, SurfaceSourceAdapter> {
  return { [SLATE_FILE_ADAPTER]: new SlateFileAdapter() }
}

/**
 * Carry an API content edit back into the source file that owns it (KTD4).
 *
 * The write is compare-and-swap on the entry's own watermark, not on the file: two
 * Surfaces authored by one file are edited independently, and refusing an edit
 * because a SIBLING entry moved would make a shared file a lock. The read-modify-
 * write is not atomic against a concurrent agent rewriting the same file — Node has
 * no such primitive for a JSON document — so the watermark check is what makes a
 * lost update visible rather than silent, and the caller retries.
 *
 * The rename is `writeFile` to a sibling temp path then `rename`, so the watcher
 * never observes a half-written file and takes it as a torn read.
 */
export class SlateFileAdapter implements SurfaceSourceAdapter {
  constructor(private readonly fs: SlateSourceFs = DEFAULT_FS) {}

  async write(input: {
    surface: { source?: { locator: string; worktree?: string } }
    content: SurfaceContent
    expectedWatermark?: string
  }): Promise<{ ok: true; watermark: string } | { ok: false; stale?: true; message: string }> {
    const binding = input.surface.source
    const parsed = binding ? parseSlateFileLocator(binding.locator) : null
    if (!binding || !parsed) {
      return { ok: false, message: 'this Surface is not bound to a Slate source file' }
    }
    if (!binding.worktree) {
      return { ok: false, message: `no worktree is recorded for source ${binding.locator}, so the file cannot be located` }
    }
    const path = slateFilePath(binding.worktree, parsed.file)
    if (!path) return { ok: false, message: `source locator ${binding.locator} does not resolve inside the slate directory` }

    let raw: string
    try {
      raw = await this.fs.readFile(path)
    } catch (err) {
      return { ok: false, message: `could not read ${parsed.file}: ${(err as Error).message}` }
    }
    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(raw)
    } catch (err) {
      return { ok: false, message: `${parsed.file} is not valid JSON (${(err as Error).message}); refusing to overwrite a file this edit cannot merge into` }
    }
    const array = Array.isArray(parsedJson)
    const entries: unknown[] = array ? (parsedJson as unknown[]) : [parsedJson]
    const index = entries.findIndex(e => !!e && typeof e === 'object' && (e as Record<string, unknown>).id === parsed.localId)
    if (index < 0) {
      return { ok: false, message: `${parsed.file} no longer holds an entry with id ${JSON.stringify(parsed.localId)}` }
    }
    const current = authoredFieldsOf(entries[index])
    if (!current) return { ok: false, message: `entry ${parsed.localId} in ${parsed.file} is not a usable surface entry` }
    if (input.expectedWatermark !== undefined && slateEntryWatermark(current) !== input.expectedWatermark) {
      // STALE, not broken. The caller can retry against the newer entry; a refresh
      // result is superseded and gets a successor rather than failing the Surface.
      return {
        ok: false,
        stale: true,
        message: `entry ${parsed.localId} in ${parsed.file} changed since it was read; re-read and retry`,
      }
    }

    // Every field the file carries that is NOT authored content is preserved by
    // spreading the prior entry: dropping an unrecognised key would make an API
    // edit quietly delete whatever a future file schema added.
    const next: Record<string, unknown> = { ...(entries[index] as Record<string, unknown>) }
    next.headline = input.content.headline
    if (input.content.body === undefined) delete next.content
    else next.content = input.content.body
    if (input.content.recipe === undefined) delete next.refresh
    else next.refresh = input.content.recipe
    // The declaration travels with the recipe (U6): they are one contract, and
    // writing back a recipe without the triggers that fire it would leave the file
    // describing a surface the host refreshes on different terms.
    if (input.content.refreshPolicy === undefined) delete next.refreshPolicy
    else next.refreshPolicy = input.content.refreshPolicy as unknown as Record<string, unknown>
    // Claims travel the same way (U1). They are in the entry watermark, so the
    // set/delete pair has to be here too: an omitted write-back would leave the file
    // holding a declaration the record no longer has, and the very next epoch would
    // read the file's version back as an author edit and undo the write.
    //
    // A REFUSED CLAIM IS NOT WRITTEN OUT OF THE AUTHOR'S FILE (plan U6, R3). The
    // record only ever holds the claims the parser accepted, so a plain write-back
    // deletes the rest — and the moment U6 wired the witness registry into the
    // parser, "the rest" became every mistyped witness kind. The consequence is worse
    // than the loss itself: the next epoch would re-read a file with nothing wrong in
    // it, the refusal would clear, and the card would look healthy having quietly
    // eaten the author's declaration on a rebuild they never asked for.
    //
    // Safe to keep because the watermark hashes PARSED claims: a refused claim is
    // absent from both sides of that hash, so leaving it in the file moves no
    // evidence and the round trip still agrees with itself.
    const refusedInFile = refusedRawClaims(entries[index])
    if (input.content.claims === undefined) {
      if (refusedInFile.length > 0) next.claims = refusedInFile
      else delete next.claims
    } else {
      next.claims = [...(input.content.claims as unknown as Record<string, unknown>[]), ...refusedInFile]
    }
    // The author's claim travels back too. Written WITHOUT `at`: the host stamps that
    // on every read, so persisting it into the file would put a host observation
    // under the author's byline and make the file and the record disagree about a
    // field neither of them owns.
    if (input.content.proposal === undefined) delete next.proposal
    else next.proposal = { state: input.content.proposal.state, ...(input.content.proposal.detail ? { detail: input.content.proposal.detail } : {}) }
    entries[index] = next

    const serialized = JSON.stringify(array ? entries : entries[0], null, 2) + '\n'
    const temp = `${path}.tinstar-tmp`
    try {
      await this.fs.writeFile(temp, serialized)
      await this.fs.rename(temp, path)
    } catch (err) {
      return { ok: false, message: `could not write ${parsed.file}: ${(err as Error).message}` }
    }
    const fields = authoredFieldsOf(next)
    // Unreachable in practice — `next` was built from a valid entry and only
    // authored fields were replaced — but returning a watermark computed from a
    // shape this module could not read would persist evidence nothing can match.
    if (!fields) return { ok: false, message: `wrote ${parsed.file} but could not re-read its authored fields` }
    return { ok: true, watermark: slateEntryWatermark(fields) }
  }
}
