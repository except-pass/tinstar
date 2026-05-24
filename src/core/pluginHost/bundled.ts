import type { Plugin } from '@tinstar/plugin-api'
import browserPkg from '../../plugins/browser/package.json'
import * as browser from '../../plugins/browser/src/index'
import natsTrafficPkg from '../../plugins/nats-traffic/package.json'
import * as natsTraffic from '../../plugins/nats-traffic/src/index'
import fileEditorPkg from '../../plugins/file-editor/package.json'
import * as fileEditor from '../../plugins/file-editor/src/index'
import imageViewerPkg from '../../plugins/image-viewer/package.json'
import * as imageViewer from '../../plugins/image-viewer/src/index'
import cannedPromptsPkg from '../../plugins/canned-prompts/package.json'
import * as cannedPrompts from '../../plugins/canned-prompts/src/index'

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
  'canned-prompts': { pkg: cannedPromptsPkg, module: cannedPrompts as Plugin },
}
