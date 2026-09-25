import type { IncomingMessage, ServerResponse } from 'node:http'
import { fail, ok } from '../../api/envelope'
import {
  executeQuotaAxi,
  interpretQuotaAxi,
  type AxiSnapshot,
  type QuotaAxiExecution,
} from './axi'
import {
  CODEX_QUOTA_UNSUPPORTED_REASON,
  GROK_QUOTA_UNSUPPORTED_REASON,
} from './reasons'

export const QUOTA_ROUTE_PATH = '/api/v6/quota'
export const QUOTA_SCHEMA = 'tinstar.v6.quota/1'

export interface QuotaRouteOptions {
  /**
   * Test seam. Production leaves this unset and runs the fixed argv
   * `quota-axi --json`. The HTTP request cannot replace it.
   */
  runQuotaAxi?: () => Promise<QuotaAxiExecution>
  /** Label the response as fixture data. ORed with `fixture: true` on the snapshot. */
  fixture?: boolean
}

export type QuotaRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean>

export interface QuotaWire {
  schema: typeof QUOTA_SCHEMA
  fixture: boolean
  codex: { state: 'unsupported'; reason: string }
  grok: { state: 'unsupported'; reason: string }
  axi: AxiSnapshot
}

/**
 * Quota routes. The only command this module can run is `quota-axi --json`.
 * Returns a listener. Tests mount it on a throwaway server. ts-account's
 * wire.ts is the production caller.
 */
export function registerQuotaRoutes(options: QuotaRouteOptions = {}): QuotaRequestHandler {
  const run = options.runQuotaAxi ?? executeQuotaAxi
  return async (req, res) => {
    if (pathnameOf(req.url) !== QUOTA_ROUTE_PATH) return false
    if (req.method !== 'GET') {
      fail(res, 'BAD_REQUEST', 'quota route accepts GET only')
      return true
    }
    const axi = await readAxi(run)
    const fixture = options.fixture === true || axi.fixture === true
    const body: QuotaWire = {
      schema: QUOTA_SCHEMA,
      fixture,
      codex: { state: 'unsupported', reason: CODEX_QUOTA_UNSUPPORTED_REASON },
      grok: { state: 'unsupported', reason: GROK_QUOTA_UNSUPPORTED_REASON },
      axi: { ...axi, fixture },
    }
    ok(res, body)
    return true
  }
}

async function readAxi(run: () => Promise<QuotaAxiExecution>): Promise<AxiSnapshot> {
  try {
    return interpretQuotaAxi(await run())
  } catch (error) {
    const missing = isEnoent(error)
    return {
      state: 'unavailable',
      reason: missing ? 'missing' : 'exit',
      fixture: false,
    }
  }
}

function isEnoent(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT'
}

function pathnameOf(url: string | undefined): string {
  if (!url) return ''
  const query = url.indexOf('?')
  return query === -1 ? url : url.slice(0, query)
}
