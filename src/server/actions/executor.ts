import { join } from 'node:path'
import { type ActionSnapshot, type ActionReceipt, type InstalledAction, type CheckPolicy, type ActionOperation } from '../../shared/actions'
import type { AskView } from '../../shared/ask'
import { tryAcquireLock, acquireLock } from '../infra/lock'
import { ActionStore } from './store'
import { coordinateTargets } from './coordination'
import { simulateRunner } from './runner'
import { type BrokerInvocation, BrokerEffectError, profileFor, SimulatedWriteAdapter, simulatedRequest, validateOperation, validateTarget } from './broker'

export interface RunInput { repair?: Extract<ActionOperation, { kind: 'repair.update' | 'repair.rerun' }>; key: string; actor: string; installed: InstalledAction; targets: ActionSnapshot[]; mode: 'direct' | 'coordinated'; view: AskView }
export interface ExecutorRuntime {
  run: (action: InstalledAction, target: ActionSnapshot, signal: AbortSignal) => Promise<ActionOperation>;
  perform: (target: ActionSnapshot, operation: ActionOperation, signal: AbortSignal) => Promise<Pick<ActionReceipt, 'providerRequest' | 'actualGitHubWrites' | 'resultingSha' | 'verification' | 'result'>>;
}
/** Shared by both surfaces. All effects serialize; unknown dependencies never fan out.
 * No receipt claims worker/coordinator identity that has not actually been observed. */
export class ActionExecutor {
  private active = new Map<string, { actor: string; controller: AbortController; work: Promise<void> }>()
  constructor(readonly store: ActionStore, private read: (url: string) => Promise<ActionSnapshot>, private policy: CheckPolicy, private readJob?: (repository: string, jobId: number) => Promise<NonNullable<BrokerInvocation['job']>>, private runtime?: ExecutorRuntime) {}
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
      receipts = targets.map((target, order) => ({ execution: this.runtime ? 'live' : 'simulation', id: `${key}-${order}`, runId: key, idempotencyKey: key, actor, actionId: installed.manifest.id,
        version: installed.manifest.version, digest: installed.manifest.digest, mode, view: input.view, captured: this.selection(target), live: null,
        declared: [...installed.manifest.capabilities], granted: [...installed.grant.capabilities], attempted: [], exercised: [],
        credentialProfile: profileFor(installed.manifest.capabilities[0]!), coordinator: 'Unknown', worker: 'Unknown', plan, order,
        startedAt: new Date().toISOString(), finishedAt: null, intendedEffect: `${this.runtime ? 'Perform' : 'Would perform'} ${installed.manifest.name} on ${target.url}`,
        operation: input.repair ?? null, outcome: 'intent', reasons: [], checkPolicyVersion: null, checkEvidence: [], providerRequest: null,
        actualGitHubWrites: 0, resultingSha: null, verification: 'not-performed', result: `Intent persisted; ${this.runtime ? 'broker validation' : 'simulation'} pending.` }))
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
      let dispatching = false
      const timeout = setTimeout(() => controller.abort(new Error('Runner time limit exceeded; no automatic retry')), input.installed.manifest.limits.timeoutMs)
      try {
        controller.signal.throwIfAborted()
        unlock = await tryAcquireLock(join(this.store.root, 'locks', `${captured.repository.replace('/', '_')}-${captured.number}.lock`))
        if (!unlock) throw new Error('PR already locked by an action in PRs or Releases')
        // Each item revalidates the original installed version even after rollback.
        const installed = await this.store.inspect(input.installed.manifest.id, input.installed.manifest.version)
        if (this.runtime) {
          // Source receives target evidence only after its installed repository,
          // branch and path envelope has been checked. Recheck again after source.
          const reasons = validateTarget(installed, captured, await this.read(captured.url), { actor: input.actor, explicit: true, origin: 'user' })
          if (reasons.length) throw new Error(reasons.join('; '))
        }
        const fixtureOperation = this.runtime ? await this.runtime.run(installed, captured, controller.signal) : simulateRunner(installed, captured.head, controller.signal)
        if (input.repair && fixtureOperation.kind !== 'ci.propose') throw new Error('Repair extras require the installed Fix CI fixture and explicit user selection')
        const operation = input.repair ?? fixtureOperation
        if (this.runtime && operation.kind.startsWith('repair.') && !input.repair) throw new Error('Live Repair requires an explicit owner-selected operation, head and job/run identity')
        if (operation.kind.startsWith('repair.') || operation.kind === 'merge.admin') unlockRepo = await acquireLock(join(this.store.root, 'locks', `${captured.repository.replace('/', '_')}.lock`))
        receipt.operation = operation; receipt.attempted = [operation.kind]; receipt.credentialProfile = profileFor(operation.kind)
        const live = await this.read(captured.url)
        controller.signal.throwIfAborted()
        receipt.live = live; receipt.checkEvidence = live.checks
        receipt.checkPolicyVersion = operation.kind === 'merge.admin' ? this.policy.version : null
        const job = operation.kind === 'repair.rerun' ? await this.readJob?.(captured.repository, operation.jobId) : undefined
        const validation = validateOperation(installed, captured, live, operation, { actor: input.actor, explicit: true, origin: 'user', job }, this.policy)
        const previousReceipts = await this.store.receipts()
        if (this.runtime && previousReceipts.some(row => row.id !== receipt.id && row.execution === 'live' && row.captured.url === captured.url && row.captured.head === captured.head && row.operation?.kind === operation.kind && row.outcome === 'unknown' && !!row.providerRequest)) validation.reasons.push('Previous Repair outcome unknown on this head; reconcile provider state before retry')
        if (operation.kind === 'repair.rerun' && previousReceipts.some(row => row.id !== receipt.id && (!this.runtime || row.execution === 'live') && row.captured.head === captured.head && row.operation?.kind === 'repair.rerun' && row.operation.jobId === operation.jobId && row.operation.runId === operation.runId && !!row.providerRequest && !['skipped', 'cancelled'].includes(row.outcome))) validation.reasons.push('This failed job already consumed its one rerun; no retry loop')
        if (validation.reasons.length) { receipt.outcome = 'skipped'; receipt.reasons = validation.reasons; receipt.result = 'Skipped; broker validation refused the proposal.' }
        else {
          // Persist exact intent BEFORE the live adapter can send a mutation.
          receipt.providerRequest = simulatedRequest(live, operation)
          if (this.runtime && receipt.providerRequest) receipt.actualGitHubWrites = null
          await this.store.append(receipt)
          controller.signal.throwIfAborted()
          dispatching = true
          Object.assign(receipt, this.runtime ? await this.runtime.perform(live, operation, controller.signal) : adapter.perform(live, operation))
          receipt.outcome = this.runtime ? receipt.actualGitHubWrites ? 'accepted' : 'completed' : 'simulated'
          receipt.exercised = this.runtime ? [operation.kind] : []
          if (operation.kind === 'ci.propose' && !this.runtime) receipt.result = this.classify(live)
        }
      } catch (error) {
        const unknown = this.runtime && dispatching && receipt.providerRequest && !(error instanceof BrokerEffectError && error.outcome === 'not-sent')
        receipt.outcome = unknown ? 'unknown' : controller.signal.aborted ? 'cancelled' : 'skipped'
        if (!unknown) receipt.actualGitHubWrites = 0
        receipt.reasons.push((error as Error).message)
        receipt.result = receipt.outcome === 'unknown' ? 'Provider outcome unknown; reconcile before any new invocation. No automatic retry.' : receipt.outcome === 'cancelled' ? 'Cancelled before sending any operation; no undo claimed.' : 'Skipped; no operation sent.'
        if (unknown && receipt.operation?.kind === 'repair.rerun' && this.readJob) {
          // Keep the uncertain acknowledgment before one read-only reconciliation.
          // An advanced attempt proves the requested state, not which actor caused it.
          await this.store.append(receipt)
          try {
            const operation = receipt.operation
            const job = await this.readJob(captured.repository, operation.jobId)
            if (job.id === operation.jobId && job.runId === operation.runId && job.head === operation.expectedHead && job.runAttempt > operation.attempt) {
              receipt.outcome = 'completed'; receipt.verification = 'accepted'
              receipt.result = 'Provider read confirms the selected run advanced beyond its original attempt. Write attribution remains unknown; no retry sent.'
            }
          } catch { /* Unavailable or ambiguous evidence keeps the unknown receipt. */ }
        }
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
