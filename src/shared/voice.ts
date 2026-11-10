/** Bound both browser capture and authenticated local inference. */
export const VOICE_MAX_SECONDS = 60
export const VOICE_MAX_BYTES = 8 * 1024 * 1024
export const VOICE_TIMEOUT_MS = 90_000
export const VOICE_MIME_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'] as const

/** Complete user-facing messages: callers display them without appending copy. */
export const VOICE_UNAVAILABLE = 'Voice input is temporarily unavailable. Your text is preserved; you can type instead.'
export const VOICE_TIMEOUT = 'Voice input timed out or the connection was interrupted. Your text is preserved; you can type instead.'
export const VOICE_EMPTY = 'No speech was recognized. Your text is preserved; try again or type instead.'
