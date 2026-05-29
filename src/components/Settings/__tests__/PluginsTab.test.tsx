import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
  fetchPluginsConfig: async () => ({ ok: true, config: { disabled: ['nats-traffic'], external: [] } }),
  savePluginsConfig: async () => {},
}))

describe('<PluginsTab>', () => {
  it('renders a row per plugin', async () => {
    render(<PluginsTab />)
    await waitFor(() => screen.getByTestId('plugin-row-browser'))
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

  it('shows an error message and no toggles when fetch fails', async () => {
    vi.resetModules()
    vi.doMock('../../../core/pluginApi/pluginsConfigClient', () => ({
      fetchPluginsConfig: async () => ({ ok: false, error: 'HTTP 500' }),
      savePluginsConfig: async () => {},
    }))
    vi.doMock('../../../widgets', () => ({
      pluginRegistry: {
        list: () => [{ name: 'x', version: '0.0.1', manifest: { apiVersion: '5', displayName: 'X' }, state: 'active', disposables: [] }],
      },
    }))
    const { PluginsTab: ReloadedTab } = await import('../PluginsTab')
    render(<ReloadedTab />)
    // give the effect a tick
    await new Promise(r => setTimeout(r, 50))
    expect(screen.getByTestId('plugins-tab-error')).toBeTruthy()
    expect(screen.queryByTestId('plugin-toggle-x')).toBeNull()
  })
})
