// Pure proxy-path helpers for the browser plugin. Kept out of BrowserPrimitive
// so notes/capture.ts can import them without a component import cycle.

/**
 * Inverse of the proxy URL mapping: given the proxied location an iframe loaded
 * (`/api/proxy/<nodeId>/p/x` + search) and the widget's current real URL (for its
 * origin), reconstruct the real target URL (`<origin>/p/x` + search). Returns null
 * when the path isn't under this widget's proxy prefix or `currentUrl` has no
 * parseable origin. Pure + exported so the round-trip with proxyUrl() is unit-tested
 * independently of the React component (cf. rewriteUrlForProxy in proxyRewrite.ts).
 */
export function unproxyPath(
  pathname: string,
  search: string,
  nodeId: string,
  currentUrl: string,
): string | null {
  const prefix = `/api/proxy/${nodeId}`
  if (pathname.indexOf(prefix + '/') !== 0 && pathname !== prefix) return null
  const rest = pathname.slice(prefix.length) || '/'
  try {
    return new URL(currentUrl).origin + rest + search
  } catch {
    return null
  }
}
