// Pre-seed cursor-agent's per-workspace "trust" so an interactive session can
// launch unattended.
//
// cursor-agent (the `agent` CLI) shows a one-time "⚠ Workspace Trust Required"
// modal the first time it runs in a directory. `--yolo`/`--force` does NOT
// bypass it, and its `--trust` flag only works in `--print`/headless mode — so
// an interactive Tinstar session (which needs the TUI) otherwise hangs on the
// modal until a human presses `a`. Tinstar creates a fresh worktree per session,
// so every launch hits an untrusted directory.
//
// Cursor persists trust as a marker file under its own config dir, keyed by a
// slug of the absolute workspace path. We replicate that here and write the
// marker before launch. Reverse-engineered from cursor 2026.07.x; every write is
// best-effort — a format drift can degrade back to the modal but must never
// throw or block a session launch. Uses cursor's own `~/.cursor` home, not
// Tinstar's config root (this is a third-party tool's private state, not ours).

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CliTemplate } from './config'

/** Default location of cursor-agent's config home. */
export function defaultCursorHome(): string {
  return join(homedir(), '.cursor')
}

/** Cursor's slug for a workspace path: strip leading slashes, then map every
 *  remaining `/` to `-`. e.g. `/home/ubuntu/repo/tinstar` → `home-ubuntu-repo-tinstar`. */
export function cursorProjectSlug(workspacePath: string): string {
  return workspacePath.replace(/^\/+/, '').replace(/\//g, '-')
}

/** Path to the `.workspace-trusted` marker cursor writes once a workspace is trusted. */
export function cursorTrustMarkerPath(cursorHome: string, workspacePath: string): string {
  return join(cursorHome, 'projects', cursorProjectSlug(workspacePath), '.workspace-trusted')
}

/** True when this template launches cursor-agent (the `agent` binary), so the
 *  trust seed applies. Keys off the command's binary rather than the template
 *  name/adapter so a user-renamed cursor template is still recognized, and a
 *  non-cursor `generic` template (e.g. `shell`) is not. */
export function isCursorAgentTemplate(template: CliTemplate | null | undefined): boolean {
  if (!template) return false
  const bin = template.startCmd.trim().split(/\s+/)[0]
  return bin === 'agent'
}

/** Write cursor's trust marker for `workspacePath` if absent, so an interactive
 *  cursor-agent launch skips the trust modal. Best-effort: returns false (never
 *  throws) when the marker can't be written, and true when it already exists or
 *  was created. `nowIso`/`cursorHome` are injectable for tests. */
export function ensureCursorWorkspaceTrust(
  workspacePath: string,
  nowIso: string = new Date().toISOString(),
  cursorHome: string = defaultCursorHome(),
): boolean {
  try {
    const marker = cursorTrustMarkerPath(cursorHome, workspacePath)
    if (existsSync(marker)) return true
    mkdirSync(dirname(marker), { recursive: true })
    // Match cursor's own marker shape (2-space-indented JSON) so cursor reads it.
    writeFileSync(marker, JSON.stringify({ trustedAt: nowIso, workspacePath }, null, 2))
    return true
  } catch {
    return false
  }
}
