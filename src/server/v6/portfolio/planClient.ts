import { mergePlanTasks, planPageHref, PLAN_SLUG } from '../../../v6/portfolio/plan'
import type { PlanView } from '../../../v6/portfolio/types'

export interface FetchPlanOptions {
  baseUrl: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

function unavailable(slug: string, href: string | null, detail = 'Stretch Plan unavailable'): PlanView {
  return { available: false, fixture: false, slug, href, tasks: [], detail }
}

/** Read-only GET. Never POST, and never writes start, end, or progress. */
export async function fetchStretchPlan(slug: string, opts: FetchPlanOptions): Promise<PlanView> {
  if (!PLAN_SLUG.test(slug)) return unavailable(slug, null, 'Invalid plan slug')
  const href = planPageHref(opts.baseUrl, slug)
  let url: URL
  try {
    url = new URL(`/plans/${slug}`, opts.baseUrl)
  } catch {
    return unavailable(slug, href)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return unavailable(slug, null)
  try {
    const response = await (opts.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
    })
    if (!response.ok) return unavailable(slug, href)
    const body = await response.json() as unknown
    const merged = mergePlanTasks(body)
    if (!merged.ok) return unavailable(slug, href, merged.diagnostic)
    return {
      available: true,
      fixture: merged.value.fixture,
      slug,
      href,
      tasks: merged.value.tasks,
      detail: '',
    }
  } catch {
    return unavailable(slug, href)
  }
}
