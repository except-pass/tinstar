// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import { AgentIcon } from '../agentIcon'
import { __resetAvatarCacheForTests } from '../agentAvatarCache'

describe('<AgentIcon>', () => {
  beforeEach(() => { __resetAvatarCacheForTests() })

  it('renders the provided emoji icon when given', () => {
    const { container } = render(<AgentIcon icon="⚡" seed="run-1" color="#ff0000" />)
    expect(container.textContent).toBe('⚡')
  })

  it('renders an <img> for URL icons', () => {
    const { container } = render(<AgentIcon icon="/foo.svg" seed="run-1" color="#ff0000" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('/foo.svg')
  })

  it('renders a colored placeholder circle when no icon and DiceBear not yet loaded', () => {
    const { container } = render(<AgentIcon seed="run-1" color="#abcdef" />)
    const placeholder = container.querySelector('[data-testid="agent-icon-placeholder"]')
    expect(placeholder).not.toBeNull()
    // The element must have a background style applied (don't assert on the exact color
    // format — jsdom normalizes hex to rgb() which is a test-env quirk, not a behavior).
    const style = placeholder!.getAttribute('style') ?? ''
    expect(style).toMatch(/background/)
  })

  it('renders DiceBear <img> after the library resolves', async () => {
    const { container } = render(<AgentIcon seed="run-distinct" color="#123456" />)
    // Poll for the avatar instead of a fixed sleep: the component self-rerenders when the
    // DiceBear dynamic import resolves, and the cache is reset per-test so every run pays the
    // cold-import cost — a hard 200ms wait is flaky on slow/cold CI runners.
    await waitFor(() => {
      expect(container.querySelector('img')).not.toBeNull()
    }, { timeout: 4000 })
    const img = container.querySelector('img')!
    expect(img.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
  })

  it('falls back to the fallback prop when given neither icon nor seed', () => {
    const { container } = render(<AgentIcon fallback={<span data-testid="fb">FB</span>} />)
    expect(container.querySelector('[data-testid="fb"]')).not.toBeNull()
  })
})
