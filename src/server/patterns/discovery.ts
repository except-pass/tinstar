import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parsePatternFile, type Pattern } from './parser'
import { getConfigRoot } from '../configRoot'

/** Default patterns directory - lives alongside other Tinstar config */
export function getDefaultPatternsDir(): string {
  return join(getConfigRoot(), 'patterns')
}

/** @deprecated Prefer getDefaultPatternsDir() — this constant freezes the path at module-load time. */
export const DEFAULT_PATTERNS_DIR = getDefaultPatternsDir()

/**
 * Discover all pattern files in a directory.
 * Returns array of parsed patterns, skipping invalid files.
 */
export function discoverPatterns(dir: string = getDefaultPatternsDir()): Pattern[] {
  if (!existsSync(dir)) return []

  const patterns: Pattern[] = []

  try {
    const files = readdirSync(dir)

    for (const file of files) {
      if (!file.endsWith('.md')) continue

      try {
        const content = readFileSync(join(dir, file), 'utf-8')
        const pattern = parsePatternFile(content)
        if (pattern) {
          patterns.push(pattern)
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return patterns
}

/**
 * Get a specific pattern by name.
 */
export function getPatternByName(name: string, dir: string = getDefaultPatternsDir()): Pattern | null {
  const patterns = discoverPatterns(dir)
  return patterns.find(p => p.name === name) ?? null
}
