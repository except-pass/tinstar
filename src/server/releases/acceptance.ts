import { readFile, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'
import type { FloorScene } from '../../shared/reconciliationPresentation'
import type { ReleasesRead } from '../../shared/releases'
import type { AcceptanceEvent, AcceptanceRecord, AcceptanceResult } from '../../shared/releaseAcceptance'
import type { ReleaseChange, ReleaseObject } from '../../shared/releaseObjects'
import { releaseChanges } from '../../shared/releaseChanges'
import { CreationReceipts } from '../reconciliation/workflowReceipts'
import { acquireLock } from '../infra/lock'

const text = z.string().trim().min(1)
const workflow = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), workflow: z.string().regex(/^[\w.-]+\.ya?ml$/),
  ref: text, productionSafe: z.literal(true), inputs: z.record(z.string()).default({}),
}).strict()
export const acceptanceSettingsSchema = z.object({ version: z.literal(1), enabled: z.boolean().default(false), checks: z.record(workflow).default({}) }).strict()
export type AcceptanceSettings = z.infer<typeof acceptanceSettingsSchema>
export async function readAcceptanceSettings(root: string): Promise<AcceptanceSettings> {
  try { return acceptanceSettingsSchema.parse(JSON.parse(await readFile(join(root, 'releases', 'acceptance.json'), 'utf8'))) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, enabled: false, checks: {} }
    throw new Error('Release acceptance configuration is invalid; dispatch remains OFF. Correct releases/acceptance.json or remove it to use the OFF default.')
  }
}
const eventSchema = z.object({ at: z.string().datetime({ offset: true }), actor: text,
  outcome: z.enum(['missing', 'running', 'passed', 'failed', 'inconclusive', 'skipped']), reason: text,
  evidence: text.nullable(), runId: z.number().int().positive().nullable(), runUrl: z.string().url().nullable() })
const recordSchema = z.object({ key: text, releaseId: text, changeId: text, checkId: text, events: z.array(eventSchema).min(1) })
export async function readAcceptanceRecords(root: string): Promise<AcceptanceRecord[]> {
  const entries = await new CreationReceipts(root).entries('release-acceptance:')
  return entries.map(([key, receipt]) => {
    const record = recordSchema.parse(JSON.parse(receipt.input))
    if (record.key !== key) throw new Error('Acceptance receipt identity differs')
    return record
  })
}
export type AcceptanceGithub = (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => Promise<Record<string, unknown>>
const exec = promisify(execFile)
/** Existing GitHub Actions is the executor. API dispatch returns the exact run
 * directly; never guess from timestamps or the most recent workflow run.
 * https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event */
export const acceptanceGithub: AcceptanceGithub = async (method, path, body) => {
  const temporary = body ? await mkdtemp(join(tmpdir(), 'tinstar-check-')) : null
  try {
    const args = ['api', method, path, '--jq', '{payload: (.|tojson)}', '--full']
    if (temporary) { const file = join(temporary, 'request.json'); await writeFile(file, JSON.stringify(body), { mode: 0o600 }); args.push('--input', file) }
    const { stdout } = await exec('gh-axi', args, { timeout: 15_000, maxBuffer: 256 * 1024 })
    const raw = stdout.trim().replace(/^payload: /, '')
    const value = JSON.parse(raw)
    return typeof value === 'string' ? JSON.parse(value) : value
  } finally { if (temporary) await rm(temporary, { recursive: true, force: true }) }
}
interface Selection { release: ReleaseObject; change: ReleaseChange; check: AcceptanceResult }
export function acceptanceSelections(data: ReleasesRead, scene: FloorScene): Selection[] {
  return (data.releases ?? []).flatMap(release => releaseChanges(release, data, scene).flatMap(change => (change.checks ?? []).map(check => ({ release, change, check }))))
}
function deliveryGap({ release, change }: Selection, fresh: boolean) {
  if (release.kind !== 'production') return 'Await exact production deployment; candidates cannot execute checks.'
  if (!fresh || release.provenance.historical) return 'Fresh deployed-target receipts required; historical review cannot dispatch.'
  if (release.membership.status !== 'complete' || change.delivery !== 'Deployed') return 'Every required PR and component must be proven in this release attempt.'
  return null
}
function request(selection: Selection, settings: AcceptanceSettings) {
  const { release, change, check } = selection, approved = settings.checks[check.ref]
  if (!approved || approved.repository.toLowerCase() !== release.repository.toLowerCase()) return null
  const values: Record<string, string> = { releaseId: release.id, fixture: check.fixture ?? '',
    sourceSha: release.sourceSha ?? '', receiptIds: change.targets.map(target => target.receipt!.id).sort().join(','),
    targets: change.targets.map(target => `${target.component}:${target.target}`).sort().join(',') }
  const inputs = Object.fromEntries(Object.entries(approved.inputs).map(([key, value]) => [key, value.replace(/\{(releaseId|fixture|sourceSha|receiptIds|targets)\}/g, (_, name: string) => values[name]!)]))
  return { repository: approved.repository, workflow: approved.workflow, path: `/repos/${approved.repository}/actions/workflows/${encodeURIComponent(approved.workflow)}/dispatches`, body: { ref: approved.ref, inputs, return_run_details: true } }
}
/** Explicit operator invocation, no web GET/timer dispatch. Checks and settings
 * are read before the short receipt lock. All mutations reuse workflow receipts. */
export class ReleaseAcceptanceRunner {
  private receipts: CreationReceipts
  constructor(private root: string, private read: () => Promise<{ data: ReleasesRead; scene: FloorScene }>, private github: AcceptanceGithub = acceptanceGithub, private now = () => new Date().toISOString()) { this.receipts = new CreationReceipts(root) }
  async plan() {
    const [{ data, scene }, settings] = await Promise.all([this.read(), readAcceptanceSettings(this.root)])
    return { enabled: settings.enabled, zeroWrites: true, checks: acceptanceSelections(data, scene).map(selection => ({
      releaseId: selection.release.id, changeId: selection.change.id, checkId: selection.check.id, key: selection.check.key,
      title: selection.change.title, ref: selection.check.ref, outcome: selection.check.outcome, request: selection.check.method === 'workflow' && selection.change.delivery === 'Deployed' ? request(selection, settings) : null,
      held: (!data.associationsComplete ? 'Complete explicit card/PR associations are required.' : deliveryGap(selection, data.reconciliation?.sourceStatus === 'fresh')) ?? (selection.check.method !== 'workflow' ? `Named ${selection.check.method} check: ${selection.check.owner}` : !request(selection, settings) ? 'No approved production-safe workflow configured for this check reference.' : !settings.enabled ? 'Dispatch is OFF in releases/acceptance.json.' : null),
    })) }
  }
  private async save(selection: Selection, event: AcceptanceEvent) {
    const previous = await this.receipts.get(selection.check.key)
    const record: AcceptanceRecord = previous ? recordSchema.parse(JSON.parse(previous.input)) : { key: selection.check.key, releaseId: selection.release.id, changeId: selection.change.id, checkId: selection.check.id, events: [] }
    record.events.push(event)
    await this.receipts.put(record.key, JSON.stringify(record), selection.change.cardId ?? undefined)
    return record
  }
  async perform(input: { actor: string; key?: string; action?: 'retry' | 'manual' | 'skip' | 'attach'; reason?: string; evidence?: string; outcome?: AcceptanceEvent['outcome']; runId?: number }) {
    if (!input.actor.trim()) throw new Error('Actor required')
    if (input.action && !input.reason?.trim()) throw new Error('A reason is required for every operator disposition')
    // Preflight before taking any lock or making an external request.
    const initial = await this.read(), settings = await readAcceptanceSettings(this.root)
    if (!input.action && !settings.enabled) return { enabled: false, records: [] }
    if (input.action && !input.key) throw new Error('Select an exact check key from the dry-run output')
    if (input.action === 'manual' && (!['passed', 'failed', 'inconclusive', 'skipped'].includes(input.outcome ?? '') || !input.evidence?.trim())) throw new Error('Manual evidence and an explicit terminal result are required')
    const selected = acceptanceSelections(initial.data, initial.scene).filter(selection => !input.key || selection.check.key === input.key)
    if (input.key && !selected.length) throw new Error('Check identity changed or is unavailable; refresh the dry run')
    await mkdir(this.root, { recursive: true })
    const unlock = await acquireLock(join(this.root, 'release-acceptance.lock'))
    try {
      const records: AcceptanceRecord[] = []
      for (const captured of selected) {
        // Re-read after waiting for the receipt lock; another process may have dispatched.
        const { data, scene } = await this.read()
        data.acceptanceRecords = await readAcceptanceRecords(this.root)
        const selection = acceptanceSelections(data, scene).find(row => row.check.key === captured.check.key)
        if (!selection) continue
        const { check } = selection, previous = check.record?.events.at(-1)
        const event = (outcome: AcceptanceEvent['outcome'], reason: string, evidence: string | null = null, runId: number | null = null, runUrl: string | null = null): AcceptanceEvent => ({ at: this.now(), actor: input.actor, outcome, reason, evidence, runId, runUrl })
        if (input.action === 'skip') { records.push(await this.save(selection, event('skipped', input.reason!, input.evidence ?? null))); continue }
        const gap = !data.associationsComplete ? 'Complete explicit card/PR associations are required.' : deliveryGap(selection, data.reconciliation?.sourceStatus === 'fresh')
        if (gap) { if (input.key) throw new Error(gap); continue }
        if (input.action === 'manual') {
          // Explicit human exception keeps prior failed/running evidence in history.
          records.push(await this.save(selection, event(input.outcome!, input.reason!, input.evidence!))); continue
        }
        const currentSettings = await readAcceptanceSettings(this.root)
        const dispatch = check.method === 'workflow' ? request(selection, currentSettings) : null
        if (!dispatch) { if (input.key) throw new Error('An approved production-safe workflow is required'); continue }
        let runId = previous?.runId ?? null
        if (input.action === 'attach') {
          if (!input.runId || !Number.isSafeInteger(input.runId) || input.runId < 1) throw new Error('A positive GitHub run ID is required')
          runId = input.runId
        }
        if (previous && ['passed', 'failed', 'skipped'].includes(previous.outcome) && !input.action) continue
        if (runId && input.action !== 'retry') {
          try {
            const run = await this.github('GET', `/repos/${dispatch.repository}/actions/runs/${runId}`)
            const url = `https://github.com/${dispatch.repository}/actions/runs/${runId}`
            if (!['queued', 'in_progress', 'requested', 'waiting', 'pending', 'completed'].includes(String(run.status)) || !Number.isFinite(Date.parse(String(run.created_at))) || run.id !== runId || run.event !== 'workflow_dispatch' || run.html_url !== url || String(run.path).split('@')[0] !== `.github/workflows/${dispatch.workflow}` || run.head_branch !== dispatch.body.ref || typeof run.created_at !== 'string' || Date.parse(run.created_at) < Math.max(...selection.change.targets.map(target => Date.parse(target.receipt!.deployedAt)))) throw new Error('Run does not match the approved check and deployment')
            const outcome = run.status !== 'completed' ? 'running' : run.conclusion === 'success' ? 'passed' : run.conclusion === 'failure' ? 'failed' : run.conclusion === 'skipped' ? 'skipped' : 'inconclusive'
            records.push(await this.save(selection, event(outcome, input.reason ?? `GitHub workflow ${run.status}: ${run.conclusion ?? 'pending'}`, url, runId, url)))
          } catch { records.push(await this.save(selection, event('inconclusive', 'GitHub run readback unavailable or mismatched. Attach the exact run with a reason, or record specific human evidence.', previous?.evidence ?? null, previous?.runId ?? null, previous?.runUrl ?? null))) }
          continue
        }
        // Intent survives process failure/response loss. No automatic repeat of
        // failed, skipped or ambiguous dispatch; audited retry is the escape.
        if (previous && input.action !== 'retry') continue
        if (!currentSettings.enabled) { if (input.key) throw new Error('Dispatch is OFF in releases/acceptance.json'); continue }
        await this.save(selection, event('inconclusive', input.reason ?? 'Dispatch intent recorded; provider response not confirmed. Do not automatically retry.'))
        try {
          const result = await this.github('POST', dispatch.path, dispatch.body)
          const id = result.workflow_run_id
          if (!Number.isSafeInteger(id) || Number(id) < 1 || result.html_url !== `https://github.com/${dispatch.repository}/actions/runs/${id}`) throw new Error('Dispatch response lacks exact run identity')
          records.push(await this.save(selection, event('running', input.reason ?? 'Approved safe acceptance workflow dispatched.', String(result.html_url), Number(id), String(result.html_url))))
        } catch { records.push(await this.save(selection, event('inconclusive', 'Dispatch outcome unknown. Inspect GitHub, then attach the exact run or retry with an audited reason. No automatic repeat.'))) }
      }
      return { enabled: settings.enabled, records }
    } finally { await unlock() }
  }
}
