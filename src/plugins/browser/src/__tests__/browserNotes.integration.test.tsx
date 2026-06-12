// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { makeBrowserPrimitive } from '../BrowserPrimitive'
import type { TinstarPluginAPI } from '@tinstar/plugin-api'
import type { Pin } from '../../../../domain/pinSet'

// ── Stateful in-memory pin store, exposed through the api.pins surface the
// browser primitive consumes (useNodePins is a reactive hook; update/remove are
// plain mutators). Mirrors the host's PinsBridge semantics closely enough to
// drive the browser's read/enrich/submit flow under test.
function makePinStore(initial: Pin[] = []) {
  let pins = initial
  const subs = new Set<() => void>()
  const emit = () => subs.forEach(fn => fn())
  // Cache the per-node filtered snapshot so getSnapshot is referentially stable
  // between emits (useSyncExternalStore loops otherwise — a fresh array each call
  // reads as "changed"). Recomputed only when the underlying `pins` ref changes.
  const cache = new Map<string, { src: Pin[]; out: Pin[] }>()
  const snapshot = (nodeId: string): Pin[] => {
    const hit = cache.get(nodeId)
    if (hit && hit.src === pins) return hit.out
    const out = pins.filter(p => p.nodeId === nodeId)
    cache.set(nodeId, { src: pins, out })
    return out
  }
  return {
    get: () => pins,
    set: (next: Pin[]) => { pins = next; emit() },
    api: {
      useNodePins(nodeId: string): Pin[] {
        return useSyncExternalStore(
          (cb) => { subs.add(cb); return () => subs.delete(cb) },
          () => snapshot(nodeId),
        )
      },
      create(_nodeId: string, pin: Pin) { pins = [...pins, pin]; emit() },
      update(_nodeId: string, id: string, fn: (p: Pin) => Pin) {
        pins = pins.map(p => (p.id === id ? fn(p) : p)); emit()
      },
      remove(_nodeId: string, id: string) { pins = pins.filter(p => p.id !== id); emit() },
    },
  }
}

const httpFetch = vi.fn()

function makeApi(store: ReturnType<typeof makePinStore>) {
  return {
    theme: { accent: { hexToRgba: (_c: string, a: number) => `rgba(0,0,0,${a})` } },
    constellations: { Badge: () => null },
    hotkeys: { onAction: () => ({ dispose() {} }) },
    canvas: { fitWidget: () => {} },
    http: { fetch: httpFetch },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    pins: store.api,
  } as unknown as TinstarPluginAPI
}

const pin = (over: Partial<Pin> = {}): Pin => ({
  id: 'p1', nodeId: 'w1', nx: 0.5, ny: 0.5, comment: 'make it pop', createdAt: 1, ...over,
})

const baseProps = {
  nodeId: 'w1', hotkeyId: 'w1', url: 'http://localhost:3000/', accent: '#abc',
  onNavigate: vi.fn(), slots: [] as string[],
}

const okEnvelope = () => ({ ok: true, status: 200, json: async () => ({ ok: true, data: null }) })

beforeEach(() => httpFetch.mockReset())

describe('BrowserPrimitive pin integration', () => {
  it('enriches a fresh shell-placed pin once with the current url + doc coords', async () => {
    const store = makePinStore([pin({ context: undefined })])
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    render(<BrowserPrimitive {...baseProps} sessionId="sess-1" />)
    // The iframe onLoad fires in jsdom; the enrichment effect writes context.
    await waitFor(() => expect(store.get()[0]!.context).toBeTruthy())
    const ctx = store.get()[0]!.context!
    expect(ctx.url).toBe('http://localhost:3000/')
    expect(typeof ctx.docX).toBe('number')
    expect(typeof ctx.docY).toBe('number')
  })

  it('does not re-enrich a pin that already carries context', async () => {
    const store = makePinStore([pin({ context: { url: 'http://localhost:3000/', docX: 7, docY: 9 } })])
    const spy = vi.spyOn(store.api, 'update')
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    render(<BrowserPrimitive {...baseProps} sessionId="sess-1" />)
    await act(async () => { await Promise.resolve() })
    expect(spy).not.toHaveBeenCalled()
    expect(store.get()[0]!.context).toEqual({ url: 'http://localhost:3000/', docX: 7, docY: 9 })
  })

  it('renders a current-page pin and hides an other-page pin', () => {
    const store = makePinStore([
      pin({ context: { url: 'http://localhost:3000/', docX: 0, docY: 0 } }),
      pin({ id: 'p2', context: { url: 'http://localhost:3000/other', docX: 0, docY: 0 } }),
    ])
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    render(<BrowserPrimitive {...baseProps} sessionId="sess-1" />)
    expect(screen.getByTestId('pin-marker-p1')).toBeInTheDocument()
    expect(screen.queryByTestId('pin-marker-p2')).toBeNull()
  })

  it('submits a single pin to enter-prompt and marks it sent', async () => {
    httpFetch.mockResolvedValue(okEnvelope())
    const store = makePinStore([
      pin({ context: { url: 'http://localhost:3000/', docX: 12, docY: 34, target: { tag: 'h2', text: 'Pro' } } }),
    ])
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    render(<BrowserPrimitive {...baseProps} sessionId="sess-1" />)
    fireEvent.pointerDown(screen.getByTestId('pin-marker-p1'))
    fireEvent.click(screen.getByTestId('pin-submit-p1'))
    await waitFor(() => expect(httpFetch).toHaveBeenCalled())
    const [url, init] = httpFetch.mock.calls[0] as [string, { body: string }]
    expect(url).toBe('/api/sessions/sess-1/enter-prompt')
    const body = JSON.parse(init.body)
    expect(body.prompt).toContain('make it pop')
    expect(body.prompt).toContain('http://localhost:3000/')
    expect(body.prompt).toContain('<h2>')
    await waitFor(() => expect(store.get()[0]!.sentAt).toBeTypeOf('number'))
  })

  it('failed submit leaves the pin unsent', async () => {
    httpFetch.mockResolvedValue({ ok: false, status: 500, json: async () => ({ ok: false, error: { message: 'boom' } }) })
    const store = makePinStore([pin({ context: { url: 'http://localhost:3000/', docX: 0, docY: 0 } })])
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    render(<BrowserPrimitive {...baseProps} sessionId="sess-1" />)
    fireEvent.pointerDown(screen.getByTestId('pin-marker-p1'))
    fireEvent.click(screen.getByTestId('pin-submit-p1'))
    await waitFor(() => expect(httpFetch).toHaveBeenCalled())
    await act(async () => { await Promise.resolve() })
    expect(store.get()[0]!.sentAt).toBeUndefined()
  })

  it('Send is disabled without an attached session', () => {
    const store = makePinStore([pin({ context: { url: 'http://localhost:3000/', docX: 0, docY: 0 } })])
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    render(<BrowserPrimitive {...baseProps} />)
    fireEvent.pointerDown(screen.getByTestId('pin-marker-p1'))
    expect(screen.getByTestId('pin-submit-p1')).toBeDisabled()
  })

  it('deleting a pin removes it from the store', () => {
    const store = makePinStore([pin({ context: { url: 'http://localhost:3000/', docX: 0, docY: 0 } })])
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    render(<BrowserPrimitive {...baseProps} sessionId="sess-1" />)
    fireEvent.pointerDown(screen.getByTestId('pin-marker-p1'))
    fireEvent.click(screen.getByTestId('pin-delete-p1'))
    expect(store.get()).toHaveLength(0)
  })
})
