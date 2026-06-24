#!/usr/bin/env node
// Guards against case-only filename collisions that build on case-sensitive
// Linux but break module resolution on case-insensitive macOS/Windows.
//
// Why this exists: v5.2.0 shipped `PinsBridge.tsx` next to `pinsBridge.ts` in
// one directory. The extensionless import `./PinsBridge` resolved correctly on
// the Linux CI runner but matched `pinsBridge.ts` first on the macOS/Windows
// release runners ("PinsBridge is not exported by ..."), so `vite build` failed
// there, the release-build matrix failed, and NO GitHub Release was ever
// published. Normal (Linux-only) CI stayed green, so the break was silent.
//
// This check runs in normal CI on every PR — it fails loudly and blocks the
// merge, long before a release tag is cut. See docs/releasing.md.
//
// Two collision classes are flagged:
//   A. Two tracked paths that are identical when lowercased — a real hazard
//      even for non-code files: `git checkout` can't materialize both on a
//      case-insensitive filesystem.
//   B. Two code modules in the SAME directory whose basename-without-extension
//      is equal case-insensitively (e.g. PinsBridge.tsx vs pinsBridge.ts) — an
//      extensionless import of either is ambiguous on a case-insensitive FS.

import { execFileSync } from 'node:child_process'

const MODULE_EXTS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'])

function trackedFiles() {
  const out = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  return out.split('\n').filter(Boolean)
}

function splitName(path) {
  const slash = path.lastIndexOf('/')
  const dir = path.slice(0, slash + 1) // '' for repo-root files
  const name = path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot + 1)
  const stem = dot < 0 ? name : name.slice(0, dot)
  return { dir, name, ext, stem }
}

function findCollisions(files) {
  const problems = []

  // Check A — whole-path case-insensitive duplicates.
  const byLowerPath = new Map()
  for (const f of files) {
    const key = f.toLowerCase()
    if (!byLowerPath.has(key)) byLowerPath.set(key, [])
    byLowerPath.get(key).push(f)
  }
  for (const [, group] of byLowerPath) {
    if (group.length > 1) {
      problems.push({ kind: 'duplicate path (case-only)', files: group.sort() })
    }
  }

  // Check B — same-directory module basename (sans extension) case collision.
  const byDir = new Map()
  for (const f of files) {
    const { dir, ext, stem } = splitName(f)
    if (!MODULE_EXTS.has(ext)) continue
    if (!byDir.has(dir)) byDir.set(dir, new Map())
    const stems = byDir.get(dir)
    const key = stem.toLowerCase()
    if (!stems.has(key)) stems.set(key, [])
    stems.get(key).push(f)
  }
  for (const [, stems] of byDir) {
    for (const [, group] of stems) {
      if (group.length > 1) {
        problems.push({ kind: 'ambiguous module (case-only)', files: group.sort() })
      }
    }
  }

  return problems
}

const problems = findCollisions(trackedFiles())

if (problems.length === 0) {
  console.log('✓ no case-only filename collisions')
  process.exit(0)
}

console.error('✗ case-only filename collision(s) detected:\n')
for (const p of problems) {
  console.error(`  [${p.kind}]`)
  for (const f of p.files) console.error(`    ${f}`)
  console.error('')
}
console.error(
  'These build on case-sensitive Linux but break module resolution on\n' +
    'case-insensitive macOS/Windows (this is exactly what silently blocked the\n' +
    'v5.2.0 release). Rename one file so no case-twin shares a directory.\n'
)
process.exit(1)
