// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import { ThumbnailStrip } from '../ThumbnailStrip'
import type { Tile } from '../useScreenshotUpload'

const tile = (over: Partial<Tile>): Tile => ({
  clientId: 'c1',
  previewUrl: 'blob:test',
  status: 'ready',
  ...over,
})

describe('ThumbnailStrip', () => {
  it('renders nothing when tiles is empty', () => {
    const { container } = render(<ThumbnailStrip tiles={[]} onRemove={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('renders a tile for each entry', () => {
    const { container } = render(
      <ThumbnailStrip
        tiles={[tile({ clientId: 'a' }), tile({ clientId: 'b' })]}
        onRemove={() => {}}
      />,
    )
    expect(container.querySelectorAll('[data-testid^="thumb-tile-"]')).toHaveLength(2)
  })

  it('shows a spinner overlay on pending tiles', () => {
    const { container } = render(
      <ThumbnailStrip
        tiles={[tile({ clientId: 'a', status: 'pending' })]}
        onRemove={() => {}}
      />,
    )
    expect(container.querySelector('[data-testid="thumb-spinner-a"]')).not.toBeNull()
  })

  it('shows an error overlay + tooltip on error tiles', () => {
    const { container } = render(
      <ThumbnailStrip
        tiles={[tile({ clientId: 'a', status: 'error', errorMessage: 'bad' })]}
        onRemove={() => {}}
      />,
    )
    const overlay = container.querySelector('[data-testid="thumb-error-a"]')
    expect(overlay).not.toBeNull()
    expect(overlay?.getAttribute('title')).toBe('bad')
  })

  it('calls onRemove(clientId) when the ✕ button is clicked', () => {
    const onRemove = vi.fn()
    const { container } = render(
      <ThumbnailStrip
        tiles={[tile({ clientId: 'a' })]}
        onRemove={onRemove}
      />,
    )
    const btn = container.querySelector('[data-testid="thumb-remove-a"]') as HTMLButtonElement
    fireEvent.click(btn)
    expect(onRemove).toHaveBeenCalledWith('a')
  })
})
