import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { parseHandFile, type Hand } from './parser'
import { getConfigRoot } from '../configRoot'
import { builtinHands } from './builtins'

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
  const userHands: Hand[] = []
  if (existsSync(dir)) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.md')) continue
        try {
          const content = readFileSync(join(dir, file), 'utf-8')
          const hand = parseHandFile(content)
          if (hand) userHands.push(hand)
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory unreadable — fall through to builtins only
    }
  }

  // Merge builtins with user-defined hands. User-defined wins on name collision
  // so users can override the marshal's prompt by dropping their own marshal.md.
  const userNames = new Set(userHands.map(h => h.name))
  const builtins = builtinHands().filter(h => !userNames.has(h.name))
  return [...userHands, ...builtins]
}

/**
 * Get a specific hand by name.
 */
export function getHandByName(name: string, dir: string = getDefaultHandsDir()): Hand | null {
  const hands = discoverHands(dir)
  return hands.find(h => h.name === name) ?? null
}
