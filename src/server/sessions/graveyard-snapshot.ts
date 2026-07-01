// Durable transcript snapshots for the Graveyard.
//
// Revive is otherwise best-effort: it depends on Claude Code's retained
// transcript, which Tinstar doesn't own and CC may prune. Snapshotting copies
// the transcript into a config-root store at retire-time so a grave stays
// revivable even after CC forgets it. At revive, the snapshot (or the still-live
// transcript) is placed at the cwd-derived path `claude --resume` looks up.
//
// All paths are built from the caller-supplied root dir (dirs.root / config
// root) — never homedir() — so the store survives per-session-dir removal.

import { existsSync, mkdirSync, copyFileSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Copy src → dest atomically: write to a sibling temp then rename, so a crash
 *  or disk-full mid-copy never leaves a truncated file that existsSync reports
 *  as a valid transcript. */
function atomicCopy(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true })
  const tmp = `${dest}.tmp`
  copyFileSync(src, tmp)
  renameSync(tmp, dest)
}

/** Where a convId's snapshot lives, under <rootDir>/graveyard-transcripts/. */
export function graveyardSnapshotPath(rootDir: string, convId: string): string {
  return join(rootDir, 'graveyard-transcripts', `${convId}.jsonl`)
}

/** Copy the source transcript into the graveyard store. Best-effort: returns
 *  false (never throws) when the source is missing or the copy fails, so a
 *  snapshot failure can't block a delete. */
export function snapshotTranscript(rootDir: string, convId: string, sourcePath: string | null): boolean {
  if (!sourcePath || !existsSync(sourcePath)) return false
  try {
    atomicCopy(sourcePath, graveyardSnapshotPath(rootDir, convId))
    return true
  } catch {
    return false
  }
}

export function hasGraveyardSnapshot(rootDir: string, convId: string): boolean {
  return existsSync(graveyardSnapshotPath(rootDir, convId))
}

/** Remove a snapshot (purge). Best-effort no-op when absent. */
export function deleteGraveyardSnapshot(rootDir: string, convId: string): void {
  try {
    rmSync(graveyardSnapshotPath(rootDir, convId), { force: true })
  } catch {
    /* best-effort */
  }
}

/** Where a worktree-missing revive runs (its cwd holds the restored transcript). */
export function reviveWorkdir(rootDir: string, name: string): string {
  return join(rootDir, 'graveyard-revives', name)
}

/** Remove a revived session's fallback workdir on teardown, so revive-then-delete
 *  cycles don't leave orphaned transcript copies accumulating under the config
 *  root. Best-effort no-op when the session used a real worktree instead. */
export function deleteReviveWorkdir(rootDir: string, name: string): void {
  try {
    rmSync(reviveWorkdir(rootDir, name), { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
}

/** Ensure a transcript exists at `destPath` (the cwd-derived path `--resume`
 *  reads), copying from `sourcePath` when it isn't already there. Returns true
 *  when the destination ends up populated. */
export function placeTranscriptAt(destPath: string, sourcePath: string | null): boolean {
  if (existsSync(destPath)) return true
  if (!sourcePath || !existsSync(sourcePath)) return false
  try {
    atomicCopy(sourcePath, destPath)
    return true
  } catch {
    return false
  }
}
