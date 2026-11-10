/** Bound both browser capture and authenticated local inference. */
export const VOICE_MAX_SECONDS = 60
export const VOICE_MAX_BYTES = 8 * 1024 * 1024
export const VOICE_TIMEOUT_MS = 90_000
export const VOICE_MIME_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav'] as const
