import type { Plugin } from '@tinstar/plugin-api'

/**
 * Static index of bundled plugins. Each entry is an ES module whose package
 * lives at src/plugins/<key>/ and whose entry exports an `activate(api)` function.
 *
 * Populated as plugins are migrated. Plan 1 adds the browser plugin (Task 9).
 */
export interface BundledEntry {
  /** The plugin's package.json contents (manifest source). */
  pkg: unknown
  /** The plugin module (must export `activate`). */
  module: Plugin
}

export const BUNDLED_PLUGINS: Record<string, BundledEntry> = {
  // populated in Task 9
}
