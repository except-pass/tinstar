import type { IncomingMessage, ServerResponse } from 'node:http'
import { createWriteStream, existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import Busboy from 'busboy'
import { fail } from './envelope'
import { resolveCorsHeaders } from './cors'
import { currentOriginAllowlist } from './originAllowlist'
import { createUploadResponder } from './uploadHelpers'

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

function extForUpload(mime: string, filename: string): string {
  const fromMime = MIME_TO_EXT[mime.toLowerCase()]
  if (fromMime) return fromMime
  // Dropped files share this upload with pasted screenshots. Keep the caller's
  // extension when it is a short token; never use the raw filename as a path.
  const match = filename.toLowerCase().match(/\.([a-z0-9]{1,8})$/)
  return match?.[1] ?? 'bin'
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
  if (!URL_RE.test(req.url.split('?')[0]!)) return false

  const allowlist = currentOriginAllowlist()
  const headers = resolveCorsHeaders({ origin: req.headers.origin, allowlist }) as Record<string, string>
  if (req.headers.origin && !allowlist.includes(req.headers.origin)) {
    fail(res, 'FORBIDDEN', 'Origin not allowed', { headers })
    return true
  }

  const declared = Number(req.headers['content-length'] || 0)
  if (declared && declared > MAX_BYTES + 16 * 1024) {
    fail(res, 'INVALID_PARAMS', `Upload exceeds ${MAX_BYTES} bytes`, { status: 413, headers })
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
      fail(res, 'BAD_REQUEST', (err as Error).message, { headers })
      return resolve(true)
    }

    let tempPath: string | null = null
    let finalPath: string | null = null
    let receivedFile = false
    let aborted = false
    const responder = createUploadResponder(res, headers, resolve, () => tempPath)
    const { sendOk, sendFail, cleanup } = responder

    bb.on('file', (_name, fileStream, info) => {
      receivedFile = true
      const ext = extForUpload(info.mimeType, info.filename ?? '')
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
        if (responder.responded) return
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
