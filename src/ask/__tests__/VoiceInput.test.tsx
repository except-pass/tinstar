import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { VoiceInput } from '../VoiceInput'

class Recorder {
  static all: Recorder[] = []
  static isTypeSupported = (mime: string) => mime === 'audio/mp4'
  mimeType = 'audio/mp4'
  state = 'inactive'
  ondataavailable?: (event: { data: Blob }) => void
  onstop?: () => void
  onerror?: () => void
  constructor() { Recorder.all.push(this) }
  start() { this.state = 'recording' }
  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) })
    queueMicrotask(() => this.onstop?.())
  }
}
let stopTrack: ReturnType<typeof vi.fn>, media: ReturnType<typeof vi.fn>, transcript: ReturnType<typeof vi.fn>
beforeEach(() => {
  Recorder.all = []
  vi.stubGlobal('isSecureContext', true)
  vi.stubGlobal('MediaRecorder', Recorder)
  stopTrack = vi.fn()
  const track = { stop: stopTrack, onended: null }
  media = vi.fn().mockResolvedValue({ getTracks: () => [track], getAudioTracks: () => [track] })
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: media } })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { text: 'Why is it waiting?' } }))))
  transcript = vi.fn().mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })
const mount = () => render(<VoiceInput disabled={false} onTranscript={transcript} />)
const mic = () => screen.getByRole('button', { name: /record voice question|stop recording and send/i })
async function begin() { fireEvent.click(mic(), { detail: 0 }); await screen.findByRole('button', { name: 'Stop recording and send' }) }

describe('local voice capture', () => {
  it('records from a hold, releases once, uploads Safari MP4 and emits one transcript', async () => {
    mount()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    // jsdom does not provide PointerEvent; use a MouseEvent with pointer fields.
    fireEvent(mic(), new MouseEvent('pointerdown', { button: 0, bubbles: true }))
    await screen.findByRole('button', { name: 'Stop recording and send' })
    clock.mockReturnValue(1400)
    fireEvent(mic(), new MouseEvent('pointerup', { button: 0, bubbles: true }))
    fireEvent.click(mic(), { detail: 1 })
    await waitFor(() => expect(transcript).toHaveBeenCalledTimes(1))
    expect(transcript).toHaveBeenCalledWith('Why is it waiting?')
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(vi.mocked(fetch).mock.calls[0]?.[1]).toMatchObject({ method: 'POST', headers: { 'Content-Type': 'audio/mp4', 'X-Tinstar-UI': '1' } })
    expect(stopTrack).toHaveBeenCalled()
  })
  it('supports tap-toggle and keyboard/screen-reader activation', async () => {
    mount(); await begin()
    expect(fetch).not.toHaveBeenCalled()
    fireEvent.click(mic(), { detail: 0 })
    await waitFor(() => expect(transcript).toHaveBeenCalledTimes(1))
  })
  it('a short pointer tap keeps recording until the second tap', async () => {
    mount()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
    fireEvent(mic(), new MouseEvent('pointerdown', { button: 0, bubbles: true }))
    await screen.findByRole('button', { name: 'Stop recording and send' })
    clock.mockReturnValue(1050)
    fireEvent(mic(), new MouseEvent('pointerup', { button: 0, bubbles: true }))
    expect(fetch).not.toHaveBeenCalled()
    fireEvent(mic(), new MouseEvent('pointerdown', { button: 0, bubbles: true }))
    fireEvent(mic(), new MouseEvent('pointerup', { button: 0, bubbles: true }))
    await waitFor(() => expect(transcript).toHaveBeenCalledTimes(1))
  })
  it('cancel and pointer cancellation never transcribe or send', async () => {
    mount(); await begin()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }))
    await act(async () => undefined)
    expect(fetch).not.toHaveBeenCalled(); expect(transcript).not.toHaveBeenCalled()
    await begin(); fireEvent(mic(), new MouseEvent('pointercancel', { bubbles: true }))
    await act(async () => undefined)
    expect(fetch).not.toHaveBeenCalled()
  })
  it('cancels an in-flight upload and ignores its late result', async () => {
    let resolve!: (response: Response) => void
    vi.mocked(fetch).mockImplementation(() => new Promise(done => { resolve = done }))
    mount(); await begin(); fireEvent.click(mic(), { detail: 0 })
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel recording' }))
    expect(vi.mocked(fetch).mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    await act(async () => { resolve(new Response(JSON.stringify({ ok: true, data: { text: 'late transcript' } }))) })
    expect(transcript).not.toHaveBeenCalled()
  })
  it('releases a late permission grant after cancellation and unmount', async () => {
    let grant!: (stream: unknown) => void
    media.mockImplementation(() => new Promise(resolve => { grant = resolve }))
    const view = mount(); fireEvent.click(mic(), { detail: 0 })
    view.unmount()
    await act(async () => { grant({ getTracks: () => [{ stop: stopTrack }] }) })
    expect(stopTrack).toHaveBeenCalledTimes(1); expect(Recorder.all).toHaveLength(0)
  })
  it.each(['NotAllowedError', 'NotFoundError'])('offers text fallback on %s', async name => {
    media.mockRejectedValue(Object.assign(new Error('denied'), { name }))
    mount(); fireEvent.click(mic(), { detail: 0 })
    expect(await screen.findByRole('alert')).toHaveTextContent(/type your question/i)
    expect(transcript).not.toHaveBeenCalled()
  })
  it('explains secure-context requirements without requesting the microphone', () => {
    vi.stubGlobal('isSecureContext', false)
    mount(); fireEvent.click(mic(), { detail: 0 })
    expect(screen.getByRole('alert')).toHaveTextContent('HTTPS')
    expect(media).not.toHaveBeenCalled()
  })
  it.each(['empty', 'server', 'network'])('preserves the text path after %s failure', async failure => {
    vi.mocked(fetch).mockImplementation(async () => {
      if (failure === 'network') throw new Error('Network interrupted')
      return new Response(JSON.stringify(failure === 'empty' ? { ok: true, data: { text: ' ' } } : { ok: false, error: { message: 'Transcriber unavailable' } }), { status: failure === 'server' ? 503 : 200 })
    })
    mount(); await begin(); fireEvent.click(mic(), { detail: 0 })
    expect(await screen.findByRole('alert')).toHaveTextContent(/text is preserved/i)
    expect(transcript).not.toHaveBeenCalled(); expect(mic()).toBeEnabled()
  })
  it('recording loss closes the microphone and does not upload', async () => {
    mount(); await begin()
    act(() => Recorder.all[0]?.onerror?.())
    expect(screen.getByRole('alert')).toHaveTextContent('interrupted')
    await act(async () => undefined)
    expect(fetch).not.toHaveBeenCalled(); expect(stopTrack).toHaveBeenCalled()
  })
})

it('release while permission is pending still stops and sends once after permission is granted', async () => {
  let grant!: (stream: unknown) => void
  media.mockImplementation(() => new Promise(resolve => { grant = resolve }))
  mount()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000)
  fireEvent(mic(), new MouseEvent('pointerdown', { button: 0, bubbles: true }))
  clock.mockReturnValue(1400)
  fireEvent(mic(), new MouseEvent('pointerup', { button: 0, bubbles: true }))
  await act(async () => { grant({ getTracks: () => [{ stop: stopTrack }], getAudioTracks: () => [] }) })
  await waitFor(() => expect(transcript).toHaveBeenCalledTimes(1))
  expect(fetch).toHaveBeenCalledTimes(1)
})

it('stops capture at the duration limit and sends only once', async () => {
  vi.useFakeTimers()
  try {
    mount()
    await act(async () => { fireEvent.click(mic(), { detail: 0 }) })
    expect(mic()).toHaveAttribute('aria-pressed', 'true')
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(transcript).toHaveBeenCalledTimes(1)
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(mic()).toHaveAttribute('aria-pressed', 'false')
  } finally { vi.useRealTimers() }
})
