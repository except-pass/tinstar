import type { Finding } from '../server/reconciliation/scene'

/** Missing observations and advisory links do not establish a work exception. */
export const isException = (finding: Finding) => !finding.sourceHealth &&
  !['confirmed-link', 'legitimate-wait-planned', 'outside-coverage', 'unknown-stale-source'].includes(finding.kind)
