import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { PluginsTab } from '../PluginsTab'

vi.mock('../../../widgets', () => ({
  pluginRegistry: {
    list: () => [
      { name: 'browser', version: '1.0.0', manifest: { apiVersion: '5', displayName: 'Browser widget' }, state: 'active', disposables: [] },
      { name: 'nats-traffic', version: '1.0.0', manifest: { apiVersion: '5', displayName: 'NATS traffic' }, state: 'active', disposables: [] },
    ],
  },
}))
vi.mock('../../../core/pluginApi/pluginsConfigClient', () => ({
  fetchPluginsConfig: async () => ({ disabled: ['nats-traffic'], external: [] }),
  savePluginsConfig: async () => {},
}))

describe('<PluginsTab>', () => {
  it('renders a row per plugin', () => {
    render(<PluginsTab />)
    expect(screen.getByTestId('plugin-row-browser')).toBeTruthy()
    expect(screen.getByTestId('plugin-row-nats-traffic')).toBeTruthy()
  })

  it('reflects disabled state after config fetch', async () => {
    render(<PluginsTab />)
    // Wait a tick for the config fetch
    await new Promise(r => setTimeout(r, 50))
    const toggle = screen.getByTestId('plugin-toggle-nats-traffic') as HTMLInputElement
    expect(toggle.checked).toBe(false)
  })
})
