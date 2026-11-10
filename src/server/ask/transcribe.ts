import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { access, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage } from 'node:http'
import { getConfigRoot } from '../configRoot'
import { VOICE_MAX_BYTES, VOICE_MAX_SECONDS, VOICE_MIME_TYPES, VOICE_TIMEOUT_MS } from '../../shared/voice'

export class VoiceError extends Error {
  constructor(readonly code: 'BAD_REQUEST' | 'BACKEND_UNAVAILABLE' | 'CONFLICT', message: string) { super(message) }
}
export interface Transcript { text: string; duration?: number; startup_ms?: number; inference_ms?: number }
export type Inference = (audio: Buffer, signal: AbortSignal, root: string) => Promise<Transcript>
// No queue: a second recording gets a visible retry/text path instead of keeping
// raw audio around while waiting. Shared across all owner/API instances.
let active = false

function matchesContainer(audio: Buffer, type: string): boolean {
  if (type === 'audio/webm') return audio.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  if (type === 'audio/mp4') return audio.toString('ascii', 4, 8) === 'ftyp'
  if (type === 'audio/ogg') return audio.toString('ascii', 0, 4) === 'OggS'
  return audio.toString('ascii', 0, 4) === 'RIFF' && audio.toString('ascii', 8, 12) === 'WAVE'
}

export class LocalTranscriber {
  constructor(private root = getConfigRoot(), private infer: Inference = runLocalInference, private timeoutMs = VOICE_TIMEOUT_MS) {}
  async transcribe(req: IncomingMessage, signal: AbortSignal): Promise<Transcript> {
    const type = (req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
    if (!VOICE_MIME_TYPES.some(mime => mime === type)) throw new VoiceError('BAD_REQUEST', 'Unsupported audio type. Record WebM, MP4, Ogg or WAV, or type your question.')
    const length = req.headers['content-length']
    if (length && Number(length) > VOICE_MAX_BYTES) throw new VoiceError('BAD_REQUEST', 'Recording exceeds 8 MiB. Try a shorter question.')
    if (active) throw new VoiceError('CONFLICT', 'Local transcription is busy. Try again shortly or type your question.')
    active = true
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) controller.abort()
    const timer = setTimeout(abort, this.timeoutMs)
    const abortRead = () => req.destroy()
    controller.signal.addEventListener('abort', abortRead, { once: true })
    try {
      const chunks: Buffer[] = []; let size = 0
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk)
        if (size > VOICE_MAX_BYTES) throw new VoiceError('BAD_REQUEST', 'Recording exceeds 8 MiB. Try a shorter question.')
        chunks.push(Buffer.from(chunk))
      }
      controller.signal.removeEventListener('abort', abortRead)
      if (controller.signal.aborted) throw new Error('aborted')
      const audio = Buffer.concat(chunks)
      chunks.length = 0
      if (!audio.length || !matchesContainer(audio, type)) throw new VoiceError('BAD_REQUEST', 'Audio does not match its declared type. Record again or type your question.')
      const result = await this.infer(audio, controller.signal, this.root)
      if (controller.signal.aborted) throw new Error('aborted')
      if (!result.text.trim()) throw new VoiceError('BAD_REQUEST', 'No speech recognized. Record again or type your question.')
      if (result.text.length > 4000) throw new VoiceError('BAD_REQUEST', 'Transcript exceeds 4,000 characters. Try a shorter question.')
      return { text: result.text.trim() }
    } catch (error) {
      if (controller.signal.aborted) throw new VoiceError('BACKEND_UNAVAILABLE', 'Local transcription timed out or was cancelled. Your text is preserved.')
      throw error
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      controller.signal.removeEventListener('abort', abortRead)
      active = false
    }
  }
}

function packagedRuntime() {
  let root = dirname(fileURLToPath(import.meta.url))
  while (!existsSync(join(root, 'bin/voice/transcribe.mjs'))) {
    const parent = dirname(root)
    if (parent === root) throw new VoiceError('BACKEND_UNAVAILABLE', 'Local voice runtime is missing. Reinstall Tin Star; text remains available.')
    root = parent
  }
  return root
}

/** Child lifetime is the recording lifetime. A process group includes the audio
 * decoder so cancellation/timeout cannot leave work or raw audio behind. */
export async function runLocalInference(audio: Buffer, signal: AbortSignal, root: string): Promise<Transcript> {
  const runtime = packagedRuntime()
  const manifest = JSON.parse(await readFile(join(runtime, 'bin/voice/model.json'), 'utf8')) as { directory: string; files: Record<string, string> }
  const model = join(root, 'voice', manifest.directory)
  try { await Promise.all(Object.keys(manifest.files).map(file => access(join(model, file)))) }
  catch { throw new VoiceError('BACKEND_UNAVAILABLE', 'Local English voice model is unavailable. Run tinstar voice install on the Tin Star server; text remains available.') }
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('aborted')); return }
    const child = spawn(process.execPath, [join(runtime, 'bin/voice/transcribe.mjs'), model, String(VOICE_MAX_SECONDS)], { detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] })
    let text = '', overflow = false
    const stop = () => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL')
        else child.kill('SIGKILL')
      } catch { /* child already exited */ }
    }
    signal.addEventListener('abort', stop, { once: true })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (text.length + chunk.length > 64 * 1024) { overflow = true; stop() }
      else text += chunk
    })
    child.stdin.on('error', () => undefined)
    child.on('error', () => { signal.removeEventListener('abort', stop); reject(new VoiceError('BACKEND_UNAVAILABLE', 'Local voice runtime unavailable. Reinstall Tin Star or type your question.')) })
    child.on('close', code => {
      signal.removeEventListener('abort', stop)
      if (signal.aborted) { reject(new Error('aborted')); return }
      try {
        const result = JSON.parse(text) as Transcript & { error?: string }
        if (result.error === 'TOO_LONG') throw new VoiceError('BAD_REQUEST', `Recording exceeds ${VOICE_MAX_SECONDS} seconds. Try a shorter question.`)
        if (result.error === 'INVALID_AUDIO') throw new VoiceError('BAD_REQUEST', 'Audio could not be decoded. Record again or type your question.')
        if (result.error || code !== 0 || overflow || typeof result.text !== 'string') throw new Error('runtime failed')
        resolve(result)
      } catch (error) {
        reject(error instanceof VoiceError ? error : new VoiceError('BACKEND_UNAVAILABLE', 'Local voice runtime/model unavailable. Run tinstar voice install or reinstall Tin Star; you can still type.'))
      }
    })
    child.stdin.end(audio)
  })
}
