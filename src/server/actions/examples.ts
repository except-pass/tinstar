import { createHash } from 'node:crypto'
import { readerRepositories, type ActionCandidate, type Capability } from '../../shared/actions'

export const sourceDigest = (source: string) => createHash('sha256').update(source).digest('hex')
const examples: Array<[string, string, Capability]> = [
  ['deep-review', 'Deep Review', 'review'], ['fix-ci', 'Fix CI', 'ci.propose'], ['explain', 'Explain', 'explain'],
  ['check-conflicts', 'Check Conflicts', 'conflicts'], ['admin-merge', 'Admin Merge', 'merge.admin'],
]
/** The same templates use trusted interpretation by default, or actual source
 * execution only inside the live broker's configured OS isolation. */
export function actionExamples(live = false): ActionCandidate[] {
  return examples.map(([id, name, capability]) => {
    const source = capability === 'merge.admin'
      ? "export default async (target, broker) => broker.propose({kind:'merge.admin', method:'squash', expectedHead:target.head, ruleset:6108448, bypassMode:'pull_request'});\n"
      : `export default async (_target, broker) => broker.propose({kind:'${capability}'});\n`
    return { source, manifest: { id, version: 'v1', name, description: live ? `${name} on selected PRs through isolated Reader/Repair operations. Admin Merge is disabled.` : `Simulated ${name} on selected PRs; actual GitHub writes = 0.`,
      entrypoint: 'implementation.mjs', digest: sourceDigest(source), capabilities: capability === 'ci.propose' ? [capability, 'repair.update', 'repair.rerun'] : [capability],
      repositories: capability === 'merge.admin' || capability === 'ci.propose' ? ['fortresspower/cmsandbox'] : [...readerRepositories],
      branches: ['main'], paths: ['**'], modes: ['direct', 'coordinated'], limits: { targets: 10, timeoutMs: 30_000, outputBytes: 64_000 },
      tests: { command: 'npm run test:unit -- src/server/actions --maxWorkers=1 --minWorkers=1', evidence: live ? 'The shipped actions tests exercise real local bubblewrap isolation and fake-only provider requests. Run them on this build/host before installation; no production GitHub write is test evidence.' : 'Trusted fixture interpreter; no source evaluation. Safety behavior is covered by actions tests shipped with Tin Star. Run them on this build before installation.' },
    } }
  })
}
export function trustedOperation(candidate: ActionCandidate, head: string) {
  const fixture = actionExamples().find(row => row.source === candidate.source && row.manifest.digest === candidate.manifest.digest)
  if (!fixture) return null
  const kind = fixture.manifest.capabilities[0]!
  return kind === 'merge.admin' ? { kind, method: 'squash', expectedHead: head, ruleset: 6108448, bypassMode: 'pull_request' } : { kind }
}
