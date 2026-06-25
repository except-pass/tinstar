import type { ServerResponse } from 'node:http'
import { existsSync, unlinkSync } from 'node:fs'
import { ok, fail } from './envelope'

export interface UploadResponder {
  sendOk(data: unknown): void
  sendFail(code: Parameters<typeof fail>[1], message: string, opts?: Parameters<typeof fail>[3]): void
  cleanup(): void
  readonly responded: boolean
}

export function createUploadResponder(
  res: ServerResponse,
  resolve: (v: boolean) => void,
  getTempPath: () => string | null,
): UploadResponder {
  let responded = false

  return {
    get responded() { return responded },

    sendOk(data: unknown) {
      if (responded) return
      responded = true
      ok(res, data)
      resolve(true)
    },

    sendFail(code, message, opts = {}) {
      if (responded) return
      responded = true
      fail(res, code, message, opts)
      resolve(true)
    },

    cleanup() {
      const p = getTempPath()
      if (p && existsSync(p)) {
        try { unlinkSync(p) } catch { /* ignore */ }
      }
    },
  }
}
