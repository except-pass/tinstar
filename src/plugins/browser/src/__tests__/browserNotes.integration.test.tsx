// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react'
import { useSyncExternalStore, useEffect, useRef } from 'react'
import { makeBrowserPrimitive } from '../BrowserPrimitive'
import { getPinCapture, registerPinCapture, unregisterPinCapture } from '../../../../pins/captureRegistry'
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
      // Mirrors createApi's useProvideCapture: keep the fn fresh via a ref and
      // register it in the real per-node capture registry (the host shell would
      // invoke it at placement). The browser primitive renders with nodeId 'w1'.
      useProvideCapture(fn: (pt: { clientX: number; clientY: number }) => Record<string, unknown> | undefined) {
        const fnRef = useRef(fn)
        fnRef.current = fn
        useEffect(() => {
          registerPinCapture('w1', (pt) => fnRef.current(pt))
          return () => unregisterPinCapture('w1')
        }, [])
      },
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

// Stub the iframe's bounding box (and optionally contentDocument) after render so
// the registered capture fn maps the drop point correctly. Returns the iframe el.
function stubIframe(
  container: HTMLElement,
  rect: Partial<DOMRect>,
  contentDocument?: Document | null,
): HTMLIFrameElement {
  const iframeEl = container.querySelector('iframe') as HTMLIFrameElement
  vi.spyOn(iframeEl, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => {}, ...rect,
  } as DOMRect)
  if (contentDocument !== undefined) {
    Object.defineProperty(iframeEl, 'contentDocument', { configurable: true, get: () => contentDocument })
  }
  return iframeEl
}

describe('BrowserPrimitive pin integration', () => {
  beforeEach(() => unregisterPinCapture('w1'))

  // ── Capture front door (api.pins.useProvideCapture). The browser registers a
  // capture fn at render; the host invokes it at the drop point. We exercise it
  // by reading the registry and calling it with a client point + stubbed iframe
  // geometry — capture now happens AT placement, not via a reactive effect. ──
  it('registers a capture fn that returns url + iframe-body-relative doc coords', () => {
    const store = makePinStore([])
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    const { container } = render(<BrowserPrimitive {...baseProps} sessionId="sess-1" />)
    // Iframe sits below a 44px toolbar; a same-origin doc with no real element
    // under the point (jsdom elementFromPoint ⇒ null) ⇒ no target, coords-only.
    stubIframe(container, { left: 0, top: 44, width: 800, height: 600 }, document)

    const capture = getPinCapture('w1')
    expect(capture).toBeTruthy()
    // Drop at client (400, 322): vx = 400-0 = 400, vy = 322-44 = 278; scroll 0.
    const ctx = capture!({ clientX: 400, clientY: 322 })!
    expect(ctx.url).toBe('http://localhost:3000/')
    expect(ctx.docX).toBe(400)
    expect(ctx.docY).toBe(278)   // header offset removed
    expect(ctx.target).toBeUndefined()  // no element under the point
  })

  it('capture fn includes a DOM target when an element is under the point', () => {
    const store = makePinStore([])
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    const { container } = render(<BrowserPrimitive {...baseProps} sessionId="sess-1" />)

    // Build a same-origin-ish document whose elementFromPoint returns an <h2>.
    const h2 = document.createElement('h2')
    h2.textContent = 'Pricing'
    const fakeDoc = {
      elementFromPoint: () => h2,
    } as unknown as Document
    stubIframe(container, { left: 0, top: 0, width: 800, height: 600 }, fakeDoc)

    const ctx = getPinCapture('w1')!({ clientX: 100, clientY: 50 })!
    expect(ctx.url).toBe('http://localhost:3000/')
    expect((ctx.target as { tag: string }).tag).toBe('h2')
    expect(ctx.docX).toBe(100)
    expect(ctx.docY).toBe(50)
  })

  it('cross-origin doc yields no target but still url + doc coords', () => {
    const store = makePinStore([])
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    const { container } = render(<BrowserPrimitive {...baseProps} sessionId="sess-1" />)
    // contentDocument access throws (cross-origin) — capture swallows and returns
    // url + coords only.
    const iframeEl = container.querySelector('iframe') as HTMLIFrameElement
    vi.spyOn(iframeEl, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => {},
    } as DOMRect)
    Object.defineProperty(iframeEl, 'contentDocument', {
      configurable: true,
      get: () => { throw new Error('cross-origin') },
    })

    const ctx = getPinCapture('w1')!({ clientX: 10, clientY: 20 })!
    expect(ctx.url).toBe('http://localhost:3000/')
    expect(ctx.target).toBeUndefined()
    expect(ctx.docX).toBe(10)
    expect(ctx.docY).toBe(20)
  })

  it('capture returns undefined when the iframe is not laid out (0-size)', () => {
    const store = makePinStore([])
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    const { container } = render(<BrowserPrimitive {...baseProps} sessionId="sess-1" />)
    stubIframe(container, { left: 0, top: 0, width: 0, height: 0 }, document)
    expect(getPinCapture('w1')!({ clientX: 100, clientY: 100 })).toBeUndefined()
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

  it('sends the FRESHLY-TYPED comment, not the stale stored one (regression)', async () => {
    // FIX 1 regression: onCommentChange persists to the store async (next-tick
    // re-render), but onSubmit runs synchronously in the same tick — pin.comment
    // still holds the pre-edit value. Threading the bubble draft through onSubmit
    // is the only fresh source. This proves the POST carries the NEW text; under
    // the old bug it would have carried 'make it pop' (the stored comment).
    httpFetch.mockResolvedValue(okEnvelope())
    const store = makePinStore([
      pin({ comment: 'make it pop', context: { url: 'http://localhost:3000/', docX: 0, docY: 0 } }),
    ])
    const BrowserPrimitive = makeBrowserPrimitive(makeApi(store))
    render(<BrowserPrimitive {...baseProps} sessionId="sess-1" />)
    fireEvent.pointerDown(screen.getByTestId('pin-marker-p1'))
    fireEvent.change(screen.getByTestId('pin-comment-p1'), { target: { value: 'use a brighter blue' } })
    fireEvent.click(screen.getByTestId('pin-submit-p1'))
    await waitFor(() => expect(httpFetch).toHaveBeenCalled())
    const [, init] = httpFetch.mock.calls[0] as [string, { body: string }]
    const body = JSON.parse(init.body)
    expect(body.prompt).toContain('use a brighter blue') // the fresh draft
    expect(body.prompt).not.toContain('make it pop')     // not the stale stored comment
    // And the store is updated with the fresh comment when marked sent.
    await waitFor(() => expect(store.get()[0]!.comment).toBe('use a brighter blue'))
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
