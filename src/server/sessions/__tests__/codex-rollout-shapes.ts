/**
 * Rollout record shapes for fabricating Codex transcripts in tests.
 *
 * Codex CLI 0.147.0 records terminal user input as a `response_item` with
 * role "user" plus an `event_msg`/`item_completed` carrying a `UserMessage`
 * item. The structures below were captured from a real 0.147.0 rollout.
 * Codex CLI <= 0.146.0 recorded the same input as `event_msg`/`user_message`;
 * Tinstar no longer parses that shape (it only trips the version floor).
 */

/** 0.147.0 `response_item` for one submitted terminal input. */
export function rolloutUserInputResponseItem(
  text: string,
  timestamp = '2026-08-11T19:46:29.863Z',
): object {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      id: '019ff254-924b-72f2-afdf-2b3f205eebc9',
      role: 'user',
      content: [{ type: 'input_text', text }],
      internal_chat_message_metadata_passthrough: {},
    },
  }
}

/** 0.147.0 `item_completed` event for the same submitted terminal input. */
export function rolloutUserInputItemCompleted(
  text: string,
  timestamp = '2026-08-11T19:46:29.875Z',
): object {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: 'thread-1',
      turn_id: 'turn-1',
      started_at_ms: 1,
      completed_at_ms: 2,
      item: {
        type: 'UserMessage',
        id: '019ff254-924b-72f2-afdf-2b3f205eebc9',
        content: [{ type: 'text', text, text_elements: [] }],
      },
    },
  }
}

/** Legacy (<= 0.146.0) user-input record; unsupported, trips the floor. */
export function legacyRolloutUserMessage(
  message: string,
  timestamp = '2026-07-31T09:14:26.000Z',
): object {
  return {
    timestamp,
    type: 'event_msg',
    payload: { type: 'user_message', message },
  }
}

export function rolloutSessionMeta(cwd = '/w'): object {
  return {
    type: 'session_meta',
    payload: { cwd, timestamp: '2026-08-11T19:37:31.719Z' },
  }
}

export function serializeRollout(records: object[]): string {
  return records.map(record => JSON.stringify(record)).join('\n') + '\n'
}
