import { redactSourceText } from '../../shared/searchDocuments'
import { isDecisionRetraction } from '../../shared/workflowRequests'
import { workflowMarkers } from '../../shared/workflowMarkers'

function redactText(text: string, redact: (text: string) => string): string {
  if (!isDecisionRetraction(text)) return redact(text)
  const lines = text.trimEnd().split('\n')
  const index = lines.length - (lines.at(-1)?.startsWith(`${workflowMarkers.operation} `) ? 2 : 1)
  const prefix = `${workflowMarkers.withdrawal} `
  const footer = lines[index]
  if (!footer?.startsWith(prefix)) return redact(text)
  try {
    const safeFooter = prefix + JSON.stringify(JSON.parse(footer.slice(prefix.length)), (_key, value) =>
      typeof value === 'string' ? redact(value) : value)
    return [redact(lines.slice(0, index).join('\n')), safeFooter, ...lines.slice(index + 1).map(redact)].join('\n')
  } catch { return redact(text) }
}
function redactReadback<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redactText(value, redact) as T
  if (Array.isArray(value)) return value.map(item => redactReadback(item, redact)) as T
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactReadback(item, redact)])) as T
  return value
}
/** Apply the existing prose redaction at the conversational readback boundary.
 * Source state used for validation/persistence stays exact and authoritative. */
export function workReadback<T>(value: T): T {
  return redactReadback(value, redactSourceText)
}
const credentialKey = String.raw`(?:[a-z][a-z0-9_-]{0,48}[_-])?(?:password|passwd|token|api[_ -]?key|secret|authorization)`
const nextCredential = (quote: string) => String.raw`(?:\{?${quote}${credentialKey}${quote}[ \t]*[:=]|\b["']?${credentialKey}["']?[ \t]*[:=][ \t]*${quote}(?![ \t]*(?:[\r\n]|$))(?:(?:\\[^\r\n]|[^${quote}\\\r\n])*${quote}|(?:\\[\s\S]|[^${quote}\\])*${quote}(?=[ \t]*(?:[\r\n,;})>\]]|$))))`
const quotedValue = (quote: string) => String.raw`${quote}(?:(?:\\[\s\S]|(?!${nextCredential(quote)})[^${quote}\\])*${quote}|(?:(?!${nextCredential(quote)})[^\r\n])*)`
const quotedCredential = String.raw`${quotedValue('"')}|${quotedValue("'")}`
const credentialAssignment = new RegExp(String.raw`((?:(["'])${credentialKey}\2|\b${credentialKey})\s*[:=]\s*)(?:${quotedCredential}|(?!\[credential omitted\])((?:(?![,;][ \t]*(?:[a-z_][\w-]*[ \t]*=|(?:"${credentialKey}"|'${credentialKey}'|${credentialKey})[ \t]*[:=]))[^\s"'])+))`, 'gi')

function redactJiraText(input: string): string {
  return input
    .replace(/\b(?:ATATT|ATCTT|secret_|ntn_|sk-|github_pat_|gh[pousr]_)[A-Za-z0-9_.~-]{16,}\b/g, '[credential omitted]')
    .replace(/((?:\bauthorization|"authorization"|'authorization')[ \t]*[:=][ \t]*(?:\r?\n[ \t]+)?)(?:basic|bearer)(?:[ \t]*\r?\n[ \t]+|[ \t]+)[a-z0-9._~+\/=-]+/gi, '$1[credential omitted]')
    .replace(/\bbearer\s+[A-Za-z0-9._~+\/=-]{12,}/gi, '[credential omitted]')
    .replace(/\bbasic\s+([a-z0-9+\/=]+)/gi, (match, token) => {
      try {
        const decoded = atob(token)
        const encoded = btoa(decoded)
        if ((token === encoded || token === encoded.replace(/=+$/, '')) &&
          decoded.includes(':') && !/[\x00-\x1f\x7f]/.test(decoded)) return '[credential omitted]'
      } catch {
        return match
      }
      return match
    })
    .replace(credentialAssignment, (_match, prefix, keyQuote, bareValue, offset, source) => {
      let suffix = ''
      if (bareValue) {
        if (/^(?:password|passwd|token|secret|api key)[ \t]*:[ \t]+$/i.test(prefix) &&
          /^[a-z]{1,5}$/i.test(bareValue) && /^[ \t]+[a-z]/i.test(source.slice(offset + _match.length))) return _match
        const closer = { '(': ')', '[': ']', '{': '}', '<': '>' }[source[offset - 1] as '(' | '[' | '{' | '<']
        const jsonObject = keyQuote === '"' && source.lastIndexOf('{', offset - 1) >
          Math.max(source.lastIndexOf('}', offset - 1), source.lastIndexOf('\n', offset - 1))
        const delimiter = closer ?? (jsonObject ? '}' : '')
        if (delimiter && bareValue.endsWith(delimiter)) suffix = delimiter
        else if (jsonObject && bareValue.endsWith(',')) suffix = ','
      }
      return keyQuote ? `${prefix}"[credential omitted]"${suffix}` : `${prefix}[credential omitted]${suffix}`
    })
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[credential omitted]@')

}

export function jiraWorkReadback<T>(value: T): T {
  return redactReadback(value, redactJiraText)
}
