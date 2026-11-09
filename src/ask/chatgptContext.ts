import type { SceneCard } from '../server/reconciliation/scene'
import type { FloorScene } from '../shared/reconciliationPresentation'
import type { PullDetail, PullSummary } from '../shared/pulls'
import { declaredPulls, releasePull } from '../shared/releases'
import { cardStatus, cardTitle } from '../reconciliation/overviewModel'
import { propertyText, workBreadcrumb } from '../reconciliation/recordFields'

export type ChatGPTTarget =
  | { kind: 'work'; card: SceneCard; scene: FloorScene; readFailed?: boolean }
  | { kind: 'pull'; pull: PullSummary; detail?: PullDetail; associationsComplete: boolean; readFailed?: boolean; now: number }

export const MAX_CHATGPT_PROMPT = 1800
export const MAX_CHATGPT_URL = 6000
// Undocumented best effort; do not add an auto-submit parameter. The visible copy
// fallback is the supported recovery when ChatGPT drops URL prefill (see feature docs).
const prefix = 'https://chatgpt.com/?prompt='
const pageId = (value: string) => /^[a-f0-9]{32}$/.test(value) ? value : null

/** Only short metadata enters a URL. Never serialize source records, bodies, logs or errors.
 * Redact recognizable credentials/contact data before truncation, including embedded URLs
 * which can carry credentials in their query. This is not a general sensitive-data classifier.
 */
function summary(value: string, limit = 160) {
  const redacted = value
    .replace(/https?:\/\/\S+/gi, '[link omitted]')
    .replace(/-----BEGIN[\s\S]*?(?:-----END[^\n]*|$)/g, '[redacted]')
    .replace(/\b(?:Bearer\s+\S+|(?:sk-|gh[pousr]_|github_pat_|ntn_|secret_)[\w-]+)\b/gi, '[redacted]')
    .replace(/\b(?:token|password|secret|api[_ -]?key)\s*[:=]\s*\S+/gi, '[redacted]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[contact omitted]')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim()
  return Array.from(redacted).slice(0, limit).map(char => char.length === 1 && /[\ud800-\udfff]/.test(char) ? '\ufffd' : char).join('') || 'Unknown'
}
const timestamp = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : 'Unknown'

function tinStarLink(base: string, search: Record<string, string>) {
  try {
    const url = new URL(base)
    if (!['https:', 'http:'].includes(url.protocol)) return null
    // Keep the app path, never copy credentials, selection queries, tokens or fragments.
    url.username = ''; url.password = ''; url.search = ''; url.hash = ''
    for (const [key, value] of Object.entries(search)) url.searchParams.set(key, value)
    return url.href
  } catch { return null }
}

/** Pure, deterministic launch package; no API calls, dispatches or source mutations. */
export function openInChatGPT(target: ChatGPTTarget, intent: 'discuss' = 'discuss', base = window.location.href) {
  const lines = [`Let's ${intent} this ${target.kind === 'work' ? 'work item' : 'pull request'}.`]
  const add = (label: string, value: string | null) => { if (value) lines.push(`${label}: ${value}`) }
  if (target.kind === 'work') {
    const { card, scene } = target, id = pageId(card.id)
    add('Work ID', id ?? 'Unknown (invalid source identifier)')
    if (id) {
      add('Notion', `https://www.notion.so/${id}`)
      add('Tin Star', tinStarLink(base, { card: id }))
    }
    add('Title', summary(cardTitle(card)))
    add('Status (observed)', summary(cardStatus(card), 60))
    add('Initiative / epic', summary(workBreadcrumb(scene, card)))
    add('Owner', summary(propertyText(card, 'Owner'), 80))
    const observation = scene.coverage.intentions
    add('Notion read', `${target.readFailed || scene.searchReadFailed ? 'last known / read failed' : observation.status} / ${observation.coverage}; observed ${timestamp(observation.observedAt)}; expires ${timestamp(observation.expiresAt)}`)
    add('Card last edited', timestamp(card.source.last_edited_time))
    const pulls = declaredPulls(card).slice(0, 2)
    for (const pull of pulls) add('Declared PR', pull.url)
  } else {
    const { pull, detail, now } = target
    const identity = releasePull(pull.url)
    const canonical = identity && identity.id === pull.id.toLowerCase() && identity.repository === pull.repository.toLowerCase() && identity.number === pull.number ? identity : null
    add('PR ID', canonical?.id ?? 'Unknown (inconsistent source identifier)')
    if (canonical) {
      add('GitHub', canonical.url)
      add('Tin Star', tinStarLink(base, { view: 'pulls', origin: JSON.stringify({ section: 'pulls', target: { kind: 'pull', id: canonical.id } }) }))
    }
    add('Title', summary(pull.title))
    add('PR read', `${target.readFailed ? 'last known / read failed' : pull.freshness}; observed ${timestamp(pull.observedAt)}`)
    add('PR last updated', timestamp(pull.updatedAt))
    add('Head', /^[a-f0-9]{40,64}$/.test(pull.head) ? pull.head : 'Unknown')
    // Ignore details from an earlier head, just as PR Operations does.
    const current = detail?.head === pull.head ? detail : undefined
    const stale = target.readFailed || current?.freshness === 'stale' || !!current && (!Number.isFinite(Date.parse(current.observedAt)) || now - Date.parse(current.observedAt) >= 120_000)
    add('CI', current ? `${current.checks}${stale ? ' (last known / stale)' : ' (observed)'}; observed ${timestamp(current.observedAt)}` : 'Unknown (not read for this head)')
    add('Work associations', target.associationsComplete && !target.readFailed ? 'Complete in observed operational scope' : 'Partial / last known; absence is unknown')
    const links = pull.links.filter(link => link.active && pageId(link.cardId))
    for (const link of links.slice(0, 2)) add('Linked work (source association)', `${link.cardId} https://www.notion.so/${link.cardId}`)
    if (links.length > 2) add('Other linked work', `${links.length - 2} omitted; inspect Tin Star`)
  }
  lines.push('This is an observed snapshot, not live state. If Tin Star MCP is connected, ask it for current context; otherwise ask me for missing details.')
  // Bound both visible text and encoded URL: unicode can expand significantly on encoding.
  let prompt = lines.shift()!
  for (const line of lines) {
    const next = `${prompt}\n${line}`
    if (next.length <= MAX_CHATGPT_PROMPT && prefix.length + encodeURIComponent(next).length <= MAX_CHATGPT_URL) prompt = next
  }
  return { prompt, url: `${prefix}${encodeURIComponent(prompt)}` }
}
