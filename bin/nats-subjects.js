export const REPLY_ONLY_SUBJECT_PREFIX = '_TINSTAR.reply-only.'
export function buildReplyOnlySubject(nonce) {
  if (typeof nonce !== 'string' || nonce.length === 0) throw new Error('reply-only subject nonce must be non-empty')
  return `${REPLY_ONLY_SUBJECT_PREFIX}${nonce}`
}
