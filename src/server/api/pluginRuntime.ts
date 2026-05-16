import { readFileSync, existsSync, statSync } from 'node:fs'
import { normalize, resolve, sep } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { readPluginsConfig } from '../../core/pluginHost/pluginsConfig'

const API_PASSTHROUGH = `
// @tinstar/plugin-api runtime — only type names are imported by external
// plugins. At runtime the actual API is delivered as the parameter to
// activate(api). This module simply provides empty named exports so that
// \`import { ... } from '@tinstar/plugin-api'\` doesn't fail to resolve.
export const __plugin_api_marker = true
export default {}
`.trim()

const REACT_PASSTHROUGH = `
// react runtime — passthrough to the host's React instance.
const React = window.__tinstar_react
if (!React) {
  throw new Error('[plugin-runtime] window.__tinstar_react not mounted')
}
export default React
export const useState = React.useState
export const useEffect = React.useEffect
export const useMemo = React.useMemo
export const useCallback = React.useCallback
export const useRef = React.useRef
export const useContext = React.useContext
export const createContext = React.createContext
export const Fragment = React.Fragment
export const Children = React.Children
`.trim()

export interface RuntimeOptions {
  configRoot: string
}

export async function handlePluginRuntime(
  req: IncomingMessage,
  res: ServerResponse,
  opts: RuntimeOptions,
): Promise<boolean> {
  const url = req.url ?? ''
  if (!url.startsWith('/api/plugin-runtime/')) return false

  if (url === '/api/plugin-runtime/api.js') {
    res.setHeader('Content-Type', 'application/javascript')
    res.end(API_PASSTHROUGH)
    return true
  }

  if (url === '/api/plugin-runtime/react.js') {
    res.setHeader('Content-Type', 'application/javascript')
    res.end(REACT_PASSTHROUGH)
    return true
  }

  const localMatch = url.match(/^\/api\/plugin-runtime\/local\/([^/]+)\/(.+)$/)
  if (localMatch) {
    const [, name, relPath] = localMatch
    if (!name || !relPath) {
      res.statusCode = 400
      res.end('malformed path')
      return true
    }
    if (relPath.includes('..')) {
      res.statusCode = 400
      res.end('path traversal')
      return true
    }
    const cfg = readPluginsConfig(opts.configRoot)
    const entry = cfg.external.find(e => e.name === name && e.path)
    if (!entry?.path) {
      res.statusCode = 404
      res.end('plugin not found')
      return true
    }
    const absolute = resolve(entry.path, relPath)
    const normalized = normalize(absolute)
    const pluginRoot = resolve(entry.path)
    if (!normalized.startsWith(pluginRoot + sep) && normalized !== pluginRoot) {
      res.statusCode = 400
      res.end('path traversal')
      return true
    }
    if (!existsSync(normalized) || !statSync(normalized).isFile()) {
      res.statusCode = 404
      res.end('file not found')
      return true
    }
    res.setHeader('Content-Type', 'application/javascript')
    res.end(readFileSync(normalized, 'utf8'))
    return true
  }

  res.statusCode = 404
  res.end('not found')
  return true
}
