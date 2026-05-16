import { PluginRegistry } from '../core/pluginHost/registry'
import { bootAllPlugins } from '../core/pluginHost/loader'
import { BUNDLED_PLUGINS } from '../core/pluginHost/bundled'
import { defaultImportExternalFn } from '../core/pluginHost/externalLoader'
import { fetchPluginsConfig } from '../core/pluginApi/pluginsConfigClient'

import './runWorkspace'
import './taskGroup'

export const pluginRegistry = new PluginRegistry()

export const pluginsReady: Promise<void> = (async () => {
  const config = await fetchPluginsConfig()
  await bootAllPlugins(BUNDLED_PLUGINS, config, pluginRegistry, defaultImportExternalFn)
})().catch(e => {
  // eslint-disable-next-line no-console
  console.error('[plugin-host] boot pipeline failed', e)
})
