import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseHandFile, type Hand } from './parser'
import { getConfigRoot } from '../configRoot'

/** Default hands directory - lives alongside other Tinstar config */
export function getDefaultHandsDir(): string {
  return join(getConfigRoot(), 'hands')
}

/** @deprecated Prefer getDefaultHandsDir() — this constant freezes the path at module-load time. */
export const DEFAULT_HANDS_DIR = getDefaultHandsDir()

/**
 * Discover all hand definition files in a directory.
 * Returns array of parsed hands, skipping invalid files.
 */
export function discoverHands(dir: string = getDefaultHandsDir()): Hand[] {
  if (!existsSync(dir)) return []

  const hands: Hand[] = []

  try {
    const files = readdirSync(dir)

    for (const file of files) {
      if (!file.endsWith('.md')) continue

      try {
        const content = readFileSync(join(dir, file), 'utf-8')
        const hand = parseHandFile(content)
        if (hand) {
          hands.push(hand)
        }
      } catch {
        // Skip unreadable files
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return hands
}

/**
 * Get a specific hand by name.
 */
export function getHandByName(name: string, dir: string = getDefaultHandsDir()): Hand | null {
  const hands = discoverHands(dir)
  return hands.find(h => h.name === name) ?? null
}
