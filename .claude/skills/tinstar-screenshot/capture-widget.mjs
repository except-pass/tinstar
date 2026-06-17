#!/usr/bin/env node
// capture-widget.mjs — take a clean screenshot of ONE Tinstar canvas widget.
//
// Drives a headless Chromium (Playwright, from the tinstar repo) against the
// running dashboard, frames the target run card via the canvas's own
// `widget:flash-focus` event, hides everything that would overlap the element
// clip, and screenshots the widget (or a sub-panel of it).
//
// Usage:
//   node capture-widget.mjs --widget <runId> --out shot.png [options]
//
// Options:
//   --widget <id>     run id == data-widget-id (usually the session name)   [required]
//   --out <file>      output PNG path                                        [required]
//   --tab recap|terminal   switch the run's session panel first             [default: leave as-is]
//   --sub <testid>    capture a sub-element by data-testid instead of the whole card
//                     (e.g. focus-zone-file-list, focus-zone-right-panel; or 'header')
//   --pad <px>        padding around the element (left/top/bottom)           [default 16]
//   --rpad <px>       right-edge padding (lower to trim neighbour bleed)     [default = pad]
//   --maxh <px>       cap clip height (crop tall, mostly-empty panels)
//   --url <url>       dashboard URL                          [default $TINSTAR_URL or :5273]
//   --vw <px> --vh <px>   viewport (wide enough that the card clears the fixed right dock)
//
// IMPORTANT: the widget must be in the ACTIVE space (spaces scope which runs
// render). Telemetry values (context %, cost, tokens) are client-fetched and not
// in /api/state — so always LOOK at the resulting PNG. See SKILL.md.
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def
}
const WID = arg('widget')
const OUT = arg('out')
if (!WID || !OUT) {
  console.error('usage: node capture-widget.mjs --widget <runId> --out <file.png> [--tab recap|terminal] [--sub <testid>] [--pad N] [--rpad N] [--maxh N] [--url URL] [--vw N] [--vh N]')
  process.exit(2)
}
const URL = arg('url', process.env.TINSTAR_URL || 'http://localhost:5273')
const TAB = arg('tab')
const SUB = arg('sub')
const PAD = Number(arg('pad', '16'))
const RPAD = Number(arg('rpad', String(PAD)))
const MAXH = arg('maxh') ? Number(arg('maxh')) : Infinity
const VW = Number(arg('vw', '2600'))
const VH = Number(arg('vh', '1600'))

// Resolve Playwright: works when this file lives inside the tinstar repo (the
// usual symlink install resolves to repo/node_modules); falls back to walking up
// for repo/node_modules/playwright if a bare import fails (e.g. --copy installs).
async function loadChromium() {
  try { return (await import('playwright')).chromium } catch {}
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 10; i++) {
    const pw = join(dir, 'node_modules', 'playwright', 'index.mjs')
    if (existsSync(pw)) return (await import(pathToFileURL(pw).href)).chromium
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('playwright not found — run from the tinstar repo or pass its node_modules on the path')
}

const chromium = await loadChromium()
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2 })
const page = await ctx.newPage()
await page.goto(URL, { waitUntil: 'domcontentloaded' }) // NOT networkidle — SSE never idles
await page.waitForSelector(`[data-widget-id="${WID}"]`, { timeout: 30000 })

// Persistent stylesheet (survives the ~1/s SSE React re-renders that wipe inline
// styles): hide every other canvas widget, all FOREIGN terminal iframes (keep
// only this session's, matched by src so DOM nesting is irrelevant), and the
// fixed shell overlays (HUD, sidebar) that bleed into element clips.
await page.addStyleTag({ content: `
  [data-widget-id]:not([data-widget-id="${WID}"]) { display: none !important; }
  iframe:not([src*="session=${WID}"]) { display: none !important; }
  [data-testid="canvas-hud"], [data-testid="minimap-toggle"], [data-testid="canvas-hud-toggle"],
  [data-testid="sidebar-slot"], [data-testid="collapsed-sidebar"] { display: none !important; }
` })
await page.waitForTimeout(800)

const card = page.locator(`[data-widget-id="${WID}"]`).first()

// Frame it using the canvas's own pan/zoom event.
await page.evaluate((id) => window.dispatchEvent(new CustomEvent('widget:flash-focus',
  { detail: { widgetId: id, source: 'run' } })), WID)
await page.waitForTimeout(1200)

if (TAB === 'recap' || TAB === 'terminal') {
  const label = TAB === 'recap' ? 'Recap' : 'Terminal'
  const btn = card.getByRole('button', { name: label }).first()
  if (await btn.count()) { await btn.click().catch(() => {}); await page.waitForTimeout(TAB === 'terminal' ? 1500 : 600) }
}

const target = SUB ? card.locator(SUB.startsWith('[') || SUB === 'header' ? SUB : `[data-testid="${SUB}"]`).first() : card
const box = await target.boundingBox()
if (!box) { console.error('NO BOX for', WID, SUB || ''); await browser.close(); process.exit(3) }
const x = Math.max(0, box.x - PAD), y = Math.max(0, box.y - PAD)
await page.screenshot({ path: OUT, clip: {
  x, y,
  width: Math.min(box.width + PAD + RPAD, VW - x),
  height: Math.min(box.height + PAD * 2, MAXH, VH - y),
} })
console.log('WROTE', OUT, JSON.stringify(box))
await browser.close()
