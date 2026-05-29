import { useCallback, useRef } from 'react'

export interface UploadHandle {
  promise: Promise<void>
  abort: () => void
}

export interface UploadOptions {
  sessionId: string
  file: File
  path: string
  onProgress: (fraction: number) => void
}

/**
 * Single-file XHR upload with progress + abort.
 * Returns a handle whose `promise` resolves on 2xx and rejects with
 * `{ code, message }` for any other outcome (HTTP error or abort).
 */
export function useFileUpload() {
  const inFlight = useRef<Set<XMLHttpRequest>>(new Set())

  const start = useCallback((opts: UploadOptions): UploadHandle => {
    const xhr = new XMLHttpRequest()
    inFlight.current.add(xhr)
    const form = new FormData()
    form.append('path', opts.path)
    form.append('file', opts.file, opts.file.name)

    const promise = new Promise<void>((resolve, reject) => {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) opts.onProgress(e.loaded / e.total)
      })
      xhr.addEventListener('load', () => {
        inFlight.current.delete(xhr)
        if (xhr.status >= 200 && xhr.status < 300) return resolve()
        try {
          const body = JSON.parse(xhr.responseText)
          reject(body?.error ?? { code: 'HTTP_ERROR', message: `HTTP ${xhr.status}` })
        } catch {
          reject({ code: 'HTTP_ERROR', message: `HTTP ${xhr.status}` })
        }
      })
      xhr.addEventListener('error', () => {
        inFlight.current.delete(xhr)
        reject({ code: 'NETWORK', message: 'Network error' })
      })
      xhr.addEventListener('abort', () => {
        inFlight.current.delete(xhr)
        reject({ code: 'ABORTED', message: 'Upload aborted' })
      })
      xhr.open('POST', `/api/sessions/${encodeURIComponent(opts.sessionId)}/files/upload`)
      xhr.send(form)
    })

    return { promise, abort: () => xhr.abort() }
  }, [])

  return { start }
}
