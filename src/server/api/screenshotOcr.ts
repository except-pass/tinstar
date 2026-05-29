import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'

const OCR_TIMEOUT_MS = 5000
const MAX_OCR_BYTES = 256 * 1024

/** Run tesseract on the given image, return trimmed text or null.
 *  Never throws. Returns null if tesseract is missing, times out, or
 *  produces empty output. Bounded by OCR_TIMEOUT_MS and MAX_OCR_BYTES. */
export function runOcr(imagePath: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      // --psm 6 ("assume a single uniform block of text") empirically gives
      // much better results on UI/terminal screenshots than the default auto
      // page-segmentation, which over-fragments dense small text.
      child = spawn('tesseract', [imagePath, '-', '-l', 'eng', '--psm', '6'], {
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      return resolve(null)
    }
    let out: Buffer[] = []
    let outLen = 0
    let truncated = false
    let settled = false
    const settle = (v: string | null) => { if (!settled) { settled = true; resolve(v) } }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      settle(null)
    }, OCR_TIMEOUT_MS)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (outLen >= MAX_OCR_BYTES) { truncated = true; return }
      const remaining = MAX_OCR_BYTES - outLen
      if (chunk.length > remaining) {
        out.push(chunk.subarray(0, remaining))
        outLen = MAX_OCR_BYTES
        truncated = true
      } else {
        out.push(chunk)
        outLen += chunk.length
      }
    })
    child.stderr?.on('data', () => { /* swallow tesseract progress noise */ })
    child.on('error', () => { clearTimeout(timer); settle(null) })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return settle(null)
      const text = Buffer.concat(out).toString('utf-8').trim()
      if (!text) return settle(null)
      settle(truncated ? `${text}\n…[truncated]` : text)
    })
  })
}

/** Write OCR text to a sidecar `.ocr.txt` next to the image. Never throws. */
export async function writeOcrSidecar(imagePath: string, text: string): Promise<void> {
  try { await writeFile(`${imagePath}.ocr.txt`, text, 'utf-8') } catch { /* ignore */ }
}
