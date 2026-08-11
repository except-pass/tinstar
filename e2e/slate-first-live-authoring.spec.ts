import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { expect } from '@playwright/test'

import { createSession, updateSession } from '../src/server/sessions/session'
import { pluginTest as test } from './fixtures'

interface Reservation {
  surfaceId: string
  localId: string
  file: string
  attemptToken: string
}

const RESOURCE_NOT_FOUND = 'Failed to load resource: the server responded with a status of 404 (Not Found)'
const RESOURCE_CONFLICT = 'Failed to load resource: the server responded with a status of 409 (Conflict)'

function isExpectedSimulatorClientError(error: string): boolean {
  return /^404 http:\/\/localhost:\d+\/api\/sessions\/CLD-\d+\/timeline\?windowSec=3600$/.test(error)
    || /^404 http:\/\/localhost:\d+\/widget-icons\/model-attribution\.svg$/.test(error)
    || /^409 http:\/\/localhost:\d+\/api\/marshal\/ensure$/.test(error)
}

function writeSurface(reservation: Reservation, headline: string, text: string) {
  mkdirSync(dirname(reservation.file), { recursive: true })
  const tmp = `${reservation.file}.tmp`
  writeFileSync(tmp, JSON.stringify({
    id: reservation.localId,
    attemptToken: reservation.attemptToken,
    headline,
    content: {
      root: 'root',
      components: [{ id: 'root', component: 'Text', variant: 'body', text }],
    },
    claims: [],
  }))
  renameSync(tmp, reservation.file)
}

test('Objective-first live authoring keeps one visible work object as it evolves', async ({
  page,
  serverDataDir,
}, testInfo) => {
  test.setTimeout(120_000)
  const consoleErrors: string[] = []
  const serverErrors: string[] = []
  const clientErrors: string[] = []
  const authoringRequests: string[] = []
  page.on('console', message => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  page.on('response', response => {
    if (response.status() >= 500) serverErrors.push(`${response.status()} ${response.url()}`)
    else if (response.status() >= 400) clientErrors.push(`${response.status()} ${response.url()}`)
  })
  page.on('request', request => {
    if (request.url().includes('/slate/authoring/')) authoringRequests.push(request.url())
  })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto('/')
  await page.evaluate(async () => {
    await fetch('/api/simulator/reset', { method: 'POST' })
    await fetch('/api/simulator/start', { method: 'POST' })
    localStorage.removeItem('tinstar-layouts-v3')
  })
  await page.reload()

  const widget = page.locator('[data-testid^="canvas-widget-run-"]').first()
  await widget.waitFor({ timeout: 15_000 })
  const runId = ((await widget.getAttribute('data-testid')) ?? '').replace('canvas-widget-run-', '')
  expect(runId, 'no simulator run available for the Slate journey').toBeTruthy()

  // Give the simulator Run a real managed-session record and writable worktree.
  // No agent process is launched: this browser scenario authors through the same
  // run-scoped contract a foreground agent receives.
  const sessionsDir = join(serverDataDir, 'sessions')
  const worktree = join(serverDataDir, 'worktrees', runId)
  mkdirSync(worktree, { recursive: true })
  createSession(sessionsDir, {
    name: runId,
    backend: 'tmux',
    workspace: { path: worktree, worktree: false },
  })
  updateSession(sessionsDir, runId, { state: 'running' })

  const objective = 'Decide the release posture and leave the Slate as the usable record.'
  const objectiveResult = await page.evaluate(async ({ id, text }) => {
    const response = await fetch(`/api/runs/${id}/slate/objective`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    })
    return { status: response.status, body: await response.json() }
  }, { id: runId, text: objective })
  expect(objectiveResult.status).toBe(200)

  await page.evaluate((id) => {
    window.dispatchEvent(new CustomEvent('widget:flash-focus', { detail: { widgetId: id, source: 'run' } }))
  }, runId)
  await page.waitForTimeout(500)
  const slate = widget.getByTestId('focus-zone-slate')
  await expect(slate.getByTestId('objective-surface')).toBeVisible({ timeout: 15_000 })
  await expect(slate.getByTestId('objective-text')).toHaveText(objective)

  // Keep the real rendered Slate in the viewport for durable QA screenshots; the
  // simulator's canvas coordinates are intentionally not part of this feature.
  await page.addStyleTag({
    content: `[data-testid^="canvas-widget-"]:not([data-testid="canvas-widget-run-${runId}"]){ display:none !important; }`,
  })
  const slateBox = await slate.boundingBox()
  await slate.evaluate((element, left) => {
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      parent.style.overflow = 'visible'
    }
    Object.assign(element.style, {
      transform: `translateX(${24 - left}px)`, zIndex: '2147483647', background: '#080b0e',
    })
  }, slateBox?.x ?? 24)
  await page.screenshot({ path: testInfo.outputPath('01-objective.png'), fullPage: false })

  const reservation = await page.evaluate(async (id): Promise<Reservation> => {
    const headers = {
      'Content-Type': 'application/json',
      'x-tinstar-actor': id,
      'x-tinstar-actor-kind': 'session',
    }
    const context = await fetch(`/api/runs/${id}/slate/authoring/context`, { headers })
    if (!context.ok) throw new Error(`authoring context failed: ${context.status}`)
    const response = await fetch(`/api/runs/${id}/slate/authoring/reservations`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        key: 'release-posture',
        label: 'Release posture',
        request: 'Keep the release decision and its evidence current.',
      }),
    })
    const body = await response.json()
    if (!response.ok) throw new Error(`reservation failed: ${response.status} ${JSON.stringify(body)}`)
    return body.data
  }, runId)

  const card = slate.getByTestId(`slate-surface-${reservation.localId}`)
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card.getByTestId(`surface-authoring-${reservation.localId}`)).toBeVisible()
  await expect(card).toContainText('Creating this card…')
  await page.screenshot({ path: testInfo.outputPath('02-authoring-shell.png'), fullPage: false })

  writeSurface(
    reservation,
    'Release posture needs a decision',
    'The migration is ready. Choose whether to release now or wait for one more benchmark.',
  )
  await expect(card).toContainText('The migration is ready.', { timeout: 20_000 })
  await expect(card.getByTestId(`surface-authoring-${reservation.localId}`)).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('03-ready-surface.png'), fullPage: false })

  // Two user interactions refine the same work object. They persist on its thread;
  // the foreground author rewrites the assigned file instead of reserving siblings.
  for (const message of ['Release now.', 'Keep rollback steps on the card.']) {
    const replyStatus = await page.evaluate(async ({ id, localId, text }) => {
      const response = await fetch(`/api/runs/${id}/slate/points/${localId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ author: 'user', text }),
      })
      return response.status
    }, { id: runId, localId: reservation.localId, text: message })
    expect(replyStatus).toBe(200)
  }
  writeSurface(
    reservation,
    'Release now — rollback steps retained',
    'Decision: release now. Roll back by reverting the deployment commit, then verify the prior image.',
  )
  await expect(card).toContainText('Decision: release now.', { timeout: 20_000 })
  await expect(card).toContainText('Roll back by reverting')

  const finalState = await page.evaluate(async ({ id, surfaceId }) => {
    const headers = { 'x-tinstar-actor': id, 'x-tinstar-actor-kind': 'session' }
    const context = await (await fetch(`/api/runs/${id}/slate/authoring/context`, { headers })).json()
    const surface = await (await fetch(`/api/surfaces/${surfaceId}`)).json()
    return {
      objective: context.data.objective,
      surfaces: context.data.surfaces,
      canonical: surface.data.surface,
    }
  }, { id: runId, surfaceId: reservation.surfaceId })

  expect(finalState.objective.headline).toBe(objective)
  expect(finalState.surfaces).toHaveLength(1)
  expect(finalState.surfaces[0]).toMatchObject({
    surfaceId: reservation.surfaceId,
    localId: reservation.localId,
    creation: { phase: 'ready' },
  })
  expect(finalState.canonical.thread.replies).toHaveLength(2)
  expect(finalState.canonical.content.headline).toBe('Release now — rollback steps retained')
  await expect(slate.locator('[data-testid^="slate-surface-compose-"]')).toHaveCount(1)
  await expect(slate.getByTestId('objective-surface')).toBeVisible()
  await expect(slate.getByTestId('objective-text')).toHaveText(objective)
  await expect(slate).not.toContainText('raw tool output')
  expect(authoringRequests.filter(url => url.endsWith('/reservations'))).toHaveLength(1)
  expect(authoringRequests.filter(url => url.endsWith('/context'))).toHaveLength(2)
  expect(serverErrors).toEqual([])
  expect(clientErrors.filter(error => !isExpectedSimulatorClientError(error))).toEqual([])
  expect(consoleErrors.filter(error => ![RESOURCE_NOT_FOUND, RESOURCE_CONFLICT].includes(error))).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('04-amended-same-surface.png'), fullPage: false })
})
