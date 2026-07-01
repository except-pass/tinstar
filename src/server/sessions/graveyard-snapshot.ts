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

import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
    const dest = graveyardSnapshotPath(rootDir, convId)
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(sourcePath, dest)
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

/** Ensure a transcript exists at `destPath` (the cwd-derived path `--resume`
 *  reads), copying from `sourcePath` when it isn't already there. Returns true
 *  when the destination ends up populated. */
export function placeTranscriptAt(destPath: string, sourcePath: string | null): boolean {
  if (existsSync(destPath)) return true
  if (!sourcePath || !existsSync(sourcePath)) return false
  try {
    mkdirSync(dirname(destPath), { recursive: true })
    copyFileSync(sourcePath, destPath)
    return true
  } catch {
    return false
  }
}
