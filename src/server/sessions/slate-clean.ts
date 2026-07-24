// "Clean the Slate" — delete a run's authored surface FILES from
// `<workdir>/.tinstar/slate/*.json`.
//
// The counterpart to slate-watcher.ts, and deliberately its mirror image: the
// watcher is the only reader of that directory, this is the only deleter. Both
// resolve the dir the same way, and both apply the same containment rules, so a
// file the watcher would refuse to READ is also one this refuses to DELETE:
//
//   · direct children only — a name containing a path separator, or any resolved
//     path that doesn't sit directly under the slate dir, is skipped;
//   · `.json` only — the extension the watcher projects from. Anything else in
//     that directory belongs to someone else and is left alone;
//   · `lstat` (NOT `stat`), so a symlink reports `isFile:false` and is skipped
//     rather than followed. Deleting through a symlink would let a planted link
//     turn "clean my slate" into "delete an arbitrary file in the worktree".
//
// ENOENT on the directory is normal — a run that never authored a surface has no
// slate dir — and counts as "already clean", not an error. Same posture as the
// watcher, where a missing dir simply projects an empty slate.
//
// Server-only (rides the server esbuild bundle) and React-free.

import { existsSync } from 'node:fs'
import { readdir, lstat, unlink } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { log } from '../logger'

/** Filesystem seam — injectable so tests are deterministic against a fake fs.
 *  Intentionally the watcher's `SlateFs` shape minus the read/watch calls, plus
 *  `unlink`; keeping the shared members identical means a test double written for
 *  one can be reused for the other. */
export interface SlateCleanFs {
  existsSync(dir: string): boolean
  readdir(dir: string): Promise<string[]> | string[]
  /** `size` + `isFile` from an `lstat` (NOT `stat`): a symlink reports `isFile:false`. */
  lstat(path: string): Promise<{ isFile: boolean }> | { isFile: boolean }
  unlink(path: string): Promise<void> | void
}

const DEFAULT_FS: SlateCleanFs = {
  existsSync,
  readdir: (dir) => readdir(dir),
  lstat: async (path) => ({ isFile: (await lstat(path)).isFile() }),
  unlink: (path) => unlink(path),
}

/** The slate dir for a workdir. Must stay in step with `SlateWatcher.slateDir`
 *  — if these two ever disagree, clean deletes from a directory the watcher
 *  isn't reading and the surfaces come straight back on the next poll. */
export function slateDirFor(workdir: string): string {
  return join(workdir, '.tinstar', 'slate')
}

/** Delete every authored surface file in a run's slate dir.
 *
 *  Returns the number of files actually unlinked. Never throws: a per-file
 *  failure (races with the agent rewriting a surface, a permissions problem) is
 *  logged and skipped so one stuck file can't abort the whole clean — a partial
 *  clean is recoverable by clicking again, an exception mid-loop is not.
 *
 *  Deliberately does NOT remove the directory itself. The watcher arms its
 *  `fs.watch` on that dir and re-arms only when it reappears; deleting it would
 *  drop the watch and leave the run's next authored surface unnoticed until a
 *  poll caught up. An empty dir projects an empty slate just as well. */
export async function deleteSlateFiles(
  workdir: string,
  fs: SlateCleanFs = DEFAULT_FS,
): Promise<number> {
  const slateDir = slateDirFor(workdir)
  if (!fs.existsSync(slateDir)) return 0 // never authored a surface → already clean

  let names: string[]
  try {
    names = await fs.readdir(slateDir)
  } catch (err) {
    // Raced with a worktree teardown, or unreadable. Nothing to report but zero.
    log.debug('slate-clean', `readdir(${slateDir}) failed: ${(err as Error).message}`)
    return 0
  }

  let deleted = 0
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const path = join(slateDir, name)
    // Containment: `join` normalizes away any `..`, so a hostile name can only
    // ever escape by landing outside this prefix — which this rejects.
    if (!path.startsWith(slateDir + sep)) continue
    try {
      const st = await fs.lstat(path)
      if (!st.isFile) continue // dir or symlink — not ours to delete
      await fs.unlink(path)
      deleted++
    } catch (err) {
      log.debug('slate-clean', `unlink(${path}) failed: ${(err as Error).message}`)
    }
  }
  return deleted
}
