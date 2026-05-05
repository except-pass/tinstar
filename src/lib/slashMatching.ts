// src/lib/slashMatching.ts
export interface SlashToken {
  /** Index of the leading `/` in the original text. */
  start: number
  /** Substring after the `/` and before the cursor. */
  partial: string
}

const WS_RE = /\s/

export function findSlashToken(text: string, cursor: number): SlashToken | null {
  // Walk back from cursor through non-whitespace to find token start.
  let i = cursor - 1
  while (i >= 0 && !WS_RE.test(text[i]!)) i--
  // text[i] is whitespace or i is -1; token candidate starts at i+1.
  const tokenStart = i + 1
  if (text[tokenStart] !== '/') return null
  return { start: tokenStart, partial: text.slice(tokenStart + 1, cursor) }
}
