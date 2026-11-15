/** P1 measurement of existing lease locking, not a new lease implementation.
 * Run: node --import tsx scripts/decision-desk-contention.ts /absolute/proof-dir
 * Only disposable local SQLite and simulated source I/O; no source APIs. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { CardLeases, withLeaseCaller } from '../src/server/reconciliation/cardLeases'

if (!process.argv[2]) throw new Error('Provide a task proof output directory')
const output = resolve(process.argv[2]); await mkdir(output, { recursive: true })
const root = await mkdtemp(join(output, 'lease-contention-'))
const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const summary = []
try {
  for (const delay of [25, 1000]) {
    const claims: number[] = [], writes: number[] = []
    for (let round = 0; round < 6; round++) {
      const services = Array.from({ length: 6 }, () => new CardLeases(root))
      const cards = Array.from({ length: 6 }, (_, i) => (delay * 1000 + round * 10 + i).toString(16).padStart(32, '0'))
      const writer = await services[0]!.claim([cards[0]!], 'fixture-writer', 'Fixture writer', `writer-${delay}-${round}`)
      if (!('lease_token' in writer) || !writer.lease_token) throw new Error('Writer claim missing')
      let started!: () => void
      const writing = new Promise<void>(resolve => { started = resolve })
      const change = withLeaseCaller('fixture-writer', writer.lease_token, () => services[0]!.mutate(cards[0]!, async () => {
        const start = performance.now(); started()
        await new Promise(resolve => setTimeout(resolve, delay))
        writes.push(performance.now() - start)
      }))
      await writing
      const results = await Promise.all(services.slice(1).map(async (service, i) => {
        const start = performance.now()
        const result = await service.claim(cards.slice(1), 'fixture-reviewer', 'Fixture reviewer', `review-${delay}-${round}-${i}`)
        claims.push(performance.now() - start)
        return 'lease' in result ? result.lease?.card_id : null
      }))
      await change
      if (results.some(result => !result) || new Set(results).size !== 5) throw new Error('Contending claims were not distinct')
    }
    const percentile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!
    summary.push({ simulated_source_delay_ms: delay, independent_instances: 6, rounds: 6, claim_samples: claims.length, write_samples: writes.length,
      claim_ms: { p50: percentile(claims, .5), p95: percentile(claims, .95), max: Math.max(...claims) }, source_write_ms: { p50: percentile(writes, .5), p95: percentile(writes, .95) }, raw_claim_ms: claims })
  }
  const result = { head, measured_at: new Date().toISOString(), scope: 'Existing generic lease locking, one simulated source write plus five independent service instances; excludes HTTP and render. No live sources or preparation.', summary }
  await writeFile(join(output, 'p1-contention.json'), JSON.stringify(result, null, 2) + '\n')
  process.stdout.write(JSON.stringify(result, null, 2) + '\n')
} finally { await rm(root, { recursive: true, force: true }) }
