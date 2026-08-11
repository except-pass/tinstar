// bin/codexSupport.js — codex CLI version floor and delivery-ledger symptoms
// consumed by `tinstar doctor`.

/**
 * First codex-cli version whose rollout schema the delivery-confirmation
 * scanner reads (response_item role:user / item_completed UserMessage).
 * Older CLIs write `event_msg`/`user_message` records the server no longer
 * parses — deliveries to them fail terminally instead of confirming
 * (src/server/sessions/codex-transcript.ts). Bump this when the scanner's
 * supported schema moves.
 */
export const MIN_SUPPORTED_CODEX_VERSION = '0.147.0'

/** Extract "0.147.0" from `codex --version` output ("codex-cli 0.147.0"). */
export function parseCodexVersion(output) {
  if (typeof output !== 'string') return null
  const match = /\b(\d+\.\d+(?:\.\d+)?)\b/.exec(output)
  return match ? match[1] : null
}

/** Numeric dotted-segment comparison; missing segments count as zero. */
export function compareVersions(a, b) {
  const left = String(a).split('.').map(Number)
  const right = String(b).split('.').map(Number)
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i] ?? 0
    const r = right[i] ?? 0
    if (l !== r) return l < r ? -1 : 1
  }
  return 0
}

// Produced by src/server/messaging/delivery-dispatch.ts when a delivery's
// provider-accepted attempts exhaust confirmation. Keep in sync with the
// template there.
const CONFIRMATION_EXHAUSTED_PREFIX = 'Provider delivery could not be confirmed after'

/**
 * Ledger deliveries whose terminal failure means "the terminal accepted every
 * injection but the transcript never yielded evidence". Genuine non-delivery
 * fails differently (recipient replaced/stopped, submission errors), so this
 * signature is the fingerprint of a receipt-format change — the symptom to
 * surface when a future codex release breaks rollout parsing again.
 */
export function unconfirmedAcceptedFailures(deliveries) {
  if (!Array.isArray(deliveries)) return []
  return deliveries.filter(delivery => {
    if (!delivery || typeof delivery !== 'object') return false
    if (delivery.state !== 'failed' || !Array.isArray(delivery.history)) return false
    const last = delivery.history[delivery.history.length - 1]
    return !!last
      && last.retryable === false
      && typeof last.reason === 'string'
      && last.reason.startsWith(CONFIRMATION_EXHAUSTED_PREFIX)
  })
}
