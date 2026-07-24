import { describe, it, expect } from 'vitest'
import { join } from 'node:path'
import { deleteSlateFiles, slateDirFor, type SlateCleanFs } from '../slate-clean'

const WORKDIR = '/tmp/run-wt'
const SLATE = slateDirFor(WORKDIR)

/** A fake slate dir. `entries` maps a NAME to what lstat should report; anything
 *  unlisted lstats as a plain file. */
function fakeFs(names: string[], opts: {
  entries?: Record<string, { isFile: boolean }>
  exists?: boolean
  readdirThrows?: boolean
  unlinkThrows?: string[]
} = {}) {
  const unlinked: string[] = []
  const fs: SlateCleanFs = {
    existsSync: () => opts.exists ?? true,
    readdir: () => {
      if (opts.readdirThrows) throw new Error('EACCES')
      return names
    },
    lstat: (path: string) => {
      const name = path.slice(SLATE.length + 1)
      return opts.entries?.[name] ?? { isFile: true }
    },
    unlink: (path: string) => {
      if (opts.unlinkThrows?.some((n) => path.endsWith(n))) throw new Error('EBUSY')
      unlinked.push(path)
    },
  }
  return { fs, unlinked }
}

describe('deleteSlateFiles — the only deleter of the watcher\'s directory', () => {
  it('deletes every .json surface file and reports the count', async () => {
    const { fs, unlinked } = fakeFs(['goal.json', 'open.json', 'steps.json'])
    await expect(deleteSlateFiles(WORKDIR, fs)).resolves.toBe(3)
    expect(unlinked.sort()).toEqual([
      join(SLATE, 'goal.json'), join(SLATE, 'open.json'), join(SLATE, 'steps.json'),
    ].sort())
  })

  it('leaves non-.json files alone — that directory is not exclusively ours', async () => {
    const { fs, unlinked } = fakeFs(['goal.json', 'README.md', 'notes.txt', '.gitkeep'])
    await expect(deleteSlateFiles(WORKDIR, fs)).resolves.toBe(1)
    expect(unlinked).toEqual([join(SLATE, 'goal.json')])
  })

  it('skips symlinks and directories instead of following them', async () => {
    // A symlink lstats as isFile:false. Deleting through one would turn "clean my
    // slate" into "delete an arbitrary file in the worktree".
    const { fs, unlinked } = fakeFs(['real.json', 'link.json', 'sub.json'], {
      entries: { 'link.json': { isFile: false }, 'sub.json': { isFile: false } },
    })
    await expect(deleteSlateFiles(WORKDIR, fs)).resolves.toBe(1)
    expect(unlinked).toEqual([join(SLATE, 'real.json')])
  })

  it('refuses a name that would escape the slate dir', async () => {
    const { fs, unlinked } = fakeFs(['../../../etc/evil.json', 'ok.json'])
    await expect(deleteSlateFiles(WORKDIR, fs)).resolves.toBe(1)
    expect(unlinked).toEqual([join(SLATE, 'ok.json')])
  })

  it('treats a missing slate dir as already clean, not an error', async () => {
    const { fs, unlinked } = fakeFs([], { exists: false })
    await expect(deleteSlateFiles(WORKDIR, fs)).resolves.toBe(0)
    expect(unlinked).toEqual([])
  })

  it('survives an unreadable dir without throwing into the request path', async () => {
    const { fs } = fakeFs(['a.json'], { readdirThrows: true })
    await expect(deleteSlateFiles(WORKDIR, fs)).resolves.toBe(0)
  })

  it('keeps going when ONE file fails — a partial clean beats an aborted one', async () => {
    // Racing the agent rewriting a surface must not strand the other files.
    const { fs, unlinked } = fakeFs(['a.json', 'stuck.json', 'c.json'], { unlinkThrows: ['stuck.json'] })
    await expect(deleteSlateFiles(WORKDIR, fs)).resolves.toBe(2)
    expect(unlinked).toEqual([join(SLATE, 'a.json'), join(SLATE, 'c.json')])
  })

  it('cleans an already-empty dir to zero without touching anything', async () => {
    // The idempotent second click. (That the dir itself is never REMOVED — the
    // watcher's fs.watch is armed on it — is guaranteed by construction: the
    // SlateCleanFs seam exposes no rmdir/rm at all, so no test can prove it.)
    const { fs, unlinked } = fakeFs([])
    await expect(deleteSlateFiles(WORKDIR, fs)).resolves.toBe(0)
    expect(unlinked).toEqual([])
  })

  it('resolves the same dir the watcher reads', () => {
    // If these ever disagree, clean deletes from a dir the watcher isn't reading
    // and every surface returns on the next poll.
    expect(slateDirFor(WORKDIR)).toBe(join(WORKDIR, '.tinstar', 'slate'))
  })
})
