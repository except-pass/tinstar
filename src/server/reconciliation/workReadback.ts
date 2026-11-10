import { redactSourceText } from '../../shared/searchDocuments'
/** Apply the existing prose redaction at the conversational readback boundary.
 * Source state used for validation/persistence stays exact and authoritative. */
export function workReadback<T>(value: T): T {
  if (typeof value === 'string') return redactSourceText(value) as T
  if (Array.isArray(value)) return value.map(item => workReadback(item)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, workReadback(item)])) as T
  return value
}
