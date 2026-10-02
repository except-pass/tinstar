// @vitest-environment jsdom
import { render, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { QuotaMeterSnapshot } from '../server/quota/parse'
import { QuotaBadges, QuotaMeters } from './QuotaRail'

const quotaSnapshot = vi.hoisted(() => ({ current: null as QuotaMeterSnapshot | null }))
vi.mock('../hooks/useQuotaMeters', () => ({ useQuotaMeters: () => quotaSnapshot.current }))

const NOW = Date.parse('2026-09-29T12:00:00.000Z')

const snapshot: QuotaMeterSnapshot = {
  checkedAt: '2026-09-29T12:00:05.000Z',
  fetchedAt: '2026-09-29T12:00:00.000Z',
  commandError: null,
  providers: [
    {
      id: 'claude', plan: 'pro', remainingPercent: 64, level: 'normal',
      limitingWindow: { id: 'seven_day', label: 'week', resetsAt: '2026-10-04T17:00:00.000Z' },
      weeklyWindow: { id: 'seven_day', label: 'week', resetsAt: '2026-10-04T17:00:00.000Z', remainingPercent: 64, level: 'normal' },
      shortWindow: { id: 'five_hour', label: 'session', resetsAt: '2026-09-29T16:00:00.000Z', remainingPercent: 82, level: 'normal' },
      projectedRunOutAt: '2026-10-02T03:00:00.000Z', runway: 'projected_exhaustion',
      error: null, refreshedAt: '2026-09-29T11:58:00.000Z',
    },
    {
      id: 'codex', plan: 'plus', remainingPercent: 18, level: 'low',
      limitingWindow: { id: 'weekly', label: 'week', resetsAt: '2026-10-03T09:00:00.000Z' },
      weeklyWindow: { id: 'weekly', label: 'week', resetsAt: '2026-10-03T09:00:00.000Z', remainingPercent: 18, level: 'low' },
      shortWindow: null,
      projectedRunOutAt: null, runway: 'through_reset',
      error: null, refreshedAt: '2026-09-29T11:59:00.000Z',
    },
    {
      id: 'grok', plan: 'supergrok', remainingPercent: null, level: 'error',
      limitingWindow: null, weeklyWindow: null, shortWindow: null, projectedRunOutAt: null, runway: null,
      error: 'usage endpoint rejected the session', refreshedAt: '2026-09-29T11:50:00.000Z',
    },
    {
      id: 'kimi', plan: 'member', remainingPercent: 3, level: 'critical',
      limitingWindow: { id: 'five_hour', label: 'session', resetsAt: '2026-09-29T14:00:00.000Z' },
      weeklyWindow: null,
      shortWindow: { id: 'five_hour', label: 'session', resetsAt: '2026-09-29T14:00:00.000Z', remainingPercent: 3, level: 'critical' },
      projectedRunOutAt: '2026-09-29T12:00:00.000Z', runway: 'exhausted_now',
      error: 'stale reading', refreshedAt: '2026-09-29T10:00:00.000Z',
    },
  ],
}

describe('cockpit provider quota', () => {
  it('shows a weekly calendar strip per weekly provider and keeps the short window beside it', () => {
    const view = render(<QuotaMeters snapshot={snapshot} now={NOW} />)
    const rail = within(view.getByRole('region', { name: 'Provider quota' }))
    expect(rail.getAllByRole('button')).toHaveLength(2)
    expect(rail.queryByRole('button', { name: 'Grok, no reading' })).toBeNull()
    expect(rail.queryByRole('button', { name: 'Kimi, 3% remaining' })).toBeNull()
    const claudeButton = rail.getByRole('button', { name: 'Claude, 64% remaining' })
    expect(claudeButton.className).toContain('is-week')
    expect(claudeButton.className).toContain('is-normal')
    expect(claudeButton.querySelector('img')?.getAttribute('src')).toBe('/agent-icons/claude.svg')
    expect(within(claudeButton).getAllByTestId('weekday-label').map(node => node.textContent)).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'])
    expect(within(claudeButton).getByTestId('bar-playhead')).toBeTruthy()
    expect(within(claudeButton).getByTestId('bar-fill').getAttribute('data-state')).toBe('warn')
    expect(within(claudeButton).getByText('5h 82')).toBeTruthy()
    const codexButton = rail.getByRole('button', { name: 'Codex, 18% remaining' })
    expect(codexButton.querySelector('img')?.getAttribute('src')).toBe('/agent-icons/openai.svg')
    expect(codexButton.className).toContain('is-week')
    expect(codexButton.className).toContain('is-low')
    expect(within(codexButton).getByTestId('bar-fill').getAttribute('data-state')).toBe('bad')
    expect(within(codexButton).queryByText(/^5h/)).toBeNull()
    const claude = within(rail.getByRole('button', { name: 'Claude, 64% remaining' }))
    const detail = within(claude.getByRole('tooltip'))
    expect(detail.getByText('64%')).toBeTruthy()
    expect(detail.getByText('week')).toBeTruthy()
    expect(detail.getByText('pro')).toBeTruthy()
    expect(detail.getByText('2m ago')).toBeTruthy()
    expect(claude.getByRole('tooltip').querySelector('time[datetime="2026-10-04T17:00:00.000Z"]')).toBeTruthy()
    expect(claude.getByRole('tooltip').querySelector('time[datetime="2026-10-02T03:00:00.000Z"]')).toBeTruthy()

    const codex = within(rail.getByRole('button', { name: 'Codex, 18% remaining' }))
    expect(codex.getByText('Through reset')).toBeTruthy()

    expect(view.container.textContent?.toLowerCase()).not.toContain('unavailable')
  })

  it('keeps compact meters on the rail when the activity strip is over its cap', () => {
    const extra = {
      ...snapshot.providers[3]!, id: 'extra', remainingPercent: 50, level: 'normal' as const, error: null,
    }
    const view = render(<QuotaMeters snapshot={{ ...snapshot, providers: [...snapshot.providers, extra] }} now={NOW} />)
    const rail = within(view.getByRole('region', { name: 'Provider quota' }))
    const grok = rail.getByRole('button', { name: 'Grok, no reading' })
    expect(grok.querySelector('img')?.getAttribute('src')).toBe('/agent-icons/grok.svg')
    expect(within(grok).getByText('usage endpoint rejected the session')).toBeTruthy()
    const kimi = rail.getByRole('button', { name: 'Kimi, 3% remaining' })
    expect(kimi.className).toContain('is-critical')
    expect(kimi.className).not.toContain('is-week')
    const kimiTip = within(within(kimi).getByRole('tooltip'))
    expect(kimiTip.getByText('stale reading')).toBeTruthy()
    expect(kimiTip.getByText('2h ago')).toBeTruthy()
  })

  it('colours, numbers and names a weekly meter from the weekly reading, not the effective one', () => {
    const claude = snapshot.providers[0]!
    const view = render(<QuotaMeters snapshot={{ ...snapshot, providers: [
      { ...claude, remainingPercent: 2, level: 'critical', weeklyWindow: { ...claude.weeklyWindow!, remainingPercent: 70, level: 'normal' } },
      { ...snapshot.providers[1]!, weeklyWindow: { ...snapshot.providers[1]!.weeklyWindow!, remainingPercent: null, level: 'error' } },
    ] }} now={NOW} />)
    const rail = within(view.getByRole('region', { name: 'Provider quota' }))
    const claudeButton = rail.getByRole('button', { name: 'Claude, 70% remaining' })
    expect(claudeButton.className).toContain('is-normal')
    expect(claudeButton.querySelector('.cockpit-quota-pct')?.textContent).toBe('70')
    const codexButton = rail.getByRole('button', { name: 'Codex, no reading' })
    expect(codexButton.className).toContain('is-error')
    expect(codexButton.querySelector('.cockpit-quota-pct')?.textContent).toBe('–')
  })

  it('keeps provider icons when a later refresh fails and puts that error on its own icon', () => {
    const view = render(<QuotaMeters snapshot={{ ...snapshot, commandError: 'quota-axi timed out', providers: snapshot.providers.slice(0, 1) }} now={NOW} />)
    const rail = within(view.getByRole('region', { name: 'Provider quota' }))
    expect(rail.getByRole('button', { name: 'Claude, 64% remaining' })).toBeTruthy()
    expect(within(rail.getByRole('button', { name: 'Quota refresh, no reading' })).getByText('quota-axi timed out')).toBeTruthy()
    expect(view.container.textContent?.toLowerCase()).not.toContain('unavailable')
  })

  it('shows an unsigned Cursor without implying a weekly quota', () => {
    const cursor = {
      ...snapshot.providers[2]!, id: 'cursor', notSetUp: true, error: 'Cursor sign-in required',
    }
    const view = render(<QuotaMeters snapshot={{ ...snapshot, providers: [cursor] }} now={NOW} />)
    const meter = within(view.getByRole('region', { name: 'Provider quota' })).getByRole('button', { name: 'Cursor, not signed in' })
    expect(meter.className).toContain('is-cycle')
    expect(meter.querySelector('img')?.getAttribute('src')).toBe('/agent-icons/cursor.svg')
    expect(meter.querySelectorAll('.cockpit-quota-day')).toHaveLength(0)
    expect(within(meter).getByText('Sign in')).toBeTruthy()
    expect(within(meter).getByText('Not signed in. Sign in to Cursor to show quota.')).toBeTruthy()
  })

  it('draws a signed-in Cursor quota against its reported cycle, not an unrelated week', () => {
    const cursor = {
      ...snapshot.providers[2]!, id: 'cursor', plan: 'Free', remainingPercent: 75, level: 'normal' as const,
      error: null,
      limitingWindow: { id: 'included_usage', label: 'included usage', resetsAt: '2026-10-24T12:00:00.000Z' },
      cycleWindow: {
        id: 'included_usage', label: 'included usage', startsAt: '2026-09-24T12:00:00.000Z',
        resetsAt: '2026-10-24T12:00:00.000Z', remainingPercent: 75, level: 'normal' as const,
      },
    }
    const view = render(<QuotaMeters snapshot={{ ...snapshot, providers: [cursor] }} now={NOW} />)
    const meter = within(view.getByRole('region', { name: 'Provider quota' })).getByRole('button', { name: 'Cursor, 75% remaining' })
    expect(meter.className).toContain('is-cycle')
    expect(meter.querySelector('img')?.getAttribute('src')).toBe('/agent-icons/cursor.svg')
    expect(meter.querySelector('.cockpit-quota-race line')?.getAttribute('x1')).toBe('30')
    expect(meter.querySelectorAll('.cockpit-quota-day')).toHaveLength(0)
    expect(within(meter).getByText('Oct 24')).toBeTruthy()
  })

  it('draws Grok Bot on the weekly strip with its own glyph and leaves Cursor on the cycle bar', () => {
    const cursor = {
      ...snapshot.providers[2]!, id: 'cursor', plan: 'Free', remainingPercent: 75, level: 'normal' as const,
      error: null,
      limitingWindow: { id: 'included_usage', label: 'included usage', resetsAt: '2026-10-24T12:00:00.000Z' },
      cycleWindow: {
        id: 'included_usage', label: 'included usage', startsAt: '2026-09-24T12:00:00.000Z',
        resetsAt: '2026-10-24T12:00:00.000Z', remainingPercent: 75, level: 'normal' as const,
      },
    }
    const bot = {
      id: 'grok_bot', plan: null, remainingPercent: 12, level: 'low' as const,
      limitingWindow: { id: 'grok_bot', label: 'Grok Bot', resetsAt: '2026-10-05T00:00:00.000Z' },
      weeklyWindow: {
        id: 'grok_bot', label: 'Grok Bot', startsAt: '2026-09-28T00:00:00.000Z',
        resetsAt: '2026-10-05T00:00:00.000Z', remainingPercent: 12, level: 'low' as const,
      },
      shortWindow: null, projectedRunOutAt: null, runway: null,
      error: null, refreshedAt: '2026-09-29T11:59:00.000Z',
    }
    const view = render(<QuotaMeters snapshot={{ ...snapshot, providers: [cursor, bot] }} now={NOW} />)
    const rail = within(view.getByRole('region', { name: 'Provider quota' }))
    const cursorButton = rail.getByRole('button', { name: 'Cursor, 75% remaining' })
    expect(cursorButton.className).toContain('is-cycle')
    expect(cursorButton.className).not.toContain('is-week')
    expect(cursorButton.querySelector('img')?.getAttribute('src')).toBe('/agent-icons/cursor.svg')
    expect(cursorButton.querySelectorAll('.cockpit-quota-day')).toHaveLength(0)
    const botButton = rail.getByRole('button', { name: 'Grok Bot, 12% remaining' })
    expect(botButton.className).toContain('is-week')
    expect(botButton.className).toContain('is-low')
    expect(botButton.querySelector('img')?.getAttribute('src')).toBe('/agent-icons/grok-bot.png')
    expect(botButton.querySelector('img')?.getAttribute('src')).not.toBe('/agent-icons/grok.svg')
    expect(within(botButton).getAllByTestId('weekday-label').map(node => node.textContent)).toEqual(['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'])
    expect(within(botButton).getByTestId('bar-playhead')).toBeTruthy()
    expect(within(botButton).getByText('12')).toBeTruthy()
  })

  it('keeps every activity-strip badge when an unsigned Cursor joins four providers', () => {
    const cursor = { ...snapshot.providers[2]!, id: 'cursor', notSetUp: true, error: 'Cursor sign-in required' }
    quotaSnapshot.current = { ...snapshot, providers: [...snapshot.providers, cursor] }
    const view = render(<QuotaBadges />)
    const badges = within(view.getByLabelText('Quota summary')).getAllByRole('button')
    expect(badges.map(badge => badge.getAttribute('aria-label'))).toEqual([
      'Claude summary, 64% remaining',
      'Codex summary, 18% remaining',
      'Grok summary, no reading',
      'Kimi summary, 3% remaining',
    ])
  })

  it('keeps every activity-strip badge when Grok Bot joins the quota rail', () => {
    const bot = {
      id: 'grok_bot', plan: null, remainingPercent: 12, level: 'low' as const,
      limitingWindow: { id: 'grok_bot', label: 'Grok Bot', resetsAt: '2026-10-05T00:00:00.000Z' },
      weeklyWindow: {
        id: 'grok_bot', label: 'Grok Bot', startsAt: '2026-09-28T00:00:00.000Z',
        resetsAt: '2026-10-05T00:00:00.000Z', remainingPercent: 12, level: 'low' as const,
      },
      shortWindow: null, projectedRunOutAt: null, runway: null,
      error: null, refreshedAt: '2026-09-29T11:59:00.000Z',
    }
    quotaSnapshot.current = { ...snapshot, providers: [...snapshot.providers, bot] }
    const view = render(<QuotaBadges />)
    expect(within(view.getByLabelText('Quota summary')).getAllByRole('button').map(badge => badge.getAttribute('aria-label'))).toEqual([
      'Claude summary, 64% remaining',
      'Codex summary, 18% remaining',
      'Grok summary, no reading',
      'Kimi summary, 3% remaining',
    ])
  })

  it('keeps every activity-strip badge when Cursor signs in as a fifth provider', () => {
    const cursor = { ...snapshot.providers[2]!, id: 'cursor', remainingPercent: 75, level: 'normal' as const, error: null }
    quotaSnapshot.current = { ...snapshot, providers: [...snapshot.providers, cursor] }
    const view = render(<QuotaBadges />)
    expect(within(view.getByLabelText('Quota summary')).getAllByRole('button')).toHaveLength(4)
  })
})
