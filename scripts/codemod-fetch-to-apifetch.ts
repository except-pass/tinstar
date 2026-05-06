#!/usr/bin/env tsx
/**
 * One-shot: rewrite fetch('/api/...') → apiFetch('/api/...') and add the import.
 * Run once, then delete this file (or keep it under scripts/one-shots/ if we have such a convention).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { relative, dirname, join } from 'node:path'

const FETCH_CALL = /(?<![.\w])fetch\((['"`])(\/api\/[^'"`]*|\/api)\1/g

function importPathFor(filePath: string): string {
  const fromDir = dirname(filePath)
  const apiClient = join(process.cwd(), 'src/apiClient')
  let rel = relative(fromDir, apiClient).replace(/\\/g, '/')
  if (!rel.startsWith('.')) rel = `./${rel}`
  return rel
}

function addImport(src: string, importPath: string): string {
  if (/from ['"].*apiClient['"]/.test(src)) return src
  // Insert after the last import at the top of the file.
  const importRegex = /^(import [^\n]+\n)+/m
  const match = src.match(importRegex)
  const importLine = `import { apiFetch } from '${importPath}'\n`
  if (match) {
    const end = (match.index ?? 0) + match[0].length
    return src.slice(0, end) + importLine + src.slice(end)
  }
  return importLine + src
}

const files = execSync(
  `grep -rln -E "fetch\\((\\\"|')/api|fetch\\(\\\`/api" src --include='*.ts' --include='*.tsx'`,
  { encoding: 'utf8' },
)
  .split('\n')
  .filter((f) => f && !f.startsWith('src/server/'))

let totalRewrites = 0
for (const file of files) {
  const before = readFileSync(file, 'utf8')
  const after = before.replace(FETCH_CALL, (_m, q, path) => {
    totalRewrites++
    return `apiFetch(${q}${path}${q}`
  })
  if (after !== before) {
    writeFileSync(file, addImport(after, importPathFor(file)))
    console.log(`rewrote ${file}`)
  }
}
console.log(`\ntotal rewrites: ${totalRewrites} across ${files.length} files`)
