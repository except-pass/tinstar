/** Legacy First Mate envelopes contain UTF-8 prose. Keep identity/protocols
 * unchanged while sharing decoding between readiness and presentation. */
export function requestText(value: string): string | null {
  if (!value.startsWith('fm-hold-v1:')) return value
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.slice(11)), char => char.charCodeAt(0)))
  } catch { return null }
}

export function decodeRequestText(value: string): string {
  return requestText(value) ?? 'Request details unavailable'
}

/** Coordination bundles have no single answer target. Retain them as context,
 * never offer an omnibus hold as one owner decision. */
export function isCoordinationRequest(value: string): boolean {
  return /^owner calls via\b/i.test(decodeRequestText(value).trim())
}

export function displayRequestText(value: string, fallback = 'First Mate request'): string {
  const decoded = requestText(value)?.split('\n').filter(line => !/^\s*Tin Star (?:request|answer|decision|operation):/.test(line)).join('\n').trim()
  if (!decoded || /fm-hold-v\d:|ask-user\s+findings=|(?:^|\s)\/(?:home|Users|tmp|srv)\/|^\s*(?:\{\s*"|\[\s*(?:\{|"))/.test(decoded)) return fallback
  return decoded.replace(/^(?:working|needs-decision|blocked|paused|done|failed|resolved)\s+(?:\[(?:at|key)=[^\]]+\]\s*)+:?\s*/i, '').replace(/\s*\(card [a-f0-9]{32}\)\.?/gi, '').trim()
}
