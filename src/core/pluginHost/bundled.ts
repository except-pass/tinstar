import type { Plugin } from '@tinstar/plugin-api'
import browserPkg from '../../plugins/browser/package.json'
import * as browser from '../../plugins/browser/src/index'
import natsTrafficPkg from '../../plugins/nats-traffic/package.json'
import * as natsTraffic from '../../plugins/nats-traffic/src/index'
import fileEditorPkg from '../../plugins/file-editor/package.json'
import * as fileEditor from '../../plugins/file-editor/src/index'
import imageViewerPkg from '../../plugins/image-viewer/package.json'
import * as imageViewer from '../../plugins/image-viewer/src/index'
import roborevPkg from '../../plugins/roborev/package.json'
import * as roborev from '../../plugins/roborev/src/index'
import modelAttributionPkg from '../../plugins/model-attribution/package.json'
import * as modelAttribution from '../../plugins/model-attribution/src/index'
import graveyardPkg from '../../plugins/graveyard/package.json'
import * as graveyard from '../../plugins/graveyard/src/index'

/**
 * Static index of bundled plugins. Each entry is an ES module whose package
 * lives at src/plugins/<key>/ and whose entry exports an `activate(api)` function.
 *
 * Populated as plugins are migrated. Plan 1 adds the browser plugin (Task 9).
 */
export interface BundledEntry {
  /** The plugin's package.json contents (manifest source). */
  pkg: unknown
  /** The plugin module (must export `activate`). */
  module: Plugin
}

export const BUNDLED_PLUGINS: Record<string, BundledEntry> = {
  browser: { pkg: browserPkg, module: browser as Plugin },
  'nats-traffic': { pkg: natsTrafficPkg, module: natsTraffic as Plugin },
  'file-editor': { pkg: fileEditorPkg, module: fileEditor as Plugin },
  'image-viewer': { pkg: imageViewerPkg, module: imageViewer as Plugin },
  roborev: { pkg: roborevPkg, module: roborev as Plugin },
  'model-attribution': { pkg: modelAttributionPkg, module: modelAttribution as Plugin },
  graveyard: { pkg: graveyardPkg, module: graveyard as Plugin },
}
