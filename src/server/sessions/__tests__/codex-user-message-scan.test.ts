import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { scanCodexUserMessages } from '../codex-transcript'
import {
  legacyRolloutUserMessage,
  rolloutSessionMeta,
  rolloutUserInputItemCompleted,
  rolloutUserInputResponseItem,
  serializeRollout,
} from './codex-rollout-shapes'

const PROMPT = 'TINSTAR_MESSAGE_ENVELOPE_V1 {"schema":"tinstar.message.v1","text":"hi"}'

function writeRollout(records: object[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'codex-scan-'))
  const path = join(dir, 'rollout.jsonl')
  writeFileSync(path, serializeRollout(records))
  return path
}

const matchesPrompt = (message: string) => message === PROMPT

describe('scanCodexUserMessages on Codex 0.147.0 rollouts', () => {
  it('finds evidence in an item_completed UserMessage record', async () => {
    const path = writeRollout([
      rolloutSessionMeta(),
      rolloutUserInputItemCompleted(PROMPT),
    ])
    const scan = await scanCodexUserMessages(path, 0, matchesPrompt)
    expect(scan.available).toBe(true)
    expect(scan.evidence?.message).toBe(PROMPT)
    expect(scan.evidence?.timestamp).toBe('2026-08-11T19:46:29.875Z')
    expect(scan.sawLegacyUserInput).toBe(false)
  })

  it('finds evidence in a response_item user message record', async () => {
    const path = writeRollout([
      rolloutSessionMeta(),
      rolloutUserInputResponseItem(PROMPT),
    ])
    const scan = await scanCodexUserMessages(path, 0, matchesPrompt)
    expect(scan.evidence?.message).toBe(PROMPT)
    expect(scan.sawLegacyUserInput).toBe(false)
  })

  it('does not match assistant response_item messages', async () => {
    const path = writeRollout([
      rolloutSessionMeta(),
      {
        timestamp: '2026-08-11T19:46:30.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: PROMPT }],
        },
      },
    ])
    const scan = await scanCodexUserMessages(path, 0, matchesPrompt)
    expect(scan.evidence).toBeNull()
  })

  it('treats a legacy user_message as the floor tripwire, not as evidence', async () => {
    const path = writeRollout([
      rolloutSessionMeta(),
      legacyRolloutUserMessage(PROMPT),
    ])
    const scan = await scanCodexUserMessages(path, 0, matchesPrompt)
    expect(scan.available).toBe(true)
    expect(scan.evidence).toBeNull()
    expect(scan.sawLegacyUserInput).toBe(true)
  })

  it('reports no legacy input on an empty or unrelated scan window', async () => {
    const path = writeRollout([rolloutSessionMeta()])
    const scan = await scanCodexUserMessages(path, 0, matchesPrompt)
    expect(scan.evidence).toBeNull()
    expect(scan.sawLegacyUserInput).toBe(false)
  })
})
