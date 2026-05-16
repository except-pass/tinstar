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

// Kick off plugin activation. Bundled plugins (currently: browser) activate
// here; other widgets remain side-effect-registered until plan 2 migrates them.
// Top-level await is supported by Vite's ESM module graph; if tsc complains
// about target, switch to `void bootBundledPlugins(...)`.
void bootBundledPlugins(BUNDLED_PLUGINS, pluginRegistry)
