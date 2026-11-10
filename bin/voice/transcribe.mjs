// One short-lived, low-priority CPU process per recording. Input/output stay in
// memory. Never log audio, decoder diagnostics, transcripts, or user filenames.
import { spawn } from 'node:child_process'
import { setPriority } from 'node:os'
import ffmpeg from 'ffmpeg-static'

try { setPriority(0, 10) } catch { /* unsupported OS: inference still has one thread */ }
const [modelPath, maxSeconds] = process.argv.slice(2)
const started = performance.now()
const output = (value) => process.stdout.write(JSON.stringify(value))
try {
  const chunks = []; let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 8 * 1024 * 1024) throw new Error('INVALID_AUDIO')
    chunks.push(chunk)
  }
  if (!ffmpeg) throw new Error('RUNTIME_UNAVAILABLE')
  const audio = await new Promise((resolve, reject) => {
    const decoder = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1', '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-vn', '-threads', '1', '-ac', '1', '-ar', '16000', '-t', String(Number(maxSeconds) + 1), '-f', 'f32le', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] })
    const pcm = []; let size = 0
    decoder.on('error', () => reject(new Error('RUNTIME_UNAVAILABLE')))
    decoder.stdout.on('data', chunk => { size += chunk.length; if (size > (Number(maxSeconds) + 1) * 16000 * 4) decoder.kill('SIGKILL'); else pcm.push(chunk) })
    decoder.stdin.on('error', () => undefined)
    decoder.on('close', code => {
      if (code !== 0 || !size || size % 4) reject(new Error('INVALID_AUDIO'))
      else if (size > Number(maxSeconds) * 16000 * 4) reject(new Error('TOO_LONG'))
      else resolve(Buffer.concat(pcm))
    })
    decoder.stdin.end(Buffer.concat(chunks)); chunks.length = 0
  })
  const samples = new Float32Array(audio.buffer, audio.byteOffset, audio.byteLength / 4)
  // Avoid Whisper's hallucinations on silence without inventing conversation text.
  if (!samples.some(sample => Math.abs(sample) > 0.005)) { output({ text: '' }); process.exit(0) }
  const { env, pipeline } = await import('@huggingface/transformers')
  env.allowRemoteModels = false; env.useBrowserCache = false; env.useFSCache = false
  const transcriber = await pipeline('automatic-speech-recognition', modelPath, {
    local_files_only: true, dtype: 'q8', device: 'cpu',
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' },
  })
  const ready = performance.now()
  const result = await transcriber(samples, { chunk_length_s: 30, stride_length_s: 5, max_new_tokens: 256, return_timestamps: false })
  output({ text: result.text.trim(), duration: samples.length / 16000, startup_ms: Math.round(ready - started), inference_ms: Math.round(performance.now() - ready) })
} catch (error) {
  const code = ['INVALID_AUDIO', 'TOO_LONG', 'RUNTIME_UNAVAILABLE'].includes(error.message) ? error.message : 'MODEL_UNAVAILABLE'
  output({ error: code }); process.exitCode = 1
}
