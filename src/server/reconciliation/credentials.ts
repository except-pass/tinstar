import { readFileSync, statSync } from 'node:fs'

/** Shared facade/backend credential format. Refuse files readable by other users
 * so a configured caller grant cannot accidentally publish its credential. */
export function privateCredential(path: string, authorization = false) {
  const info = statSync(path)
  if (!info.isFile() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) throw new Error('Credential must be owner-only')
  const value = readFileSync(path, 'utf8')
  if (!authorization) return value.trim()
  const match = /^Bearer ([^\s]{32,})(?:\r?\n)?$/.exec(value)
  if (!match || match[0] !== value) throw new Error('Caller file must contain one Bearer authorization value')
  return match[1]!
}
