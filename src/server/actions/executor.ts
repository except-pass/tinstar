import { join } from 'node:path'
import { type ActionSnapshot, type ActionReceipt, type InstalledAction, type CheckPolicy, type ActionOperation } from '../../shared/actions'
import type { AskView } from '../../shared/ask'
import { tryAcquireLock, acquireLock } from '../infra/lock'
import { ActionStore } from './store'
import { coordinateTargets } from './coordination'
import { simulateRunner } from './runner'
import { type BrokerInvocation, profileFor, SimulatedWriteAdapter, validateOperation } from './broker'

export interface RunInput { repair?: Extract<ActionOperation, { kind: 'repair.update' | 'repair.rerun' }>; key: string; actor: string; installed: InstalledAction; targets: ActionSnapshot[]; mode: 'direct' | 'coordinated'; view: AskView }
/** Shared by both surfaces. All effects serialize; unknown dependencies never fan out.
 * No receipt claims worker/coordinator identity that has not actually been observed. */
export class ActionExecutor {
  private active = new Map<string, { actor: string; controller: AbortController; work: Promise<void> }>()
  constructor(readonly store: ActionStore, private read: (url: string) => Promise<ActionSnapshot>, private policy: CheckPolicy, private readJob?: (repository: string, jobId: number) => Promise<NonNullable<BrokerInvocation['job']>>) {}
  async start(input: RunInput): Promise<string> {
    const { installed, actor, mode, key } = input
    const coordination = mode === 'coordinated' ? coordinateTargets(input.targets) : { targets: input.targets, plan: [] }
    const targets = coordination.targets
    if (!/^[a-f0-9-]{36}$/.test(key) || !actor || !targets.length || targets.length > installed.manifest.limits.targets || targets.length > 10 || new Set(targets.map(row => row.id)).size !== targets.length || !installed.manifest.modes.includes(mode)) throw new Error('Choose unique targets within installed action limits')
    const unlock = await acquireLock(join(this.store.root, 'runs.lock'))
    let receipts: ActionReceipt[]
    try {
      const previous = (await this.store.receipts()).filter(row => row.runId === key)
      if (previous.length) {
        if (previous.length !== targets.length || previous.some(row => row.actor !== actor || row.actionId !== installed.manifest.id || row.version !== installed.manifest.version || row.mode !== mode || row.digest !== installed.manifest.digest || JSON.stringify(row.operation && row.operation.kind.startsWith('repair.') ? row.operation : undefined) !== JSON.stringify(input.repair) || JSON.stringify(row.captured) !== JSON.stringify(this.selection(targets.find(target => target.url === row.captured.url) ?? targets[0]!)))) throw new Error('Idempotency key belongs to another invocation')
        return key
      }
      const plan = coordination.plan.length ? [...coordination.plan] : targets.map(target => `${target.url}: serialized; dependency order unknown, re-read before proposal`)
      const failures = new Map<string, string[]>()
      for (const target of targets) for (const check of target.checks.filter(check => check.conclusion === 'failure')) failures.set(check.name, [...failures.get(check.name) ?? [], target.url])
      for (const [name, urls] of failures) if (urls.length > 1) plan.push(`Shared failure candidate ${name}: ${urls.join(', ')}; per-PR repair remains isolated`)
      receipts = targets.map((target, order) => ({ id: `${key}-${order}`, runId: key, idempotencyKey: key, actor, actionId: installed.manifest.id,
        version: installed.manifest.version, digest: installed.manifest.digest, mode, view: input.view, captured: this.selection(target), live: null,
        declared: [...installed.manifest.capabilities], granted: [...installed.grant.capabilities], attempted: [], exercised: [],
        credentialProfile: profileFor(installed.manifest.capabilities[0]!), coordinator: 'Unknown', worker: 'Unknown', plan, order,
        startedAt: new Date().toISOString(), finishedAt: null, intendedEffect: `Would perform ${installed.manifest.name} on ${target.url}`,
        operation: input.repair ?? null, outcome: 'intent', reasons: [], checkPolicyVersion: null, checkEvidence: [], providerRequest: null,
        actualGitHubWrites: 0, resultingSha: null, verification: 'not-performed', result: 'Intent persisted; simulation pending.' }))
      for (const receipt of receipts) await this.store.append(receipt)
    } finally { await unlock() }
    const controller = new AbortController()
    // Store active state before executing so cancellation and immediate reads see the run.
    const work = Promise.resolve().then(() => this.execute({ ...input, targets }, receipts, controller)).finally(() => this.active.delete(key))
    this.active.set(key, { actor, controller, work })
    // Avoid an unhandled rejection if audit storage fails; persisted intent remains unknown.
    void work.catch(() => {})
    return key
  }
  private selection(target: ActionSnapshot) { return { url: target.url, head: target.head, base: target.base, baseHead: target.baseHead } }
  async wait(runId: string) { await this.active.get(runId)?.work }
  async cancel(runId: string, actor: string) {
    const run = this.active.get(runId)
    if (!run || run.actor !== actor) throw new Error('Active run unavailable for this actor')
    run.controller.abort(new Error('Cancelled by initiating user; unsent operations stopped'))
  }
  private async execute(input: RunInput, receipts: ActionReceipt[], controller: AbortController) {
    const adapter = new SimulatedWriteAdapter()
    for (let index = 0; index < receipts.length; index++) {
      const receipt = receipts[index]!, captured = input.targets[index]!
      let unlock: (() => Promise<void>) | null = null, unlockRepo: (() => Promise<void>) | null = null
      const timeout = setTimeout(() => controller.abort(new Error('Runner time limit exceeded; no automatic retry')), input.installed.manifest.limits.timeoutMs)
      try {
        controller.signal.throwIfAborted()
        unlock = await tryAcquireLock(join(this.store.root, 'locks', `${captured.repository.replace('/', '_')}-${captured.number}.lock`))
        if (!unlock) throw new Error('PR already locked by an action in PRs or Releases')
        // Each item revalidates the original installed version even after rollback.
        const installed = await this.store.inspect(input.installed.manifest.id, input.installed.manifest.version)
        const fixtureOperation = simulateRunner(installed, captured.head, controller.signal)
        if (input.repair && fixtureOperation.kind !== 'ci.propose') throw new Error('Repair extras require the installed Fix CI fixture and explicit user selection')
        const operation = input.repair ?? fixtureOperation
        if (operation.kind.startsWith('repair.') || operation.kind === 'merge.admin') unlockRepo = await acquireLock(join(this.store.root, 'locks', `${captured.repository.replace('/', '_')}.lock`))
        receipt.operation = operation; receipt.attempted = [operation.kind]; receipt.credentialProfile = profileFor(operation.kind)
        const live = await this.read(captured.url)
        controller.signal.throwIfAborted()
        receipt.live = live; receipt.checkEvidence = live.checks
        receipt.checkPolicyVersion = operation.kind === 'merge.admin' ? this.policy.version : null
        const job = operation.kind === 'repair.rerun' ? await this.readJob?.(captured.repository, operation.jobId) : undefined
        const validation = validateOperation(installed, captured, live, operation, { actor: input.actor, explicit: true, origin: 'user', job }, this.policy)
        if (operation.kind === 'repair.rerun' && (await this.store.receipts()).some(row => row.id !== receipt.id && row.captured.url === captured.url && row.captured.head === captured.head && row.operation?.kind === 'repair.rerun' && row.operation.jobId === operation.jobId && row.operation.runId === operation.runId && !!row.providerRequest)) validation.reasons.push('This failed job already consumed its one rerun; no retry loop')
        if (validation.reasons.length) { receipt.outcome = 'skipped'; receipt.reasons = validation.reasons; receipt.result = 'Skipped; broker validation refused the proposal.' }
        else {
          // Intent with exact provider request precedes even a simulated effect.
          Object.assign(receipt, adapter.perform(live, operation), { outcome: 'intent' })
          await this.store.append(receipt)
          controller.signal.throwIfAborted()
          receipt.outcome = 'simulated'
          if (operation.kind === 'ci.propose') receipt.result = this.classify(live)
        }
      } catch (error) {
        receipt.outcome = controller.signal.aborted ? 'cancelled' : 'skipped'
        receipt.reasons.push((error as Error).message)
        receipt.result = receipt.outcome === 'cancelled' ? 'Cancelled before sending any operation; no undo claimed.' : 'Skipped; no operation sent.'
      } finally {
        clearTimeout(timeout)
        receipt.finishedAt = new Date().toISOString()
        try { await this.store.append(receipt) } finally { await unlockRepo?.(); await unlock?.() }
      }
    }
  }
  private classify(live: ActionSnapshot) {
    const failed = live.checks.filter(check => check.conclusion === 'failure')
    const classification = !live.checksComplete ? 'unknown' : failed.some(check => /runner|infrastructure|allocation/i.test(check.name)) ? 'infrastructure/runner' : failed.length ? 'code or flaky tests (unverified)' : 'unknown'
    return `SIMULATED Fix CI: ${classification}; ${failed.map(check => check.name).join(', ') || 'no failed check observed'}. Proposed investigation only; no patch, rerun or worker dispatch. Per-PR semantic review and targeted tests required before any repair.`
  }
}
