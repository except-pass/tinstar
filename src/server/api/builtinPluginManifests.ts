// Manifests (package.json only) of the bundled built-in plugins, for the
// widget-registry/palette listing. This deliberately imports ONLY the JSON
// manifests — NOT the plugin modules under src/plugins/*/src — so the server
// bundle stays free of client/React component code. The components themselves
// are bundled + activated on the client via src/core/pluginHost/bundled.ts.
//
// Keep this list in sync with BUNDLED_PLUGINS in core/pluginHost/bundled.ts.
import browserPkg from '../../plugins/browser/package.json'
import natsTrafficPkg from '../../plugins/nats-traffic/package.json'
import fileEditorPkg from '../../plugins/file-editor/package.json'
import imageViewerPkg from '../../plugins/image-viewer/package.json'
import roborevPkg from '../../plugins/roborev/package.json'
import modelAttributionPkg from '../../plugins/model-attribution/package.json'
import roundupPkg from '../../plugins/roundup/package.json'

/** Built-in plugin package.json manifests (server-safe — manifest only). */
export const BUILTIN_PLUGIN_PKGS: unknown[] = [browserPkg, natsTrafficPkg, fileEditorPkg, imageViewerPkg, roborevPkg, modelAttributionPkg, roundupPkg]
