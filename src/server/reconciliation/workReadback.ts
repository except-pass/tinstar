import { redactSourceText } from '../../shared/searchDocuments'
import { isDecisionRetraction } from '../../shared/workflowRequests'
import { workflowMarkers } from '../../shared/workflowMarkers'

function redactText(text: string): string {
  if (!isDecisionRetraction(text)) return redactSourceText(text)
  const lines = text.trimEnd().split('\n')
  const index = lines.length - (lines.at(-1)?.startsWith(`${workflowMarkers.operation} `) ? 2 : 1)
  const prefix = `${workflowMarkers.withdrawal} `
  const footer = lines[index]
  if (!footer?.startsWith(prefix)) return redactSourceText(text)
  try {
    const safeFooter = prefix + JSON.stringify(JSON.parse(footer.slice(prefix.length)), (_key, value) =>
      typeof value === 'string' ? redactSourceText(value) : value)
    return [redactSourceText(lines.slice(0, index).join('\n')), safeFooter, ...lines.slice(index + 1).map(redactSourceText)].join('\n')
  } catch { return redactSourceText(text) }
}
/** Apply the existing prose redaction at the conversational readback boundary.
 * Source state used for validation/persistence stays exact and authoritative. */
export function workReadback<T>(value: T): T {
  if (typeof value === 'string') return redactText(value) as T
  if (Array.isArray(value)) return value.map(item => workReadback(item)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, workReadback(item)])) as T
  return value
}
