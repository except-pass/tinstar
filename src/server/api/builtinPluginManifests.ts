// Manifests (package.json only) of the built-in plugins, for the server's
// widget-registry listing (pluginWidgetRegistry.ts).
import browserPkg from '../../plugins/browser/package.json'
import natsTrafficPkg from '../../plugins/nats-traffic/package.json'
import fileEditorPkg from '../../plugins/file-editor/package.json'
import imageViewerPkg from '../../plugins/image-viewer/package.json'
import roborevPkg from '../../plugins/roborev/package.json'
import modelAttributionPkg from '../../plugins/model-attribution/package.json'
import roundupPkg from '../../plugins/roundup/package.json'
import firstmatePkg from '../../plugins/firstmate/package.json'
import graveyardPkg from '../../plugins/graveyard/package.json'

/** Built-in plugin package.json manifests (server-safe — manifest only). */
export const BUILTIN_PLUGIN_PKGS: unknown[] = [browserPkg, natsTrafficPkg, fileEditorPkg, imageViewerPkg, roborevPkg, modelAttributionPkg, roundupPkg, graveyardPkg, firstmatePkg]
