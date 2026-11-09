// @vitest-environment node
import { afterAll, beforeAll, expect, it } from 'vitest'
import { chromium, type Browser } from '@playwright/test'
import { createServer, type ViteDevServer } from 'vite'

let server: ViteDevServer, browser: Browser, origin: string
beforeAll(async () => {
  server = await createServer({ configFile: false, server: { host: '127.0.0.1', port: 0 }, plugins: [{
    name: 'swipe-fixture',
    configureServer(server) {
      server.middlewares.use('/swipe-fixture', async (req, res, next) => {
        if (req.url?.includes('html-proxy')) return next()
        res.setHeader('Content-Type', 'text/html')
        res.end(await server.transformIndexHtml('/swipe-fixture', `<html><style>
          body { margin: 20px; background: white }
          .surface { width: 300px; height: 80px; margin: 20px 0 }
          table { width: 300px; table-layout: fixed; border-spacing: 0 }
          td { padding: 0; height: 80px }
          .swipe-reveal, .swipe-body { height: 80px }
          .swipe-body { pointer-events: none }
        </style><div id="root"></div><script type="module">
          import { createElement as h } from 'react'
          import { createRoot } from 'react-dom/client'
          import { AskProvider } from '/src/ask/Ask.tsx'
          import { AskSurface } from '/src/ask/AskSurface.tsx'
          import { initialPresentation } from '/src/reconciliation/presentation.ts'
          const surface = (kind, as, children) => h(AskSurface, {
            as, className: 'surface ' + kind, subject: { cardId: 'test' }, onInspect() {}
          }, children)
          createRoot(document.getElementById('root')).render(h(AskProvider, {
            scene: null, state: initialPresentation(), send() {}, onReturn() {}
          }, [surface('relationship', 'div', [h('small', { key: 'status' }, 'Linked'), h('button', { key: 'control' }, 'Worker')]),
              surface('block', 'section', 'Transparent block'),
              h('table', { key: 'table' }, h('tbody', null, surface('table', 'tr', [h('td', { key: 'first' }, 'First'), h('td', { key: 'last' }, 'Last')])))]))
        </script></html>`))
      })
    },
  }] })
  await server.listen()
  origin = server.resolvedUrls!.local[0]!
  browser = await chromium.launch({ headless: true })
}, 30_000)
afterAll(async () => { await browser?.close(); await server?.close() })

it.each(['relationship', 'table', 'block'])('clips both reveals to the exposed strip on a transparent %s', async kind => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/**', route => route.fulfill({ json: { ok: true, data: [] } }))
    await page.goto(new URL('swipe-fixture', origin).href)
    const surface = page.locator(`.surface.${kind}`)
    await surface.waitFor()
    for (const dx of [-80, 80, -1000, 1000]) {
      await surface.dispatchEvent('pointerdown', { pointerType: 'mouse', pointerId: 1, button: 0, clientX: 1200, clientY: 100 })
      await surface.dispatchEvent('pointermove', { pointerType: 'mouse', pointerId: 1, clientX: 1200 + dx, clientY: 100 })
      const rails = surface.locator('.swipe-rail')
      await rails.first().waitFor()
      expect(await rails.count()).toBe(kind === 'table' ? 2 : 1)
      for (const rail of await rails.all()) {
        const result = await rail.evaluate(element => {
          const body = element.parentElement!.querySelector('.swipe-body')!
          const box = element.getBoundingClientRect(), moved = body.getBoundingClientRect()
          const left = moved.left > box.left
          const edge = left ? moved.left : moved.right
          const exposed = left ? (box.left + edge) / 2 : (edge + box.right) / 2
          const covered = left ? (edge + box.right) / 2 : (box.left + edge) / 2
          ;(element as HTMLElement).style.pointerEvents = 'auto'
          return {
            background: getComputedStyle(body).backgroundColor,
            exposed: element.contains(document.elementFromPoint(exposed, box.top + 40)),
            covered: element.contains(document.elementFromPoint(covered, box.top + 40)),
          }
        })
        expect(result).toEqual({ background: 'rgba(0, 0, 0, 0)', exposed: true, covered: false })
      }
      await surface.dispatchEvent('pointercancel', { pointerType: 'mouse', pointerId: 1 })
      for (const rail of await rails.all()) {
        const samples = await rail.evaluate(element => {
          const body = element.parentElement!.querySelector('.swipe-body')!
          const railAnimation = element.getAnimations()[0]!, bodyAnimation = body.getAnimations()[0]!
          railAnimation.pause(); bodyAnimation.pause()
          return [0, 55, 110, 220].map(time => {
            railAnimation.currentTime = time; bodyAnimation.currentTime = time
            const box = element.getBoundingClientRect(), moved = body.getBoundingClientRect()
            const x = (Math.max(box.left, moved.left) + Math.min(box.right, moved.right)) / 2
            return element.contains(document.elementFromPoint(x, box.top + 40))
          })
        })
        expect(samples).toEqual([false, false, false, false])
      }
      await expect(rails).toHaveCount(0)
    }
  } finally { await page.close() }
}, 30_000)
