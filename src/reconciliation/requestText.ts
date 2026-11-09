/** First Mate hold envelopes carry UTF-8 prose, not a user-facing identifier. */
export function decodeRequestText(value: string): string {
  if (!value.startsWith('fm-hold-v1:')) return value
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(value.slice('fm-hold-v1:'.length)), char => char.charCodeAt(0))) }
  catch { return 'Open the source request to read this decision.' }
}
