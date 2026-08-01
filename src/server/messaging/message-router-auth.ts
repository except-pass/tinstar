import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MESSAGE_ROUTER_AUTH_FILE } from './message-router-address'

const AUTH_KEY_BYTES = 32
const AUTH_HEX_PATTERN = /^[0-9a-f]{64}$/

export interface MessageRouterSenderIdentity {
  sessionId: string
  incarnation: string
}

export interface AuthenticatedMessageRoute<T> {
  payload: T
  auth: string
}

function readMasterKey(path: string): Buffer {
  const key = readFileSync(path)
  if (key.byteLength !== AUTH_KEY_BYTES) {
    throw new Error(`invalid message router authentication key in ${path}`)
  }
  chmodSync(path, 0o600)
  return Buffer.from(key)
}

/** Stable 32-byte secret shared only by this Tinstar host and derived sessions. */
export function messageRouterMasterKey(configRoot: string): Buffer {
  const path = join(configRoot, MESSAGE_ROUTER_AUTH_FILE)
  try {
    return readMasterKey(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  mkdirSync(configRoot, { recursive: true })
  const created = randomBytes(AUTH_KEY_BYTES)
  try {
    writeFileSync(path, created, { flag: 'wx', mode: 0o600 })
    chmodSync(path, 0o600)
    return created
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    return readMasterKey(path)
  }
}

/** Derive one launch-scoped key without persisting per-session secrets. */
export function deriveMessageRouterSessionKey(
  masterKey: Uint8Array,
  sender: MessageRouterSenderIdentity,
): Buffer {
  return createHmac('sha256', masterKey)
    .update(JSON.stringify({
      sessionId: sender.sessionId,
      incarnation: sender.incarnation,
    }), 'utf8')
    .digest()
}

export function messageRouterAuthKeyFromHex(value: string): Buffer {
  if (!AUTH_HEX_PATTERN.test(value)) {
    throw new Error('message router authentication key must be 64 lowercase hex characters')
  }
  return Buffer.from(value, 'hex')
}

function payloadAuth(payload: unknown, key: Uint8Array): Buffer {
  return createHmac('sha256', key)
    .update(JSON.stringify(payload), 'utf8')
    .digest()
}

export function signMessageRoutePayload<T>(
  payload: T,
  key: Uint8Array,
): AuthenticatedMessageRoute<T> {
  return { payload, auth: payloadAuth(payload, key).toString('hex') }
}

export function verifyMessageRouteEnvelope(
  envelope: AuthenticatedMessageRoute<unknown>,
  key: Uint8Array,
): boolean {
  if (!AUTH_HEX_PATTERN.test(envelope.auth)) return false
  const supplied = Buffer.from(envelope.auth, 'hex')
  const expected = payloadAuth(envelope.payload, key)
  return supplied.byteLength === expected.byteLength
    && timingSafeEqual(supplied, expected)
}
