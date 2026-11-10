import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { Readable } from 'node:stream'
import { mkdtemp, readdir, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalTranscriber, runLocalInference, VoiceError, type Inference } from '../transcribe'
import { AskApi } from '../routes'
import { VOICE_UNAVAILABLE, VOICE_TIMEOUT, VOICE_EMPTY, VOICE_MAX_BYTES } from '../../../shared/voice'
import { boundSearchDocuments, sceneSearchDocuments } from '../../../shared/searchDocuments'
import { fixtureScene } from '../../../../test-fixtures/reconciliation/scenes'
import { seedOriginAllowlist, resetOriginAllowlistForTests } from '../../api/originAllowlist'

const wav = Buffer.from('RIFF0000WAVEfmt ', 'ascii')
function request(body = wav, type = 'audio/wav', length?: number) {
  const req = Readable.from([body]) as IncomingMessage
  req.headers = { 'content-type': type, ...(length === undefined ? {} : { 'content-length': String(length) }) }
  return req
}
const signal = () => new AbortController().signal
let server: Server | undefined, root = ''
afterEach(async () => {
  if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined }
  if (root) { await rm(root, { recursive: true, force: true }); root = '' }
  resetOriginAllowlistForTests()
})

describe('bounded ephemeral transcription', () => {
  it('validates container and type, trims transcript and never writes request audio', async () => {
    root = await mkdtemp(join(tmpdir(), 'voice-test-'))
    const infer = vi.fn<Inference>(async () => ({ text: '  What changed?  ', startup_ms: 10 }))
    const service = new LocalTranscriber(root, infer)
    expect(await service.transcribe(request(), signal())).toEqual({ text: 'What changed?' })
    expect(infer).toHaveBeenCalledTimes(1)
    expect(infer.mock.calls[0]?.[0]).toEqual(wav)
    expect(await readdir(root)).toEqual([])
    await expect(service.transcribe(request(Buffer.from('not audio')), signal())).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(service.transcribe(request(wav, 'text/plain'), signal())).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(service.transcribe(request(Buffer.alloc(0)), signal())).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(infer).toHaveBeenCalledTimes(1)
  })
  it('rejects declared and streamed oversize before inference', async () => {
    const infer = vi.fn<Inference>(async () => ({ text: 'unused' }))
    const service = new LocalTranscriber('/unused-test-root', infer)
    await expect(service.transcribe(request(wav, 'audio/wav', VOICE_MAX_BYTES + 1), signal())).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    await expect(service.transcribe(request(Buffer.alloc(VOICE_MAX_BYTES + 1)), signal())).rejects.toMatchObject({ code: 'BAD_REQUEST' })
    expect(infer).not.toHaveBeenCalled()
  })
  it.each([
    ['audio/webm;codecs=opus', Buffer.from([0x1a, 0x45, 0xdf, 0xa3])],
    ['audio/mp4', Buffer.from('0000ftypisom')],
    ['audio/ogg;codecs=opus', Buffer.from('OggS')],
  ])('accepts browser container %s', async (type, bytes) => {
    const infer = vi.fn<Inference>(async () => ({ text: 'Browser voice' }))
    expect(await new LocalTranscriber('/unused-test-root', infer).transcribe(request(bytes, type), signal())).toEqual({ text: 'Browser voice' })
  })
  it('admits one recording, rejects concurrent uploads without queueing, then releases the slot', async () => {
    let finish!: (result: { text: string }) => void
    const infer = vi.fn(() => new Promise<{ text: string }>(resolve => { finish = resolve }))
    const service = new LocalTranscriber('/unused-test-root', infer)
    const first = service.transcribe(request(), signal())
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(1))
    await expect(service.transcribe(request(), signal())).rejects.toMatchObject({ code: 'CONFLICT' })
    finish({ text: 'First question' }); await first
    const retry = service.transcribe(request(), signal())
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2))
    finish({ text: 'Second question' }); expect(await retry).toEqual({ text: 'Second question' })
  })
  it('times out inference, propagates cancellation and allows text/retry afterwards', async () => {
    const infer = vi.fn((_audio: Buffer, cancellation: AbortSignal) => new Promise<{ text: string }>((_resolve, reject) => cancellation.addEventListener('abort', () => reject(new Error('aborted')), { once: true })))
    const service = new LocalTranscriber('/unused-test-root', infer, 25)
    await expect(service.transcribe(request(), signal())).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE', message: VOICE_TIMEOUT })
    const abort = new AbortController()
    const task = service.transcribe(request(), abort.signal)
    await vi.waitFor(() => expect(infer).toHaveBeenCalledTimes(2), { interval: 1 })
    abort.abort()
    await expect(task).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    expect(await new LocalTranscriber('/unused-test-root', async () => ({ text: 'Recovered' })).transcribe(request(), signal())).toEqual({ text: 'Recovered' })
  })
  it.each(['', ' '.repeat(10), 'a'.repeat(4001)])('rejects empty or overlong transcription', async text => {
    await expect(new LocalTranscriber('/unused-test-root', async () => ({ text })).transcribe(request(), signal())).rejects.toMatchObject({ code: 'BAD_REQUEST' })
  })
  it('reports missing local models clearly and creates no audio files', async () => {
    root = await mkdtemp(join(tmpdir(), 'voice-missing-'))
    await expect(runLocalInference(wav, signal(), root)).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE', message: VOICE_UNAVAILABLE })
    expect(await readdir(root)).toEqual([])
  })
})

it('protects transcription with the existing owner, UI handshake and origin boundary; it creates no Ask turn', async () => {
  root = await mkdtemp(join(tmpdir(), 'voice-http-'))
  const infer = vi.fn<Inference>(async () => ({ text: 'Why is it waiting?' }))
  const voice = new LocalTranscriber(root, infer)
  const api = new AskApi({ scene: async () => { const scene = fixtureScene(); return { ...scene, searchIndex: boundSearchDocuments(sceneSearchDocuments(scene)) } } }, root, async () => ({ ownerLogins: ['owner@example.test'], bridgeToken: 'test-bridge-token-at-least-32-characters' }), undefined, undefined, undefined, voice)
  server = createServer((req, res) => { void api.handle(req, res) })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no address')
  seedOriginAllowlist(address.port)
  const url = `http://127.0.0.1:${address.port}/api/ask/transcribe`
  const valid = { 'Tailscale-User-Login': 'owner@example.test', 'X-Tinstar-UI': '1' }
  const rejectedHeaders: Record<string, string>[] = [{}, { 'Tailscale-User-Login': 'intruder@example.test', 'X-Tinstar-UI': '1' }, { 'Tailscale-User-Login': 'owner@example.test' }, { ...valid, Origin: 'https://evil.test' }, { Authorization: 'Bearer test-bridge-token-at-least-32-characters' }]
  for (const headers of rejectedHeaders) {
    const result = await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav' }, body: wav })
    expect(result.status).toBe(403)
  }
  expect(infer).not.toHaveBeenCalled()
  const result = await fetch(url, { method: 'POST', headers: { ...valid, 'Content-Type': 'audio/wav' }, body: wav })
  expect(await result.json()).toEqual({ ok: true, data: { text: 'Why is it waiting?' } })
  expect(result.headers.get('cache-control')).toBe('no-store')
  expect(await api.store.list('owner@example.test')).toEqual([])
  infer.mockRejectedValueOnce(new VoiceError('BAD_REQUEST', 'Recording exceeds 60 seconds.'))
  const long = await fetch(url, { method: 'POST', headers: { ...valid, 'Content-Type': 'audio/wav' }, body: wav })
  expect(long.status).toBe(400)
  for (const [failure, message] of [
    [new VoiceError('BACKEND_UNAVAILABLE', VOICE_UNAVAILABLE), VOICE_UNAVAILABLE],
    [new VoiceError('BACKEND_UNAVAILABLE', VOICE_TIMEOUT), VOICE_TIMEOUT],
    [new Error('Operator-only internal failure'), VOICE_UNAVAILABLE],
  ] as const) {
    infer.mockRejectedValueOnce(failure)
    const response = await fetch(url, { method: 'POST', headers: { ...valid, 'Content-Type': 'audio/wav' }, body: wav })
    const result = await response.json()
    expect(result.error.message).toBe(message)
    expect(result.error.message).not.toMatch(/tinstar voice install|Tin Star server|\.\./i)
  }
  infer.mockResolvedValueOnce({ text: '' })
  const empty = await fetch(url, { method: 'POST', headers: { ...valid, 'Content-Type': 'audio/wav' }, body: wav })
  expect((await empty.json()).error.message).toBe(VOICE_EMPTY)
})


it('dedupes missing-model notices across requests and restart, suppresses preview delivery, and clears on recovery', async () => {
  root = await mkdtemp(join(tmpdir(), 'voice-outage-preview-'))
  let recovered = false
  const infer = vi.fn<Inference>(async (audio, cancellation, configRoot) => {
    if (!recovered) return runLocalInference(audio, cancellation, configRoot)
    return { text: 'Voice is working again.' }
  })
  const settings = { ownerLogins: ['owner@example.test'], bridgeToken: 'test-bridge-token-at-least-32-characters' }
  const voice = new LocalTranscriber(root, infer)
  const make = () => new AskApi({ scene: async () => { throw new Error('No scene required') } }, root, async () => settings, undefined, undefined, undefined, voice)
  let api = make()
  server = createServer((req, res) => { void api.handle(req, res) })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('no address')
  seedOriginAllowlist(address.port)
  const base = `http://127.0.0.1:${address.port}/api/ask`
  const post = () => fetch(base + '/transcribe', { method: 'POST', headers: { 'Tailscale-User-Login': 'owner@example.test', 'X-Tinstar-UI': '1', 'Content-Type': 'audio/wav' }, body: wav })
  for (let click = 0; click < 3; click++) {
    expect(await (await post()).json()).toEqual({ ok: false, error: { code: 'BACKEND_UNAVAILABLE', message: VOICE_UNAVAILABLE } })
    api = make() // The durable outage survives a server/API restart.
  }
  await Promise.all(Array.from({ length: 5 }, () => api.store.voiceModelAvailable(false)))
  const rows = () => readFile(join(root, 'ask-requests.json'), 'utf8').then(JSON.parse)
  expect(await rows()).toHaveLength(1)
  expect(await api.store.list('owner@example.test')).toEqual([])
  const bridge = () => fetch(base + '/bridge', { headers: { Authorization: `Bearer ${settings.bridgeToken}` } }).then(r => r.json())
  expect((await bridge()).data.pending).toEqual([]) // Existing preview delivery boundary.
  await writeFile(join(root, 'config.json'), JSON.stringify({ checkInWatchdog: { previewDeliveryEnabled: true } }))
  const notice = (await bridge()).data.pending[0]
  expect(notice.body).toContain('SYSTEM VOICE MODEL NOTICE')
  expect((await bridge()).data.pending).toHaveLength(1)
  const note = { schema: 'fm-inbox-note.v1' as const, outcome: 'created' as const, id: 'voice-notice', request_id: notice.inbox_request_id, saved: true as const, announced: true, acknowledged: true }
  const update = (value: unknown) => fetch(base + '/bridge', { method: 'POST', headers: { Authorization: `Bearer ${settings.bridgeToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(value) }).then(r => r.json())
  expect((await update({ request_id: notice.request_id, error: 'capture-failed' })).ok).toBe(true)
  expect((await bridge()).data.pending).toEqual([notice])
  expect((await update({ request_id: notice.request_id, note: { ...note, announced: false } })).ok).toBe(true)
  expect((await update({ request_id: notice.request_id, error: 'wake-failed' })).ok).toBe(true)
  expect((await bridge()).data.pending).toEqual([notice])
  expect(await rows()).toHaveLength(1) // Delivery repair reuses the same notice.
  expect((await update({ request_id: notice.request_id, note })).ok).toBe(true)
  expect((await bridge()).data.pending).toEqual([])
  await post()
  expect(await rows()).toHaveLength(1) // A delivered notice never creates another per click.
  // Populate only availability fixtures; the test inference never loads them.
  const manifest = JSON.parse(await readFile('bin/voice/model.json', 'utf8'))
  for (const file of Object.keys(manifest.files)) {
    const path = join(root, 'voice', manifest.directory, file)
    await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, '')
  }
  recovered = true
  expect((await (await post()).json()).data.text).toBe('Voice is working again.')
  expect((await rows())[0].voice_outage.resolved_at).toEqual(expect.any(String))
  expect((await bridge()).data.tracked).toEqual([])
  await rm(join(root, 'voice'), { recursive: true })
  recovered = false
  await post()
  expect(await rows()).toHaveLength(2)
  expect((await bridge()).data.pending).toHaveLength(1)
})
