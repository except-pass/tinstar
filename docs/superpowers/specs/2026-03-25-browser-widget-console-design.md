# Browser Widget Console Capture

## Problem

Browser widgets embed local dev servers (e.g., portal on localhost:3000) in iframes. Developers need to see `console.log`/`warn`/`error` output without opening Chrome DevTools. Currently there's no way to see console output from the iframe.

## Constraint

The iframe is cross-origin (different port = different origin on localhost). We can't access `iframe.contentWindow.console` from the parent. Two options exist:

1. **Proxy the target** through Tinstar's backend so it's same-origin, then inject a console-capture script
2. **Require the target page** to include a Tinstar console bridge script

Option 1 is more robust (works with any local dev server without modifying it). Option 2 is simpler but requires page cooperation.

## Design: Reverse Proxy + Script Injection

### Proxy route

Add `GET /api/proxy/:widgetId/*` that:
1. Looks up the browser widget's target URL from the document store
2. Forwards the request to the target, streaming the response back
3. For HTML responses: injects a `<script>` tag before `</head>` that loads the console bridge
4. For non-HTML responses (JS, CSS, images): passes through unmodified

This makes the iframe same-origin with Tinstar. The browser widget's iframe `src` changes from `http://localhost:3000/page` to `/api/proxy/<widgetId>/page`.

### Console bridge script

A small inline script injected into proxied HTML pages:

```javascript
// Override console methods and post messages to parent
['log', 'warn', 'error', 'info', 'debug'].forEach(method => {
  const original = console[method];
  console[method] = function(...args) {
    original.apply(console, args);
    try {
      window.parent.postMessage({
        type: 'tinstar:console',
        method,
        args: args.map(a => {
          try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
          catch { return String(a); }
        }),
        timestamp: new Date().toISOString(),
      }, '*');
    } catch {}
  };
});

// Capture uncaught errors too
window.addEventListener('error', e => {
  window.parent.postMessage({
    type: 'tinstar:console',
    method: 'error',
    args: [`${e.message} at ${e.filename}:${e.lineno}:${e.colno}`],
    timestamp: new Date().toISOString(),
  }, '*');
});
```

### Console panel in BrowserWidget

The browser widget component listens for `tinstar:console` messages and renders them in a collapsible panel at the bottom of the widget:

- Collapsed by default — just a badge showing error count (red) or total count (gray)
- Click to expand — scrollable list of log entries with timestamps
- Color-coded: `log`=white, `warn`=amber, `error`=red, `info`=cyan
- Clear button to reset
- Auto-scrolls to bottom on new entries

### Widget URL rewriting

When creating or loading a browser widget:
- Store the original URL (`http://localhost:3000/page`) as `widget.url`
- The iframe renders `/api/proxy/<widgetId>/page` instead
- If proxy fails (target down), show a "target unreachable" message in the iframe area

## Files to Create/Modify

| File | Change |
|------|--------|
| `src/server/api/proxy.ts` | **New.** HTTP reverse proxy with HTML script injection |
| `src/server/api/routes.ts` | Wire proxy route |
| `src/widgets/browserWidget/BrowserWidget.tsx` | Add console panel, listen for postMessage, rewrite iframe src to proxy URL |
| `src/widgets/browserWidget/console-bridge.ts` | **New.** The injected script (as a string constant for injection) |

## What Stays the Same

- Browser widget creation API unchanged
- Widget data model unchanged (url field keeps the original target URL)
- Non-proxied mode still works for pages that don't need console capture

## Edge Cases

- **WebSocket connections** (e.g., HMR): proxy needs to handle `Upgrade: websocket` headers for Vite/webpack dev servers to work properly
- **Relative URLs in the proxied page**: the proxy serves from a path prefix, so relative URLs should resolve correctly if we preserve the path structure
- **Large responses**: stream through, don't buffer entire response
- **Target server restarts**: proxy returns 502, widget shows "target unreachable"

## Not in scope

- Console capture for external (non-localhost) URLs
- Network request inspection (that's Chrome DevTools territory)
- DOM inspection
