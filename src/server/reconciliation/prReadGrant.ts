import type { IncomingMessage } from 'node:http'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { z } from 'zod'
import { getConfigRoot } from '../configRoot'
import { askConfigSchema } from '../ask/routes'
import { privateCredential } from './credentials'
import { secretEquals } from './sessions'

const grantsSchema = z.array(z.object({
  callerId: z.string().min(1),
  callerTokenFile: z.string().refine(isAbsolute),
  ownerLogin: z.string().min(1),
}))

/** Only list_prs/get_pr use this authority. Re-read configuration and credentials
 * on every call so deletion/rotation revokes even an already connected client.
 * Both credentials are required: an install-token holder must not impersonate
 * a granted caller by forging its ID or the browser's owner header. */
export async function authorizePrReadGrant(req?: IncomingMessage, root = getConfigRoot()): Promise<boolean> {
  if (!req) return false
  try {
    const installation = privateCredential(join(root, 'mcp-token'))
    if (!installation || !secretEquals(String(req.headers.authorization ?? ''), `Bearer ${installation}`)) return false
    const raw = JSON.parse(await readFile(join(root, 'config.json'), 'utf8'))
    const owners = askConfigSchema.parse(raw.ask).ownerLogins
    const grants = grantsSchema.parse(raw.mcp?.prReadGrants ?? [])
    const callerId = req.headers['x-tinstar-caller'], proof = req.headers['x-tinstar-caller-authorization']
    if (typeof callerId !== 'string' || typeof proof !== 'string') return false
    for (const grant of grants) {
      if (grant.callerId !== callerId || !owners.includes(grant.ownerLogin)) continue
      const credential = privateCredential(grant.callerTokenFile, true)
      if (!secretEquals(credential, installation) && secretEquals(proof, `Bearer ${credential}`)) return true
    }
  } catch { /* Missing/malformed config or credentials never grant private PR reads. */ }
  return false
}
