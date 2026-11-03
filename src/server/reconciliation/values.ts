export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
export const text = (value: unknown): string | null => typeof value === 'string' ? value : null
