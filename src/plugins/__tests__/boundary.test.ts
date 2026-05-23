import { describe, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Boundary contract: plugin source files under `src/plugins/<name>/src/**`
 * must not import host runtime modules. Belt-and-suspenders with the ESLint
 * rule from Phase 3 — catches the case where eslint isn't run in CI, or where
 * someone disables the rule for a single file.
 *
 * Allowed exceptions (intentional):
 *   - `import type` from `src/domain/types` (all plugins — widget data shapes)
 *   - `import { EV }` from `src/lib/windowEvents` (nats-traffic — shared schema)
 *
 * See docs/adrs/0002-plugin-api-boundary.md.
 */

const PLUGINS_DIR = join(__dirname, '..')

const FORBIDDEN_RUNTIME_PATTERNS = [
  /from\s+['"][^'"]*\/components\//,
  /from\s+['"][^'"]*\/hooks\//,
  /from\s+['"][^'"]*\/hotkeys\//,
  /from\s+['"][^'"]*\/widgets\//,
  /from\s+['"][^'"]*\/apiClient['"]/,
  /from\s+['"][^'"]*\/lib\/uiPrefs['"]/,
  /from\s+['"][^'"]*\/lib\/userPrefs['"]/,
]

const ALLOWED_TYPE_PATTERN = /^import\s+type\s+/

function walkPluginFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules') continue
    const p = join(dir, entry)
    const s = statSync(p)
    if (s.isDirectory()) out.push(...walkPluginFiles(p))
    else if (/\.(ts|tsx)$/.test(entry)) out.push(p)
  }
  return out
}

describe('plugin boundary', () => {
  const files = readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== '__tests__')
    .flatMap((d) => {
      const srcDir = join(PLUGINS_DIR, d.name, 'src')
      try {
        statSync(srcDir)
      } catch {
        return [] as string[]
      }
      return walkPluginFiles(srcDir)
    })

  it.each(files)('%s only imports @tinstar/plugin-api or type-only from domain', (file) => {
    const text = readFileSync(file, 'utf-8')
    const lines = text.split('\n')
    lines.forEach((line, idx) => {
      if (!/from\s+['"]/.test(line)) return
      const isTypeOnly = ALLOWED_TYPE_PATTERN.test(line.trim())
      for (const pattern of FORBIDDEN_RUNTIME_PATTERNS) {
        if (pattern.test(line) && !isTypeOnly) {
          throw new Error(
            `Forbidden runtime import in ${file}:${idx + 1}\n  ${line.trim()}\n` +
              `Plugins must consume @tinstar/plugin-api only. See docs/adrs/0002-plugin-api-boundary.md.`,
          )
        }
      }
    })
  })
})
