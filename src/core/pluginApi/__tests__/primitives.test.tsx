// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act, render, fireEvent } from '@testing-library/react'
import type { PluginRecord } from '../../pluginHost/registry'
import type { PluginManifest, WidgetProps } from '@tinstar/plugin-api'
import { createPluginApi } from '../createApi'
import { getWidgetComponent } from '../../../widgets/widgetComponentRegistry'
import { ConstellationProvider } from '../../../hotkeys/ConstellationContext'
import { WidgetIdProvider } from '../widgetIdContext'
import type { PluginWidgetInstance } from '../../../domain/types'

// --- Host dependency mocks (mirror usePluginWidgetData.test.tsx) -------------

// Mock apiFetch so the debounced PATCH never hits the network.
vi.mock('../../../apiClient', () => ({
  apiFetch: vi.fn().mockResolvedValue(new Response('{}', { status: 200 })),
  apiUrl: (p: string) => p,
}))

// In-memory plugin-widget store. addOptimistic mutates it AND bumps a version
// so subscribers (useServerEvents consumers) re-render with the new data —
// exactly the round-trip usePluginWidgetData performs against the real store.
let mockState: { pluginWidgets: PluginWidgetInstance[]; constellationGraphs: unknown[]; pinSets: unknown[] } = { pluginWidgets: [], constellationGraphs: [], pinSets: [] }
const listeners = new Set<() => void>()
function emit() { for (const l of [...listeners]) l() }
const addOptimistic = vi.fn((_kind: string, instance: PluginWidgetInstance) => {
  mockState = {
    ...mockState,
    pluginWidgets: mockState.pluginWidgets.map(p => (p.id === instance.id ? instance : p)),
  }
  emit()
})

vi.mock('../../../hooks/useServerEvents', () => ({
  useServerEvents: () => {
    // Subscribe so addOptimistic-driven mutations re-render consumers.
    const React = require('react') as typeof import('react')
    const [, force] = React.useReducer((n: number) => n + 1, 0)
    React.useEffect(() => {
      const l = () => force()
      listeners.add(l)
      return () => { listeners.delete(l) }
    }, [])
    return { state: mockState, connected: true, loading: false, addOptimistic, disconnect: () => {} }
  },
}))

import { apiFetch } from '../../../apiClient'

function makeRecord(name = 'primitives-test-plugin'): PluginRecord {
  return {
    name,
    version: '0.0.0',
    manifest: { apiVersion: '5', displayName: name } as PluginManifest,
    state: 'pending',
    disposables: [],
  }
}

const NODE_ID = 'browser-node-1'
const DEFAULT_URL = 'http://x/'

describe('api.primitives browser round-trip', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockClear()
    addOptimistic.mockClear()
    listeners.clear()
    localStorage.clear()
    // Seed the host's plugin-widget instance the BrowserBackedWidget binds to.
    mockState = {
      constellationGraphs: [],
      pinSets: [],
      pluginWidgets: [{
        id: NODE_ID,
        pluginId: 'primitives-test-plugin',
        widgetType: 'test-browser',
        spaceId: 'space-1',
        position: { x: 0, y: 0 },
        size: { width: 800, height: 600 },
        data: {}, // no _browser yet ⇒ handle.url falls back to defaultUrl
        createdAt: 't',
        updatedAt: 't',
      } as PluginWidgetInstance],
    }
  })
  afterEach(() => {
    listeners.clear()
  })

  it('useBrowser().url starts at defaultUrl and navigate() persists to _browser', () => {
    const api = createPluginApi(makeRecord())

    // Accessory exercises the REAL api.primitives.useBrowser() handle.
    function Accessory() {
      const browser = api.primitives.useBrowser()
      return (
        <div>
          <span data-testid="url">{browser.url}</span>
          <button data-testid="go" onClick={() => browser.navigate('http://x/p/abc')}>go</button>
        </div>
      )
    }

    // REAL registerBrowserWidget — builds BrowserBackedWidget + registers it.
    const disposable = api.primitives.registerBrowserWidget({
      type: 'test-browser',
      defaultUrl: DEFAULT_URL,
      accessory: { placement: 'right', component: Accessory },
    })

    const reg = getWidgetComponent('test-browser')
    expect(reg).toBeDefined()
    const RegisteredWidget = reg!.component

    const widgetProps: WidgetProps = {
      data: {},
      zoom: 1,
      isSelected: false,
      isDragging: false,
      isHovered: false,
      isDropTarget: false,
    }

    const { getByTestId } = render(
      <ConstellationProvider spaceId="space-1" nodeIds={[NODE_ID]}>
        <WidgetIdProvider id={NODE_ID}>
          <RegisteredWidget {...widgetProps} />
        </WidgetIdProvider>
      </ConstellationProvider>,
    )

    // 1. Initial url comes from defaultUrl (no _browser persisted yet).
    expect(getByTestId('url').textContent).toBe(DEFAULT_URL)

    // 2. Clicking the accessory button navigates — updates the handle AND
    //    persists to the in-memory plugin-widget store's _browser.url.
    act(() => {
      fireEvent.click(getByTestId('go'))
    })

    // Handle reflects the new url (re-derived from persisted data._browser.url).
    expect(getByTestId('url').textContent).toBe('http://x/p/abc')

    // Round-trip persisted: addOptimistic wrote _browser to the store.
    expect(addOptimistic).toHaveBeenCalledWith(
      'pluginWidget',
      expect.objectContaining({
        id: NODE_ID,
        data: expect.objectContaining({ _browser: expect.objectContaining({ url: 'http://x/p/abc' }) }),
      }),
    )

    // And the in-memory store itself now holds _browser.url === navigated url.
    const stored = mockState.pluginWidgets.find(p => p.id === NODE_ID)
    expect((stored?.data as { _browser?: { url: string } } | undefined)?._browser?.url).toBe('http://x/p/abc')

    disposable.dispose()
  })

  it('persists defaultUrl to _browser on mount so the server proxy can resolve a fresh widget', () => {
    // A freshly spawned browser-backed widget has data:{}. The server proxy
    // resolves its target ONLY from the persisted _browser.url (proxyResolve.ts),
    // so without this the proxy 404s "Browser target not found". The widget must
    // persist defaultUrl once on mount.
    const api = createPluginApi(makeRecord())
    const disposable = api.primitives.registerBrowserWidget({ type: 'test-browser', defaultUrl: DEFAULT_URL })

    const RegisteredWidget = getWidgetComponent('test-browser')!.component
    const widgetProps: WidgetProps = {
      data: {}, zoom: 1, isSelected: false, isDragging: false, isHovered: false, isDropTarget: false,
    }

    act(() => {
      render(
        <ConstellationProvider spaceId="space-1" nodeIds={[NODE_ID]}>
          <WidgetIdProvider id={NODE_ID}>
            <RegisteredWidget {...widgetProps} />
          </WidgetIdProvider>
        </ConstellationProvider>,
      )
    })

    expect(addOptimistic).toHaveBeenCalledWith(
      'pluginWidget',
      expect.objectContaining({
        id: NODE_ID,
        data: expect.objectContaining({ _browser: expect.objectContaining({ url: DEFAULT_URL }) }),
      }),
    )
    const stored = mockState.pluginWidgets.find(p => p.id === NODE_ID)
    expect((stored?.data as { _browser?: { url: string } } | undefined)?._browser?.url).toBe(DEFAULT_URL)

    disposable.dispose()
  })

  it('does NOT clobber an already-persisted _browser.url on mount', () => {
    // An existing widget reloads with its url already in the store; the mount
    // persist must be a no-op (useData is synchronous, so the url is present on
    // first render) — otherwise reload would reset the user's navigation.
    mockState.pluginWidgets[0]!.data = { _browser: { url: 'http://x/p/keep' } }
    const api = createPluginApi(makeRecord())
    const disposable = api.primitives.registerBrowserWidget({ type: 'test-browser', defaultUrl: DEFAULT_URL })
    const RegisteredWidget = getWidgetComponent('test-browser')!.component
    const widgetProps: WidgetProps = {
      data: {}, zoom: 1, isSelected: false, isDragging: false, isHovered: false, isDropTarget: false,
    }

    act(() => {
      render(
        <ConstellationProvider spaceId="space-1" nodeIds={[NODE_ID]}>
          <WidgetIdProvider id={NODE_ID}>
            <RegisteredWidget {...widgetProps} />
          </WidgetIdProvider>
        </ConstellationProvider>,
      )
    })

    expect(addOptimistic).not.toHaveBeenCalled()
    const stored = mockState.pluginWidgets.find(p => p.id === NODE_ID)
    expect((stored?.data as { _browser?: { url: string } } | undefined)?._browser?.url).toBe('http://x/p/keep')

    disposable.dispose()
  })
})
