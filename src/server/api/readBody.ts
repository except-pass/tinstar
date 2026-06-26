import type { IncomingMessage } from 'node:http'

const MAX_BODY_BYTES = 1_000_000  // 1 MB
const READ_TIMEOUT_MS = 5_000

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    const timer = setTimeout(() => {
      try { req.destroy() } catch { /* ignore */ }
      reject(new Error('body read timeout'))
    }, READ_TIMEOUT_MS)
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        clearTimeout(timer)
        try { req.destroy() } catch { /* ignore */ }
        reject(new Error('body too large'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      clearTimeout(timer)
      resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', e => {
      clearTimeout(timer)
      reject(e)
    })
  })
}
