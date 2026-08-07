import { pluginTest as test } from './fixtures'
import { expect } from '@playwright/test'
import { resetAndWaitForData } from './helpers'

test('Add surface always leaves one visible saved card', async ({ page }, testInfo) => {
  test.setTimeout(90_000)
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await resetAndWaitForData(page)

  const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
  await widget.waitFor({ timeout: 15_000 })
  const runId = ((await widget.getAttribute('data-testid')) ?? '').replace('canvas-widget-run-', '')
  await page.evaluate((id) => {
    window.dispatchEvent(new CustomEvent('widget:flash-focus', { detail: { widgetId: id, source: 'run' } }))
  }, runId)
  await page.waitForTimeout(700)
  // Canvas widgets can be transformed outside the viewport while still mounted.
  // Dispatch to the real DOM affordance without making camera position part of
  // this authoring contract test.
  await widget.getByTestId('slate-open-strip').dispatchEvent('click')
  const slate = widget.getByTestId('focus-zone-slate')
  await expect(slate.getByTestId('slate-blank-invite')).toBeVisible()

  await slate.getByTestId('composer-template-open-points').dispatchEvent('click')
  await slate.getByTestId('composer-submit').dispatchEvent('click')

  // The simulator has no matching live author, so this settles as a visible
  // failure. That is the useful browser proof: accepted work cannot disappear
  // behind a successful-looking button or leave the Slate blank.
  const failed = slate.locator('[data-testid^="surface-failed-"]').first()
  await expect(failed).toBeVisible({ timeout: 15_000 })
  await expect(failed).toContainText('Open points')
  const card = failed.locator('xpath=..')
  const cardTestId = await card.getAttribute('data-testid')
  expect(cardTestId).toMatch(/^slate-surface-compose-/)
  await expect(slate.locator('[data-testid^="slate-surface-compose-"]')).toHaveCount(1)
  await page.addStyleTag({
    content: `[data-testid^="canvas-widget-"]:not([data-testid="canvas-widget-run-${runId}"]){ display:none !important; }`,
  })
  // The simulator canvas can place the selected widget beyond the viewport even
  // though its DOM remains interactive. For the QA artifact only, translate the
  // real rendered Slate node into view and relax ancestor clipping.
  const slateBox = await slate.boundingBox()
  await slate.evaluate((element, left) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      parent.style.overflow = 'visible'
    }
    Object.assign(element.style, {
      transform: `translateX(${24 - left}px)`, zIndex: '2147483647', background: '#080b0e',
    })
  }, slateBox?.x ?? 24)
  await page.waitForTimeout(300)
  await page.screenshot({ path: testInfo.outputPath('saved-failed-card.png'), fullPage: false })

  // Retry reuses the same card. In this fixture it may fail again immediately,
  // but it must never create a sibling or move to another identity.
  await failed.locator('button', { hasText: 'Retry' }).dispatchEvent('click')
  await expect(slate.locator(`[data-testid="${cardTestId}"]`)).toBeVisible()
  await expect(slate.locator('[data-testid^="slate-surface-compose-"]')).toHaveCount(1)
})
