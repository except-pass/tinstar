import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { TimelinePanel, stripHeightPx } from '../TimelinePanel'

vi.mock('../../../hooks/useSessionTimeline', () => ({ useSessionTimeline: vi.fn() }))
vi.mock('../../../context/ConfigContext', () => ({ useConfig: vi.fn() }))
import { useSessionTimeline } from '../../../hooks/useSessionTimeline'
import { useConfig } from '../../../context/ConfigContext'

const cfg = (timeline: boolean) => ({
  ui: { telemetryPanels: { cost: true, tokens: true, cacheHit: false, duty: true, turnLength: true, timeline } },
})

const tl = {
  t0: 0, t1: 100, partial: false, marks: [],
  turns: [[0, 100, true]] as [number, number, boolean][],
  bands: [
    { start: 0, end: 60, kind: 'approval' as const, name: 'exec_command', detail: 'rm -rf /tmp/x' },
    { start: 60, end: 100, kind: 'tool' as const, name: 'exec', detail: '' },
  ],
}

beforeEach(() => vi.clearAllMocks())

describe('TimelinePanel', () => {
  it('renders nothing when the config gate is off (R13)', () => {
    vi.mocked(useConfig).mockReturnValue(cfg(false) as never)
    vi.mocked(useSessionTimeline).mockReturnValue({ timeline: tl, windowSec: 3600, loading: false, error: null })
    const { container } = render(<TimelinePanel sessionId="s" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders three strips when enabled (R9)', () => {
    vi.mocked(useConfig).mockReturnValue(cfg(true) as never)
    vi.mocked(useSessionTimeline).mockReturnValue({ timeline: tl, windowSec: 3600, loading: false, error: null })
    render(<TimelinePanel sessionId="s" />)
    expect(screen.getAllByTestId('timeline-strip')).toHaveLength(3)
  })

  it('shows an explicit no-transcript state rather than an empty strip (R18, AE6)', () => {
    vi.mocked(useConfig).mockReturnValue(cfg(true) as never)
    vi.mocked(useSessionTimeline).mockReturnValue({ timeline: null, windowSec: 3600, loading: false, error: null })
    render(<TimelinePanel sessionId="marshal" />)
    expect(screen.getByText(/no transcript/i)).toBeInTheDocument()
    expect(screen.queryByTestId('timeline-strip')).not.toBeInTheDocument()
  })

  it('prints percentages from durations, not pixels (R17)', () => {
    vi.mocked(useConfig).mockReturnValue(cfg(true) as never)
    vi.mocked(useSessionTimeline).mockReturnValue({ timeline: tl, windowSec: 3600, loading: false, error: null })
    render(<TimelinePanel sessionId="s" />)
    // 60 of 100 seconds is approval, 40 is tool
    expect(screen.getByText('60%')).toBeInTheDocument()
    expect(screen.getByText('40%')).toBeInTheDocument()
  })

  it('distinguishes a broken route from a session with no transcript (#11)', () => {
    vi.mocked(useConfig).mockReturnValue(cfg(true) as never)
    vi.mocked(useSessionTimeline).mockReturnValue({ timeline: null, windowSec: 3600, loading: false, error: 'HTTP 500' })
    render(<TimelinePanel sessionId="s" />)
    expect(screen.getByText(/timeline unavailable/i)).toBeInTheDocument()
    expect(screen.queryByText(/no transcript/i)).not.toBeInTheDocument()
  })

  it('labels an open turn as current', () => {
    vi.mocked(useConfig).mockReturnValue(cfg(true) as never)
    vi.mocked(useSessionTimeline).mockReturnValue({ timeline: tl, windowSec: 3600, loading: false, error: null })
    render(<TimelinePanel sessionId="s" />)
    expect(screen.getByText('NOW')).toBeInTheDocument()
  })
})

describe('stripHeightPx', () => {
  it('draws a shorter stretch of time as a shorter bar (R10)', () => {
    const session = stripHeightPx(97 * 3600, 97 * 3600)
    const turn = stripHeightPx(5.3 * 3600, 97 * 3600)
    const window = stripHeightPx(3600, 97 * 3600)
    expect(session).toBeGreaterThan(turn)
    expect(turn).toBeGreaterThan(window)
  })

  it('never collapses a short range to an unreadable sliver (R10)', () => {
    // strict proportionality would give this about 1.5px
    expect(stripHeightPx(1800, 116 * 3600)).toBeGreaterThanOrEqual(60)
  })

  it('does not stretch a short range to fill the rail', () => {
    expect(stripHeightPx(3600, 97 * 3600)).toBeLessThan(260)
  })

  it('gives the longest range the full height', () => {
    expect(stripHeightPx(100, 100)).toBe(260)
  })
})
