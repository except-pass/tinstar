interface BrowserWidgetLike { id: string; url: string; headers?: Record<string, string> }
interface PluginWidgetLike { id: string; data?: unknown }

export interface ProxyTarget { url: string; headers?: Record<string, string> }

export function resolveProxyTarget(
  nodeId: string,
  browserWidgets: BrowserWidgetLike[],
  pluginWidgets: PluginWidgetLike[],
): ProxyTarget | null {
  const bw = browserWidgets.find(w => w.id === nodeId)
  if (bw) return { url: bw.url, headers: bw.headers }

  const pw = pluginWidgets.find(p => p.id === nodeId)
  const embedded = (pw?.data as { _browser?: ProxyTarget } | undefined)?._browser
  if (embedded?.url) return { url: embedded.url, headers: embedded.headers }

  return null
}
