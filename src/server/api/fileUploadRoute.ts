import type { IncomingMessage, ServerResponse } from 'node:http'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { randomBytes } from 'node:crypto'
import Busboy from 'busboy'
import { loadServerPrefs } from '../serverPrefs'

interface Ctx { sessDir: string; configRoot: string }

const URL_RE = /^\/api\/sessions\/([^/]+)\/files\/upload\/?$/

function json(res: ServerResponse, payload: unknown, status = 200) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

function getSessionWorkspace(sessDir: string, name: string): string | null {
  const path = join(sessDir, `${name}.json`)
  if (!existsSync(path)) return null
  try {
    const sess = JSON.parse(readFileSync(path, 'utf8'))
    return sess?.workspace?.path ?? null
  } catch {
    return null
  }
}

export async function handleFileUpload(req: IncomingMessage, res: ServerResponse, ctx: Ctx): Promise<boolean> {
  if (!req.url || req.method !== 'POST') return false
  const m = req.url.match(URL_RE)
  if (!m) return false

  const sessionName = decodeURIComponent(m[1])
  const wsRoot = getSessionWorkspace(ctx.sessDir, sessionName)
  if (!wsRoot) {
    json(res, { ok: false, error: { code: 'SESSION_NOT_FOUND', message: `Session '${sessionName}' not found` } }, 404)
    return true
  }

  const prefs = loadServerPrefs(ctx.configRoot)
  const maxBytes = prefs.uploadMaxBytes

  const declared = Number(req.headers['content-length'] || 0)
  if (declared && declared > maxBytes + 16 * 1024) {
    json(res, { ok: false, error: { code: 'FILE_TOO_LARGE', message: `Upload exceeds ${maxBytes} bytes` } }, 413)
    return true
  }

  return new Promise<boolean>((resolve) => {
    let bb: ReturnType<typeof Busboy>
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: maxBytes, files: 1, fields: 5 } })
    } catch (err) {
      json(res, { ok: false, error: { code: 'INVALID_MULTIPART', message: (err as Error).message } }, 400)
      return resolve(true)
    }

    let targetPath: string | null = null
    let tempPath: string | null = null
    let finalPath: string | null = null
    let bytesWritten = 0
    let aborted = false
    let responded = false

    function send(payload: unknown, status: number) {
      if (responded) return
      responded = true
      json(res, payload, status)
      resolve(true)
    }
    function cleanup() {
      if (tempPath && existsSync(tempPath)) {
        try { unlinkSync(tempPath) } catch { /* ignore */ }
      }
    }

    bb.on('field', (name, value) => {
      if (name === 'path') targetPath = value
    })

    bb.on('file', (_name, fileStream, _info) => {
      if (!targetPath) {
        fileStream.resume()
        send({ ok: false, error: { code: 'PATH_REQUIRED', message: 'path field must precede file' } }, 400)
        return
      }
      const rel = targetPath
      const abs = join(wsRoot, rel)
      if (!abs.startsWith(wsRoot + '/') && abs !== wsRoot) {
        fileStream.resume()
        send({ ok: false, error: { code: 'INVALID_PATH', message: 'Path escapes workspace' } }, 400)
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
        send({ ok: false, error: { code: 'FILE_TOO_LARGE', message: `Upload exceeds ${maxBytes} bytes` } }, 413)
      })
      fileStream.pipe(out)
      out.on('error', () => {
        aborted = true
        cleanup()
        send({ ok: false, error: { code: 'WRITE_FAILED', message: 'Failed writing file' } }, 500)
      })
      out.on('finish', () => {
        if (aborted || responded) return
        if (!tempPath || !finalPath || !targetPath) {
          send({ ok: false, error: { code: 'NO_FILE', message: 'No file part received' } }, 400)
          return
        }
        try {
          renameSync(tempPath, finalPath)
          send({ ok: true, data: { path: relative(wsRoot, finalPath), bytes: bytesWritten } }, 200)
        } catch (err) {
          cleanup()
          send({ ok: false, error: { code: 'WRITE_FAILED', message: (err as Error).message } }, 500)
        }
      })
    })

    bb.on('error', (err) => {
      aborted = true
      cleanup()
      send({ ok: false, error: { code: 'PARSE_FAILED', message: (err as Error).message } }, 400)
    })

    bb.on('close', () => {
      if (aborted || responded) return
      // If no file was received (e.g. no file part in body), report missing file
      if (!tempPath && !finalPath) {
        send({ ok: false, error: { code: 'NO_FILE', message: 'No file part received' } }, 400)
      }
    })

    req.on('aborted', () => {
      aborted = true
      cleanup()
    })

    req.pipe(bb)
  })
}
