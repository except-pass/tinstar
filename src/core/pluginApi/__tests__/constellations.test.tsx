// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import type { PluginRecord } from '../../pluginHost/registry'
import type { PluginManifest } from '@tinstar/plugin-api'
import { createPluginApi } from '../createApi'
import { ConstellationProvider } from '../../../hotkeys/ConstellationContext'

function makeRecord(name = 'test-plugin'): PluginRecord {
  return {
    name,
    version: '0.0.0',
    manifest: { apiVersion: '5', displayName: name } as PluginManifest,
    state: 'pending',
    disposables: [],
  }
}

describe('api.constellations', () => {
  it('Badge renders the slot chip', () => {
    const api = createPluginApi(makeRecord())
    const Badge = api.constellations.Badge
    const { container } = render(<Badge slots={['1', '3', '5']} testId="b" />)
    expect(container.querySelector('[data-testid="b"]')?.textContent).toMatch(/1 3 5/)
  })

  it('Badge renders nothing for empty slots', () => {
    const api = createPluginApi(makeRecord())
    const Badge = api.constellations.Badge
    const { container } = render(<Badge slots={[]} />)
    expect(container.textContent).toBe('')
  })

  it('useContext returns the constellation state when inside a provider', () => {
    const api = createPluginApi(makeRecord())
    let observed: ReturnType<typeof api.constellations.useContext> | null = null
    function Inner() {
      observed = api.constellations.useContext()
      return null
    }
    render(
      <ConstellationProvider spaceId="s-1" nodeIds={['n-1']}>
        <Inner />
      </ConstellationProvider>,
    )
    expect(typeof observed!.slotsForNode).toBe('function')
    expect(typeof observed!.nodesInSlot).toBe('function')
  })
})
