import { createHash } from 'node:crypto'
import { readerRepositories, type ActionCandidate, type Capability } from '../../shared/actions'

export const sourceDigest = (source: string) => createHash('sha256').update(source).digest('hex')
const examples: Array<[string, string, Capability]> = [
  ['deep-review', 'Deep Review', 'review'], ['fix-ci', 'Fix CI', 'ci.propose'], ['explain', 'Explain', 'explain'],
  ['check-conflicts', 'Check Conflicts', 'conflicts'], ['admin-merge', 'Admin Merge', 'merge.admin'],
]
/** These checked-in templates are trusted simulation fixtures, not downloaded code.
 * Custom executable source is stored for inspection only until approved OS isolation exists. */
export function actionExamples(): ActionCandidate[] {
  return examples.map(([id, name, capability]) => {
    const source = capability === 'merge.admin'
      ? "export default async (target, broker) => broker.propose({kind:'merge.admin', method:'squash', expectedHead:target.head, ruleset:6108448, bypassMode:'pull_request'});\n"
      : `export default async (_target, broker) => broker.propose({kind:'${capability}'});\n`
    return { source, manifest: { id, version: 'v1', name, description: `Simulated ${name} on selected PRs; actual GitHub writes = 0.`,
      entrypoint: 'implementation.mjs', digest: sourceDigest(source), capabilities: capability === 'ci.propose' ? [capability, 'repair.update', 'repair.rerun'] : [capability],
      repositories: capability === 'merge.admin' || capability === 'ci.propose' ? ['fortresspower/cmsandbox'] : [...readerRepositories],
      branches: ['main'], paths: ['**'], modes: ['direct', 'coordinated'], limits: { targets: 10, timeoutMs: 30_000, outputBytes: 64_000 },
      tests: { command: 'npm run test:unit -- src/server/actions', evidence: 'Trusted fixture interpreter; no source evaluation. Safety behavior is covered by actions tests shipped with Tin Star. Run them on this build before installation.' },
    } }
  })
}
export function trustedOperation(candidate: ActionCandidate, head: string) {
  const fixture = actionExamples().find(row => row.source === candidate.source && row.manifest.digest === candidate.manifest.digest)
  if (!fixture) return null
  const kind = fixture.manifest.capabilities[0]!
  return kind === 'merge.admin' ? { kind, method: 'squash', expectedHead: head, ruleset: 6108448, bypassMode: 'pull_request' } : { kind }
}
