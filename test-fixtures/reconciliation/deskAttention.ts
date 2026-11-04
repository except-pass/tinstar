/** Controlled browser requests for read-only Desk navigation. */
import type { Page } from '@playwright/test'
import type { AttentionCard } from '../../src/cockpit/shell/types'
import type { QueueItem } from '../../src/server/reconciliation/queue'
import { fixtureQueue, fixtureScene } from './scenes'

export async function installDeskAttention(page: Page, base: string) {
  await page.route('**/api/reconciliation/scene', route => route.fulfill({ json: { ok: true, data: fixtureScene() } }))
  await page.route('**/api/reconciliation/queue', async route => {
    const body = await page.request.get(`${base}/api/fleet`).then(response => response.json()) as { data: { attention: AttentionCard[] } }
    const now = Date.now(), queue = fixtureQueue(now)
    queue.items = body.data.attention.map((card): QueueItem => ({
      id: card.key, title: card.headline, action: card.headline, kind: card.type === 'blocked' ? 'blocked' : 'decision',
      readiness: 'ready-now', reasons: ['Controlled owner-routed response fixture'], cardIds: [], executionIds: [], homeIds: card.home ? [card.home] : [], decisionKeys: card.decisionKey ? [card.decisionKey] : [],
      evidence: [], checkpoint: null, oneTouch: true,
      sources: [{ request: card.home ? { home: card.home, taskId: card.taskId, id: card.decisionKey ?? card.holdId, kind: 'decision' } : undefined, kind: 'firstmate', id: JSON.stringify([card.home, card.taskId]), field: 'controlled owner routing', observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60_000).toISOString(), status: 'fresh', coverage: 'complete' }],
    }))
    await route.fulfill({ json: { ok: true, data: queue } })
  })
}
