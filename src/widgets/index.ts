import { PluginRegistry } from '../core/pluginHost/registry'
import { bootAllPlugins } from '../core/pluginHost/loader'
import { BUNDLED_PLUGINS } from '../core/pluginHost/bundled'
import { defaultImportExternalFn } from '../core/pluginHost/externalLoader'
import { fetchPluginsConfig } from '../core/pluginApi/pluginsConfigClient'
import type { PluginsConfig } from '../core/pluginHost/pluginsConfig'

import './runWorkspace'
import './taskGroup'

export const pluginRegistry = new PluginRegistry()

export const pluginsReady: Promise<void> = (async () => {
  const result = await fetchPluginsConfig()
  if (!result.ok) {
    // eslint-disable-next-line no-console
    console.warn('[plugin-host] could not fetch plugins-config; booting bundled plugins only:', result.error)
  }
  const config: PluginsConfig = result.ok ? result.config : { disabled: [], external: [] }
  await bootAllPlugins(BUNDLED_PLUGINS, config, pluginRegistry, defaultImportExternalFn)
})().catch(e => {
  // eslint-disable-next-line no-console
  console.error('[plugin-host] boot pipeline failed', e)
})
