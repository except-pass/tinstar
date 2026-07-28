// @vitest-environment node
//
// The `slate-file` binding's two halves: the locator/watermark vocabulary the
// ingress side speaks, and the egress adapter that carries an API content edit back
// into the file so the next epoch agrees with it.
import { describe, it, expect } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DocumentStore } from '../../stores/document-store'
import { SurfaceService, type SurfaceCallContext } from '../surface-service'
import {
  parseSlateFileLocator,
  slateEntryWatermark,
  SlateFileAdapter,
  slateFileLocator,
  slateFilePath,
  SLATE_FILE_ADAPTER,
} from '../slate-source'
import type { Surface, SurfacePrincipalRef } from '../../../domain/types'

const HUMAN: SurfacePrincipalRef = { kind: 'human', id: 'actor-1' }
function ctx(at = 1_000): SurfaceCallContext { return { actor: HUMAN, at } }

describe('locators', () => {
  it('round-trips a file and entry id', () => {
    expect(parseSlateFileLocator(slateFileLocator('a.json', 'blockers')))
      .toEqual({ file: 'a.json', localId: 'blockers' })
  })

  it('refuses a locator this adapter does not own', () => {
    // What migration stamps for a point that has no file at all.
    expect(parseSlateFileLocator('run:run-a/point:blockers')).toBeNull()
  })

  it('refuses a locator that would escape the slate directory', () => {
    expect(parseSlateFileLocator('file:../../evil.json#x')).toBeNull()
    expect(parseSlateFileLocator('file:sub/dir.json#x')).toBeNull()
    expect(parseSlateFileLocator('file:notjson#x')).toBeNull()
    expect(slateFilePath('/wt', '../escape.json')).toBeNull()
  })
})

describe('watermarks', () => {
  it('ignores everything but the authored fields', () => {
    const a = slateEntryWatermark({ headline: 'h', author: 'agent' })
    const b = slateEntryWatermark({ headline: 'h', author: 'agent' })
    expect(a).toBe(b)
    expect(slateEntryWatermark({ headline: 'h', author: 'user' })).not.toBe(a)
    expect(slateEntryWatermark({ headline: 'h', recipe: 'r', author: 'agent' })).not.toBe(a)
  })
})

describe('the egress adapter', () => {
  let dir: string
  const bound = (over: Partial<Surface['source']> = {}) => ({
    source: { adapter: SLATE_FILE_ADAPTER, locator: slateFileLocator('a.json', 'blockers'), generation: 1, worktree: dir, ...over },
  })

  function seed(entries: unknown): void {
    dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    writeFileSync(join(slate, 'a.json'), JSON.stringify(entries, null, 2))
  }
  function read(): unknown {
    return JSON.parse(readFileSync(join(dir, '.tinstar', 'slate', 'a.json'), 'utf8'))
  }

  it('replaces the addressed entry and preserves its siblings and unknown fields', async () => {
    seed([
      { id: 'blockers', headline: 'Two blockers', content: { root: 'x', components: {} }, someFutureField: 7 },
      { id: 'plan', headline: 'The plan' },
    ])
    const r = await new SlateFileAdapter().write({
      surface: bound() as never,
      content: { headline: 'One blocker' },
    })

    expect(r.ok).toBe(true)
    const after = read() as Record<string, unknown>[]
    expect(after).toHaveLength(2)
    expect(after[0]).toEqual({ id: 'blockers', headline: 'One blocker', someFutureField: 7 })
    expect(after[1]).toEqual({ id: 'plan', headline: 'The plan' })
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns a watermark the ingress side reproduces from the same file', async () => {
    seed([{ id: 'blockers', headline: 'Two blockers' }])
    const r = await new SlateFileAdapter().write({
      surface: bound() as never,
      content: { headline: 'One blocker', recipe: 'rebuild me' },
    })

    expect(r.ok && r.watermark).toBe(slateEntryWatermark({ headline: 'One blocker', recipe: 'rebuild me', author: 'agent' }))
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses when the entry changed since it was read', async () => {
    seed([{ id: 'blockers', headline: 'Two blockers' }])
    const r = await new SlateFileAdapter().write({
      surface: bound() as never,
      content: { headline: 'One blocker' },
      expectedWatermark: 'sha256:not-the-current-one',
    })

    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/changed since it was read/)
    expect((read() as Record<string, unknown>[])[0]!.headline).toBe('Two blockers')
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses rather than overwriting a file it cannot merge into', async () => {
    dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    writeFileSync(join(slate, 'a.json'), '{ not json')
    const r = await new SlateFileAdapter().write({ surface: bound() as never, content: { headline: 'x' } })

    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/not valid JSON/)
    expect(readFileSync(join(slate, 'a.json'), 'utf8')).toBe('{ not json')
    rmSync(dir, { recursive: true, force: true })
  })

  it('refuses a Surface whose binding names no file', async () => {
    const r = await new SlateFileAdapter().write({
      surface: { source: { adapter: 'legacy-slate-point', locator: 'run:r/point:p', generation: 0 } } as never,
      content: { headline: 'x' },
    })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.message).toMatch(/not bound to a Slate source file/)
  })
})

describe('registered on the service', () => {
  it('carries a source-bound API content edit into the file instead of refusing it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'slate-src-'))
    const slate = join(dir, '.tinstar', 'slate')
    mkdirSync(slate, { recursive: true })
    writeFileSync(join(slate, 'a.json'), JSON.stringify([{ id: 'blockers', headline: 'Two blockers' }]))

    const docStore = new DocumentStore()
    const svc = new SurfaceService(docStore, {
      newId: () => 'sf-1',
      sourceAdapters: { [SLATE_FILE_ADAPTER]: new SlateFileAdapter() },
    })
    const created = await svc.create({
      spaceId: 'spc-a',
      home: { kind: 'canvas', spaceId: 'spc-a' },
      content: { headline: 'Two blockers' },
      contentAuthority: 'source-binding',
      source: { adapter: SLATE_FILE_ADAPTER, locator: slateFileLocator('a.json', 'blockers'), worktree: dir },
    }, ctx())
    expect(created.ok).toBe(true)

    const edited = await svc.updateContent('sf-1', { headline: 'One blocker', expectedRev: 1 }, ctx(2_000))
    expect(edited.ok).toBe(true)
    // Both halves moved: the file, and the watermark persisted on the binding.
    const after = JSON.parse(readFileSync(join(slate, 'a.json'), 'utf8')) as Record<string, unknown>[]
    expect(after[0]!.headline).toBe('One blocker')
    expect(docStore.getSurface('sf-1')!.source!.watermark)
      .toBe(slateEntryWatermark({ headline: 'One blocker', author: 'agent' }))
    rmSync(dir, { recursive: true, force: true })
  })
})
