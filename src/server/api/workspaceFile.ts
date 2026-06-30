import { statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { getSession } from '../sessions/session'
import type { ErrorCode } from '../../domain/api'

/**
 * Resolve a workspace-relative path for a session and enforce the security
 * boundary (path stays inside the workspace, target is a real file).
 *
 * Extracted so the file-download route and the file-push route share ONE
 * containment guard — if this logic lived in two places, a future tweak to one
 * would silently weaken the other's boundary. Both routes pass the already
 * URL-decoded session name and relative path.
 */

export type WorkspaceFileResult =
  | { ok: true; abs: string; wsRoot: string; rel: string; filename: string; size: number }
  | { ok: false; code: ErrorCode; message: string }

export function resolveWorkspaceFile(
  sessDir: string,
  sessionName: string,
  rel: string | null | undefined,
): WorkspaceFileResult {
  const rawWsRoot = getSession(sessDir, sessionName)?.workspace?.path ?? null
  if (!rawWsRoot) {
    return { ok: false, code: 'SESSION_NOT_FOUND', message: `Session '${sessionName}' not found` }
  }
  if (!rel) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'path is required' }
  }

  // Normalize once so a trailing slash on the workspace path doesn't turn the
  // `wsRoot + '/'` containment check into `…//` and 403 every request.
  const wsRoot = resolve(rawWsRoot)
  const abs = resolve(wsRoot, rel)
  if (!abs.startsWith(wsRoot + '/') && abs !== wsRoot) {
    return { ok: false, code: 'PATH_OUTSIDE_WORKSPACE', message: 'Path escapes workspace' }
  }

  let stat
  try {
    stat = statSync(abs)
  } catch {
    return { ok: false, code: 'NOT_FOUND', message: `'${rel}' not found` }
  }
  if (!stat.isFile()) {
    return { ok: false, code: 'INVALID_PARAMS', message: 'Path is not a file' }
  }

  return { ok: true, abs, wsRoot, rel, filename: basename(abs), size: stat.size }
}
