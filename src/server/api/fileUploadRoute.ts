import type { IncomingMessage, ServerResponse } from 'node:http'
import { createWriteStream, mkdirSync, renameSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import Busboy from 'busboy'
import { loadConfigMerged } from '../sessions/config'
import { getSession } from '../sessions/session'
import { fail } from './envelope'
import { createUploadResponder } from './uploadHelpers'

interface Ctx { sessDir: string; configRoot: string }

const URL_RE = /^\/api\/sessions\/([^/]+)\/files\/upload\/?$/

function getSessionWorkspace(sessDir: string, name: string): string | null {
  return getSession(sessDir, name)?.workspace?.path ?? null
}

export async function handleFileUpload(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  if (!req.url || req.method !== 'POST') return false
  const m = req.url.match(URL_RE)
  if (!m || m[1] === undefined) return false

  const sessionName = decodeURIComponent(m[1])
  const wsRoot = getSessionWorkspace(ctx.sessDir, sessionName)
  if (!wsRoot) {
    fail(res, 'SESSION_NOT_FOUND', `Session '${sessionName}' not found`)
    return true
  }

  const cfg = loadConfigMerged(ctx.configRoot) as { uploadMaxBytes: number }
  const maxBytes = cfg.uploadMaxBytes

  const declared = Number(req.headers['content-length'] || 0)
  if (declared && declared > maxBytes + 16 * 1024) {
    // 413 Payload Too Large — not in the canonical HTTP_STATUS table since
    // FILE_TOO_LARGE doesn't map to a generic ErrorCode; classify as
    // INVALID_PARAMS at the body layer and override the HTTP status.
    fail(res, 'INVALID_PARAMS', `Upload exceeds ${maxBytes} bytes`, { status: 413 })
    return true
  }

  return new Promise<boolean>((resolve) => {
    let bb: ReturnType<typeof Busboy>
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1, fields: 5 } })
    } catch (err) {
      fail(res, 'BAD_REQUEST', (err as Error).message)
      return resolve(true)
    }

    let targetPath: string | null = null
    let tempPath: string | null = null
    let finalPath: string | null = null
    let bytesWritten = 0
    let aborted = false
    const responder = createUploadResponder(res, resolve, () => tempPath)
    const { sendOk, sendFail, cleanup } = responder

    bb.on('field', (name, value) => {
      if (name === 'path') targetPath = value
    })

    bb.on('file', (_name, fileStream, _info) => {
      if (!targetPath) {
        fileStream.resume()
        sendFail('BAD_REQUEST', 'path field must precede file')
        return
      }
      const rel = targetPath
      const abs = join(wsRoot, rel)
      if (!abs.startsWith(wsRoot + '/') && abs !== wsRoot) {
        fileStream.resume()
        sendFail('PATH_OUTSIDE_WORKSPACE', 'Path escapes workspace')
        return
      }
      finalPath = abs
      mkdirSync(dirname(abs), { recursive: true })
      tempPath = join(dirname(abs), `.tinstar-upload.${randomBytes(8).toString('hex')}`)
      const out = createWriteStream(tempPath)
      fileStream.on('data', (chunk: Buffer) => { bytesWritten += chunk.length })
      fileStream.on('limit', () => {
        aborted = true
        out.destroy()
        cleanup()
        sendFail('INVALID_PARAMS', `Upload exceeds ${maxBytes} bytes`, { status: 413 })
      })
      fileStream.pipe(out)
      out.on('error', () => {
        aborted = true
        cleanup()
        sendFail('INTERNAL', 'Failed writing file')
      })
      out.on('finish', () => {
        if (aborted || responder.responded) return
        if (!tempPath || !finalPath || !targetPath) {
          sendFail('BAD_REQUEST', 'No file part received')
          return
        }
        try {
          renameSync(tempPath, finalPath)
          sendOk({ path: relative(wsRoot, finalPath), bytes: bytesWritten })
        } catch (err) {
          cleanup()
          sendFail('INTERNAL', (err as Error).message)
        }
      })
    })

    bb.on('error', (err) => {
      aborted = true
      cleanup()
      sendFail('BAD_REQUEST', (err as Error).message)
    })

    bb.on('close', () => {
      if (aborted || responder.responded) return
      // If no file was received (e.g. no file part in body), report missing file
      if (!tempPath && !finalPath) {
        sendFail('BAD_REQUEST', 'No file part received')
      }
    })

    req.on('aborted', () => {
      aborted = true
      cleanup()
    })

    req.pipe(bb)
  })
}
