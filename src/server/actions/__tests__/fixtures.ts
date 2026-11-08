import { randomUUID } from 'node:crypto'
import type { ActionSnapshot, CheckPolicy, InstalledAction, ActionOperation } from '../../../shared/actions'
import { actionExamples } from '../examples'
export const head = 'a'.repeat(40), baseHead = 'b'.repeat(40)
export const check = { id: 1, name: 'test / test', appId: 15368, appSlug: 'github-actions', head, status: 'completed', conclusion: 'success', url: 'https://github.com/fortresspower/cmsandbox/actions/runs/1/job/1', startedAt: '2026-11-08T00:00:00Z', completedAt: '2026-11-08T00:01:00Z' }
export function snapshot(number = 1): ActionSnapshot {
  return { id: `fortresspower/cmsandbox#${number}`, url: `https://github.com/fortresspower/cmsandbox/pull/${number}`, number, repository: 'fortresspower/cmsandbox',
    head, base: 'main', baseHead, headRef: `feature-${number}`, headRepository: 'fortresspower/cmsandbox', state: 'open', draft: false, protectedHead: false, pendingMerge: false, threadsResolved: true, rulesVerified: true,
    changedPaths: ['components/web-fmp/src/example.ts'], pathsComplete: true, observedAt: new Date().toISOString(), checks: [{ ...check }], checksComplete: true }
}
export const policy: CheckPolicy = { version: 'fixture-v1', repository: 'fortresspower/cmsandbox', observedAt: '2026-11-08T00:00:00Z', provenance: ['Synthetic full coverage for behavior tests only'],
  common: [{ name: check.name, appId: check.appId, appSlug: check.appSlug }], workloads: [{ id: 'fixture', prefixes: ['components/'], excludedPrefixes: [], complete: true, checks: [], evidence: ['Synthetic path coverage, not live policy'] }], unknownReason: 'Unknown path' }
export function installed(id = 'admin-merge'): InstalledAction {
  const example = actionExamples().find(row => row.manifest.id === id)!
  return { ...example, predecessor: null, installedAt: new Date().toISOString(), grant: { actor: 'owner', at: new Date().toISOString(), version: example.manifest.version, digest: example.manifest.digest,
    capabilities: [...example.manifest.capabilities], repositories: [...example.manifest.repositories], branches: [...example.manifest.branches], paths: [...example.manifest.paths] } }
}
export const merge: ActionOperation = { kind: 'merge.admin', method: 'squash', expectedHead: head, ruleset: 6108448, bypassMode: 'pull_request' }
export const invocation = { actor: 'owner', explicit: true, origin: 'user' as const }
export const run = (action: InstalledAction, targets = [snapshot()]) => ({ key: randomUUID(), actor: 'owner', installed: action, targets, mode: 'direct' as const, view: { scene: 'pulls' as const } })
