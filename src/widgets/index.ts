// Side-effect imports: register all widget components at module load
import './runWorkspace'
import './taskGroup'
import './fileEditor'      // registers FileEditorWidget
import './imageViewer'     // registers ImageViewerWidget
import './natsTraffic'     // registers NatsTrafficWidget

import { PluginRegistry } from '../core/pluginHost/registry'
import { bootBundledPlugins } from '../core/pluginHost/loader'
import { BUNDLED_PLUGINS } from '../core/pluginHost/bundled'

export const pluginRegistry = new PluginRegistry()

/**
 * Resolves once all bundled plugins have been activated (or failed and
 * captured in the registry). App code that needs widgets to be registered
 * before rendering can await this. The .catch is a hard backstop — any
 * uncaught path inside the boot pipeline ends here, not as an
 * unhandledrejection.
 */
export const pluginsReady: Promise<void> = bootBundledPlugins(BUNDLED_PLUGINS, pluginRegistry).catch(e => {
  // eslint-disable-next-line no-console
  console.error('[plugin-host] boot pipeline failed', e)
})
