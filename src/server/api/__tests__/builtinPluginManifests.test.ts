import { describe, it, expect } from 'vitest'
import { BUILTIN_PLUGIN_PKGS } from '../builtinPluginManifests'
import { parseManifest } from '../../../core/pluginHost/manifest'

describe('BUILTIN_PLUGIN_PKGS — server-side palette registry source', () => {
  // parseManifest throws on a malformed manifest, so mapping the whole list
  // doubles as a well-formedness check on every built-in entry.
  const parsed = BUILTIN_PLUGIN_PKGS.map((p) => parseManifest(p))

  it('every listed built-in manifest parses', () => {
    expect(parsed).toHaveLength(BUILTIN_PLUGIN_PKGS.length)
  })

  it('includes roundup as a palette-spawnable widget', () => {
    // Regression guard: Roundup shipped in the client BUNDLED_PLUGINS
    // (core/pluginHost/bundled.ts) but was omitted from this server list, so the
    // palette — which reads /api/plugin-widgets/registry, built from this array —
    // never listed it. The two lists must stay in sync; this test fails if they drift.
    const roundup = parsed.find((m) => m.name === 'roundup')
    expect(roundup, 'roundup missing from BUILTIN_PLUGIN_PKGS').toBeDefined()
    const widgets = (roundup!.manifest.contributes?.widgets ?? []) as Array<{ type?: string; spawn?: string }>
    expect(widgets.some((w) => w.type === 'roundup' && w.spawn === 'palette')).toBe(true)
  })
})
