import { PluginRegistry } from '../core/pluginHost/registry'
import { bootAllPlugins } from '../core/pluginHost/loader'
import { BUNDLED_PLUGINS } from '../core/pluginHost/bundled'
import { defaultImportExternalFn } from '../core/pluginHost/externalLoader'
import type { PluginsConfig } from '../core/pluginHost/pluginsConfig'

import './runWorkspace'
import './taskGroup'

export const pluginRegistry = new PluginRegistry()

// TODO(v5-plan-3): replace EMPTY_CONFIG with a real fetch of plugins.json
// via a /api/plugins-config endpoint. Until then, external plugins listed in
// ~/.config/tinstar/plugins.json are NOT loaded in the client — only the
// server-side runtime route is wired up.
const EMPTY_CONFIG: PluginsConfig = { disabled: [], external: [] }

export const pluginsReady: Promise<void> = bootAllPlugins(
  BUNDLED_PLUGINS,
  EMPTY_CONFIG,
  pluginRegistry,
  defaultImportExternalFn,
).catch(e => {
  // eslint-disable-next-line no-console
  console.error('[plugin-host] boot pipeline failed', e)
})
