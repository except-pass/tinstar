import { useEffect, useId, useRef, useState } from 'react'
import { apiFetch } from '../apiClient'
import { VOICE_MAX_BYTES, VOICE_MAX_SECONDS, VOICE_TIMEOUT_MS, VOICE_UNAVAILABLE, VOICE_TIMEOUT, VOICE_EMPTY, voiceFailureMessage } from '../shared/voice'

type Phase = 'idle' | 'requesting' | 'recording' | 'transcribing'
interface Capture {
  id: number; recorder?: MediaRecorder; stream?: MediaStream; chunks: Blob[]; bytes: number
  started: number; stopAfterPermission: boolean; cancelled: boolean; timer?: ReturnType<typeof setInterval>
  upload?: AbortController
}

/** User-activated MediaRecorder only; never browser/cloud speech recognition. */
export function VoiceInput({ disabled, onTranscript, onBusyChange }: { disabled: boolean; onTranscript: (text: string) => Promise<void>; onBusyChange?: (busy: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>('idle'), [elapsed, setElapsed] = useState(0), [error, setError] = useState<string | null>(null)
  const active = useRef<Capture | null>(null), serial = useRef(0)
  const pointer = useRef<{ at: number; wasRecording: boolean } | null>(null)
  const callbacks = useRef({ onTranscript, onBusyChange }); callbacks.current = { onTranscript, onBusyChange }
  const helpId = useId()
  const changePhase = (next: Phase) => { setPhase(next); callbacks.current.onBusyChange?.(next !== 'idle') }
  const release = (capture: Capture) => {
    clearInterval(capture.timer)
    capture.stream?.getTracks().forEach(track => { track.onended = null; track.stop() })
    capture.stream = undefined
  }
  const cancel = () => {
    const capture = active.current
    active.current = null
    if (capture) {
      capture.cancelled = true; capture.upload?.abort(); release(capture)
      if (capture.recorder?.state === 'recording') capture.recorder.stop()
      capture.chunks = []
    }
    changePhase('idle')
  }
  const fail = (message: string) => { cancel(); setError(message) }
  const stop = () => {
    const capture = active.current
    if (!capture) return
    if (!capture.recorder) { capture.stopAfterPermission = true; return }
    if (capture.recorder.state === 'recording') {
      changePhase('transcribing'); capture.recorder.stop(); release(capture)
    }
  }
  const start = async () => {
    if (disabled || active.current) return
    setError(null); setElapsed(0)
    if (!globalThis.isSecureContext) { setError('Microphone needs HTTPS or localhost. You can still type your question.'); return }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') { setError('Recording is unavailable in this browser. Type your question instead.'); return }
    const capture: Capture = { id: ++serial.current, chunks: [], bytes: 0, started: 0, stopAfterPermission: false, cancelled: false }
    active.current = capture; changePhase('requesting')
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false })
      if (active.current !== capture) { stream.getTracks().forEach(track => track.stop()); return }
      capture.stream = stream
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type))
      const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 64000 })
      capture.recorder = recorder
      recorder.ondataavailable = event => {
        if (capture.cancelled || !event.data.size) return
        capture.bytes += event.data.size
        if (capture.bytes > VOICE_MAX_BYTES) { fail('Recording is too large. Try a shorter question or type it.'); return }
        capture.chunks.push(event.data)
      }
      recorder.onerror = () => fail('Recording was interrupted. Your text is preserved; try again or type your question.')
      stream.getAudioTracks().forEach(track => { track.onended = () => { if (active.current === capture) fail('Microphone disconnected. Try again or type your question.') } })
      recorder.onstop = () => {
        if (capture.cancelled || active.current !== capture) return
        release(capture); changePhase('transcribing')
        const audio = new Blob(capture.chunks, { type: recorder.mimeType || mimeType || 'audio/webm' })
        capture.chunks = []
        if (!audio.size) { fail('No audio was captured. Try again or type your question.'); return }
        capture.upload = new AbortController()
        const timeout = setTimeout(() => capture.upload?.abort(), VOICE_TIMEOUT_MS + 10_000)
        void (async () => {
          try {
            const response = await apiFetch('/api/ask/transcribe', { method: 'POST', headers: { 'X-Tinstar-UI': '1', 'Content-Type': audio.type }, body: audio, signal: capture.upload!.signal })
            const result = await response.json()
            if (active.current !== capture) return
            if (!response.ok || !result.ok) { fail(voiceFailureMessage(result.error)); return }
            const text = typeof result.data?.text === 'string' ? result.data.text.trim() : ''
            if (!text) { fail(VOICE_EMPTY); return }
            active.current = null; changePhase('idle')
            await callbacks.current.onTranscript(text)
          } catch (reason) {
            if (active.current !== capture) return
            fail((reason as { name?: string } | null)?.name === 'AbortError' ? VOICE_TIMEOUT : VOICE_UNAVAILABLE)
          } finally { clearTimeout(timeout) }
        })()
      }
      capture.started = Date.now(); recorder.start(500); changePhase('recording')
      capture.timer = setInterval(() => {
        const seconds = Math.floor((Date.now() - capture.started) / 1000)
        setElapsed(seconds)
        // Leave headroom for encoder padding and the final MediaRecorder chunk.
        if (seconds >= VOICE_MAX_SECONDS - 1) stop()
      }, 250)
      if (capture.stopAfterPermission) stop()
    } catch (reason) {
      if (active.current !== capture) return
      fail((reason as Error).name === 'NotAllowedError' ? 'Microphone permission denied. Allow microphone access in your browser or type your question.' : 'Microphone unavailable. Your text is preserved; try again or type your question.')
    }
  }
  const cancelRef = useRef(cancel); cancelRef.current = cancel
  useEffect(() => {
    const hide = () => { if (document.hidden) cancelRef.current() }
    const pagehide = () => cancelRef.current()
    document.addEventListener('visibilitychange', hide); window.addEventListener('pagehide', pagehide)
    return () => {
      document.removeEventListener('visibilitychange', hide); window.removeEventListener('pagehide', pagehide)
      cancelRef.current()
    }
  }, [])
  const recording = phase === 'recording' || phase === 'requesting'
  return <div className="ask-voice" data-recording={recording} data-phase={phase} onKeyDown={event => { if (event.key === 'Escape' && phase !== 'idle') { event.preventDefault(); event.stopPropagation(); cancel() } }}>
    <button type="button" className="ask-mic" aria-label={recording ? 'Stop recording and send' : 'Record voice question'} aria-pressed={recording} aria-describedby={helpId} disabled={disabled || phase === 'transcribing'}
      onPointerDown={event => {
        if (event.button !== 0 || disabled || phase === 'transcribing') return
        event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture?.(event.pointerId)
        pointer.current = { at: Date.now(), wasRecording: !!active.current }
        if (!active.current) void start()
      }} onPointerUp={event => {
        event.preventDefault(); event.stopPropagation()
        const gesture = pointer.current; pointer.current = null
        if (gesture && (gesture.wasRecording || Date.now() - gesture.at >= 250)) stop()
      }} onPointerCancel={() => { pointer.current = null; cancel() }}
      onClick={event => { event.stopPropagation(); if (event.detail === 0 && !pointer.current) { if (active.current) stop(); else void start() } }}>
      <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8" /></svg><span>{recording ? 'Stop' : 'Talk'}</span>
    </button>
    <div><p id={helpId}>{phase === 'requesting' ? 'Allow microphone access…' : phase === 'transcribing' ? 'Transcribing locally…' : recording ? `Recording · ${elapsed}s / ${VOICE_MAX_SECONDS}s` : 'Hold to talk; release to send. Or tap to start and stop.'}</p>
      <span className="ask-voice-status" role="status" aria-live="polite">{phase === 'requesting' ? 'Waiting for microphone permission.' : phase === 'recording' ? 'Microphone recording. Stop to transcribe and send.' : phase === 'transcribing' ? 'Transcribing locally.' : ''}</span>
      {phase !== 'idle' && <button type="button" onClick={cancel}>Cancel recording</button>}
    </div>
    {error && <p role="alert">{error}</p>}
  </div>
}
