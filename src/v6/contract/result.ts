/** Fail-closed parse result. Unknown required enums become a diagnostic, never a coerced value. */
export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; diagnostic: string }

export function parsed<T>(value: T): ParseResult<T> {
  return { ok: true, value }
}

export function rejected<T>(diagnostic: string): ParseResult<T> {
  return { ok: false, diagnostic }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function requiredString(raw: unknown, field: string): ParseResult<string> {
  if (typeof raw !== 'string' || raw.length === 0) {
    return rejected(`${field} must be a non-empty string`)
  }
  return parsed(raw)
}

export function optionalString(raw: unknown, field: string): ParseResult<string | undefined> {
  if (raw === undefined) return parsed(undefined)
  if (typeof raw !== 'string') return rejected(`${field} must be a string when present`)
  return parsed(raw)
}
