import { extname, isAbsolute, join, relative, resolve } from 'node:path'

export const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

export type StaticDecision =
  | { kind: 'forbidden' }
  | { kind: 'file'; filePath: string; mime: string }
  | { kind: 'not-found' }
  | { kind: 'spa'; indexPath: string }

/**
 * Decide how to serve a static request. Pure routing logic — all filesystem access
 * goes through the injected `fileExists` probe so it can be unit-tested.
 *
 * Rules:
 * - A path that escapes `clientDir` → forbidden (traversal guard).
 * - A path WITH a file extension: serve it if it exists, else **404**. It must NOT
 *   fall back to index.html — otherwise a missing/stale hashed chunk (e.g. after a
 *   rebuild changes `/assets/*.js` hashes) is served as text/html, and the browser's
 *   dynamic `import()` rejects with a MIME error. That's what leaves lazily-loaded
 *   widgets (e.g. the mermaid renderer) stuck on "Rendering diagram…".
 * - An extension-less route → SPA fallback to index.html (client-side routing).
 */
export function decideStaticServe(
  pathname: string,
  clientDir: string,
  fileExists: (p: string) => boolean,
): StaticDecision {
  const ext = extname(pathname)
  const filePath = resolve(join(clientDir, pathname))

  // Prevent path traversal outside clientDir. Use a path-segment boundary check
  // (path.relative) rather than a string prefix: a bare startsWith would also
  // accept a sibling-prefix escape like `/../client-evil/secret.js` when
  // clientDir is `/client`. relative() yields '' for clientDir itself, a child
  // path for contained files, and a '..'-leading or absolute path for escapes.
  const rel = relative(resolve(clientDir), filePath)
  if (rel.startsWith('..') || isAbsolute(rel)) return { kind: 'forbidden' }

  if (ext) {
    if (fileExists(filePath)) {
      return { kind: 'file', filePath, mime: MIME_TYPES[ext] ?? 'application/octet-stream' }
    }
    // File-looking request that doesn't exist: 404, never SPA-fallback.
    return { kind: 'not-found' }
  }

  const indexPath = join(clientDir, 'index.html')
  if (fileExists(indexPath)) return { kind: 'spa', indexPath }
  return { kind: 'not-found' }
}
