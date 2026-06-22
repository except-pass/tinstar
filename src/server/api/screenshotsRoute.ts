import type { IncomingMessage, ServerResponse } from 'node:http'
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import Busboy from 'busboy'
import { ok, fail } from './envelope'

interface Ctx { configRoot: string }

const URL_RE = /^\/api\/screenshots\/?$/
const MAX_BYTES = 25 * 1024 * 1024 // 25 MB

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
}

function extForMime(mime: string): string | null {
  return MIME_TO_EXT[mime.toLowerCase()] ?? null
}

function timestampFilename(ext: string): string {
  const iso = new Date().toISOString().replace(/[:.]/g, '-')
  const suffix = randomBytes(2).toString('hex')
  return `${iso}-${suffix}.${ext}`
}

export async function handleScreenshotUpload(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: Ctx,
): Promise<boolean> {
  if (!req.url || req.method !== 'POST') return false
  if (!URL_RE.test(req.url)) return false

  const declared = Number(req.headers['content-length'] || 0)
  if (declared && declared > MAX_BYTES + 16 * 1024) {
    fail(res, 'INVALID_PARAMS', `Upload exceeds ${MAX_BYTES} bytes`, { status: 413 })
    return true
  }

  const screenshotsDir = join(ctx.configRoot, 'screenshots')
  if (!existsSync(screenshotsDir)) {
    mkdirSync(screenshotsDir, { recursive: true })
  }

  return new Promise<boolean>((resolve) => {
    let bb: ReturnType<typeof Busboy>
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_BYTES, files: 1, fields: 0 } })
    } catch (err) {
      fail(res, 'BAD_REQUEST', (err as Error).message)
      return resolve(true)
    }

    let tempPath: string | null = null
    let finalPath: string | null = null
    let responded = false
    let receivedFile = false
    let aborted = false

    function sendOk(data: unknown) {
      if (responded) return
      responded = true
      ok(res, data)
      resolve(true)
    }
    function sendFail(code: Parameters<typeof fail>[1], message: string, opts: Parameters<typeof fail>[3] = {}) {
      if (responded) return
      responded = true
      fail(res, code, message, opts)
      resolve(true)
    }
    function cleanup() {
      if (tempPath && existsSync(tempPath)) {
        try { unlinkSync(tempPath) } catch { /* ignore */ }
      }
    }

    bb.on('file', (_name, fileStream, info) => {
      receivedFile = true
      const mime = info.mimeType
      const ext = extForMime(mime)
      if (!ext) {
        fileStream.resume() // drain
        sendFail('INVALID_PARAMS', `Unsupported image MIME type: ${mime}`)
        return
      }
      const filename = timestampFilename(ext)
      finalPath = join(screenshotsDir, filename)
      tempPath = `${finalPath}.part`
      const ws = createWriteStream(tempPath)
      fileStream.pipe(ws)
      fileStream.on('limit', () => {
        ws.destroy()
        cleanup()
        sendFail('INVALID_PARAMS', `Upload exceeds ${MAX_BYTES} bytes`, { status: 413 })
      })
      ws.on('error', (err) => {
        cleanup()
        sendFail('INTERNAL', `Write failed: ${err.message}`)
      })
      ws.on('close', () => {
        if (responded) return
        if (aborted) {
          cleanup()
          return
        }
        try {
          renameSync(tempPath!, finalPath!)
        } catch (err) {
          cleanup()
          sendFail('INTERNAL', `Rename failed: ${(err as Error).message}`)
          return
        }
        sendOk({ path: finalPath })
      })
    })

    bb.on('finish', () => {
      if (!receivedFile) {
        sendFail('INVALID_PARAMS', 'No file field in upload')
      }
    })

    bb.on('error', (err) => {
      cleanup()
      sendFail('BAD_REQUEST', (err as Error).message)
    })

    req.on('aborted', () => {
      aborted = true
      cleanup()
    })

    req.pipe(bb)
  })
}
