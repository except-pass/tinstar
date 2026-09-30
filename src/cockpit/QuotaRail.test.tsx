// @vitest-environment jsdom
import { render, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { QuotaMeterSnapshot } from '../server/quota/parse'
import { QuotaMeters } from './QuotaRail'

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
    expect(rail.getAllByRole('button')).toHaveLength(4)
    const claudeButton = rail.getByRole('button', { name: 'Claude, 64% remaining' })
    expect(claudeButton.className).toContain('is-week')
    expect(claudeButton.className).toContain('is-normal')
    expect(claudeButton.querySelector('img')?.getAttribute('src')).toBe('/agent-icons/claude.svg')
    expect(rail.getByRole('button', { name: 'Grok, no reading' }).querySelector('img')?.getAttribute('src')).toBe('/agent-icons/grok.svg')
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
    expect(rail.getByRole('button', { name: 'Kimi, 3% remaining' }).className).toContain('is-critical')
    expect(rail.getByRole('button', { name: 'Kimi, 3% remaining' }).className).not.toContain('is-week')

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

    const grok = within(rail.getByRole('button', { name: 'Grok, no reading' }))
    expect(grok.getByText('usage endpoint rejected the session')).toBeTruthy()

    const kimi = within(within(rail.getByRole('button', { name: 'Kimi, 3% remaining' })).getByRole('tooltip'))
    expect(kimi.getByText('stale reading')).toBeTruthy()
    expect(kimi.getByText('2h ago')).toBeTruthy()
    expect(view.container.textContent?.toLowerCase()).not.toContain('unavailable')
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
})
