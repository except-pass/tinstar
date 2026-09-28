import { describe, it, expect } from 'vitest'
import { BUILTIN_PLUGIN_PKGS } from '../builtinPluginManifests'
import { parseManifest } from '../../../core/pluginHost/manifest'

describe('BUILTIN_PLUGIN_PKGS — server-side widget registry source', () => {
  // parseManifest throws on a malformed manifest, so mapping the whole list
  // doubles as a well-formedness check on every built-in entry.
  const parsed = BUILTIN_PLUGIN_PKGS.map((p) => parseManifest(p))

  it('every listed built-in manifest parses', () => {
    expect(parsed).toHaveLength(BUILTIN_PLUGIN_PKGS.length)
  })

  // Named regression records: each of these shipped broken once.
  it.each(['roundup', 'graveyard'])('includes %s as a palette-spawnable widget', (name) => {
    const found = parsed.find((m) => m.name === name)
    expect(found, `${name} missing from BUILTIN_PLUGIN_PKGS`).toBeDefined()
    const widgets = (found!.manifest.contributes?.widgets ?? []) as Array<{ type?: string; spawn?: string }>
    expect(widgets.some((w) => w.type === name && w.spawn === 'palette')).toBe(true)
  })
})
