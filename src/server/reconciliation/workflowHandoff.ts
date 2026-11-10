import { submitHandoffSchema, type SubmitHandoffInput, type CreateWorkInput, type UpdateWorkInput, type StartWorkResult } from '../../shared/workflow'
import { ContractError, ImplementationContracts, implementationContract, digest, canonical } from './implementationContract'
import type { WorkflowChange } from './workflow'
import type { WorkReader, WorkCard } from './workReader'
import type { CreationReceipts, HandoffReceiptState } from './workflowReceipts'
import { NotionWriteError } from './workflowContent'

export interface HandoffDependencies {
  reader: WorkReader; receipts: CreationReceipts; contracts: ImplementationContracts
  create(input: CreateWorkInput, actor: string): Promise<StartWorkResult>
  update(input: UpdateWorkInput, actor: string): Promise<StartWorkResult>
  hasNote(cardId: string, actor: string, operationId: string): Promise<boolean>
  matches(card: WorkCard, desired: Record<string, unknown>): boolean
  exclusive<T>(id: string, perform: () => Promise<T>): Promise<T>
  notify(change: WorkflowChange): Promise<void>
  delivery(cardId: string, operationId: string): Promise<unknown>
  execution(card: WorkCard): Promise<unknown>
}

/** One recording workflow composed over the existing writer/bridge. Not a
 * dispatcher: only a verified contract can lead to a Queued assignment. */
export class HandoffOperations {
  constructor(private deps: HandoffDependencies) {}
  async submit(raw: SubmitHandoffInput, actor: string) {
    const parsed = submitHandoffSchema.safeParse(raw)
    if (!parsed.success || !actor.trim()) return { outcome: 'not-saved', record: { state: 'not-saved' }, assignment: { state: 'unknown' }, delivery: { state: 'unknown' }, execution: { state: 'unknown' },
      recovery: { code: 'invalid-input', message: parsed.success ? 'Authenticated caller required' : parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ') } }
    const input = parsed.data
    if (input.expected_contract_hash && !input.revision_id) return { outcome: 'not-saved', record: { state: 'not-saved' }, assignment: { state: 'unknown' }, delivery: { state: 'unknown' }, execution: { state: 'unknown' }, recovery: { code: 'revision-required', message: 'An amendment requires an explicit revision_id as well as expected_contract_hash' } }
    let contract: ReturnType<typeof implementationContract>
    try { contract = implementationContract(input, actor) }
    catch (error) { return { outcome: 'not-saved', record: { state: 'not-saved' }, assignment: { state: 'unknown' }, delivery: { state: 'unknown' }, execution: { state: 'unknown' }, recovery: { code: 'contract-too-large', message: error instanceof Error ? error.message : 'Contract cannot be represented losslessly' } } }
    return this.deps.exclusive('handoff-submissions', async () => {
      let card: WorkCard | undefined, state: HandoffReceiptState = {}, attempted = false
      let wasRecorded = false
      let spec: Awaited<ReturnType<ImplementationContracts['write']>> | undefined
      const key = canonical(['handoff', actor, input.submission_id, input.revision_id ?? 'initial'])
      const targetKey = canonical(['handoff-target', actor, input.submission_id])
      const signature = digest(canonical(input))
      const operation = (step: string) => `handoff-${contract.manifest.version.slice(0, 48)}-${step}`
      const creationFields = { ...this.properties(input), Name: input.title, Owner: input.owner, Area: input.area, Status: 'Backlog' }
      const save = () => this.deps.receipts.put(key, signature, card?.id, state)
      const response = async (code?: string, message?: string) => {
        const current = card ? await this.deps.reader.card(card.id, true).catch(() => undefined) : undefined
        if (current) card = current
        if (card && !current && !code) { code = 'source-unavailable'; message = 'Contract bytes verified, but final card/assignment readback is unavailable. Retry the identical submission to reconcile current state.' }
        let inventory: Awaited<ReturnType<ImplementationContracts['inventory']>> | undefined
        if (card) inventory = await this.deps.contracts.inventory(card.id).catch(() => undefined)
        const confirmed = contract.chunks.flatMap((text, index) => (inventory?.sections ?? []).filter(block => block.text === `Tin Star contract chunk: ${contract.manifest.version} ${index}\n${text}`).map(block => ({ index, block_id: block.id })))
        const verified = spec?.outcome === 'available', complete = verified && !code
        return { submission_id: input.submission_id, outcome: complete ? 'saved' : card || attempted ? 'partially-saved' : 'not-saved',
          record: { state: verified ? wasRecorded ? 'already-recorded' : state.created ? 'created' : 'updated' : card ? 'partially-saved' : 'not-saved',
            ...(card ? { card_id: card.id, url: card.url ?? `https://www.notion.so/${card.id}`, fields_readback: current ? 'confirmed' : 'unavailable', verified_fields: current ? Object.fromEntries(Object.entries(current.properties).map(([name, property]) => [name, property.value])) : {} } : {}),
            spec_version: contract.manifest.version, spec_hash: contract.manifest.hash, spec_length: contract.manifest.length,
            full_spec_readback: spec?.outcome === 'available' ? 'verified' : 'incomplete', confirmed_chunks: confirmed,
            missing_chunks: contract.chunks.map((_text, index) => index).filter(index => !confirmed.some(chunk => chunk.index === index)),
            references: 'Caller-declared durable links saved verbatim; linked media is not copied or independently verified',
            reader: { tool: 'get_work', card_id: card?.id, implementation_contract: { revision: contract.manifest.version, offset: 0, limit: 10 } } },
          assignment: { owner: current?.properties.Owner?.value ?? null, status: current?.properties.Status?.value ?? null,
            state: !current ? 'unknown' : current.properties.Status?.value === 'In Progress' ? 'existing-active' : state.assignment_done && current.properties.Status?.value === 'Queued' ? 'newly-queued' : 'preserved',
            ...(code === 'assignment-conflict' ? { blocked_from_transition: true } : {}) },
          delivery: card ? await this.deps.delivery(card.id, operation('contract')).catch(() => ({ state: 'unknown' })) : { state: 'unknown' },
          execution: current ? await this.deps.execution(current).catch(() => ({ state: 'unknown' })) : { state: 'unknown' },
          recovery: code ? { code, message, pending_batch_hashes: state.pending ?? [], pending_update: state.pending_update ? operation(state.pending_update) : null, retry: 'Retry identical submission_id, revision_id and payload. Never change the ID merely to bypass an uncertain create/append. For a changed approved contract use a new revision_id and expected_contract_hash; inspect concurrent edits before correction.' } : null }
      }
      try {
        const previous = await this.deps.receipts.get(key)
        if (previous && previous.input !== signature) return response('submission-conflict', 'Same submission/revision ID has different input; declare an explicit new revision')
        state = previous?.handoff ?? {}
        wasRecorded = state.notified === true
        const target = await this.deps.receipts.get(targetKey)
        if (!previous) await save()
        if ('card_id' in input.target) {
          if (previous?.cardId && previous.cardId !== input.target.card_id || target?.cardId && target.cardId !== input.target.card_id) return response('target-conflict', 'Submission is already bound to a different card')
          card = await this.deps.reader.card(input.target.card_id, true)
        } else {
          const externalKey = canonical(['handoff-external', input.target.external_ref])
          const external = await this.deps.receipts.get(externalKey)
          const knownId = previous?.cardId ?? target?.cardId ?? external?.cardId
          if (knownId) card = await this.deps.reader.card(knownId, true)
          else {
            if (input.revision_id || input.expected_contract_hash) return response('revision-conflict', 'A later revision needs the existing authoritative card ID or external reference receipt')
            if (input.target.candidate_ids.length) {
              const candidates = await Promise.all(input.target.candidate_ids.map(async id => {
                const candidate = await this.deps.reader.card(id, true)
                return { card_id: candidate.id, url: candidate.url, title: candidate.properties.Name?.value, status: candidate.properties.Status?.value }
              }))
              return { ...await response('needs-target', 'Candidate cards require an explicit card_id; no title match or overwrite was attempted'), candidates }
            }
            const createId = `handoff-create-${digest(externalKey).slice(0, 48)}`
            const create: CreateWorkInput = { operation_id: createId, name: input.title, owner: input.owner, area: input.area, status: 'Backlog',
              properties: this.properties(input), content: { brief: input.objective } }
            const externalIntent = canonical({ actor, create })
            if (external && external.input !== externalIntent) return response('create-unconfirmed', 'External reference has an unresolved creation with different metadata/caller; reconcile it before amending')
            await this.deps.receipts.put(externalKey, externalIntent)
            // The existing durable creation latch is written before Notion POST.
            // Reusing the external reference also reuses that creation identity.
            const created = await this.deps.create(create, actor)
            attempted = created.outcome !== 'not-saved'
            if (!created.card) {
              if (created.outcome === 'not-saved') await this.deps.receipts.remove(externalKey)
              return response(created.code, created.message)
            }
            card = await this.deps.reader.card((created.card as WorkCard).id, true)
            state.created = true
            state.properties_done = this.deps.matches(card, creationFields)
            await this.deps.receipts.put(externalKey, input.target.external_ref, card.id)
            if (created.outcome !== 'saved') { await save(); return response(created.code, created.message) }
          }
        }
        if (card.archived || card.in_trash) return response('archived', 'Restore the card explicitly before adding an implementation contract')
        await this.deps.receipts.put(targetKey, input.submission_id, card.id)
        await save()
        return await this.deps.exclusive(card.id, async () => {
          try {
            card = await this.deps.reader.card(card!.id, true)
            const before = card
            if (state.created && !state.properties_done) {
              // A human may have edited a newly created page after an uncertain
              // response. Do not "repair" their fields to match the old create.
              if (!this.deps.matches(card, creationFields)) return response('creation-readback-mismatch', 'Created card fields differ from the declared handoff. Inspect/correct this exact card explicitly; it will not be overwritten or queued by a retry.')
              state.properties_done = true; await save()
            }
            const update = async (step: string, value: UpdateWorkInput) => {
              if (state.pending_update && (state.pending_update !== step || !await this.deps.hasNote(card!.id, actor, operation(step))))
                throw new ContractError('update-unconfirmed', 'Earlier property/assignment history remains uncertain. Inspect the current card and operation marker; the missing history POST will not be automatically repeated.')
              state.pending_update = step; await save()
              const result = await this.deps.update(value, actor)
              if (result.outcome !== 'partially-saved') { delete state.pending_update; await save() }
              return result
            }
            if (!state.original) {
              const properties = { ...this.properties(input), Name: input.title, Area: input.area }
              state.original = Object.fromEntries(Object.keys(properties).map(name => [name, card!.properties[name]?.value ?? null]))
              await save()
            }
            attempted = true
            spec = await this.deps.contracts.write(card.id, contract, state, save)
            state.contract_done = true; await save()
            if (!state.properties_done) {
              const edited = await update('properties', { kind: 'edit', card_id: card.id, operation_id: operation('properties'), expected: state.original,
                properties: { ...this.properties(input), Name: input.title, Area: input.area } })
              if (edited.outcome !== 'saved') return response(edited.code, edited.message)
              state.properties_done = true; await save()
            }
            if (!state.assignment_done && (state.created || input.assignment)) {
              const assignment = input.assignment ?? { owner: input.owner, status: 'Queued' as const, expected_owner: input.owner, expected_status: 'Backlog' }
              const assigned = await update('assignment', { kind: 'assign', card_id: card.id, operation_id: operation('assignment'), owner: assignment.owner, status: assignment.status,
                expected: { Owner: assignment.expected_owner, Status: assignment.expected_status }, note: `Verified implementation contract ${contract.manifest.version}; SHA-256 ${contract.manifest.hash}` })
              if (assigned.outcome !== 'saved') return response('assignment-conflict', assigned.message)
              state.assignment_done = true; await save()
            }
            card = await this.deps.reader.card(card.id, true)
            if (!state.notified) {
              try { await this.deps.notify({ before, card, actor, operationId: operation('contract'), properties: {}, sections: [`Implementation contract ${contract.manifest.version}; use get_work implementation_contract to retrieve all chunks and verify SHA-256 ${contract.manifest.hash}`] }) }
              catch { return response('notification-unconfirmed', 'Full contract is verified; existing Firstmate bridge notice could not be confirmed. Retry the same submission to reconcile delivery.') }
              state.notified = true; await save()
            }
            this.deps.reader.confirm(card)
            return response()
          } catch (error) {
            if (card) card = await this.deps.reader.card(card.id, true).catch(() => card!)
            return response(error instanceof ContractError ? error.code : error instanceof NotionWriteError ? `notion-http-${error.status}` : 'save-unconfirmed',
              error instanceof ContractError ? error.message : 'Only listed readbacks are confirmed. The same-ID retry reconciles Notion before any further write; no offline work is queued.')
          }
        })
      } catch (error) {
        return response(error instanceof ContractError ? error.code : 'source-unavailable', error instanceof ContractError ? error.message : 'Current configured-board source or receipt unavailable; no further write attempted')
      }
    })
  }
  private properties(input: SubmitHandoffInput) {
    return { ...(input.initiative === undefined ? {} : { Initiative: input.initiative }), ...(input.epic === undefined ? {} : { Epic: input.epic }),
      ...(input.priority ? { Priority: input.priority } : {}), ...(input.parent_card_id ? { 'Parent item': [input.parent_card_id] } : {}) }
  }
}
