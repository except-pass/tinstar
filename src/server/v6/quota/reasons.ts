/**
 * Codex declares provider-quota unsupported in
 * src/server/providers/codex-delivery.ts. The sentence is that capability's
 * reason. This module does not read Codex rollout files.
 */
export const CODEX_QUOTA_UNSUPPORTED_REASON = 'Not implemented by this delivery slice'

/**
 * GROK_PROVIDER in src/server/providers/lifecycle.ts has no observe block and
 * no provider-quota capability. Its OTLP sentence is a different capability
 * and is not reused as a quota reason.
 */
export const GROK_QUOTA_UNSUPPORTED_REASON = 'Grok Build has no quota observer'
