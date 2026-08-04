// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { render, within } from '@testing-library/react'
import type { ProviderAccountQuotaObservationWire } from '../../../domain/provider-observation-wire'
import { ProviderQuotaCards } from '../ProviderQuotaCards'

const hudCss = readFileSync(
  resolve(process.cwd(), 'src/components/CanvasHud/hud.css'),
  'utf8',
)

const NOW = Date.parse('2026-08-01T12:00:00.000Z')

function quota(
  providerId: string,
  accountRef: string,
  windows: Array<{
    id: string
    label: string
    windowMinutes: number
    usedPercent: number
    resetsAt?: string
  }>,
): ProviderAccountQuotaObservationWire {
  return {
    kind: 'provider-quota',
    providerId,
    scope: { kind: 'provider', accountRef },
    source: { id: 'native', label: `${providerId} native quota` },
    freshness: {
      state: 'fresh',
      observedAt: '2026-08-01T11:58:00.000Z',
      checkedAt: '2026-08-01T11:58:00.000Z',
    },
    availability: { state: 'available', value: { windows } },
  }
}

describe('<ProviderQuotaCards>', () => {
  it('keeps providers and accounts separate while rendering native window labels', () => {
    const observations = [
      quota('claude', 'default', [{
        id: 'five-hour',
        label: '5 hours',
        windowMinutes: 300,
        usedPercent: 67,
        resetsAt: '2026-08-01T15:13:00.000Z',
      }]),
      quota('codex', 'team-a', [{
        id: 'primary',
        label: 'Primary window',
        windowMinutes: 240,
        usedPercent: 89,
      }]),
      quota('codex', 'team-b', [{
        id: 'weekly',
        label: 'Weekly pool',
        windowMinutes: 10_080,
        usedPercent: 25,
      }]),
    ]

    const view = render(<ProviderQuotaCards observations={observations} nowMs={NOW} />)
    const claude = view.getByTestId('provider-quota-card-claude-default')
    const codex = view.getByTestId('provider-quota-card-codex-team-a')
    const codexTeamB = view.getByTestId('provider-quota-card-codex-team-b')

    expect(within(claude).getByText('Claude')).toBeTruthy()
    expect(within(claude).getByText('default')).toBeTruthy()
    expect(within(claude).getByText('33% left')).toBeTruthy()
    expect(within(claude).getByText(/5 hours · 67% used · resets 3h 13m/)).toBeTruthy()
    expect(within(codex).getByText('Codex')).toBeTruthy()
    expect(within(codex).getByText('team-a')).toBeTruthy()
    expect(within(codex).getByText('11% left')).toBeTruthy()
    expect(within(codex).getByText(/Primary window · 89% used/)).toBeTruthy()
    expect(within(codex).queryByText(/5 hours/)).toBeNull()
    expect(within(codex).queryByText(/Weekly pool/)).toBeNull()
    expect(within(codexTeamB).getByText('team-b')).toBeTruthy()
    expect(within(codexTeamB).getByText('75% left')).toBeTruthy()
    expect(within(codexTeamB).queryByText(/Primary window/)).toBeNull()
  })

  it('restores duration-specific quota visuals for Claude windows', () => {
    const observation = quota('claude', 'default', [
      {
        id: 'five-hour',
        label: '5 hours',
        windowMinutes: 300,
        usedPercent: 67,
        resetsAt: '2026-08-01T15:13:00.000Z',
      },
      {
        id: 'seven-day',
        label: '7 days',
        windowMinutes: 10_080,
        usedPercent: 25,
        resetsAt: '2026-08-05T12:00:00.000Z',
      },
    ])

    const view = render(<ProviderQuotaCards observations={[observation]} nowMs={NOW} />)
    const card = view.getByTestId('provider-quota-card-claude-default')

    expect(within(card).getByTestId('cycle-trough')).toBeTruthy()
    expect(within(card).getByTestId('bar-trough')).toBeTruthy()
    expect(within(card).queryByTestId('provider-quota-gauge')).toBeNull()
  })

  it('chooses Codex visuals by native duration rather than primary/secondary order', () => {
    const observation = quota('codex', 'default', [
      {
        id: 'primary',
        label: 'Primary',
        windowMinutes: 10_080,
        usedPercent: 40,
        resetsAt: '2026-08-05T12:00:00.000Z',
      },
      {
        id: 'secondary',
        label: 'Secondary',
        windowMinutes: 300,
        usedPercent: 8.5,
        resetsAt: '2026-08-01T15:13:00.000Z',
      },
    ])

    const view = render(<ProviderQuotaCards observations={[observation]} nowMs={NOW} />)
    const card = view.getByTestId('provider-quota-card-codex-default')

    expect(within(card).getByText(/Primary · 40% used/)).toBeTruthy()
    expect(within(card).getByText(/Secondary · 9% used/)).toBeTruthy()
    expect(within(card).getByTestId('bar-trough')).toBeTruthy()
    expect(within(card).getByTestId('cycle-trough')).toBeTruthy()
  })

  it('keeps tuple identities distinct when provider or account IDs contain NUL', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const observations = [
        quota('provider\u0000account', 'suffix', [{
          id: 'first',
          label: 'First window',
          windowMinutes: 300,
          usedPercent: 10,
        }]),
        quota('provider', 'account\u0000suffix', [{
          id: 'second',
          label: 'Second window',
          windowMinutes: 300,
          usedPercent: 20,
        }]),
      ]

      const view = render(<ProviderQuotaCards observations={observations} nowMs={NOW} />)
      const titles = [...view.container.querySelectorAll<HTMLElement>('.provider-quota-card')]
        .map(card => card.title)

      expect(titles).toContain('provider\u0000account · suffix\nprovider\u0000account native quota\nfresh · 2m ago')
      expect(titles).toContain('provider · account\u0000suffix\nprovider native quota\nfresh · 2m ago')
      expect(errorSpy.mock.calls.some(call => (
        call.some(value => String(value).includes('same key'))
      ))).toBe(false)
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('shows stale freshness and provider source directly on the card', () => {
    const observation = quota('codex', 'default', [{
      id: 'primary',
      label: 'Primary',
      windowMinutes: 300,
      usedPercent: 40,
    }])
    observation.freshness = {
      state: 'stale',
      observedAt: '2026-08-01T10:00:00.000Z',
      checkedAt: '2026-08-01T11:00:00.000Z',
      staleSince: '2026-08-01T10:05:00.000Z',
    }

    const view = render(<ProviderQuotaCards observations={[observation]} nowMs={NOW} />)

    expect(view.getByText('stale · 2h ago')).toBeTruthy()
    expect(view.getByText('codex native quota')).toBeTruthy()
  })

  it('uses one rounded utilization so displayed percentages remain complementary', () => {
    const observation = quota('codex', 'default', [{
      id: 'primary',
      label: 'Primary',
      windowMinutes: 300,
      usedPercent: 67.5,
    }])

    const view = render(<ProviderQuotaCards observations={[observation]} nowMs={NOW} />)

    expect(view.getByText((_, element) => (
      element?.classList.contains('provider-quota-sub') === true
      && element.textContent === 'Primary · 68% used'
    ))).toBeTruthy()
    expect(view.getByText('32% left')).toBeTruthy()
    expect(view.getByRole('img').getAttribute('aria-label'))
      .toBe('Primary: 68% used, 32% remaining')
    expect(view.getByTestId('provider-quota-gauge')).toBeTruthy()
    expect(view.queryByText('33% left')).toBeNull()
  })

  it('retains cached quota while marking its freshness as refresh failed', () => {
    const observation = quota('codex', 'default', [{
      id: 'primary',
      label: 'Primary',
      windowMinutes: 300,
      usedPercent: 40,
    }])

    const view = render(
      <ProviderQuotaCards
        observations={[observation]}
        error="Tinstar is unreachable"
        nowMs={NOW}
      />,
    )

    expect(view.getByRole('status').textContent).toContain('Tinstar is unreachable')
    expect(view.getByText('60% left')).toBeTruthy()
    expect(view.getByText('refresh failed')).toBeTruthy()
    expect(view.queryByText(/fresh ·/)).toBeNull()
    expect(view.getByText('codex native quota')).toBeTruthy()
  })

  it('renders unavailable and unsupported states without inventing zero usage', () => {
    const unavailable = quota('forge', 'default', [])
    unavailable.availability = {
      state: 'unavailable',
      reason: 'source-error',
      message: 'native quota timed out',
    }
    unavailable.freshness = {
      state: 'unknown',
      observedAt: null,
      checkedAt: '2026-08-01T12:00:00.000Z',
    }

    const unsupported: ProviderAccountQuotaObservationWire = {
      kind: 'provider-quota',
      providerId: 'generic',
      scope: { kind: 'provider', accountRef: 'default' },
      source: null,
      freshness: {
        state: 'unknown',
        observedAt: null,
        checkedAt: '2026-08-01T12:00:00.000Z',
      },
      availability: { state: 'unsupported', reason: 'Provider has no quota API' },
    }

    const view = render(
      <ProviderQuotaCards observations={[unavailable, unsupported]} nowMs={NOW} />,
    )

    expect(view.getByText('Unavailable · native quota timed out')).toBeTruthy()
    expect(view.getByText('Unsupported · Provider has no quota API')).toBeTruthy()
    expect(view.queryByText(/0% used/)).toBeNull()
  })

  it('does not retain cards from a previous provider/account identity', () => {
    const view = render(
      <ProviderQuotaCards
        observations={[quota('codex', 'team-a', [{
          id: 'primary',
          label: 'Team A window',
          windowMinutes: 300,
          usedPercent: 40,
        }])]}
        nowMs={NOW}
      />,
    )
    expect(view.getByText(/Team A window/)).toBeTruthy()

    view.rerender(
      <ProviderQuotaCards
        observations={[quota('claude', 'default', [{
          id: 'five-hour',
          label: '5 hours',
          windowMinutes: 300,
          usedPercent: 10,
        }])]}
        nowMs={NOW}
      />,
    )

    expect(view.queryByTestId('provider-quota-card-codex-team-a')).toBeNull()
    expect(view.queryByText(/Team A window/)).toBeNull()
    expect(view.getByTestId('provider-quota-card-claude-default')).toBeTruthy()
  })

  it('keeps long opaque identities available without displacing freshness', () => {
    const accountRef = 'account-0123456789abcdef-0123456789abcdef@example.test'
    const observation = quota('future-provider-with-a-long-name', accountRef, [{
      id: 'primary',
      label: 'Primary',
      windowMinutes: 300,
      usedPercent: 40,
    }])

    const view = render(<ProviderQuotaCards observations={[observation]} nowMs={NOW} />)
    const card = view.getByTestId(
      `provider-quota-card-future-provider-with-a-long-name-${accountRef}`,
    )
    const account = within(card).getByText(accountRef)
    const freshness = within(card).getByText('fresh · 2m ago')

    expect(card.getAttribute('title')).toContain(
      `future-provider-with-a-long-name · ${accountRef}`,
    )
    expect(account.classList.contains('provider-quota-account')).toBe(true)
    expect(freshness.classList.contains('provider-quota-freshness')).toBe(true)
    expect(hudCss).toMatch(/\.provider-quota-account\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s)
    expect(hudCss).toMatch(/\.provider-quota-freshness\s*\{[^}]*flex:\s*0 0 auto;/s)
  })
})
