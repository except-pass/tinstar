import { createHash } from 'node:crypto'
import type { SubmitHandoffInput } from '../../shared/workflow'
import { heading, paragraph, WorkflowContent, NotionWriteError, type WorkflowCreateBlock, createBlockText } from './workflowContent'
import type { HandoffReceiptState } from './workflowReceipts'

export const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
export const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)
const manifestPrefix = 'Tin Star implementation contract: '
const chunkPrefix = (version: string) => `Tin Star contract chunk: ${version} `
const completeText = (manifest: ContractManifest) => `Tin Star contract complete: ${canonical(Object.fromEntries(
  ['schema', 'version', 'submission_id', 'revision_id', 'actor', 'external_ref', 'input_hash', 'hash', 'length', 'bytes', 'chunks', 'spec_offset', 'spec_length', 'previous_hash']
    .map(key => [key, manifest[key as keyof ContractManifest]])))}`
export interface ContractManifest {
  schema: 'tinstar.implementation-contract.v1'; version: string; submission_id: string; revision_id: string; actor: string
  input_hash: string; hash: string; length: number; bytes: number; chunks: number; spec_offset: number; spec_length: number
  previous_hash: string | null; external_ref: string | null
}
export class ContractError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}
export function implementationContract(input: SubmitHandoffInput, actor: string) {
  const revision = input.revision_id ?? 'initial'
  const prefix = `# Objective\n${input.objective}\n\n# Approved specification\n`
  const list = (items: string[]) => items.map((item, index) => `${index + 1}. ${item}`).join('\n')
  const text = prefix + input.spec_markdown + `\n\n# Acceptance criteria\n${list(input.acceptance_criteria)}\n\n# Approved decisions\n${list(input.decisions)}\n\n# Forbidden approaches\n${list(input.forbidden_approaches)}\n\n# Durable references\n${input.references.map(ref => `${ref.description}: ${ref.url}`).join('\n')}\n` +
    (input.source_conversation ? `\nSource conversation: ${input.source_conversation}\n` : '') +
    (input.parent_card_id ? `\nParent card: https://www.notion.so/${input.parent_card_id}\n` : '') +
    (input.ui_prototype ? `\nApproved prototype: ${input.ui_prototype}\nBinding UI acceptance: the approved prototype is the implementation contract. A real screenshot of the first implemented pass must be compared with this prototype before claiming done.\n` : '')
  // This bound keeps each Notion write and on-demand read finite, without truncation.
  if (Buffer.byteLength(text, 'utf8') > 1500000) throw new ContractError('contract-too-large', 'Contract exceeds 1,500,000 UTF-8 bytes; submit a smaller explicit revision. Nothing was truncated.')
  const chunks: string[] = []; let part = ''
  for (const char of text) {
    if (part.length + char.length > 8000) { chunks.push(part); part = '' }
    part += char
  }
  if (part) chunks.push(part)
  const manifest: ContractManifest = { schema: 'tinstar.implementation-contract.v1', version: digest(canonical([actor, input.submission_id, revision])),
    submission_id: input.submission_id, revision_id: revision, actor, external_ref: 'external_ref' in input.target ? input.target.external_ref : null, input_hash: digest(canonical(input)), hash: digest(text), length: text.length,
    bytes: Buffer.byteLength(text, 'utf8'), chunks: chunks.length, spec_offset: prefix.length, spec_length: input.spec_markdown.length, previous_hash: input.expected_contract_hash ?? null }
  return { manifest, text, chunks, brief: input.objective }
}
type Section = Awaited<ReturnType<WorkflowContent['sections']>>[number]
export class ImplementationContracts {
  constructor(private content: WorkflowContent) {}
  manifests(sections: Section[]) {
    return sections.filter(block => block.text.startsWith(manifestPrefix)).map(block => {
      let parsed: ContractManifest
      try { parsed = JSON.parse(block.text.slice(manifestPrefix.length)) } catch { throw new ContractError('contract-conflict', 'Malformed implementation contract manifest; inspect the named card before correction') }
      if (parsed.schema !== 'tinstar.implementation-contract.v1' || !/^[a-f0-9]{64}$/.test(parsed.version) || !/^[a-f0-9]{64}$/.test(parsed.hash) || !Number.isInteger(parsed.chunks) || parsed.chunks < 1 || parsed.chunks > 1000)
        throw new ContractError('contract-conflict', 'Invalid implementation contract manifest')
      return { ...parsed, block_id: block.id }
    })
  }
  verify(sections: Section[], manifest: ContractManifest) {
    const chunks = Array.from({ length: manifest.chunks }, (_, index) => {
      const prefix = `${chunkPrefix(manifest.version)}${index}\n`, matches = sections.filter(block => block.text.startsWith(prefix))
      if (matches.length !== 1) throw new ContractError('contract-incomplete', `Contract ${manifest.version} chunk ${index} is missing or duplicated`)
      return { index, block_id: matches[0]!.id, text: matches[0]!.text.slice(prefix.length) }
    })
    const text = chunks.map(chunk => chunk.text).join('')
    if (text.length !== manifest.length || Buffer.byteLength(text, 'utf8') !== manifest.bytes || digest(text) !== manifest.hash)
      throw new ContractError('contract-conflict', `Contract ${manifest.version} readback hash/length differs; preserve and inspect concurrent edits`)
    return { chunks, text }
  }
  async inventory(id: string) {
    const sections = await this.content.sections(id, true, true), versions = this.manifests(sections)
    if (new Set(versions.map(version => version.version)).size !== versions.length) throw new ContractError('contract-conflict', 'Duplicate implementation contract version markers')
    const approved = versions.filter(version => sections.filter(block => block.text === completeText(version)).length === 1)
    return { sections, versions, current: approved.at(-1) }
  }
  async read(id: string, options: { revision?: string; offset: number; limit: number }) {
    const inventory = await this.inventory(id)
    const manifest = options.revision ? inventory.versions.find(row => row.version === options.revision) : inventory.current
    if (!manifest) return { outcome: 'unavailable', reason: 'No completed contract with that version', versions: inventory.versions }
    if (inventory.sections.filter(block => block.text === completeText(manifest)).length !== 1)
      return { outcome: 'partially-saved', code: 'contract-incomplete', complete_response: false, verified: false, manifest,
        reason: 'Contract completion metadata is missing, changed or duplicated; inspect this exact version' }
    const { chunks } = this.verify(inventory.sections, manifest)
    const page = chunks.slice(options.offset, options.offset + options.limit)
    return { outcome: 'available', manifest, verified: true, encoding: 'UTF-8', normalization: 'none',
      chunks: page, next_offset: options.offset + page.length < chunks.length ? options.offset + page.length : null,
      complete_response: options.offset === 0 && page.length === chunks.length,
      versions: inventory.versions.map(row => ({ version: row.version, revision_id: row.revision_id, hash: row.hash, block_id: row.block_id })) }
  }
  async write(id: string, contract: ReturnType<typeof implementationContract>, state: HandoffReceiptState, save: () => Promise<void>) {
    const { manifest, chunks } = contract
    let inventory = await this.inventory(id)
    const previous = inventory.versions.find(row => row.version === manifest.version)
    if (previous && previous.input_hash !== manifest.input_hash) throw new ContractError('submission-conflict', 'Submission/revision already contains different input')
    if (previous && canonical({ ...previous, block_id: undefined }) !== canonical(manifest)) throw new ContractError('contract-conflict', 'Managed contract manifest was edited; preserve and inspect the current version')
    const completed = inventory.sections.filter(block => block.text === completeText(manifest)).length === 1
    if (state.contract_done && (!previous || !completed)) throw new ContractError('contract-conflict', 'A previously verified contract or completion marker changed; inspect the card before explicit correction')
    const otherIncomplete = inventory.versions.find(row => row.version !== manifest.version && !inventory.sections.some(block => block.text === completeText(row)))
    if (otherIncomplete) throw new ContractError('revision-conflict', `Resume incomplete version ${otherIncomplete.version} before amending it`)
    if ((!previous || !completed) && (inventory.current?.hash ?? null) !== manifest.previous_hash)
      throw new ContractError('revision-conflict', 'Current approved contract changed; declare revision_id and expected_contract_hash to append an amendment')
    if (inventory.current && inventory.current.version !== manifest.version) this.verify(inventory.sections, inventory.current)
    const desired = [paragraph(`Tin Star executive brief: ${manifest.version}\nExecutive brief\n${contract.brief}`), heading('Implementation contract'), paragraph(manifestPrefix + JSON.stringify(manifest)),
      ...chunks.map((chunk, index) => paragraph(`${chunkPrefix(manifest.version)}${index}\n${chunk}`))]
    const matches = (text: string) => inventory.sections.filter(block => block.text === text)
    // An uncertain append is never repeated. A retry first locates every block
    // in that batch; only then can subsequent, never-submitted batches continue.
    if (state.pending?.length) {
      if (!state.pending.every(hash => inventory.sections.filter(block => digest(block.text) === hash).length === 1)) throw new ContractError('append-unconfirmed', 'An earlier append remains uncertain. Inspect confirmed block IDs and the pending batch; retry the same ID after Notion settles. Do not create another task or automatically repeat that append.')
      delete state.pending; await save()
    }
    for (let offset = 0; offset < desired.length;) {
      inventory = await this.inventory(id)
      const count = offset === 0 ? 1 : 20
      const missing = desired.slice(offset, offset + count).filter(block => {
        const text = createBlockText(block), found = matches(text)
        if (found.length > 1) throw new ContractError('contract-conflict', 'Duplicate contract blocks; inspect the version before correction')
        // Detect edited chunks instead of appending a replacement over human work.
        const marker = text.split('\n')[0]!
        if (!found.length && inventory.sections.some(section => section.text.split('\n')[0] === marker)) throw new ContractError('contract-conflict', `Managed contract block changed: ${marker}`)
        return !found.length
      })
      const atStart = offset === 0
      offset += count
      if (!missing.length) continue
      await this.append(id, missing, state, save, atStart)
      inventory = await this.inventory(id)
      if (!missing.every(block => matches(createBlockText(block)).length === 1)) throw new ContractError('append-unconfirmed', 'Only some contract blocks read back; pending batch retained for safe reconciliation')
      delete state.pending; await save()
    }
    inventory = await this.inventory(id)
    this.verify(inventory.sections, manifest)
    const completion = completeText(manifest)
    if (!matches(completion).length) {
      await this.append(id, [paragraph(completion)], state, save)
      inventory = await this.inventory(id)
      if (matches(completion).length !== 1) throw new ContractError('append-unconfirmed', 'Contract content verified; completion marker unconfirmed')
      delete state.pending; await save()
    }
    return this.read(id, { revision: manifest.version, offset: 0, limit: 1 })
  }
  private async append(id: string, children: WorkflowCreateBlock[], state: HandoffReceiptState, save: () => Promise<void>, atStart = false) {
    state.pending = children.map(block => digest(createBlockText(block))); await save()
    try { await this.content.request(`blocks/${id}/children`, 'PATCH', { children, ...(atStart ? { position: { type: 'start' } } : {}) }) }
    catch (error) {
      if (error instanceof NotionWriteError && error.status < 500) { delete state.pending; await save() }
      throw error
    }
  }
}
