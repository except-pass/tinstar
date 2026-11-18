/** Browser contract fixture only. P5 manual proof additionally runs the actual
 * P1–P3 APIs against an isolated SQLite/source partition. Never production data. */
import type { Page } from '@playwright/test'
import { preparedDecisionFixture } from '../../test-fixtures/reconciliation/preparedDecision'
import { fixtureId, fixtureQueue } from '../../test-fixtures/reconciliation/scenes'
export async function installDecisionDesk(page: Page, initialCard = fixtureId(1)) {
  let held: string | null = null, invalidated = false
  const queue = fixtureQueue()
  const packet = (card: string) => ({ id: '00000000-0000-4000-8000-000000000001', published_at: new Date().toISOString(),
    packet: { ...preparedDecisionFixture(card).packet, title: queue.items.find(item => item.cardIds.includes(card))?.title ?? 'Prepared source fixture' } })
  const claimed = () => ({ outcome: 'held', packet: packet(held!), lease_token: 'opaque-browser-fixture-lease', lease: { card_id: held, generation: 1, holder: 'Browser fixture review', expires_at: new Date(Date.now() + 3600_000).toISOString() } })
  await page.route('**/api/reconciliation/decision-desk/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/').pop(), input = route.request().postDataJSON()
    let data: unknown
    if (path === 'sessions') data = input ? { session: { id: 'browser-fixture-review' }, review_session_token: 'opaque-browser-fixture-session' } : { sessions: [{ id: 'browser-fixture-review', label: 'Browser fixture review', device: 'desktop', held: held ? { title: packet(held).packet.title } : null }] }
    else if (path === 'claim') { const previous = held; held ??= input.card_id ?? initialCard; data = invalidated ? { outcome: 'packet-invalidated', packet: null,
      message: 'The card changed and will be prepared again if it still needs Will.' } :
      { ...claimed(), outcome: previous && input.card_id && input.card_id !== previous ? 'already-holding' : 'held' } }
    else if (path === 'snapshot') data = { counts: { ready: 0, leased: held ? 1 : 0, preparing: 0, needs_repreparation: 0, to_prepare: 0, requests: 1 }, coverage: 'complete', omissions: [], runner: { configured: false, explanation: 'No preparation runner is configured.' }, ready: [], pending: [], recorded_requests: [] }
    else if (path === 'metrics') data = { reviewed_today_utc: 0, scope: 'isolated-browser-fixture', recording_started_at: new Date().toISOString() }
    else if (path === 'submission-state') data = { submissions: [] }
    else if (path === 'release') { held = null; data = { outcome: 'skipped', next: { outcome: 'no-prepared-decisions' } } }
    else { await route.fulfill({ status: 503, json: { ok: false, error: { message: 'Unsupported browser fixture operation' } } }); return }
    await route.fulfill({ json: { ok: true, data } })
  })
  return { invalidate: () => { invalidated = true } }
}

/** Explicit user mode selection; the default must remain the source workbench. */
export async function openDecisionDesk(page: Page) {
  const modes = page.getByRole('navigation', { name: 'Decisions mode' })
  await modes.getByRole('button', { name: 'Decision Desk', exact: true }).click()
}
