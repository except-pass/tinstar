import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const runtime = fileURLToPath(new URL('../../bin/voice/transcribe.mjs', import.meta.url))
function wave(seconds: number) {
  const audio = Buffer.alloc(44 + seconds * 16000 * 2)
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8)
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22)
  audio.writeUInt32LE(16000, 24); audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34)
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40)
  return audio
}
async function decode(audio: Buffer) {
  return new Promise<{ code: number | null; result: unknown; stderr: string }>((resolve, reject) => {
    // An intentionally missing model: decoding limits and silence must be
    // resolved before model load. These tests never download or run inference.
    const child = spawn(process.execPath, [runtime, '/missing-test-model', '60'])
    let out = '', err = ''
    child.stdout.on('data', chunk => { out += chunk.toString() })
    child.stderr.on('data', chunk => { err += chunk.toString() })
    child.stdin.on('error', () => undefined)
    child.on('error', reject)
    child.on('close', code => { try { resolve({ code, result: JSON.parse(out), stderr: err }) } catch (error) { reject(error) } })
    child.stdin.end(audio)
  })
}
describe('packaged audio decoder executable', () => {
  it('rejects actual decoded duration above 60s rather than trusting metadata', async () => {
    expect(await decode(wave(61))).toEqual({ code: 1, result: { error: 'TOO_LONG' }, stderr: '' })
  })
  it('rejects corrupt media without exposing diagnostics or audio', async () => {
    expect(await decode(Buffer.from('RIFF invalid-private-audio'))).toEqual({ code: 1, result: { error: 'INVALID_AUDIO' }, stderr: '' })
  })
  it('returns empty text for silence without loading a model', async () => {
    expect(await decode(wave(1))).toEqual({ code: 0, result: { text: '' }, stderr: '' })
  })
})
