import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { ReconciliationSources, type CheckInSnapshot } from '../src/server/reconciliation'
import { loadReconciliationConfig } from '../src/server/reconciliation/config'
import { getConfigRoot } from '../src/server/configRoot'
import { checkInDecisions } from '../src/server/reconciliation/checkInWatchdog'

/** A report is deliberately incapable of delivery: it never constructs a
 * watchdog/store, starts the backend, or contacts the First Mate inbox bridge. */
async function main() {
  const { values } = parseArgs({ options: {
    'config-home': { type: 'string' }, snapshot: { type: 'string' }, at: { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.help) {
    console.log('Usage: npm run --silent check-in:report -- [--config-home DIR | --snapshot FILE] [--at ISO_TIMESTAMP]\nRead-only due/eligibility/recipient report. No request creation, delivery, Notion writes or timers. --snapshot reads a saved source snapshot without accessing live sources.')
    return
  }
  const now = values.at ? Date.parse(values.at) : Date.now()
  if (!Number.isFinite(now)) throw new Error('Invalid clock')
  const snapshot: CheckInSnapshot = values.snapshot ? JSON.parse(await readFile(values.snapshot, 'utf8')) :
    await new ReconciliationSources(loadReconciliationConfig(values['config-home'] ?? getConfigRoot())).checkInSnapshot(true)
  const census = snapshot.checkIns ?? snapshot.intentions
  console.log(JSON.stringify({ generatedAt: new Date(now).toISOString(), delivery: 'report-only',
    source: { scope: census.data?.scope, observedAt: census.observedAt, status: census.status, coverage: census.coverage, hasMore: census.data?.hasMore },
    boardSource: { status: snapshot.intentions.status, coverage: snapshot.intentions.coverage, hasMore: snapshot.intentions.data?.hasMore },
    decisions: checkInDecisions(snapshot, now) }, null, 2))
}
main().catch(() => { console.error('Check-in report unavailable; check arguments and read-only source access. No delivery attempted.'); process.exitCode = 1 })
