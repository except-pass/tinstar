import { describe, it, expect } from 'vitest'
import { BUILTIN_PLUGIN_PKGS } from '../builtinPluginManifests'
import { BUNDLED_PLUGINS } from '../../../core/pluginHost/bundled'
import { parseManifest } from '../../../core/pluginHost/manifest'

describe('BUILTIN_PLUGIN_PKGS — server-side palette registry source', () => {
  // parseManifest throws on a malformed manifest, so mapping the whole list
  // doubles as a well-formedness check on every built-in entry.
  const parsed = BUILTIN_PLUGIN_PKGS.map((p) => parseManifest(p))

  it('every listed built-in manifest parses', () => {
    expect(parsed).toHaveLength(BUILTIN_PLUGIN_PKGS.length)
  })

  // The general form of the bug both roundup and graveyard hit independently:
  // a plugin registered only in the client BUNDLED_PLUGINS activates fine but
  // never appears as a palette tile, because the palette reads
  // /api/plugin-widgets/registry — built from THIS array. No error, no console
  // warning, just a missing tile. This guard fails the moment the lists drift,
  // so the next bundled plugin can't repeat it.
  it('lists exactly the plugins bundled on the client', () => {
    const nameOf = (pkg: unknown) => (pkg as { name: string }).name
    expect(new Set(parsed.map((m) => m.name))).toEqual(
      new Set(Object.values(BUNDLED_PLUGINS).map((e) => nameOf(e.pkg))),
    )
  })

  // Named regression records: each of these shipped broken once.
  it.each(['roundup', 'graveyard'])('includes %s as a palette-spawnable widget', (name) => {
    const found = parsed.find((m) => m.name === name)
    expect(found, `${name} missing from BUILTIN_PLUGIN_PKGS`).toBeDefined()
    const widgets = (found!.manifest.contributes?.widgets ?? []) as Array<{ type?: string; spawn?: string }>
    expect(widgets.some((w) => w.type === name && w.spawn === 'palette')).toBe(true)
  })
})
