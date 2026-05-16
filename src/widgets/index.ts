import { PluginRegistry } from '../core/pluginHost/registry'
import { bootAllPlugins } from '../core/pluginHost/loader'
import { BUNDLED_PLUGINS } from '../core/pluginHost/bundled'
import { defaultImportExternalFn } from '../core/pluginHost/externalLoader'
import type { PluginsConfig } from '../core/pluginHost/pluginsConfig'

import './runWorkspace'
import './taskGroup'

export const pluginRegistry = new PluginRegistry()

// Plan 2: client uses empty config. Plan 3's settings UI will fetch real
// config from a server endpoint and wire enable/disable + external entries.
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
