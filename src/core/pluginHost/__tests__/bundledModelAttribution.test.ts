import { describe, it, expect } from 'vitest'
import { BUNDLED_PLUGINS } from '../bundled'
import { BUILTIN_PLUGIN_PKGS } from '../../../server/api/builtinPluginManifests'

/**
 * Registration-integrity gate for the model-attribution bundled plugin
 * (Switchboard Phase 2, Step 4). Proves the two-place wiring without a browser:
 * the runtime module index (BUNDLED_PLUGINS) and the server manifest list
 * (BUILTIN_PLUGIN_PKGS) must both carry the plugin, and its manifest must
 * declare the model-attribution widget at apiVersion "5".
 */
describe('model-attribution bundled registration', () => {
  it('is present in BUNDLED_PLUGINS with an activate() and a valid manifest', () => {
    const entry = BUNDLED_PLUGINS['model-attribution']
    expect(entry, 'model-attribution must be registered in BUNDLED_PLUGINS').toBeDefined()
    if (!entry) throw new Error('model-attribution missing from BUNDLED_PLUGINS')

    // The module must export an activate function so the host can boot it.
    expect(typeof entry.module.activate).toBe('function')

    // The manifest (package.json) must declare the model-attribution widget at apiVersion "5".
    const pkg = entry.pkg as {
      name?: string
      tinstar?: {
        apiVersion?: string
        contributes?: { widgets?: { type?: string }[] }
      }
    }
    expect(pkg.tinstar?.apiVersion).toBe('5')
    const widgetTypes = (pkg.tinstar?.contributes?.widgets ?? []).map(w => w.type)
    expect(widgetTypes).toContain('model-attribution')
  })

  it('is present in BUILTIN_PLUGIN_PKGS so the server serves it to the palette', () => {
    const names = BUILTIN_PLUGIN_PKGS.map(p => (p as { name?: string }).name)
    expect(names).toContain('model-attribution')
  })
})
