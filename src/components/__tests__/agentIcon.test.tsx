// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
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
    const style = placeholder!.getAttribute('style') ?? ''
    expect(style).toContain('#abcdef')
  })

  it('renders DiceBear <img> after the library resolves', async () => {
    const { container, rerender } = render(<AgentIcon seed="run-distinct" color="#123456" />)
    await new Promise(r => setTimeout(r, 200))
    rerender(<AgentIcon seed="run-distinct" color="#123456" />)
    const img = container.querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toMatch(/^data:image\/svg\+xml/)
  })

  it('falls back to the fallback prop when given neither icon nor seed', () => {
    const { container } = render(<AgentIcon fallback={<span data-testid="fb">FB</span>} />)
    expect(container.querySelector('[data-testid="fb"]')).not.toBeNull()
  })
})
