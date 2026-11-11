import { readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

/** Review delivery accepts either configured fleet, without changing which
 * homes the legacy cockpit observes.
 * @param {{ firstmate?: { homes?: unknown }, reconciliation?: { fleet?: unknown } }} config
 * @returns {Array<{home: string, label?: string}>}
 */
export function configuredReviewHomes(config) {
  const legacy = Array.isArray(config.firstmate?.homes) ? config.firstmate.homes : []
  const fleet = Array.isArray(config.reconciliation?.fleet) ? config.reconciliation.fleet : []
  return [
    ...legacy.filter(home => typeof home === 'string' && isAbsolute(home)).map(home => ({ home })),
    ...fleet.filter(row => row && typeof row.home === 'string' && isAbsolute(row.home))
      .map(row => ({ home: row.home, ...(typeof row.label === 'string' ? { label: row.label } : {}) })),
  ]
}

/** @param {string} root */
export function loadReviewHomes(root) {
  try { return configuredReviewHomes(JSON.parse(readFileSync(join(root, 'config.json'), 'utf8'))) }
  catch { return [] }
}

/** Persist paths, never labels. Refuse ambiguous labels rather than choosing
 * another home's inbox; an exact configured absolute path disambiguates.
 * @param {Array<{home: string, label?: string}>} homes
 * @param {string | undefined} selector
 * @returns {string | null}
 */
export function resolveReviewHome(homes, selector) {
  const matches = new Set(homes.filter(row => selector === undefined ||
    (isAbsolute(selector) ? row.home === selector : row.label === selector)).map(row => row.home))
  return matches.size === 1 ? [...matches][0] : null
}
