/**
 * UUID v4 generator using crypto.getRandomValues(), which works in both
 * secure (HTTPS/localhost) and non-secure (plain HTTP) browser contexts.
 *
 * crypto.randomUUID() is secure-context-only and throws on plain HTTP
 * origins like http://infrapoc:PORT/, breaking all ID generation.
 */
export function randomUUID(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40  // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80  // RFC 4122 variant
  const h = Array.from(bytes, b => b.toString(16).padStart(2, '0'))
  return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10).join('')}`
}
