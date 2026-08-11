import { expect, type Locator } from '@playwright/test'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { pluginTest as test } from './fixtures'
import { createSession, updateSession } from '../src/server/sessions/session'

function cardBody(label: string, lines: number) {
  const children = Array.from({ length: lines }, (_, i) => `line-${i}`)
  return {
    root: 'root',
    components: [
      { id: 'root', component: 'Column', children: ['heading', ...children] },
      { id: 'heading', component: 'Text', variant: 'h3', text: label },
      ...children.map((id, i) => ({
        id,
        component: 'Text',
        variant: 'body',
        text: `${label} detail ${i + 1}: enough prose to exercise wrapping and natural card height.`,
      })),
    ],
  }
}

interface CellRect {
  x: number
  y: number
  right: number
  bottom: number
}

interface Reservation {
  localId: string
  file: string
  attemptToken: string
}

function writeSurface(reservation: Reservation, headline: string, content: ReturnType<typeof cardBody>) {
  mkdirSync(dirname(reservation.file), { recursive: true })
  const tmp = `${reservation.file}.tmp`
  writeFileSync(tmp, JSON.stringify({
    id: reservation.localId,
    attemptToken: reservation.attemptToken,
    headline,
    content,
    claims: [],
  }))
  renameSync(tmp, reservation.file)
}

test('Slate cards pack and reflow across one, two, and three columns', async ({ page, serverDataDir }, testInfo) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1920, height: 1080 })
  await page.goto('/')
  await page.evaluate(async () => {
    await fetch('/api/simulator/reset', { method: 'POST' })
    await fetch('/api/simulator/start', { method: 'POST' })
    localStorage.removeItem('tinstar-layouts-v3')
  })
  await page.reload()

  const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
  await widget.waitFor({ timeout: 15_000 })
  const testId = await widget.getAttribute('data-testid')
  const runId = (testId ?? '').replace('canvas-widget-run-', '')
  if (!testId || !runId) throw new Error('no simulator Run available for the masonry journey')

  const sessionsDir = join(serverDataDir, 'sessions')
  const worktree = join(serverDataDir, 'worktrees', runId)
  mkdirSync(worktree, { recursive: true })
  createSession(sessionsDir, {
    name: runId,
    backend: 'tmux',
    workspace: { path: worktree, worktree: false },
  })
  updateSession(sessionsDir, runId, { state: 'running' })

  const bodies = [
    cardBody('Tall release plan', 9),
    cardBody('Short decision', 1),
    cardBody('Medium evidence', 4),
    cardBody('Rollback note', 2),
    cardBody('Owner map', 3),
    cardBody('Acceptance checks', 5),
    cardBody('Tiny follow-up', 1),
  ]
  for (const [index, content] of bodies.entries()) {
    const reservation = await page.evaluate(async ({ id, index }): Promise<Reservation> => {
      const response = await fetch(`/api/runs/${id}/slate/authoring/reservations`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-tinstar-actor': id,
          'x-tinstar-actor-kind': 'session',
        },
        body: JSON.stringify({
          key: `masonry-card-${index + 1}`,
          label: `Masonry card ${index + 1}`,
          request: `Maintain masonry card ${index + 1}.`,
        }),
      })
      const body = await response.json()
      if (!response.ok) throw new Error(`reservation failed: ${response.status} ${JSON.stringify(body)}`)
      return body.data
    }, { id: runId, index })
    writeSurface(reservation, `Masonry card ${index + 1}`, content)
  }

  const initialSlate = widget.getByTestId('focus-zone-slate')
  await expect(initialSlate).toBeVisible({ timeout: 15_000 })
  await expect(initialSlate).toContainText('Tall release plan detail 1', { timeout: 20_000 })
  await expect(initialSlate.locator('[data-testid^="surface-authoring-"]')).toHaveCount(0)

  const setSlateWidth = async (width: number) => {
    await page.evaluate((nextWidth) => {
      const prefs = JSON.parse(localStorage.getItem('tinstar-ui-prefs') ?? '{}')
      localStorage.setItem('tinstar-ui-prefs', JSON.stringify({
        ...prefs,
        slateWidth: nextWidth,
        telemetryCollapsed: true,
      }))
    }, width)
    await page.reload()
    await page.addStyleTag({
      content: `[data-testid^="canvas-widget-"]:not([data-testid="${testId}"]){ display:none !important; }`,
    })
    const currentWidget = page.getByTestId(testId)
    await currentWidget.waitFor({ timeout: 15_000 })
    const slate = currentWidget.getByTestId('focus-zone-slate')
    await slate.waitFor({ timeout: 15_000 })
    const slateBox = await slate.boundingBox()
    await slate.evaluate((element, left) => {
      for (let parent = element.parentElement; parent; parent = parent.parentElement) {
        parent.style.overflow = 'visible'
      }
      Object.assign(element.style, {
        transform: `translateX(${24 - left}px)`,
        zIndex: '2147483647',
        background: '#080b0e',
      })
    }, slateBox?.x ?? 24)
    const layout = slate.locator('[data-layout="masonry"]')
    await expect(layout.locator(':scope > [data-slate-masonry-cell]')).toHaveCount(bodies.length)
    await page.waitForTimeout(150)
    return { slate, layout }
  }

  const rects = async (layout: Locator): Promise<CellRect[]> => layout.evaluate((root) =>
    Array.from(root.querySelectorAll<HTMLElement>(':scope > [data-slate-masonry-cell]')).map((cell) => {
      const rect = cell.getBoundingClientRect()
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom }
    }),
  )

  const assertNoOverlap = (cells: CellRect[]) => {
    for (let i = 0; i < cells.length; i += 1) {
      for (let j = i + 1; j < cells.length; j += 1) {
        const a = cells[i]!
        const b = cells[j]!
        const overlaps = a.x < b.right - 1 && a.right > b.x + 1
          && a.y < b.bottom - 1 && a.bottom > b.y + 1
        expect(overlaps, `masonry cells ${i + 1} and ${j + 1} overlap`).toBe(false)
      }
    }
  }

  let wideLayout: Locator | null = null
  for (const [width, expectedColumns] of [[320, 1], [520, 2], [820, 3]] as const) {
    const { slate, layout } = await setSlateWidth(width)
    if (expectedColumns === 3) wideLayout = layout
    await expect(layout).toHaveAttribute('data-columns', String(expectedColumns))
    const cells = await rects(layout)
    expect(new Set(cells.map(cell => Math.round(cell.x))).size).toBe(expectedColumns)
    assertNoOverlap(cells)
    const overflow = await layout.evaluate(element => element.scrollWidth - element.clientWidth)
    expect(overflow).toBeLessThan(4)
    const box = await slate.boundingBox()
    if (!box) throw new Error('Slate has no browser geometry')
    await page.screenshot({
      path: testInfo.outputPath(`slate-${expectedColumns}-columns.png`),
      clip: {
        x: box.x,
        y: Math.max(0, box.y),
        width: box.width,
        height: Math.min(box.height, 1080 - Math.max(0, box.y)),
      },
    })
  }

  if (!wideLayout) throw new Error('three-column layout was not exercised')
  const layout = wideLayout
  const packed = await rects(layout)
  // Card four follows the short second card upward instead of waiting for the tall
  // first card's grid row to finish — the behavior the old row grid could not offer.
  expect(Math.round(packed[3]!.x)).toBe(Math.round(packed[1]!.x))
  expect(packed[3]!.y).toBeLessThan(packed[0]!.bottom)

  const beforeMinimize = packed.map(cell => `${Math.round(cell.x)},${Math.round(cell.y)}`)
  const firstCard = layout.locator(':scope > [data-slate-masonry-cell]').first()
  await firstCard.locator('[data-testid^="minimize-surface-"]').dispatchEvent('click')
  await expect(firstCard.locator('[data-minimized="true"]')).toHaveCount(1)
  await page.waitForTimeout(150)
  const afterMinimize = await rects(layout)
  assertNoOverlap(afterMinimize)
  expect(afterMinimize.map(cell => `${Math.round(cell.x)},${Math.round(cell.y)}`)).not.toEqual(beforeMinimize)
})
